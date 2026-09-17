/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  APPROVAL_MODES,
  isBareMode,
  isSafeModeEnv,
} from '@qwen-code/qwen-code-core';
import { loadSettings } from '../config/settings.js';
import { resolveUnattendedAcpChildApprovalMode } from '../runtime/unattended-acp-child-approval-mode.js';

/**
 * Workspace-derived approval mode for an unattended ACP child spawned by
 * the daemon (scheduled-task mint, keepalive bind, HTTP manual run).
 *
 * Reads the merged workspace settings the same way status/settings readers
 * do. Does not invent a separate default: ACP children boot DEFAULT when
 * `tools.approvalMode` is unset; this then applies the unattended policy
 * (honor pins / restricted DEFAULT / elevate implicit DEFAULT → AUTO).
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
    settingsApprovalMode = undefined;
  }

  const restricted = isSafeModeEnv() || isBareMode();
  let effectiveMode = ApprovalMode.DEFAULT;
  if (!restricted && settingsApprovalMode) {
    const parsed = parsePinnedApprovalMode(settingsApprovalMode);
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

function parsePinnedApprovalMode(value: string): ApprovalMode | undefined {
  const normalized = value.trim().toLowerCase();
  const canonical =
    normalized === 'auto_edit' || normalized === 'autoedit'
      ? ApprovalMode.AUTO_EDIT
      : normalized;
  return (APPROVAL_MODES as readonly string[]).includes(canonical)
    ? (canonical as ApprovalMode)
    : undefined;
}
