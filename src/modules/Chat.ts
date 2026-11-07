import { AssemblyHelper } from "../core/AssemblyHelper";
import { BaseModule } from "../core/BaseModule";
import { State } from "../data/State";
import { CHAT_WORDS } from "../data/ChatWords";
import { Logger } from "../logger/Logger";

export class ChatModule extends BaseModule {
    public readonly name = "Chat";

    private EOSManager!: Il2Cpp.Class;
    private PlayerControl!: Il2Cpp.Class;

    private EOSManager_IsFreechatAllowed!: Il2Cpp.Method;

    private lastSend = 0;

    public init(): void {
        this.EOSManager = AssemblyHelper.AssemblyCSharp.class("EOSManager");
        this.PlayerControl = AssemblyHelper.AssemblyCSharp.class("PlayerControl");

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

    /** Sends the word selected in the menu to the chat */
    public sendSelectedWord(): void {
        const word = CHAT_WORDS[State.selectedWordIndex];
        if (!word) {
            Logger.warn(`[${this.name}::sendSelectedWord] No word selected`);
            return;
        }

        const localPlayer = this.PlayerControl.field<Il2Cpp.Object>("LocalPlayer").value;
        if (localPlayer.isNull()) {
            Logger.warn(`[${this.name}::sendSelectedWord] LocalPlayer is null`);
            return;
        }

        // The game limits chat to one message per 3 seconds
        const now = Date.now();
        if (now - this.lastSend < 3000) {
            Logger.warn(`[${this.name}::sendSelectedWord] Too fast, wait 3 seconds`);
            return;
        }
        this.lastSend = now;

        localPlayer.method<boolean>("RpcSendChat").invoke(Il2Cpp.string(word));
    }
}
