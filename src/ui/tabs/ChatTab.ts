import { ObsidianLayout, add, CENTER } from "frida-java-menu";

import { I18n } from "../../i18n/I18n";
import { State } from "../../data/State";
import { ModuleManager } from "../../core/ModuleManager";
import { ChatModule } from "../../modules/Chat";
import { UnityUtils } from "../../utils/UnityUtils";

export class ChatTab {
    static draw(layout: ObsidianLayout) {
        const chat = layout.textView(I18n.t("menu.tabs.chat"));
        chat.gravity = CENTER;
        add(chat);

        add(
            layout.toggle(
                I18n.t("menu.functions.free_chat"),
                UnityUtils.run((state: boolean) => {
                    State.freeChat = state;
                    ModuleManager.get(ChatModule)?.forceFreeChatPermission("toggle");
                })
            )
        );
        add(layout.textView(I18n.t("menu.functions.free_chat_note")));
    }
}
