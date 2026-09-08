/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  createDebugLogger,
  type Config,
  type SessionRestoreProjection,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('SESSION_APPROVAL_MODE');

/**
 * True when a session's config derives from a restricted mode: safe/bare
 * sessions ignore `tools.approvalMode` at boot (loadCliConfig pins them to
 * DEFAULT), so they must never take on a requested or recorded mode.
 */
export function isRestrictedApprovalModeConfig(config: Config): boolean {
  return config.isSafeMode?.() === true || config.getBareMode?.() === true;
}

/**
 * The raw workspace `tools.approvalMode` value as string | null provenance:
 * the string when the key holds one, null when it is absent (or holds a
 * non-string, which boot rejects before this is ever consulted).
 */
export function rawSettingsApprovalMode(merged: {
  tools?: { approvalMode?: unknown };
}): string | null {
  const raw = merged.tools?.approvalMode;
  return typeof raw === 'string' ? raw : null;
}

/**
 * Applies a restored session approval mode to the config.
 *
 * Returns true when a valid transcript record was held back because the
 * workspace `tools.approvalMode` value changed since the record was written
 * (added, edited, or deleted while the session's child was reaped): the
 * settings-derived boot mode then outranks the record, and the caller should
 * persist that boot mode so the divergence is repaired durably.
 */
export function applyRestoredSessionApprovalMode(
  config: Config,
  projection: SessionRestoreProjection | undefined,
  options?: { settingsApprovalMode?: string | null },
): boolean {
  const restored = projection?.runtime.recording.sessionApprovalMode;
  if (!restored) return false;

  if (isRestrictedApprovalModeConfig(config)) {
    debugLogger.warn(
      'Ignoring restored approval mode because this session is restricted.',
    );
    return false;
  }

  if (restored.kind === 'invalid') {
    config.restoreApprovalModeState({ mode: ApprovalMode.DEFAULT });
    debugLogger.warn(
      'Ignoring invalid session approval mode record; using default mode.',
    );
    return false;
  }

  // The record outranks the workspace setting only while the setting still
  // holds the raw value observed when the record was written. Records that
  // predate provenance carry no settingsApprovalMode and win as before.
  if (
    restored.payload.settingsApprovalMode !== undefined &&
    restored.payload.settingsApprovalMode !==
      (options?.settingsApprovalMode ?? null)
  ) {
    debugLogger.warn(
      'Ignoring restored approval mode because the workspace approvalMode setting changed since it was recorded.',
    );
    return true;
  }

  try {
    config.restoreApprovalModeState(restored.payload);
  } catch (error) {
    config.restoreApprovalModeState({ mode: ApprovalMode.DEFAULT });
    debugLogger.warn(
      `Restored approval mode was rejected by current policy; using default mode: ${error}`,
    );
  }
  return false;
}
