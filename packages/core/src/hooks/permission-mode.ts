/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode } from '../config/approval-mode.js';
import { PermissionMode } from './types.js';

/**
 * Maps an approval mode, as held by Config or persisted with a background
 * agent, to the permission mode reported in hook input. Unknown or missing
 * values map to {@link PermissionMode.Default}.
 */
export function approvalModeToPermissionMode(
  mode: string | undefined,
): PermissionMode {
  switch (mode) {
    case ApprovalMode.PLAN:
      return PermissionMode.Plan;
    case ApprovalMode.AUTO_EDIT:
      return PermissionMode.AutoEdit;
    case ApprovalMode.AUTO:
      return PermissionMode.Auto;
    case ApprovalMode.YOLO:
      return PermissionMode.Yolo;
    default:
      return PermissionMode.Default;
  }
}
