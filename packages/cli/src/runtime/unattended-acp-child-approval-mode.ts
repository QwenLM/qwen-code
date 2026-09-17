/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode } from '@qwen-code/qwen-code-core';

/**
 * Approval mode for an unattended ACP child (scheduled-task fire, keepalive
 * mint, daemon HTTP run) that has nobody attached to answer
 * `session/request_permission`.
 *
 * Restricted (safe/bare) sessions stay on DEFAULT. An explicit
 * `tools.approvalMode` pin is honored, including `plan` and `default`. Only
 * the implicit ACP ask-permissions boot default — DEFAULT with no settings
 * pin — is elevated to AUTO so the child does not park forever on its first
 * write.
 */
export function resolveUnattendedAcpChildApprovalMode(
  effectiveMode: ApprovalMode,
  settingsApprovalMode: string | undefined,
  restricted: boolean,
): ApprovalMode {
  if (restricted) return ApprovalMode.DEFAULT;
  if (settingsApprovalMode) return effectiveMode;
  if (effectiveMode === ApprovalMode.DEFAULT) return ApprovalMode.AUTO;
  return effectiveMode;
}
