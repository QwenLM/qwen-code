/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolution of `general.dialogExpiry`.
 *
 * Read from trusted scopes only, which is a deliberate asymmetry with its
 * neighbour `security.crossSessionInbound`. That setting has a severity order,
 * so a repository may move it in exactly one direction and no further. A timeout
 * has no such order: a checked-in `60s` races the user's attention and a
 * checked-in `never` parks a hostile message indefinitely so it is still there
 * to be approved absent-mindedly. With no safe direction to permit, the
 * repository scopes are simply not read.
 */

import { ENV_USER_DIALOG_TIMEOUT_MS } from '@qwen-code/core';
import type { LoadedSettings, SettingsFile } from './settings.js';
import type { DialogExpirySetting } from './settingsSchema.js';

/** No deadline. Guard with `timeout > 0`, not with a truthiness check. */
export const NO_TIMEOUT = 0;

/** Applied when nothing is configured. */
export const DEFAULT_DIALOG_TIMEOUT_MS = 300_000;

const EXPIRY_MS: Record<Exclude<DialogExpirySetting, 'never'>, number> = {
  '60s': 60_000,
  '5m': 300_000,
  '10m': 600_000,
};

const VALID_VALUES: readonly string[] = ['60s', '5m', '10m', 'never'];

function readScope(file: SettingsFile | undefined): DialogExpirySetting | undefined {
  const value = file?.settings?.general?.dialogExpiry;
  return typeof value === 'string' && VALID_VALUES.includes(value)
    ? (value)
    : undefined;
}

function readEnvOverride(): number | undefined {
  const raw = process.env[ENV_USER_DIALOG_TIMEOUT_MS];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The configured dialog timeout in milliseconds, or {@link NO_TIMEOUT}.
 *
 * Trusted scopes only, first hit wins; the env override beats both.
 */
export function resolveDialogTimeoutMs(settings: LoadedSettings): number {
  const override = readEnvOverride();
  if (override !== undefined) return override;

  const configured = readScope(settings.flag) ?? readScope(settings.user);
  if (configured === undefined) return DEFAULT_DIALOG_TIMEOUT_MS;
  return configured === 'never' ? NO_TIMEOUT : EXPIRY_MS[configured];
}

/**
 * The timeout for a held cross-session message's approval prompt.
 *
 * Identical to {@link resolveDialogTimeoutMs} except that `never` is clamped
 * back to the default. One approval is outstanding at a time, so an unbounded
 * request would occupy the only prompting slot for the rest of the session and
 * every later hold would degrade to a line of text nobody is watching — the gate
 * still working, the queue still filling, and nothing ever asking again.
 *
 * The clamp is defensible on what the setting means rather than on expedience:
 * `never` says "do not cancel *my* dialog out from under me", which is a
 * statement about prompts the user initiated. A peer's approval request is
 * another process asking for this session's attention, and declining to answer
 * it is a complete answer.
 */
export function resolvePeerApprovalTimeoutMs(settings: LoadedSettings): number {
  const resolved = resolveDialogTimeoutMs(settings);
  return resolved === NO_TIMEOUT ? DEFAULT_DIALOG_TIMEOUT_MS : resolved;
}
