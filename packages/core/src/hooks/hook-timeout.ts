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
 * Command hook timeouts used to be read as milliseconds. A configured value at
 * or above this threshold is still read that way so existing settings keep
 * their meaning: sub-second millisecond values were never usable for a
 * spawned process, and second values this large are rare.
 */
export const LEGACY_MILLISECOND_TIMEOUT_THRESHOLD = 1000;

const warnedLegacyTimeouts = new Set<string>();

/**
 * Resolves a command hook's configured `timeout`, in seconds, to milliseconds.
 * Missing or unusable values fall back to
 * {@link DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS}.
 */
export function resolveCommandHookTimeoutMs(
  timeout: number | undefined,
  hookLabel: string,
): number {
  if (
    typeof timeout !== 'number' ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  ) {
    return DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS * 1000;
  }
  if (timeout >= LEGACY_MILLISECOND_TIMEOUT_THRESHOLD) {
    const key = `${hookLabel}\0${timeout}`;
    if (!warnedLegacyTimeouts.has(key)) {
      warnedLegacyTimeouts.add(key);
      debugLogger.warn(
        `Hook "${hookLabel}" sets timeout ${timeout}, which looks like milliseconds. ` +
          `Hook timeouts are in seconds; reading it as ${timeout}ms. ` +
          `Set it to ${timeout / 1000} to keep this timeout and silence this warning.`,
      );
    }
    return timeout;
  }
  return timeout * 1000;
}
