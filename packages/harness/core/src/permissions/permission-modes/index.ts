/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission mode behaviour for this host. Mode *names* come from
 * `../manager/decision/index.js` — import `PermissionModes` / `PermissionMode`
 * from there, and everything else from here.
 */

export {
  PERMISSION_MODE_CYCLE,
  PLAN_MODE_BLOCKED_MESSAGE,
  PLAN_MODE_FORCE_EXITED_MESSAGE,
  BYPASS_PERMISSIONS_DISABLED_MESSAGE,
  AUTO_MODE_UNSUPPORTED_MESSAGE,
  permissionModeQueueEffect,
  getNextPermissionMode,
  isAcceptEditsMode,
  isAutoMode,
  isDefaultMode,
  isDontAskMode,
  isPlanStateBlockedByMode,
  isYoloMode,
  parsePermissionMode,
  resolveEffectiveMode,
} from './modes.js';

export {
  WORK_STATE_COLORS,
  permissionModeColor,
  permissionModeDescription,
  permissionModeShortTitle,
  permissionModeSymbol,
  permissionModeTitle,
  type PermissionModeDisplay,
} from './display.js';
