/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Stall watchdog + retry for workflow agent dispatches. A
 * workflow `agent()` can hang indefinitely if the model loops, the provider
 * stalls mid-stream, or a tool never returns. The subagent's own
 * `max_time_minutes` (10 min) is a coarse backstop; the stall watchdog is
 * finer-grained: it aborts a dispatch after `stallMs` (default 60s) of NO
 * observable progress, and the resilient wrapper retries up to
 * `MAX_STALL_ATTEMPTS` times before abandoning.
 *
 * "Progress" = any of the subagent's reasoning-loop events (round start,
 * streamed text, token usage, tool call/result). Crucially the timer is
 * SUSPENDED while a tool is in flight: a legitimately long-running tool
 * (a 90s shell build, a slow MCP call) must not be flagged as a stall. The
 * timer only counts wall-clock during which the subagent is producing
 * nothing AND has no tool executing.
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

import { AgentEventEmitter, AgentEventType } from './agent-events.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

/** Default stall timeout: 60s of no progress (with no tool in flight). */
export const DEFAULT_STALL_MS = 60_000;

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
  if (raw !== undefined && raw.trim() !== '') {
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
    if (sec === 0) return 0;
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
 * The watchdog arms on the FIRST progress event, not at attach time. The
 * time-to-first-response window — connection setup, server-side queueing, and
 * a reasoning model's pre-first-token thinking — emits no events (`ROUND_START`
 * fires only AFTER `await sendMessageStream` resolves), so counting it would
 * false-trip on a healthy-but-slow first response and waste 3× tokens on the
 * retry loop. That window is instead bounded by the subagent's own
 * `max_time_minutes`; the watchdog's job is post-first-response streaming stalls.
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

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const arm = (): void => {
    clear();
    if (disposed || fired) return;
    // Suspend the timer while any tool is executing — a slow tool is not a
    // stall. The TOOL_RESULT handler re-arms once the tool count returns to 0.
    if (inFlightTools > 0) return;
    timer = setTimeout(() => {
      if (disposed || fired) return;
      fired = true;
      debugLogger.warn(
        `[Workflow] agent dispatch stalled — no progress for ${stallMs}ms; aborting.`,
      );
      try {
        controller.abort('stalled');
      } catch (e) {
        debugLogger.warn('stall watchdog abort threw:', e);
      }
    }, stallMs);
    // Don't keep the event loop alive solely for the watchdog timer.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  };

  const onActivity = (): void => arm();
  const onToolCall = (): void => {
    inFlightTools += 1;
    clear(); // hold the timer while the tool runs
  };
  const onToolResult = (): void => {
    inFlightTools = Math.max(0, inFlightTools - 1);
    arm();
  };

  emitter.on(AgentEventType.ROUND_START, onActivity);
  emitter.on(AgentEventType.ROUND_END, onActivity);
  emitter.on(AgentEventType.STREAM_TEXT, onActivity);
  emitter.on(AgentEventType.USAGE_METADATA, onActivity);
  emitter.on(AgentEventType.TOOL_CALL, onToolCall);
  emitter.on(AgentEventType.TOOL_RESULT, onToolResult);

  // Intentionally NOT armed here. The first `onActivity` (the first response
  // event of round 1) arms it, so time-to-first-response is not counted as a
  // stall (see the doc comment); first-response hangs are bounded by the
  // subagent's `max_time_minutes`.

  return {
    stalled: () => fired,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clear();
      emitter.off(AgentEventType.ROUND_START, onActivity);
      emitter.off(AgentEventType.ROUND_END, onActivity);
      emitter.off(AgentEventType.STREAM_TEXT, onActivity);
      emitter.off(AgentEventType.USAGE_METADATA, onActivity);
      emitter.off(AgentEventType.TOOL_CALL, onToolCall);
      emitter.off(AgentEventType.TOOL_RESULT, onToolResult);
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
        throw new Error(
          `agent "${label ?? 'workflow-agent'}" stalled on all ` +
            `${MAX_STALL_ATTEMPTS} attempts (no progress for ${stallMs}ms each).`,
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
