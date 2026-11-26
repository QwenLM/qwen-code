/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionMode } from '@qwen-code/core';
import type { I18nService } from '@qwen-code/core';
import type { UiMessageKey } from './types.js';

const PERMISSION_MODE_TITLE_KEYS = {
  default: 'status.permission.mode.default',
  acceptEdits: 'status.permission.mode.acceptEdits',
  auto: 'status.permission.mode.auto',
  dontAsk: 'status.permission.mode.dontAsk',
  yolo: 'status.permission.mode.yolo',
} as const satisfies Record<PermissionMode, UiMessageKey>;

const PERMISSION_MODE_SHORT_TITLE_KEYS = {
  ...PERMISSION_MODE_TITLE_KEYS,
  auto: 'status.permission.mode.autoShort',
} as const satisfies Record<PermissionMode, UiMessageKey>;

export function getLocalizedPermissionModeTitle(
  mode: PermissionMode | undefined,
  t: I18nService['get'],
): string {
  return t(PERMISSION_MODE_TITLE_KEYS[mode ?? 'default']);
}

export function getLocalizedPermissionModeShortTitle(
  mode: PermissionMode | undefined,
  t: I18nService['get'],
): string {
  return t(PERMISSION_MODE_SHORT_TITLE_KEYS[mode ?? 'default']);
}
