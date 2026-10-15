/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Stall watchdog + retry for workflow agent dispatches. A
 * workflow `agent()` can hang indefinitely if the model loops, the provider
 * stalls mid-stream, or a tool never returns. The subagent's own
 * `max_time_minutes` (10 min, per attempt) is a coarse backstop; the stall
 * watchdog is finer-grained: it aborts a dispatch after `stallMs` (default 3 min) of NO
 * observable progress, and the resilient wrapper retries up to
 * `MAX_STALL_ATTEMPTS` times before abandoning.
 *
 * "Progress" = any of the subagent's reasoning-loop events (round start,
 * streamed text, token usage, tool call/result). Crucially the timer is
 * SUSPENDED while a tool is in flight: a legitimately long-running tool
 * (a 90s shell build, a slow MCP call) must not be flagged as a stall. The
 * timer only counts wall-clock during which the subagent is producing
 * nothing AND has no tool executing. A retry-owned backoff sleep the request
 * announces (`RETRY_WAIT`) likewise holds the timer, but only until its declared
 * delay elapses.
 *
 * Design (low-invasiveness): the resilient wrapper owns the per-attempt
 * `AbortController` and `AgentEventEmitter`. It chains the caller's parent
 * signal into the per-attempt controller (so parent cancellation still
 * propagates) and passes BOTH the per-attempt signal and emitter into the
 * single-attempt dispatch. A stall fires `controller.abort('stalled')`,
 * which makes the subagent return `CANCELLED`; the single-attempt dispatch
 * then throws its "did not complete" terminal, which the wrapper catches.
 * The wrapper distinguishes a stall-abort (retry) from a parent-abort
 * (propagate) via `watchdog.stalled()` + the parent `signal.aborted` flag.
 *
 * Schema-mode rescue happens for free: if a stall fires AFTER the subagent
 * already captured a valid `structured_output`, the single-attempt dispatch
 * returns that payload BEFORE reaching the terminate-mode check, so the
 * wrapper sees a success and never retries.
 */

import {
  AgentEventEmitter,
  AgentEventType,
  type AgentRetryWaitEvent,
} from './agent-events.js';
import {
  WORKFLOW_ABORT_REASON_STALLED,
  WorkflowAgentFailedError,
} from './workflow-agent-failure.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { parsePositiveIntegerEnv } from '../../utils/env.js';

/**
 * Default stall timeout: no progress (with no tool in flight) for this long
 * ends the attempt.
 *
 * Repository-managed backoff sleeps — the `retryWithBackoff` ladder, stream-side
 * rate-limit sleeps (`RATE_LIMIT_RETRY_OPTIONS` in llm-chat.ts —
 * 60s/120s/240s/300s), an unclamped provider `Retry-After`, and unattended-mode
 * persistent backoff (a `Retry-After` there is capped only at 6h) — are
 * announced as retry waits and extend the window themselves (see
 * `attachStallWatchdog`). Retries inside a provider SDK sleep without any
 * announcement, so the window stays sized against the `retryWithBackoff`
 * ladder — 1.5s, 3s, 6s, 12s, 24s then 30s between attempts
 * (`DEFAULT_RETRY_OPTIONS` in utils/retry.ts), 76.5s nominal — as the
 * silent stretch a healthy request may show.
 */
export const DEFAULT_STALL_MS = 180_000;

/** Largest delay `setTimeout` accepts without overflowing to ~immediate. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Total attempts (initial + retries) for a single `agent()` dispatch. */
export const MAX_STALL_ATTEMPTS = 3;

export const MAX_WORKFLOW_STALL_MS_ENV = 'QWEN_CODE_WORKFLOW_STALL_SECONDS';

/**
 * Resolve the per-dispatch stall timeout. Precedence: the per-call
 * `agent({stallMs})` override, then `QWEN_CODE_WORKFLOW_STALL_SECONDS`
 * (whole seconds), then `DEFAULT_STALL_MS`. A non-positive / non-finite
 * override falls back to the default. A value of `0` disables the watchdog
 * (returns `0` — callers treat 0 as "no watchdog").
 */
export function resolveStallMs(
  perCall: number | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  if (typeof perCall === 'number' && Number.isFinite(perCall)) {
    // Explicit 0 disables; negative is a caller bug → default.
    if (perCall === 0) return 0;
    if (perCall > 0) return perCall;
  }
  const raw = env[MAX_WORKFLOW_STALL_MS_ENV];
  const trimmed = raw?.trim();
  if (trimmed) {
    if (trimmed === '0') return 0;
    const sec = parsePositiveIntegerEnv(trimmed, 0);
    if (sec > 0) return sec * 1000;
  }
  return DEFAULT_STALL_MS;
}

const debugLogger = createDebugLogger('WORKFLOW_STALL');

export interface StallWatchdogHandle {
  /** True once the watchdog has fired `controller.abort('stalled')`. */
  stalled(): boolean;
  /** Clear the timer + detach listeners. Idempotent; call in a `finally`. */
  dispose(): void;
}

/**
 * Attach a stall watchdog to a subagent's event emitter. The watchdog arms
 * a `stallMs` timer that any progress event resets; while a tool is in
 * flight the timer is held (a long tool call is not a stall). When the
 * timer elapses with no in-flight tool, it fires `controller.abort('stalled')`.
 *
 * The watchdog arms on the first progress event rather than at attach time, but
 * that excludes far less than it appears to. `ROUND_START` is emitted as soon as
 * `await sendMessageStream(...)` resolves — and that call returns a lazily
 * iterated async generator, so it resolves BEFORE the request reaches the wire;
 * the generator body issues it on first iteration. The deferred arm therefore
 * only skips round 1's pre-generator work (the send-lock drain, route
 * resolution, and any auto-compaction), not the request itself. Connection
 * setup, server-side queueing, and a reasoning model's pre-first-token thinking
 * all elapse with the timer already running.
 *
 * So `stallMs` must be wide enough to cover a healthy first response, not just a
 * mid-stream gap. The binding case this window is sized against is the
 * `retryWithBackoff` silent retry ladder — see `DEFAULT_STALL_MS`. Once the
 * provider streams anything at all, including thought deltas, `STREAM_TEXT`
 * resets the timer.
 *
 * A `RETRY_WAIT` start registers a finite wait: while it is active the
 * deadline is its declared end plus `stallMs`, and its `end` restarts the full
 * window from the moment the request actually resumed. A wait whose end never
 * arrives stops shielding once its delay elapses, and repeated or unknown
 * notifications cannot extend anything. A wait also arms the watchdog, so a
 * request that starts waiting before `ROUND_START` is still bounded.
 *
 * A `stallMs` of 0 means "no watchdog" — this returns an inert handle.
 */
export function attachStallWatchdog(
  emitter: AgentEventEmitter,
  controller: AbortController,
  stallMs: number,
): StallWatchdogHandle {
  if (stallMs <= 0) {
    return { stalled: () => false, dispose: () => {} };
  }

  let inFlightTools = 0;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // Monotonic time of the last progress, or of when the last retry wait
  // ended. Undefined until the first progress event or retry wait.
  let lastActivity: number | undefined;
  // Active retry waits → monotonic time their declared delay elapses.
  const waits = new Map<string, number>();
  // Every waitId this attempt has started, so a repeated start cannot renew it.
  const startedWaitIds = new Set<string>();

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const markActivity = (): void => {
    lastActivity = Math.max(lastActivity ?? 0, performance.now());
  };

  const arm = (): void => {
    clear();
    if (disposed || fired) return;
    // Suspend the timer while any tool is executing — a slow tool is not a
    // stall. The TOOL_RESULT handler re-arms once the tool count returns to 0.
    if (inFlightTools > 0) return;
    if (lastActivity === undefined && waits.size === 0) return;
    const now = performance.now();
    let base = lastActivity ?? now;
    for (const [waitId, until] of waits) {
      // A wait whose end never arrived stops shielding once its declared
      // delay elapses; that moment then counts as when it ended.
      if (until <= now) {
        waits.delete(waitId);
        lastActivity = Math.max(lastActivity ?? until, until);
      }
      base = Math.max(base, until);
    }
    const due = base + stallMs;
    if (due > now) {
      // Re-evaluated on wake, so an over-long delay is split into chunks
      // rather than overflowing setTimeout.
      timer = setTimeout(arm, Math.min(due - now, MAX_TIMER_DELAY_MS));
      // Don't keep the event loop alive solely for the watchdog timer.
      timer.unref?.();
      return;
    }
    fired = true;
    debugLogger.warn(
      `[Workflow] agent dispatch stalled — no progress for ${stallMs}ms; aborting.`,
    );
    try {
      controller.abort(WORKFLOW_ABORT_REASON_STALLED);
    } catch (e) {
      debugLogger.warn('stall watchdog abort threw:', e);
    }
  };

  const onActivity = (): void => {
    markActivity();
    arm();
  };
  const onToolCall = (): void => {
    inFlightTools += 1;
    clear(); // hold the timer while the tool runs
  };
  const onToolResult = (): void => {
    inFlightTools = Math.max(0, inFlightTools - 1);
    markActivity();
    arm();
  };
  const onRetryWait = (event: AgentRetryWaitEvent): void => {
    if (event.phase === 'start') {
      if (startedWaitIds.has(event.waitId)) return;
      if (!Number.isFinite(event.delayMs) || event.delayMs <= 0) return;
      startedWaitIds.add(event.waitId);
      const now = performance.now();
      waits.set(event.waitId, now + event.delayMs);
      lastActivity ??= now;
    } else {
      if (!waits.delete(event.waitId)) return;
      // The resumed request gets a full window from when it actually resumed.
      markActivity();
    }
    arm();
  };

  emitter.on(AgentEventType.ROUND_START, onActivity);
  emitter.on(AgentEventType.ROUND_END, onActivity);
  emitter.on(AgentEventType.STREAM_TEXT, onActivity);
  emitter.on(AgentEventType.USAGE_METADATA, onActivity);
  emitter.on(AgentEventType.TOOL_CALL, onToolCall);
  emitter.on(AgentEventType.TOOL_RESULT, onToolResult);
  emitter.on(AgentEventType.RETRY_WAIT, onRetryWait);

  // Intentionally NOT armed here — the first `onActivity` (or retry wait) arms
  // it. Note this defers arming only past round 1's pre-request work, NOT past
  // the request: `ROUND_START` fires before the call is on the wire (see the
  // doc comment).
  // A first-response hang is therefore caught by this watchdog, not left to
  // the subagent's `max_time_minutes` (which is per attempt and resets on
  // every stall retry, so it never bounds the sequence).

  return {
    stalled: () => fired,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clear();
      waits.clear();
      emitter.off(AgentEventType.ROUND_START, onActivity);
      emitter.off(AgentEventType.ROUND_END, onActivity);
      emitter.off(AgentEventType.STREAM_TEXT, onActivity);
      emitter.off(AgentEventType.USAGE_METADATA, onActivity);
      emitter.off(AgentEventType.TOOL_CALL, onToolCall);
      emitter.off(AgentEventType.TOOL_RESULT, onToolResult);
      emitter.off(AgentEventType.RETRY_WAIT, onRetryWait);
    },
  };
}

/**
 * One single-attempt dispatch. Receives the per-attempt abort signal (the
 * wrapper chains the parent signal into it + the watchdog aborts it) and
 * the per-attempt emitter (the watchdog is already attached). Returns the
 * agent result on success; throws on any non-success terminal.
 */
export type StallAttemptFn<T> = (
  attemptSignal: AbortSignal,
  emitter: AgentEventEmitter,
) => Promise<T>;

export interface RunStallResilientOptions {
  stallMs: number;
  /** Caller's parent abort signal (cancellation, wall-clock). */
  signal?: AbortSignal;
  /** For the abandoned-error message. */
  label?: string;
}

/**
 * Run a single-attempt dispatch under the stall watchdog, retrying on stall
 * up to `MAX_STALL_ATTEMPTS`. A non-stall failure (MAX_TURNS, TIMEOUT,
 * ERROR, schema-nudge-exhaustion) propagates immediately without retry —
 * those are deterministic outcomes a retry won't fix. A parent abort
 * propagates without retry.
 *
 * The watchdog is disabled (no retries, raw single attempt) when
 * `stallMs <= 0`.
 */
export async function runStallResilient<T>(
  attemptFn: StallAttemptFn<T>,
  opts: RunStallResilientOptions,
): Promise<T> {
  const { stallMs, signal, label } = opts;

  // Watchdog disabled: single raw attempt, parent signal threaded straight
  // through (no per-attempt controller needed).
  if (stallMs <= 0) {
    const emitter = new AgentEventEmitter();
    return attemptFn(signal ?? new AbortController().signal, emitter);
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const controller = new AbortController();
    // Chain the parent signal so cancellation / wall-clock still aborts the
    // attempt. Named handler so we can detach it after each attempt.
    let onParentAbort: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        onParentAbort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', onParentAbort);
      }
    }
    const emitter = new AgentEventEmitter();
    const watchdog = attachStallWatchdog(emitter, controller, stallMs);
    try {
      return await attemptFn(controller.signal, emitter);
    } catch (err) {
      // Parent abort takes priority — never retry a user/wall-clock cancel.
      if (signal?.aborted) throw err;
      // A stall manifests as the attempt's "did not complete (CANCELLED)"
      // throw; the watchdog flag is the authoritative signal that WE aborted.
      if (watchdog.stalled() && attempt < MAX_STALL_ATTEMPTS) {
        debugLogger.warn(
          `[Workflow] agent "${label ?? 'workflow-agent'}" stalled ` +
            `(attempt ${attempt}/${MAX_STALL_ATTEMPTS}) — retrying.`,
        );
        continue;
      }
      if (watchdog.stalled()) {
        throw new WorkflowAgentFailedError(
          `agent "${label ?? 'workflow-agent'}" stalled on all ` +
            `${MAX_STALL_ATTEMPTS} attempts (no progress for ${stallMs}ms each).`,
          'stalled',
        );
      }
      throw err;
    } finally {
      watchdog.dispose();
      if (onParentAbort && signal) {
        signal.removeEventListener('abort', onParentAbort);
      }
    }
  }
}
