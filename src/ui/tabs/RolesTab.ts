import { ObsidianLayout, add, CENTER } from "frida-java-menu";

import { I18n } from "../../i18n/I18n";
import { State } from "../../data/State";
import { UnityUtils } from "../../utils/UnityUtils";
import { ModuleManager } from "../../core/ModuleManager";
import { PlayerModule } from "../../modules/Player";
import { SELECTABLE_ROLES } from "../../modules/Roles";

export class RolesTab {
    static draw(layout: ObsidianLayout) {
        const roles = layout.textView(I18n.t("menu.tabs.roles"));
        roles.gravity = CENTER;
        add(roles);

        add(
            layout.button(
                I18n.t("menu.functions.complete_my_tasks"),
                UnityUtils.run(() => ModuleManager.get(PlayerModule)?.completeMyTasks())
            )
        );

        add(
            layout.toggle(I18n.t("menu.functions.always_impostor"), (state: boolean) => {
                State.alwaysImpostor = state;
            })
        );

        add(
            layout.radioGroup(
                I18n.t("menu.functions.role_select"),
                SELECTABLE_ROLES.map(role => role.name),
                (index: number) => {
                    State.selectedRoleIndex = index;
                }
            )
        );

        add(layout.textView(I18n.t("menu.functions.role_note")));
    }
}
