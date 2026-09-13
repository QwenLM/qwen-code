/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createDebugLogger,
  isDebugLogFileEnabled,
} from '../utils/debugLogger.js';
import { sessionIdContext } from '../utils/sessionIdContext.js';

const debugLogger = createDebugLogger('HOOK_TIMEOUT');

/** Default timeout for a command hook, in seconds. */
export const DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS = 60;

/**
 * Command hook timeouts used to be read as milliseconds. A configured value at
 * or above this threshold is still read that way so existing settings keep
 * their meaning: sub-second millisecond values were never usable for a
 * spawned process, and second values this large are rare.
 */
export const LEGACY_MILLISECOND_TIMEOUT_THRESHOLD = 1000;

const warnedHookTimeouts = new Set<string>();

/** True when a command hook `timeout` is still read as legacy milliseconds. */
export function isLegacyMillisecondHookTimeout(timeout: number): boolean {
  return (
    Number.isFinite(timeout) && timeout >= LEGACY_MILLISECOND_TIMEOUT_THRESHOLD
  );
}

/** Describes a legacy millisecond timeout and how to rewrite it in seconds. */
export function formatLegacyHookTimeoutWarning(
  timeout: number,
  hookLabel: string,
): string {
  const seconds = timeout / 1000;
  const advice =
    seconds >= LEGACY_MILLISECOND_TIMEOUT_THRESHOLD
      ? `A timeout this long cannot be written in seconds while the old form is supported, so leave it as ${timeout}.`
      : `Set it to ${seconds} to keep this timeout. If you meant ${timeout} seconds, set it to ${timeout * 1000}.`;
  return (
    `Hook "${hookLabel}" sets timeout ${timeout}, which is read as ${timeout}ms: ` +
    `hook timeouts are in seconds, and values of ${LEGACY_MILLISECOND_TIMEOUT_THRESHOLD} or more keep their old millisecond meaning. ` +
    advice
  );
}

function describeConfiguredTimeout(timeout: unknown): string {
  if (typeof timeout === 'number') {
    return String(timeout);
  }
  try {
    return JSON.stringify(timeout) ?? String(timeout);
  } catch {
    return String(timeout);
  }
}

/** Describes a configured timeout that cannot be used, and the default used instead. */
export function formatUnusableHookTimeoutWarning(
  timeout: unknown,
  hookLabel: string,
): string {
  return (
    `Hook "${hookLabel}" sets timeout ${describeConfiguredTimeout(timeout)}, which is not a positive number of seconds, ` +
    `so the default of ${DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS} seconds is used instead.`
  );
}

/**
 * Writes a timeout warning once per session, hook and configured value. The
 * key is recorded only when the warning can actually be written, so a hook
 * first resolved while debug logging is off is still named once it is on.
 */
function warnOnce(key: string, message: () => string): void {
  const sessionKey = `${sessionIdContext.getStore() ?? ''}\0${key}`;
  if (warnedHookTimeouts.has(sessionKey)) {
    return;
  }
  if (!isDebugLogFileEnabled() || !debugLogger.isEnabled()) {
    return;
  }
  warnedHookTimeouts.add(sessionKey);
  debugLogger.warn(message());
}

/**
 * Forgets which timeouts were already warned about. Only for tests; the
 * runtime relies on the one-warning-per-hook deduplication.
 */
export function resetLegacyTimeoutWarnings(): void {
  warnedHookTimeouts.clear();
}

/**
 * Resolves a command hook's configured `timeout`, in seconds, to milliseconds.
 * A missing value uses the default; an unusable one also uses the default and
 * is named in the debug log.
 */
export function resolveCommandHookTimeoutMs(
  timeout: unknown,
  hookLabel: string,
): number {
  if (timeout === undefined) {
    return DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS * 1000;
  }
  // Settings files are not type-checked, so a numeric string such as
  // "60000" can arrive here. The timer used to coerce it, so keep honouring
  // it rather than silently replacing it with the default.
  const value =
    typeof timeout === 'string' && timeout.trim() !== ''
      ? Number(timeout)
      : timeout;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    warnOnce(
      `unusable\0${hookLabel}\0${describeConfiguredTimeout(timeout)}`,
      () => formatUnusableHookTimeoutWarning(timeout, hookLabel),
    );
    return DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS * 1000;
  }
  if (isLegacyMillisecondHookTimeout(value)) {
    warnOnce(`legacy\0${hookLabel}\0${value}`, () =>
      formatLegacyHookTimeoutWarning(value, hookLabel),
    );
    return value;
  }
  return value * 1000;
}
