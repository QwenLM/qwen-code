/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run-level budget enforcement for headless / non-interactive Qwen Code
 * sessions. See issue QwenLM/qwen-code#4103.
 *
 * The enforcer is wired into the non-interactive run loop: the loop ticks
 * the API counter immediately before each `sendMessageStream` call and the
 * tool counter immediately after each `executeToolCall`. A wall-clock timer
 * is started in the constructor and torn down by `stop()` on exit. When any
 * limit is exceeded the enforcer aborts the run via the shared
 * `AbortController` and records the reason so the caller can emit a
 * structured error.
 *
 * Counters are post-increment: the very first call is always allowed; the
 * (N+1)th call after a budget of N is denied. This mirrors how
 * `maxSessionTurns` behaves so users can reason about budgets uniformly.
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
  /** Wall-clock budget in seconds. `-1` or `undefined` disables. */
  maxWallTimeSeconds?: number;
  /** Max cumulative tool calls. `-1` or `undefined` disables. */
  maxToolCalls?: number;
  /** Max cumulative model-stream-request calls. `-1` or `undefined` disables. */
  maxApiCalls?: number;
}

const SECOND = 1000;

/**
 * Parses a duration string used by `--max-wall-time`.
 *
 * Accepted forms:
 *   - plain number (interpreted as seconds): `"90"` → 90
 *   - suffixed: `"30s"`, `"5m"`, `"1h"`, `"500ms"`
 *   - case-insensitive suffix; whitespace tolerated
 *
 * Returns the duration in **seconds** for parity with `maxWallTimeSeconds`
 * in settings.json. Sub-second precision is preserved (e.g. `"500ms"` →
 * `0.5`).
 *
 * Throws on garbage input rather than silently defaulting — a typo in a
 * CI budget flag should fail loud at startup, not silently disable the
 * guardrail.
 */
export function parseDurationSeconds(input: string): number {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new Error('Invalid duration: empty string');
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Use a number of seconds (e.g. 90) or a duration with unit (e.g. 30s, 5m, 1h, 500ms).`,
    );
  }
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid duration "${input}": must be a non-negative number.`,
    );
  }
  const unit = match[2] ?? 's';
  switch (unit) {
    case 'ms':
      return value / 1000;
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 3600;
    default:
      // Unreachable given the regex, but keeps the type-checker honest.
      throw new Error(`Invalid duration unit "${unit}"`);
  }
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
   * True if any budget is configured. Lets the caller skip
   * instantiation entirely when nothing is constrained.
   */
  hasAnyLimit(): boolean {
    return (
      this.maxWallTimeSeconds > 0 ||
      this.maxToolCalls >= 0 ||
      this.maxApiCalls >= 0
    );
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
    this.exceeded = record;
    this.stop();
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }
  }
}
