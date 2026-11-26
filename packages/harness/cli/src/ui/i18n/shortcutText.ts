/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { I18nService } from '@qwen-code/core';
import type { UiMessageKey } from './types.js';

const SHORTCUT_MESSAGE_KEYS = {
  TAB_SWITCH: 'shortcut.tabSwitch',
  TAB_ONLY_SWITCH: 'shortcut.tabOnlySwitch',
  ARROW_SWITCH: 'shortcut.arrowSwitch',
  NAVIGATE: 'shortcut.navigate',
  SELECT: 'shortcut.select',
  CONFIRM: 'shortcut.confirm',
  ENTER_TOGGLE: 'shortcut.toggle',
  ENTER_TO_LIST: 'shortcut.enterToList',
  CANCEL: 'shortcut.cancel',
  CLOSE: 'shortcut.close',
  GO_BACK: 'shortcut.back',
  ESC_CANCEL_SEARCH: 'shortcut.cancelSearch',
  SEARCH: 'shortcut.search',
  S_SESSION_ONLY: 'shortcut.sessionOnly',
  R_REFRESH: 'shortcut.refresh',
  R_EXIT_APPLY: 'shortcut.restartApply',
  TAB_TOGGLE: 'shortcut.tabToggle',
} as const satisfies Record<string, UiMessageKey>;

export type LocalizedShortcutHintId = keyof typeof SHORTCUT_MESSAGE_KEYS;

export function formatLocalizedShortcutHint(
  t: I18nService['get'],
  ...ids: LocalizedShortcutHintId[]
): string {
  return ids.map((id) => t(SHORTCUT_MESSAGE_KEYS[id])).join(' · ');
}
