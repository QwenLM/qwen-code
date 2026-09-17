/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  APPROVAL_MODES,
} from '@qwen-code/qwen-code-core/config/approval-mode.js';

export type ResolveUnattendedAcpChildApprovalModeOptions = {
  /**
   * True when the live mode was chosen by the operator (CLI `--approval-mode` /
   * `--yolo`, or a runtime `session/set_mode` / ext write that bumped
   * `approvalModeRevision`), as opposed to the implicit ACP ask-permissions
   * birth default. Only the implicit birth default is elevated to AUTO.
   */
  explicitlyChosen?: boolean;
};

/**
 * Approval mode for an unattended ACP child (scheduled-task fire, keepalive
 * mint, daemon HTTP run, model-facing `create_sub_session`) that has nobody
 * attached to answer `session/request_permission`.
 *
 * Restricted (safe/bare) sessions stay on DEFAULT. An explicit
 * `tools.approvalMode` pin is honored **by its own value** (not the live
 * session mode — a controller `set_mode` must not override an on-disk pin).
 * Only the implicit ACP ask-permissions boot default — DEFAULT with no
 * settings pin and no explicit operator choice — is elevated to AUTO so the
 * child does not park forever on its first write.
 */
export function resolveUnattendedAcpChildApprovalMode(
  effectiveMode: ApprovalMode,
  settingsApprovalMode: string | undefined,
  restricted: boolean,
  options?: ResolveUnattendedAcpChildApprovalModeOptions,
): ApprovalMode {
  if (restricted) return ApprovalMode.DEFAULT;

  if (typeof settingsApprovalMode === 'string' && settingsApprovalMode.trim()) {
    // Honor the pin's value, not the live session mode (R2-2).
    const pinned = tryParseApprovalModePin(settingsApprovalMode);
    // Present but unparseable: fail closed to DEFAULT (do not elevate).
    return pinned ?? ApprovalMode.DEFAULT;
  }

  if (effectiveMode === ApprovalMode.DEFAULT) {
    // Explicit argv / set_mode DEFAULT must not be escalated (R3-4).
    if (options?.explicitlyChosen) return ApprovalMode.DEFAULT;
    return ApprovalMode.AUTO;
  }
  return effectiveMode;
}

/**
 * Lenient twin of `parseApprovalModeValue` — same spellings, returns
 * undefined instead of throwing so unattended dispatch can fail closed.
 */
export function tryParseApprovalModePin(
  value: string,
): ApprovalMode | undefined {
  const normalized = value.trim().toLowerCase();
  const canonical =
    normalized === 'auto_edit' || normalized === 'autoedit'
      ? ApprovalMode.AUTO_EDIT
      : normalized;
  return (APPROVAL_MODES as readonly string[]).includes(canonical)
    ? (canonical as ApprovalMode)
    : undefined;
}

/**
 * True when the process argv carries an explicit approval-mode choice
 * (`--approval-mode` / `--yolo` / `-y`). Used with
 * `config.getApprovalModeRevision() > 0` to distinguish an operator-chosen
 * DEFAULT from the implicit ACP birth default.
 */
export function hasExplicitApprovalModeCliArg(
  argv: readonly string[] = process.argv,
): boolean {
  for (const arg of argv) {
    if (arg === '--approval-mode' || arg.startsWith('--approval-mode=')) {
      return true;
    }
    if (arg === '--yolo' || arg === '-y') {
      return true;
    }
  }
  return false;
}
