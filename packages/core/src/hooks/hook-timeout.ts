/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('HOOK_TIMEOUT');

/** Default timeout for a command hook, in seconds. */
export const DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS = 600;

/**
 * Default timeout, in seconds, for command hooks on events whose hooks keep
 * running after Qwen Code exits (MessageDisplay, StopFailure, SessionDelete).
 * Nothing waits for their result, so a long default would only leave a
 * detached process group running.
 */
export const SURVIVING_COMMAND_HOOK_TIMEOUT_SECONDS = 60;

/**
 * Command hook timeouts used to be read as milliseconds. A configured value at
 * or above this threshold is still read that way so existing settings keep
 * their meaning: sub-second millisecond values were never usable for a
 * spawned process, and second values this large are rare.
 */
export const LEGACY_MILLISECOND_TIMEOUT_THRESHOLD = 1000;

const warnedLegacyTimeouts = new Set<string>();

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

/**
 * Forgets which legacy timeouts were already warned about. Only for tests;
 * the runtime relies on the one-warning-per-hook deduplication.
 */
export function resetLegacyTimeoutWarnings(): void {
  warnedLegacyTimeouts.clear();
}

/**
 * Resolves a command hook's configured `timeout`, in seconds, to milliseconds.
 * Missing or unusable values fall back to `defaultSeconds`.
 */
export function resolveCommandHookTimeoutMs(
  timeout: number | undefined,
  hookLabel: string,
  defaultSeconds: number = DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS,
): number {
  if (
    typeof timeout !== 'number' ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  ) {
    return defaultSeconds * 1000;
  }
  if (isLegacyMillisecondHookTimeout(timeout)) {
    const key = `${hookLabel}\0${timeout}`;
    if (!warnedLegacyTimeouts.has(key)) {
      warnedLegacyTimeouts.add(key);
      debugLogger.warn(formatLegacyHookTimeoutWarning(timeout, hookLabel));
    }
    return timeout;
  }
  return timeout * 1000;
}
