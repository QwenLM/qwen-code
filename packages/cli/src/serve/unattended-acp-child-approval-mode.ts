/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { isSafeModeEnv } from '@qwen-code/qwen-code-core/utils/safe-mode.js';
import { loadSettings } from '../config/settings.js';
import {
  resolveUnattendedAcpChildApprovalMode,
  tryParseApprovalModePin,
} from '../runtime/unattended-acp-child-approval-mode.js';

/**
 * Workspace-derived approval mode for an unattended ACP child spawned by
 * the daemon (scheduled-task mint, keepalive bind, HTTP manual run).
 *
 * Reads the merged workspace settings the same way status/settings readers
 * do. Does not invent a separate default: ACP children boot DEFAULT when
 * `tools.approvalMode` is unset; this then applies the unattended policy
 * (honor pins / restricted DEFAULT / elevate implicit DEFAULT → AUTO).
 *
 * Note: bare mode (`QWEN_CODE_SIMPLE`) is intentionally NOT consulted —
 * that env key is scrubbed from ACP children, so a daemon running bare
 * would otherwise dispatch DEFAULT to a child that is not bare (R3-9).
 * Safe mode is inherited by children and stays restricted.
 */
export function resolveUnattendedAcpChildApprovalModeForWorkspace(
  workspaceCwd: string,
): ApprovalMode {
  let settingsApprovalMode: string | undefined;
  try {
    const loaded = loadSettings(workspaceCwd, { skipLoadEnvironment: true });
    const value = loaded.merged.tools?.approvalMode;
    if (typeof value === 'string' && value.trim().length > 0) {
      settingsApprovalMode = value;
    }
  } catch {
    // Settings-read failure: fail closed (no elevation). Treat as a present
    // but unreadable pin so the shared resolver returns DEFAULT rather than
    // silently escalating to AUTO (R3-7).
    return ApprovalMode.DEFAULT;
  }

  const restricted = isSafeModeEnv();
  let effectiveMode = ApprovalMode.DEFAULT;
  if (!restricted && settingsApprovalMode) {
    const parsed = tryParseApprovalModePin(settingsApprovalMode);
    if (parsed !== undefined) {
      effectiveMode = parsed;
    }
  }

  return resolveUnattendedAcpChildApprovalMode(
    effectiveMode,
    settingsApprovalMode,
    restricted,
  );
}
