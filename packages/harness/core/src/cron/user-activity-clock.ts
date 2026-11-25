/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-level presence clock injected by the host.
 *
 * Turn submission is too coarse for a threshold of minutes. A `/loop` task
 * firing every five minutes means someone reading its output, typing nothing,
 * looks identical to someone who walked away — the submission clock only moves
 * when they send something. The TUI already keeps exactly the clock this needs,
 * updated on every real keypress with automated terminal responses and passive
 * cursor drift excluded.
 *
 * Injected rather than imported because that clock lives in the CLI package and
 * core cannot depend on it. Shared across sessions on purpose: a physical
 * keyboard belongs to the process, not to a conversation.
 * `CronManager.getUserIdleDurationMs` reads it first and falls back to that
 * session's own submission time.
 *
 * Hosts without a keyboard — headless, SDK, remote worker — register nothing and
 * keep the submission clock, which for them is the only interaction there is.
 */
let userActivityClock: (() => number | undefined) | undefined;

export function registerUserActivityClock(
  clock: (() => number | undefined) | undefined,
): void {
  userActivityClock = clock;
}

/**
 * The host's answer, or undefined when no host registered a clock or the clock
 * has nothing to report.
 */
export function readUserActivityClock(): number | undefined {
  return userActivityClock?.();
}

/** Test-only. A test that registers a clock and does not clear it leaks it. */
export function resetUserActivityClockForTest(): void {
  userActivityClock = undefined;
}
