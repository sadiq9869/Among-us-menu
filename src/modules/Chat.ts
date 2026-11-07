// ===== NEW FILE: add this file at src/modules/Chat.ts =====
import { AssemblyHelper } from "../core/AssemblyHelper";
import { BaseModule } from "../core/BaseModule";
import { State } from "../data/State";

export class ChatModule extends BaseModule {
    public readonly name = "Chat";

    private EOSManager!: Il2Cpp.Class;

    private EOSManager_IsFreechatAllowed!: Il2Cpp.Method;

    public init(): void {
        this.EOSManager = AssemblyHelper.AssemblyCSharp.class("EOSManager");

        this.EOSManager_IsFreechatAllowed = this.EOSManager.method<boolean>("IsFreechatAllowed");
    }

    public override initHooks(): void {
        // The game asks "is free chat allowed for this account?". When the toggle is on, we always answer yes.
        this.EOSManager_IsFreechatAllowed.implementation = function (): boolean {
            if (State.freeChat) {
                return true;
            }
            return this.method<boolean>("IsFreechatAllowed").invoke();
        };
    }
}
