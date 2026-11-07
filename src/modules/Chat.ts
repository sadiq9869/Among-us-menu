import { AssemblyHelper } from "../core/AssemblyHelper";
import { BaseModule } from "../core/BaseModule";
import { State } from "../data/State";
import { Logger } from "../logger/Logger";
import { UnityUtils } from "../utils/UnityUtils";

/** Epic.OnlineServices.KWS.KWSPermissionStatus is an int: Granted = 0, Rejected = 1, Pending = 2 (dump.cs) */
const KWS_GRANTED = 0;

/** AccountManager.freeChatAllowed offset in the dump.cs this was written for (0x90). Only used to warn if the build differs. */
const DUMP_FREECHAT_FIELD_OFFSET = 0x90;

/**
 * Methods of the free chat UI / Find a Game flow. All names and parameter counts are from dump.cs.
 * They are hooked only to set the permission BEFORE the original code runs; the original is always called with the same arguments.
 * Which one of them shows the "Free Chat lobbies require permission" dialog is not known yet, so all of them are covered and logged.
 */
const CHAT_FLOW_HOOKS: { className: string; method: string; argc: number }[] = [
    { className: "ChatModeToggle", method: "ClickFreeChat", argc: 0 },
    { className: "ChatModeToggle", method: "UpdateDisplay", argc: 0 },
    { className: "ChatModeCycle", method: "CycleChatMode", argc: 0 },
    { className: "ChatModeCycle", method: "UpdateDisplay", argc: 0 },
    { className: "FindAGameManager", method: "SetChatRestriction", argc: 0 },
    { className: "FindAGameManager", method: "AddChatFilterValue", argc: 2 },
    { className: "FindAGameManager", method: "FilterModified", argc: 0 }
];

export class ChatModule extends BaseModule {
    public readonly name = "Chat";

    private EOSManager!: Il2Cpp.Class;
    private AccountManager!: Il2Cpp.Class;

    private EOSManager_IsFreechatAllowed!: Il2Cpp.Method<boolean>;

    private readonly warned = new Set<string>();

    public init(): void {
        this.EOSManager = AssemblyHelper.AssemblyCSharp.class("EOSManager");
        this.AccountManager = AssemblyHelper.AssemblyCSharp.class("AccountManager");

        this.EOSManager_IsFreechatAllowed = this.EOSManager.method<boolean>("IsFreechatAllowed");
    }

    public override initHooks(): void {
        const module = this;

        // The game asks "is free chat allowed for this account?". When the toggle is on, we always answer yes.
        // @ts-ignore
        this.EOSManager_IsFreechatAllowed.implementation = function (this: Il2Cpp.Object): boolean {
            if (State.freeChat) {
                module.forceFreeChatPermission("IsFreechatAllowed");
                return true;
            }
            return this.method<boolean>("IsFreechatAllowed").invoke();
        };

        for (const target of CHAT_FLOW_HOOKS) {
            const method = AssemblyHelper.AssemblyCSharp.tryClass(target.className)?.tryMethod(target.method, target.argc);
            if (!method) {
                Logger.warn(`[${this.name}::initHooks] ${target.className}.${target.method} not found, skipped`);
                continue;
            }

            // @ts-ignore
            method.implementation = function (this: Il2Cpp.Object, ...args: any[]): any {
                Logger.hook(`[${module.name}] ${target.className}.${target.method} (freeChat=${State.freeChat})`);
                module.forceFreeChatPermission(`${target.className}.${target.method}`);
                return this.method(target.method, target.argc).invoke(...args);
            };
        }
    }

    /**
     * Sets AccountManager.freeChatAllowed to Granted while the Free Chat toggle is on.
     *
     * The field is read from memory at the offset the game itself reports for it (it is a plain int enum),
     * so the bridge's enum conversion is not involved.
     */
    public forceFreeChatPermission(reason: string): void {
        if (!State.freeChat) return;

        try {
            const manager = this.getAccountManager();
            if (!manager) return;

            const field = manager.class.tryField("freeChatAllowed");
            if (field === null || field.isStatic || !field.type.name.includes("KWSPermissionStatus")) {
                this.warnOnce("field", "AccountManager.freeChatAllowed is missing or has another type in this build");
                return;
            }
            if (field.offset !== DUMP_FREECHAT_FIELD_OFFSET) {
                this.warnOnce("offset", `freeChatAllowed offset is 0x${field.offset.toString(16)}, dump.cs had 0x${DUMP_FREECHAT_FIELD_OFFSET.toString(16)} (different build?)`);
            }

            const address = manager.handle.add(field.offset);
            const before = address.readS32();
            if (before !== KWS_GRANTED) {
                address.writeS32(KWS_GRANTED);
                Logger.info(`[${this.name}] freeChatAllowed ${before} -> ${KWS_GRANTED} (${reason})`);
            }
        } catch (e) {
            Logger.debug(`[${this.name}::forceFreeChatPermission] ${e}`);
        }
    }

    /** `AccountManager` singleton (DestroyableSingleton<AccountManager>). Tries three ways, because only one of them is needed. */
    private getAccountManager(): Il2Cpp.Object | undefined {
        try {
            const viaField = this.AccountManager.tryField<Il2Cpp.Object>("_instance")?.value;
            if (viaField && !viaField.isNull()) return viaField;
        } catch (e) {
            Logger.debug(`[${this.name}::getAccountManager] _instance: ${e}`);
        }

        try {
            const viaMethod = this.AccountManager.tryMethod<Il2Cpp.Object>("get_Instance")?.invoke();
            if (viaMethod && !viaMethod.isNull()) return viaMethod;
        } catch (e) {
            Logger.debug(`[${this.name}::getAccountManager] get_Instance: ${e}`);
        }

        try {
            const found = UnityUtils.FindObjectsOfType(this.AccountManager);
            if (found.length > 0) {
                const first = found.get(0);
                if (!first.isNull()) return first;
            }
        } catch (e) {
            Logger.debug(`[${this.name}::getAccountManager] FindObjectsOfType: ${e}`);
        }

        this.warnOnce("instance", "AccountManager instance not found");
        return undefined;
    }

    private warnOnce(key: string, message: string): void {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        Logger.warn(`[${this.name}] ${message}`);
    }
}
