/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run-level budget enforcement for headless / non-interactive Qwen Code
 * sessions. See issue QwenLM/qwen-code#4103.
 *
 * Two budgets are enforced today:
 *  - `--max-wall-time` / `model.maxWallTimeSeconds` — clock-time guardrail
 *    for long-running unattended runs.
 *  - `--max-tool-calls` / `model.maxToolCalls` — bounds the cumulative
 *    number of tool executions (success or failure).
 *
 * `tickToolCall()` is invoked **before** each `executeToolCall` so that a
 * budget of N caps the run at exactly N executions — the (N+1)th tick
 * aborts before the work is performed. The wall-clock timer is started via
 * `start()` and torn down by `stop()`. When any limit is exceeded the
 * enforcer aborts the run via the shared `AbortController` and records the
 * reason so the caller can emit a structured error envelope.
 */

export type BudgetKind = 'wall-time' | 'tool-calls';

export interface BudgetExceeded {
  kind: BudgetKind;
  limit: number;
  /** Observed value at the moment the budget was exceeded. */
  observed: number;
  /** Human-readable message suitable for stderr / structured error output. */
  message: string;
}

export interface RunBudgetOptions {
  /**
   * Wall-clock budget in seconds. Non-positive (`-1`, `0`, undefined)
   * disables the budget; the CLI parser rejects `0` at the input layer so
   * this enforcer never sees a legitimate "zero seconds" value.
   */
  maxWallTimeSeconds?: number;
  /**
   * Max cumulative tool calls. `-1` / `undefined` disables; `0` is a valid
   * budget meaning "no tool calls allowed" (the first tick aborts).
   */
  maxToolCalls?: number;
}

const SECOND = 1000;
/**
 * Node clamps `setTimeout` delays >= 2^31 to 1 ms, which would fire the
 * timer almost immediately. Reject upstream so a user typing `--max-wall-time
 * 100d` gets a clear error instead of a confusing instant abort.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_WALL_TIME_SECONDS = Math.floor(MAX_TIMEOUT_MS / SECOND);
/**
 * Wall-clock budgets below 1s are almost always a typo (someone meant `1m`
 * or `1h`); accepting them silently produces a run that aborts on the next
 * event-loop tick before any model request returns. Round-trip latency to
 * any reasonable LLM is multiple seconds, so a sub-second budget is also
 * not a meaningful guardrail. Reject loudly.
 */
const MIN_WALL_TIME_SECONDS = 1;

/**
 * Parses a duration string used by `--max-wall-time`.
 *
 * Accepted forms (all must resolve to a duration in
 * `[MIN_WALL_TIME_SECONDS, MAX_WALL_TIME_SECONDS]`):
 *   - plain number (interpreted as seconds): `"90"` → 90
 *   - suffixed: `"30s"`, `"5m"`, `"1h"`, `"1.5h"`, `"3600s"`
 *   - `ms` suffix is syntactically accepted but rejected at the floor
 *     unless the value resolves to `>= 1s` (e.g. `"1000ms"` is legal,
 *     `"500ms"` is not)
 *   - case-insensitive suffix; whitespace tolerated
 *
 * Returns the duration in **seconds** for parity with `maxWallTimeSeconds`
 * in settings.json.
 *
 * Throws on garbage input, on negative values (regex-rejected — no sign
 * allowed), on zero, on sub-second values below `MIN_WALL_TIME_SECONDS`,
 * and on values above `MAX_WALL_TIME_SECONDS`. A typo in a CI budget flag
 * should fail loud at startup, not silently disable (or instant-fire) the
 * guardrail.
 */
export function parseDurationSeconds(input: string): number {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new Error('Invalid duration: empty string');
  }
  // The regex disallows a leading sign, so negatives short-circuit on
  // structural mismatch — no explicit `< 0` check needed.
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
  if (seconds <= 0) {
    throw new Error(
      `Invalid duration "${input}": must be greater than zero. Omit the flag entirely if you don't want a wall-clock budget.`,
    );
  }
  if (seconds < MIN_WALL_TIME_SECONDS) {
    // Only suggest a "did you mean" rewrite when the user actually
    // used the `ms` suffix — for bare sub-second inputs like `0.5` or
    // `0.5s`, the rewrite would be a no-op ("did you mean 0.5s?") and
    // just confuses the error.
    const hint = /ms\b/i.test(trimmed)
      ? ` (probably a typo — did you mean ${input.replace(/ms\b/i, 's')}?)`
      : '';
    throw new Error(
      `Invalid duration "${input}": below the ${MIN_WALL_TIME_SECONDS}s minimum${hint}. Sub-second wall-clock budgets fire before any model round-trip can complete.`,
    );
  }
  if (seconds > MAX_WALL_TIME_SECONDS) {
    throw new Error(
      `Invalid duration "${input}": exceeds the maximum supported wall-clock budget (${MAX_WALL_TIME_SECONDS}s ≈ 24 days). Use a smaller value.`,
    );
  }
  return seconds;
}

/**
 * Validates a `maxWallTimeSeconds` value sourced from settings.json
 * (as opposed to the CLI flag, which goes through `parseDurationSeconds`).
 *
 * The settings entry is a plain number, so the CLI's parser doesn't run.
 * Mirror the same rejection rules here so `maxWallTimeSeconds: 0` in
 * settings.json doesn't silently disable the budget (the enforcer treats
 * `<= 0` as "no timer") while the equivalent `--max-wall-time 0` flag is
 * fatal. Asymmetry would be a foot-gun.
 *
 * Returns the validated value, or `-1` for the "unlimited" sentinel.
 */
export function validateMaxWallTimeSetting(value: number): number {
  if (value === -1) return -1;
  if (!Number.isFinite(value)) {
    throw new Error(
      `model.maxWallTimeSeconds must be a finite number; got ${value}.`,
    );
  }
  if (value <= 0) {
    throw new Error(
      `model.maxWallTimeSeconds must be > 0 (or -1 for unlimited); got ${value}. ` +
        `Use -1 to disable, not 0.`,
    );
  }
  if (value < MIN_WALL_TIME_SECONDS) {
    throw new Error(
      `model.maxWallTimeSeconds ${value} is below the ${MIN_WALL_TIME_SECONDS}s minimum. Sub-second budgets fire before any model round-trip can complete.`,
    );
  }
  if (value > MAX_WALL_TIME_SECONDS) {
    throw new Error(
      `model.maxWallTimeSeconds ${value} exceeds the maximum supported wall-clock budget (${MAX_WALL_TIME_SECONDS}s ≈ 24 days).`,
    );
  }
  return value;
}

/**
 * Upper bound for `maxToolCalls`. Above this, a value is almost certainly
 * a typo (`1e10` meant `1e1`, or a misplaced zero): no realistic run
 * executes a billion tool calls, and `tickToolCall`'s `>` gate would
 * functionally never trip. Same fail-loud philosophy as `MAX_WALL_TIME_SECONDS`.
 */
const MAX_TOOL_CALLS = 1_000_000;

/**
 * Validates a `maxToolCalls` value sourced from either the `--max-tool-calls`
 * CLI flag or `model.maxToolCalls` in settings.json. Mirrors
 * `validateMaxWallTimeSetting`: the enforcer treats anything `< 0` as "no
 * limit", so any non-`-1` negative would silently disable the budget. Reject
 * up front to keep the fail-loud philosophy symmetric across all budgets.
 *
 * `0` IS legal here — it means "no tool calls allowed; first tick aborts"
 * (asymmetric with wall-time where 0 is fatal). Documented in the schema.
 */
export function validateMaxToolCalls(value: number): number {
  if (value === -1) return -1;
  if (!Number.isFinite(value)) {
    throw new Error(`maxToolCalls must be a finite number; got ${value}.`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(
      `maxToolCalls must be an integer (or -1 for unlimited); got ${value}.`,
    );
  }
  if (value < 0) {
    throw new Error(
      `maxToolCalls must be >= 0 (or -1 for unlimited); got ${value}. Use -1 to disable, not a negative number.`,
    );
  }
  if (value > MAX_TOOL_CALLS) {
    throw new Error(
      `maxToolCalls ${value} exceeds the supported ceiling (${MAX_TOOL_CALLS}). Likely a typo — use a smaller value or -1 for unlimited.`,
    );
  }
  return value;
}

export class RunBudgetEnforcer {
  private readonly maxWallTimeSeconds: number;
  private readonly maxToolCalls: number;
  private readonly abortController: AbortController;
  private wallTimer: ReturnType<typeof setTimeout> | null = null;
  private toolCallCount = 0;
  private exceeded: BudgetExceeded | null = null;

  constructor(opts: RunBudgetOptions, abortController: AbortController) {
    this.maxWallTimeSeconds = opts.maxWallTimeSeconds ?? -1;
    this.maxToolCalls = opts.maxToolCalls ?? -1;
    this.abortController = abortController;
  }

  /**
   * Starts the wall-clock timer (if configured). Idempotent so callers
   * don't need to thread "did I already start?" state.
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
    (this.wallTimer as NodeJS.Timeout).unref?.();
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
    // claim it as a budget event — otherwise the caller would emit exit
    // code 55 ("budget exceeded") when the real cause was user
    // cancellation (130).
    if (this.abortController.signal.aborted) return;
    this.exceeded = record;
    this.stop();
    this.abortController.abort();
  }
}
