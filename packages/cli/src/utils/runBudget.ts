/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run-level budget enforcement for headless / non-interactive Qwen Code
 * sessions. See issue QwenLM/qwen-code#4103.
 *
 * The enforcer is wired into the non-interactive run loop: both `tickApiCall`
 * and `tickToolCall` are called *before* the corresponding `sendMessageStream`
 * / `executeToolCall` so that a budget of N caps the run at exactly N
 * executions — the (N+1)th tick aborts before the work is performed. A
 * wall-clock timer is started via `start()` and torn down by `stop()` on
 * exit. When any limit is exceeded the enforcer aborts the run via the
 * shared `AbortController` and records the reason so the caller can emit a
 * structured error.
 *
 * Counters post-increment internally so the first call is always allowed
 * and the (N+1)th is denied. This mirrors how `maxSessionTurns` behaves so
 * users can reason about budgets uniformly.
 */

export type BudgetKind = 'wall-time' | 'tool-calls' | 'api-calls';

export interface BudgetExceeded {
  kind: BudgetKind;
  limit: number;
  /** Observed value at the moment the budget was exceeded. */
  observed: number;
  /** Human-readable message suitable for stderr / structured error output. */
  message: string;
}

export interface RunBudgetOptions {
  /** Wall-clock budget in seconds. Non-positive (`-1`, `0`, undefined) disables. */
  maxWallTimeSeconds?: number;
  /**
   * Max cumulative tool calls. `-1` / `undefined` disables; `0` is a valid
   * budget meaning "no tool calls allowed" (the first tick aborts).
   */
  maxToolCalls?: number;
  /**
   * Max cumulative model-stream-request calls. `-1` / `undefined` disables;
   * `0` is a valid budget meaning "no API calls allowed" (the first tick
   * aborts before any stream is opened).
   */
  maxApiCalls?: number;
}

const SECOND = 1000;

/**
 * Parses a duration string used by `--max-wall-time`.
 *
 * Accepted forms (all must resolve to a positive duration):
 *   - plain number (interpreted as seconds): `"90"` → 90
 *   - suffixed: `"30s"`, `"5m"`, `"1h"`, `"500ms"`
 *   - case-insensitive suffix; whitespace tolerated
 *
 * Returns the duration in **seconds** for parity with `maxWallTimeSeconds`
 * in settings.json. Sub-second precision is preserved (e.g. `"500ms"` →
 * `0.5`).
 *
 * Throws on garbage input, on negative values (regex-rejected — no sign
 * allowed), and on zero — rather than silently defaulting. A typo in a CI
 * budget flag should fail loud at startup, not silently disable the
 * guardrail. To run without a wall-clock budget, omit the flag.
 */
export function parseDurationSeconds(input: string): number {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new Error('Invalid duration: empty string');
  }
  // Regex disallows a leading sign, so negatives short-circuit on
  // structural mismatch below — no explicit `< 0` check needed.
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Use a positive number of seconds (e.g. 90) or a duration with unit (e.g. 30s, 5m, 1h, 500ms).`,
    );
  }
  const value = Number.parseFloat(match[1]);
  const unit = match[2] ?? 's';
  let seconds: number;
  switch (unit) {
    case 'ms':
      seconds = value / 1000;
      break;
    case 's':
      seconds = value;
      break;
    case 'm':
      seconds = value * 60;
      break;
    case 'h':
      seconds = value * 3600;
      break;
    default:
      // Unreachable given the regex, but keeps the type-checker honest.
      throw new Error(`Invalid duration unit "${unit}"`);
  }
  // Zero is rejected as a foot-gun: `--max-wall-time 0` would silently
  // disable the budget (the enforcer treats <=0 as "no timer"), which is
  // the opposite of what a user typing "0" probably means. If they want
  // unlimited, they shouldn't pass the flag at all.
  if (seconds <= 0) {
    throw new Error(
      `Invalid duration "${input}": must be greater than zero. Omit the flag entirely if you don't want a wall-clock budget.`,
    );
  }
  return seconds;
}

export class RunBudgetEnforcer {
  private readonly maxWallTimeSeconds: number;
  private readonly maxToolCalls: number;
  private readonly maxApiCalls: number;
  private readonly abortController: AbortController;
  private wallTimer: ReturnType<typeof setTimeout> | null = null;
  private toolCallCount = 0;
  private apiCallCount = 0;
  private exceeded: BudgetExceeded | null = null;

  constructor(opts: RunBudgetOptions, abortController: AbortController) {
    this.maxWallTimeSeconds = opts.maxWallTimeSeconds ?? -1;
    this.maxToolCalls = opts.maxToolCalls ?? -1;
    this.maxApiCalls = opts.maxApiCalls ?? -1;
    this.abortController = abortController;
  }

  /**
   * Starts the wall-clock timer (if configured). Idempotent — calling
   * start() twice is a no-op so callers don't need to thread "did I
   * already start?" state.
   */
  start(): void {
    if (this.wallTimer !== null) return;
    if (this.maxWallTimeSeconds <= 0) return;
    this.wallTimer = setTimeout(() => {
      this.markExceeded({
        kind: 'wall-time',
        limit: this.maxWallTimeSeconds,
        observed: this.maxWallTimeSeconds,
        message: `Run aborted: wall-clock budget of ${this.maxWallTimeSeconds}s exceeded (--max-wall-time).`,
      });
    }, this.maxWallTimeSeconds * SECOND);
    // Don't keep the event loop alive solely for the timeout — once the
    // main loop exits naturally we want the process to exit too.
    if (typeof this.wallTimer === 'object' && this.wallTimer !== null) {
      (this.wallTimer as NodeJS.Timeout).unref?.();
    }
  }

  /** Records one API stream-request and enforces `maxApiCalls`. */
  tickApiCall(): void {
    this.apiCallCount += 1;
    if (this.maxApiCalls >= 0 && this.apiCallCount > this.maxApiCalls) {
      this.markExceeded({
        kind: 'api-calls',
        limit: this.maxApiCalls,
        observed: this.apiCallCount,
        message: `Run aborted: API-call budget of ${this.maxApiCalls} exceeded (--max-api-calls); observed ${this.apiCallCount}.`,
      });
    }
  }

  /** Records one tool execution and enforces `maxToolCalls`. */
  tickToolCall(): void {
    this.toolCallCount += 1;
    if (this.maxToolCalls >= 0 && this.toolCallCount > this.maxToolCalls) {
      this.markExceeded({
        kind: 'tool-calls',
        limit: this.maxToolCalls,
        observed: this.toolCallCount,
        message: `Run aborted: tool-call budget of ${this.maxToolCalls} exceeded (--max-tool-calls); observed ${this.toolCallCount}.`,
      });
    }
  }

  /**
   * Returns the budget-exceeded record if one fired, else null. The
   * non-interactive loop checks this after `abortController.signal`
   * fires to distinguish "budget abort" from "user SIGINT" so it can
   * emit a structured-error envelope with the right reason.
   */
  getExceeded(): BudgetExceeded | null {
    return this.exceeded;
  }

  /** Cancels the wall-clock timer. Safe to call multiple times. */
  stop(): void {
    if (this.wallTimer !== null) {
      clearTimeout(this.wallTimer);
      this.wallTimer = null;
    }
  }

  private markExceeded(record: BudgetExceeded): void {
    // First fence wins — once one budget has been recorded, subsequent
    // overruns (e.g. an in-flight tool finishing after wall-time fired)
    // don't clobber the original reason.
    if (this.exceeded !== null) return;
    // If the abort already happened from a different source (SIGINT, an
    // external `options.abortController` shared with a parent), don't
    // claim the abort as a budget event — otherwise routeAbort would
    // emit exit code 55 ("budget exceeded") when the real cause was
    // user cancellation (130).
    if (this.abortController.signal.aborted) return;
    this.exceeded = record;
    this.stop();
    this.abortController.abort();
  }
}
