import { AssemblyHelper } from "../core/AssemblyHelper";
import { BaseModule } from "../core/BaseModule";
import { State } from "../data/State";
import { UnityUtils } from "../utils/UnityUtils";
import { Logger } from "../logger/Logger";

/** Roles that can be picked in the menu. `id` is the game's RoleTypes number. */
export const SELECTABLE_ROLES: { name: string; id: number }[] = [
    { name: "Impostor", id: 1 },
    { name: "Shapeshifter", id: 5 },
    { name: "Phantom", id: 9 },
    { name: "Viper", id: 18 }
];

interface RolePlayer {
    player: Il2Cpp.Object; // PlayerControl
    role: number; // RoleTypes
}

export class RolesModule extends BaseModule {
    public readonly name = "Roles";

    private AmongUsClient!: Il2Cpp.Class;
    private PlayerControl!: Il2Cpp.Class;
    private RoleManager!: Il2Cpp.Class;

    private RoleManager_SelectRoles!: Il2Cpp.Method;

    public init(): void {
        this.AmongUsClient = AssemblyHelper.AssemblyCSharp.class("AmongUsClient");
        this.PlayerControl = AssemblyHelper.AssemblyCSharp.class("PlayerControl");
        this.RoleManager = AssemblyHelper.AssemblyCSharp.class("RoleManager");

        this.RoleManager_SelectRoles = this.RoleManager.method<void>("SelectRoles");
    }

    public override initHooks(): void {
        const module = this;

        // The host runs SelectRoles once when the game starts.
        // We let the game give everyone their roles first, then do our swap.
        this.RoleManager_SelectRoles.implementation = function (): void {
            this.method<void>("SelectRoles").invoke();

            if (!State.alwaysImpostor) return;

            try {
                module.applySelectedRole();
            } catch (error: any) {
                Logger.error(`[${module.name}::SelectRoles] Role swap failed, game continues normally: ${error}`);
            }
        };
    }

    /**
     * Gives the local player the role chosen in the menu.
     *
     * The player who would lose a role gets our old role (a real swap),
     * so the number of impostors never goes up.
     */
    public applySelectedRole(): void {
        if (!this.amHost()) {
            Logger.warn(`[${this.name}::applySelectedRole] Not the host, skipping`);
            return;
        }

        const target = SELECTABLE_ROLES[State.selectedRoleIndex]?.id;
        if (target === undefined) {
            Logger.warn(`[${this.name}::applySelectedRole] No role selected`);
            return;
        }

        const me = this.localPlayer;
        if (me.isNull()) {
            Logger.warn(`[${this.name}::applySelectedRole] LocalPlayer is null`);
            return;
        }

        const myRole = this.getRole(me);
        if (myRole === undefined) {
            Logger.warn(`[${this.name}::applySelectedRole] Could not read my role`);
            return;
        }

        // Already have it: nothing to do
        if (myRole === target) {
            Logger.debug(`[${this.name}::applySelectedRole] Already role ${target}`);
            return;
        }

        const others = this.collectOthers(me);
        const total = others.length + 1;

        const impostorsBefore = others.filter(p => this.isImpostorRole(p.role)).length + (this.isImpostorRole(myRole) ? 1 : 0);

        // 1) Someone already has the role we want? Swap with them.
        let partner = others.find(p => p.role === target);

        // 2) Otherwise, if we are crewmate-side, swap with a random impostor.
        if (!partner && !this.isImpostorRole(myRole)) {
            const impostors = others.filter(p => this.isImpostorRole(p.role));
            if (impostors.length > 0) {
                partner = impostors[Math.floor(Math.random() * impostors.length)];
            }
        }

        // 3) Otherwise (we are already an impostor, or there is no impostor): only our role changes.

        // Safety check before touching anything: impostors must not increase
        let impostorsAfter = impostorsBefore - this.imp(myRole) + this.imp(target);
        if (partner) {
            impostorsAfter = impostorsAfter - this.imp(partner.role) + this.imp(myRole);
        }

        if (impostorsAfter > impostorsBefore && impostorsBefore > 0) {
            Logger.warn(`[${this.name}::applySelectedRole] Would raise impostors ${impostorsBefore} -> ${impostorsAfter}, skipping`);
            return;
        }
        if (impostorsAfter > impostorsBefore && impostorsAfter >= total - impostorsAfter) {
            Logger.warn(`[${this.name}::applySelectedRole] Impostors would equal/outnumber crew, skipping`);
            return;
        }

        // Order matters: first the other player gets our old role, then we take the new one.
        // This way the impostor count never goes above the original value.
        if (partner) {
            Logger.debug(`[${this.name}::applySelectedRole] Swapping: partner ${partner.role} -> ${myRole}, me ${myRole} -> ${target}`);
            partner.player.method<void>("RpcSetRole", 2).invoke(myRole, true);
        } else {
            Logger.debug(`[${this.name}::applySelectedRole] No swap partner, me ${myRole} -> ${target}`);
        }

        me.method<void>("RpcSetRole", 2).invoke(target, true);
    }

    /** All valid, alive, connected players except `me` with their current role */
    private collectOthers(me: Il2Cpp.Object): RolePlayer[] {
        const result: RolePlayer[] = [];

        // static List<PlayerControl> PlayerControl::AllPlayerControls
        const list = this.PlayerControl.field<Il2Cpp.Object>("AllPlayerControls").value;
        if (list.isNull()) return result;

        const count = list.method<number>("get_Count").invoke();
        for (let i = 0; i < count; i++) {
            const player = list.method<Il2Cpp.Object>("get_Item").invoke(i);
            if (player.isNull()) continue;
            if (player.handle.equals(me.handle)) continue;

            try {
                if (UnityUtils.cachedPtr(player).isNull()) continue;

                const data = player.method<Il2Cpp.Object>("get_Data").invoke();
                if (data.isNull()) continue;
                if (data.field<boolean>("Disconnected").value) continue;
                if (data.field<boolean>("IsDead").value) continue;

                result.push({ player, role: Number(data.field<number>("RoleType").value) });
            } catch (e) {
                Logger.debug(`[${this.name}::collectOthers] Skipping a player: ${e}`);
            }
        }

        return result;
    }

    /** Current RoleTypes number of a player, or undefined if not ready yet */
    private getRole(player: Il2Cpp.Object): number | undefined {
        try {
            const data = player.method<Il2Cpp.Object>("get_Data").invoke();
            if (data.isNull()) return undefined;
            return Number(data.field<number>("RoleType").value);
        } catch (e) {
            Logger.debug(`[${this.name}::getRole] ${e}`);
            return undefined;
        }
    }

    /** `static RoleManager::IsImpostorRole`. Works for any impostor-type role the game has */
    private isImpostorRole(role: number): boolean {
        return this.RoleManager.method<boolean>("IsImpostorRole").invoke(role);
    }

    private imp(role: number): number {
        return this.isImpostorRole(role) ? 1 : 0;
    }

    /** `AmongUsClient.Instance.AmHost` */
    private amHost(): boolean {
        const client = this.AmongUsClient.field<Il2Cpp.Object>("Instance").value;
        if (client.isNull()) return false;
        return client.method<boolean>("get_AmHost").invoke();
    }

    /** `static PlayerControl::LocalPlayer` */
    private get localPlayer(): Il2Cpp.Object {
        return this.PlayerControl.field<Il2Cpp.Object>("LocalPlayer").value;
    }
}
