/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  APPROVAL_MODES,
} from '@qwen-code/qwen-code-core/config/approval-mode.js';

function formatApprovalModeError(value: string): Error {
  return new Error(
    `Invalid approval mode: ${value}. Valid values are: ${APPROVAL_MODES.join(
      ', ',
    )}`,
  );
}

/**
 * Normalizes an approval-mode spelling exactly the way boot accepts it:
 * trimmed, lowercased, with the legacy `auto_edit`/`autoedit` aliases mapped
 * to AUTO_EDIT. Throws for values boot would reject. Shared with the ACP
 * daemon's reload convergence and the Managed compatibility evaluation, so both
 * agree with boot for every accepted spelling.
 */
export function parseApprovalModeValue(value: string): ApprovalMode {
  const normalized = value.trim().toLowerCase();
  const canonical =
    normalized === 'auto_edit' || normalized === 'autoedit'
      ? ApprovalMode.AUTO_EDIT
      : normalized;
  const approvalMode = APPROVAL_MODES.find((mode) => mode === canonical);
  if (approvalMode === undefined) {
    throw formatApprovalModeError(value);
  }
  return approvalMode;
}
