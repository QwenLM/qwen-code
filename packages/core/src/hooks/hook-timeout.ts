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
import { HookType } from './types.js';

const debugLogger = createDebugLogger('HOOK_TIMEOUT');

/** Default timeout for a command hook, in seconds. */
export const DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS = 60;

/** Default timeout for an HTTP hook, in seconds. */
export const DEFAULT_HTTP_HOOK_TIMEOUT_SECONDS = 600;

/** Default timeout for a prompt hook, in seconds. */
export const DEFAULT_PROMPT_HOOK_TIMEOUT_SECONDS = 30;

/**
 * Default timeout for a function hook, in MILLISECONDS: SDK-registered
 * function hooks keep milliseconds, unlike the other hook types.
 */
export const DEFAULT_FUNCTION_HOOK_TIMEOUT_MS = 5000;

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
 * How a hook's timer delay was decided.
 * - `configured`: the configured value, converted to milliseconds.
 * - `legacy-milliseconds`: a command hook value read in the old millisecond
 *   form (see {@link LEGACY_MILLISECOND_TIMEOUT_THRESHOLD}).
 * - `default`: the hook type's default.
 * - `unusable`: the configured value was used, but the runtime cannot honour
 *   it as written: the timer fires after 1 ms, or no timer is installed.
 */
export type HookTimeoutSource =
  | 'configured'
  | 'legacy-milliseconds'
  | 'default'
  | 'unusable';

export interface HookTimeoutDescription {
  /**
   * The delay, in milliseconds, of the timer the runner installs, or `null`
   * when it installs none and the hook can run unbounded.
   */
  timeoutMs: number | null;
  source: HookTimeoutSource;
  /** A value was configured, and the hook type's default replaced it. */
  ignoredConfiguredValue: boolean;
}

/**
 * Node runs a timer whose delay is not between 1 ms and 2^31 - 1 ms (zero,
 * negative, NaN, below one, or too large for a 32-bit signed integer) after
 * 1 ms instead.
 */
const MIN_TIMER_DELAY_MS = 1;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

function describeTimerDelay(
  delayMs: number,
  source: 'configured' | 'legacy-milliseconds' = 'configured',
): HookTimeoutDescription {
  return delayMs >= MIN_TIMER_DELAY_MS && delayMs <= MAX_TIMER_DELAY_MS
    ? { timeoutMs: delayMs, source, ignoredConfiguredValue: false }
    : {
        timeoutMs: MIN_TIMER_DELAY_MS,
        source: 'unusable',
        ignoredConfiguredValue: false,
      };
}

function defaultTimeout(
  timeoutMs: number,
  timeout: unknown,
): HookTimeoutDescription {
  return {
    timeoutMs,
    source: 'default',
    ignoredConfiguredValue: timeout !== undefined,
  };
}

/**
 * The command runner's reading of `timeout`, before Node's timer adjusts it.
 * Shared by {@link resolveCommandHookTimeoutMs} and
 * {@link describeHookTimeout} so the two cannot drift.
 */
function readCommandHookTimeout(timeout: unknown): {
  timeoutMs: number;
  source: Exclude<HookTimeoutSource, 'unusable'>;
  ignoredConfiguredValue: boolean;
} {
  if (timeout === undefined) {
    return {
      timeoutMs: DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS * 1000,
      source: 'default',
      ignoredConfiguredValue: false,
    };
  }
  // Settings files are not type-checked, so a numeric string such as
  // "60000" can arrive here. The timer used to coerce it, so keep honouring
  // it rather than silently replacing it with the default.
  const value =
    typeof timeout === 'string' && timeout.trim() !== ''
      ? Number(timeout)
      : timeout;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return {
      timeoutMs: DEFAULT_COMMAND_HOOK_TIMEOUT_SECONDS * 1000,
      source: 'default',
      ignoredConfiguredValue: true,
    };
  }
  if (isLegacyMillisecondHookTimeout(value)) {
    return {
      timeoutMs: value,
      source: 'legacy-milliseconds',
      ignoredConfiguredValue: false,
    };
  }
  return {
    timeoutMs: value * 1000,
    source: 'configured',
    ignoredConfiguredValue: false,
  };
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
  const resolved = readCommandHookTimeout(timeout);
  if (resolved.ignoredConfiguredValue) {
    warnOnce(
      `unusable\0${hookLabel}\0${describeConfiguredTimeout(timeout)}`,
      () => formatUnusableHookTimeoutWarning(timeout, hookLabel),
    );
  } else if (resolved.source === 'legacy-milliseconds') {
    warnOnce(`legacy\0${hookLabel}\0${resolved.timeoutMs}`, () =>
      formatLegacyHookTimeoutWarning(resolved.timeoutMs, hookLabel),
    );
  }
  return resolved.timeoutMs;
}

/**
 * What a hook runner really does with a configured `timeout`, for display.
 * Pure: no logging, no warnings, no clock. It mirrors each runner:
 * - command: {@link resolveCommandHookTimeoutMs}, then a timer. Command hooks
 *   on MessageDisplay, StopFailure and SessionDelete run detached and install
 *   no timer, and async command hooks are checked by polling, where a delay
 *   above the timer limit is honoured; this still describes the timer.
 * - http: a falsy value uses the default; otherwise `timeout * 1000` goes to
 *   `combineAbortSignals`, which installs no timer unless it is above zero.
 * - prompt: `(timeout ?? default) * 1000` goes straight to `setTimeout`.
 * - function: `timeout ?? default`, in milliseconds, goes straight to
 *   `setTimeout`.
 */
export function describeHookTimeout(
  hookType: HookType,
  timeout: unknown,
): HookTimeoutDescription {
  switch (hookType) {
    case HookType.Command: {
      const resolved = readCommandHookTimeout(timeout);
      return resolved.source === 'default'
        ? resolved
        : describeTimerDelay(resolved.timeoutMs, resolved.source);
    }
    case HookType.Http: {
      if (!timeout) {
        return defaultTimeout(
          DEFAULT_HTTP_HOOK_TIMEOUT_SECONDS * 1000,
          timeout,
        );
      }
      const delayMs = Number(timeout) * 1000;
      if (!(delayMs > 0)) {
        return {
          timeoutMs: null,
          source: 'unusable',
          ignoredConfiguredValue: false,
        };
      }
      return describeTimerDelay(delayMs);
    }
    case HookType.Prompt:
      return timeout === undefined || timeout === null
        ? defaultTimeout(DEFAULT_PROMPT_HOOK_TIMEOUT_SECONDS * 1000, timeout)
        : describeTimerDelay(Number(timeout) * 1000);
    case HookType.Function:
      return timeout === undefined || timeout === null
        ? defaultTimeout(DEFAULT_FUNCTION_HOOK_TIMEOUT_MS, timeout)
        : describeTimerDelay(Number(timeout));
    default: {
      const exhaustive: never = hookType;
      return exhaustive;
    }
  }
}
