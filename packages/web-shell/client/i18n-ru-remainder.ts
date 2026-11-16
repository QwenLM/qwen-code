/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ACTIVITY_MESSAGES_RU } from './components/sidebar/activity-messages.js';
import { CHANNEL_EVENTS_MESSAGES_RU } from './components/channels/channel-events-messages.js';
import { MANAGED_EXTENSION_MESSAGES_RU } from './components/managed/managed-extension-messages.js';

/**
 * Interactive-only Russian catalogs whose English/Chinese siblings stay in
 * the transcript bundle. `--mode transcript` stubs this module so exported
 * HTML does not ship a third copy of those surfaces.
 */
function githubBoundActionOptionDescriptions(
  base: Record<string, string>,
): Record<string, string> {
  const prefix = 'channels.editor.field.github.boundSessionActions';
  const entries: Record<string, string> = {};
  for (const [key, description] of Object.entries(base)) {
    entries[`${prefix}.optionDescription.${key}`] = description;
    for (const role of ['review', 'verify', 'fix']) {
      entries[`${prefix}.optionDescription.${role}:${key}`] = description;
    }
  }
  return entries;
}

export const RU_REMAINDER: Record<
  string,
  string | ((vars?: Record<string, string | number>) => string)
> = {
  ...ACTIVITY_MESSAGES_RU,
  ...CHANNEL_EVENTS_MESSAGES_RU,
  ...MANAGED_EXTENSION_MESSAGES_RU,
  ...githubBoundActionOptionDescriptions({
    default: 'Шаблон по умолчанию для событий без более конкретного ключа',
    'watch:ci_failure': 'Проверки CI на head-коммите стали красными',
    'watch:merge_conflict': 'В PR появились конфликты слияния',
    'watch:head_change': 'Изменился head-коммит PR',
    'watch:state_change': 'PR смержен или закрыт',
    mention: 'Вас @упомянули в комментарии',
    review_requested: 'Вас попросили провести ревью',
    assign: 'Вас назначили на этот PR',
    author: 'В созданном вами PR появились обновления',
    comment: 'Новый комментарий в отслеживаемом PR',
    ci_activity: 'Обновление CI в отслеживаемом PR',
    manual: 'Вы вручную подписались на этот PR',
    state_change: 'PR закрыт или смержен',
    subscribed: 'Обновление в PR, на который вы подписаны',
    team_mention: 'Упомянута ваша команда',
    security_alert: 'Предупреждение безопасности репозитория',
    approval_requested: 'Вас попросили подтвердить',
    invitation: 'Вы получили приглашение к совместной работе',
    member_feature_requested: 'Уведомление о запросе функции участника',
    security_advisory_credit:
      'Вас указали в благодарностях к бюллетеню безопасности',
  }),
};
