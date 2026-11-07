import { toast } from "frida-java-menu";

import { AssemblyHelper } from "../core/AssemblyHelper";
import { BaseModule } from "../core/BaseModule";
import { State } from "../data/State";
import { Logger } from "../logger/Logger";
import { EnumUtils } from "../utils/EnumUtils";
import { UnityUtils } from "../utils/UnityUtils";

/** Roles that can be picked in the menu. `id` is the game's RoleTypes number (checked against dump.cs, RoleTypes : ushort). */
export const SELECTABLE_ROLES: { name: string; id: number }[] = [
    { name: "Impostor", id: 1 },
    { name: "Shapeshifter", id: 5 },
    { name: "Phantom", id: 9 },
    { name: "Viper", id: 18 }
];

/**
 * Impostor-team RoleTypes (Impostor, Shapeshifter, ImpostorGhost, Phantom, Viper), taken from the role names in dump.cs.
 * Used only if RoleManager.IsImpostorRole can't be called.
 */
const IMPOSTOR_TEAM_FALLBACK = new Set<number>([1, 5, 7, 9, 18]);

/** When to re-check that the roles stuck (ms after the swap) */
const VERIFY_DELAYS_MS = [1000, 2500];

interface RecordedRole {
    player: Il2Cpp.Object; // PlayerControl
    role: number | undefined; // RoleTypes, undefined if the argument could not be read
}

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
    private RoleManager_IsImpostorRole!: Il2Cpp.Method<boolean>;
    private PlayerControl_RpcSetRole!: Il2Cpp.Method;

    // While SelectRoles runs, we write down every role the game hands out.
    // The game applies roles a little later (coroutine), so reading them back right away is not reliable.
    private collecting = false;
    private recorded: RecordedRole[] = [];

    public init(): void {
        this.AmongUsClient = AssemblyHelper.AssemblyCSharp.class("AmongUsClient");
        this.PlayerControl = AssemblyHelper.AssemblyCSharp.class("PlayerControl");
        this.RoleManager = AssemblyHelper.AssemblyCSharp.class("RoleManager");

        this.RoleManager_SelectRoles = this.RoleManager.method<void>("SelectRoles");
        this.RoleManager_IsImpostorRole = this.RoleManager.method<boolean>("IsImpostorRole");
        this.PlayerControl_RpcSetRole = this.PlayerControl.method<void>("RpcSetRole", 2);
    }

    public override initHooks(): void {
        const module = this;

        // Just listens: records (player, role) while SelectRoles is running, then passes the call through unchanged
        // @ts-ignore
        this.PlayerControl_RpcSetRole.implementation = function (this: Il2Cpp.Object, roleType: unknown, canOverrideRole: boolean): void {
            if (module.collecting) {
                try {
                    module.recorded.push({ player: this, role: EnumUtils.toNumber(roleType) });
                } catch (e) {
                    Logger.debug(`[${module.name}::RpcSetRole] Could not record: ${e}`);
                }
            }
            return this.method<void>("RpcSetRole", 2).invoke(roleType as any, canOverrideRole);
        };

        // The host runs SelectRoles once when the game starts.
        // We let the game hand out roles first, then do our swap.
        // @ts-ignore
        this.RoleManager_SelectRoles.implementation = function (this: Il2Cpp.Object): void {
            const active = State.alwaysImpostor;
            module.recorded = [];
            module.collecting = active;

            try {
                this.method<void>("SelectRoles").invoke();
            } finally {
                module.collecting = false;
            }

            if (!active) return;

            try {
                module.applySelectedRole();
            } catch (error: any) {
                Logger.error(`[${module.name}::SelectRoles] Role swap failed, game continues normally: ${error}`);
                module.say(`Role swap error: ${error?.message ?? error}`);
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
            this.say("Always Impostor: you are not the host, skipped");
            return;
        }

        const chosen = SELECTABLE_ROLES[State.selectedRoleIndex];
        if (chosen === undefined) {
            this.say("Always Impostor: no role selected");
            return;
        }
        const target = chosen.id;

        const me = this.localPlayer;
        if (me.isNull()) {
            this.say("Always Impostor: LocalPlayer is null");
            return;
        }

        // Best source: what the game just handed out. Fallback: read from player data.
        let source = "rpc";
        let everyone = this.fromRecorded();
        if (everyone.length === 0) {
            source = "data";
            everyone = this.fromPlayerData();
        }

        const mine = everyone.find(p => p.player.handle.equals(me.handle));
        const myRole = mine ? mine.role : this.getRole(me);
        if (myRole === undefined) {
            // Never send anything with an unknown role: this is exactly the NaN bug
            this.say(`Always Impostor: could not read my role (source ${source}), skipped`);
            return;
        }

        const others = everyone.filter(p => !p.player.handle.equals(me.handle));
        const total = others.length + 1;
        const impostorsBefore = others.filter(p => this.isImpostorRole(p.role)).length + this.imp(myRole);

        // Already have it: nothing to do
        if (myRole === target) {
            this.say(`Always Impostor: already ${chosen.name}`);
            return;
        }

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
            this.say(`Always Impostor: would raise impostors ${impostorsBefore}->${impostorsAfter}, skipped`);
            return;
        }
        if (impostorsAfter > impostorsBefore && impostorsAfter >= total - impostorsAfter) {
            this.say("Always Impostor: impostors would equal crew, skipped");
            return;
        }

        // Order matters: first the other player gets our old role, then we take the new one.
        if (partner) {
            partner.player.method<void>("RpcSetRole", 2).invoke(myRole, true);
        }
        me.method<void>("RpcSetRole", 2).invoke(target, true);

        this.say(`Role swap (${source}): me ${myRole}->${target} ${chosen.name}, partner ${partner ? partner.role + "->" + myRole : "none"}`);

        this.scheduleVerify(me, target, chosen.name, partner ? partner.player : undefined, myRole);
    }

    /** The game applies roles a moment later. Check a few times and send again if they did not stick. */
    private scheduleVerify(me: Il2Cpp.Object, target: number, targetName: string, partner: Il2Cpp.Object | undefined, partnerNewRole: number): void {
        VERIFY_DELAYS_MS.forEach((delay, index) => {
            const isLast = index === VERIFY_DELAYS_MS.length - 1;
            setTimeout(() => {
                UnityUtils.runInMain(() => this.verify(me, target, targetName, partner, partnerNewRole, isLast)).catch(e =>
                    Logger.debug(`[${this.name}::verify] ${e}`)
                );
            }, delay);
        });
    }

    /** Checks that the roles stuck. If not, sends them again */
    private verify(
        me: Il2Cpp.Object,
        target: number,
        targetName: string,
        partner: Il2Cpp.Object | undefined,
        partnerNewRole: number,
        isLast: boolean
    ): void {
        try {
            if (me.isNull() || UnityUtils.cachedPtr(me).isNull()) return;

            const myNow = this.getRole(me);
            if (myNow === undefined) {
                this.say("Role check: could not read my role");
            } else if (myNow !== target) {
                me.method<void>("RpcSetRole", 2).invoke(target, true);
                this.say(`Role check: I was ${myNow}, sent ${targetName} again`);
            } else if (isLast) {
                this.say(`Role check OK: I am ${myNow} (${targetName})`);
            }

            if (partner && !partner.isNull() && !UnityUtils.cachedPtr(partner).isNull()) {
                const partnerNow = this.getRole(partner);
                if (partnerNow !== undefined && partnerNow !== partnerNewRole) {
                    partner.method<void>("RpcSetRole", 2).invoke(partnerNewRole, true);
                }
            }
        } catch (e) {
            Logger.debug(`[${this.name}::verify] ${e}`);
        }
    }

    /** Roles the game handed out during SelectRoles (last one wins per player) */
    private fromRecorded(): RolePlayer[] {
        const byHandle = new Map<string, RolePlayer>();
        for (const entry of this.recorded) {
            try {
                if (entry.player.isNull()) continue;
                if (UnityUtils.cachedPtr(entry.player).isNull()) continue;

                const role = entry.role ?? this.getRole(entry.player);
                if (role === undefined) {
                    Logger.debug(`[${this.name}::fromRecorded] Skipping a player: role unreadable`);
                    continue;
                }

                byHandle.set(entry.player.handle.toString(), { player: entry.player, role });
            } catch (e) {
                Logger.debug(`[${this.name}::fromRecorded] Skipping a player: ${e}`);
            }
        }
        return Array.from(byHandle.values());
    }

    /** Fallback: read roles from player data (may be out of date right after SelectRoles) */
    private fromPlayerData(): RolePlayer[] {
        const result: RolePlayer[] = [];

        // static List<PlayerControl> PlayerControl::AllPlayerControls
        const list = this.PlayerControl.field<Il2Cpp.Object>("AllPlayerControls").value;
        if (list.isNull()) return result;

        const count = list.method<number>("get_Count").invoke();
        for (let i = 0; i < count; i++) {
            const player = list.method<Il2Cpp.Object>("get_Item").invoke(i);
            if (player.isNull()) continue;

            try {
                if (UnityUtils.cachedPtr(player).isNull()) continue;

                const data = player.method<Il2Cpp.Object>("get_Data").invoke();
                if (data.isNull()) continue;
                if (data.field<boolean>("Disconnected").value) continue;

                const role = this.getRole(player);
                if (role === undefined) continue;

                result.push({ player, role });
            } catch (e) {
                Logger.debug(`[${this.name}::fromPlayerData] Skipping a player: ${e}`);
            }
        }

        return result;
    }

    /**
     * Current RoleTypes number of a player, or undefined if not ready yet.
     *
     * NetworkedPlayerInfo.RoleType is a ushort enum, so it is read straight from memory.
     * Going through the bridge's `.value` gave an object, which became NaN.
     */
    private getRole(player: Il2Cpp.Object): number | undefined {
        try {
            const data = player.method<Il2Cpp.Object>("get_Data").invoke();
            if (data.isNull()) return undefined;
            return EnumUtils.readU16Field(data, "RoleType");
        } catch (e) {
            Logger.debug(`[${this.name}::getRole] ${e}`);
            return undefined;
        }
    }

    /** `static RoleManager::IsImpostorRole`. Works for any impostor-type role the game has */
    private isImpostorRole(role: number): boolean {
        try {
            const result = this.RoleManager_IsImpostorRole.invoke(role);
            if (typeof result === "boolean") return result;
        } catch (e) {
            Logger.debug(`[${this.name}::isImpostorRole] ${e}`);
        }
        return IMPOSTOR_TEAM_FALLBACK.has(role);
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

    /** Log + on-screen message, so you can see what happened without a computer */
    private say(message: string): void {
        Logger.info(`[${this.name}] ${message}`);
        try {
            toast(message, 1);
        } catch (e) {
            Logger.debug(`[${this.name}::say] toast failed: ${e}`);
        }
    }

    /** `static PlayerControl::LocalPlayer` */
    private get localPlayer(): Il2Cpp.Object {
        return this.PlayerControl.field<Il2Cpp.Object>("LocalPlayer").value;
    }
}
