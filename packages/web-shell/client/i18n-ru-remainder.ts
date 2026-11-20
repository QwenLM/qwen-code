/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ACTIVITY_MESSAGES_RU } from './components/sidebar/activity-messages.js';
import { CHANNEL_EVENTS_MESSAGES_RU } from './components/channels/channel-events-messages.js';
import { MANAGED_EXTENSION_MESSAGES_RU } from './components/managed/managed-extension-messages.js';
import { ruPlural } from './utils/plural.js';

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
  'hooks.title': 'Статистика хуков',
  'hooks.thisTurn': 'Этот ход · основной агент',
  'hooks.executions': 'Запуски',
  'hooks.blocked': 'Блокировки',
  'hooks.unsuccessful': 'Сбои',
  'hooks.duration': 'Всего времени',
  'hooks.compactSummary': (v) =>
    `${v?.executions ?? 0} ${ruPlural(v?.executions, 'запуск', 'запуска', 'запусков')} · ${v?.blocked ?? 0} ${ruPlural(v?.blocked, 'блокировка', 'блокировки', 'блокировок')} · ${v?.unsuccessful ?? 0} ${ruPlural(
      v?.unsuccessful,
      'сбой',
      'сбоя',
      'сбоев',
    )} · ${v?.duration ?? '—'}`,
  'hooks.partial':
    'Записи неполные. Итоги покрывают только записанные запуски.',
  'hooks.more': 'Другие действия с ответом',
  'hooks.loading': 'Загрузка хуков…',
  'hooks.loadFailed': 'Не удалось загрузить записи хуков.',
  'hooks.retry': 'Повторить',
  'hooks.loadMore': 'Загрузить ещё 50',
  'hooks.type': 'Тип хука',
  'hooks.started': 'Начало',
  'hooks.ended': 'Конец',
  'hooks.exitCode': 'Код выхода',
  'hooks.dispatchDuration': 'Длительность отправки',
  'hooks.dispatchHelp': 'Отправлено в фон. Итоговый результат не собирается.',
  'hooks.unknownHelp': 'Итог в терминале не записан или соединение прервалось.',
  'hooks.status.running': 'Выполняется',
  'hooks.status.unknown': 'Результат недоступен',
  'hooks.status.dispatched': 'Отправлено в фон',
  'hooks.status.success': 'Успешно',
  'hooks.status.blocked': 'Заблокировано',
  'hooks.status.error': 'Ошибка',
  'hooks.status.timeout': 'Таймаут',
  'hooks.status.cancelled': 'Отменено',
  'hooks.source.system': 'Система',
  'hooks.source.user': 'Пользователь',
  'hooks.source.project': 'Проект',
  'hooks.source.extensions': 'Расширение',
  'hooks.source.session': 'Сессия',
  'hooks.source.unknown': 'Неизвестный источник',
  'hooks.coverage.recorded': 'Запусков хуков не записано.',
  'hooks.coverage.unrecorded': 'Запуски хуков в этом ходе не записывались.',
  'hooks.coverage.unsupported':
    'Статистика хуков для этой среды выполнения не поддерживается.',
  'hooks.coverage.partial': 'В сохранённых записях нет доступных запусков.',
};
