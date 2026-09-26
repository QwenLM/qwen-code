/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentEventEmitter, AgentEventType } from './agent-events.js';
import {
  attachStallWatchdog,
  resolveStallMs,
  runStallResilient,
  DEFAULT_STALL_MS,
  MAX_STALL_ATTEMPTS,
  MAX_WORKFLOW_STALL_MS_ENV,
} from './workflow-stall.js';
import {
  isWorkflowAgentFailedError,
  type WorkflowAgentFailedError,
} from './workflow-agent-failure.js';
import { DEFAULT_RETRY_OPTIONS } from '../../utils/retry.js';
import { getRetryDelayMs } from '../../utils/retryPolicy.js';

describe('resolveStallMs', () => {
  const fromEnv = (seconds: string) =>
    resolveStallMs(undefined, { [MAX_WORKFLOW_STALL_MS_ENV]: seconds });

  it('uses the per-call override when positive', () => {
    expect(resolveStallMs(5000, {})).toBe(5000);
  });
  it('per-call 0 disables the watchdog', () => {
    expect(resolveStallMs(0, {})).toBe(0);
  });
  it('falls back to env seconds when no per-call override', () => {
    expect(fromEnv('30')).toBe(30_000);
  });
  it('env 0 disables', () => {
    expect(fromEnv('0')).toBe(0);
  });
  it.each(['0x10', '1e3', '1.0', '2.5', '0x0'])(
    'ignores malformed env seconds %j',
    (value) => {
      expect(fromEnv(value)).toBe(DEFAULT_STALL_MS);
    },
  );
  it('falls back to default when nothing set', () => {
    expect(resolveStallMs(undefined, {})).toBe(DEFAULT_STALL_MS);
  });
  it('ignores a negative per-call value (falls through to default)', () => {
    expect(resolveStallMs(-5, {})).toBe(DEFAULT_STALL_MS);
  });

  // The default has to outlast the transport's own silent retry ladder, or a
  // request retrying exactly as designed reads as a stall:
  // `DEFAULT_RETRY_OPTIONS` (utils/retry.ts) sleeps 1.5s, 3s, 6s, 12s, 24s, 30s
  // between attempts, and agent-core consumes each `retry` stream event
  // without emitting anything the watchdog counts as progress, so the whole
  // ladder is one silent stretch. Asserting the relationship, not the literal,
  // survives a retune of either.
  //
  // The ladder is DERIVED from `DEFAULT_RETRY_OPTIONS`, not hand-copied: a
  // local literal would stay green while a retune pushed the real ladder past
  // the window (the false-stall regression this guards). Mirrors
  // retryWithBackoff's error path: `maxAttempts - 1` sleeps, `currentDelay`
  // doubling from `initialDelayMs` under the `maxDelayMs` cap, each through
  // `getRetryDelayMs` with that path's ±30% jitter.
  const transportLadderMs = (random: () => number) => {
    const { maxAttempts, initialDelayMs, maxDelayMs } = DEFAULT_RETRY_OPTIONS;
    let currentDelay = initialDelayMs;
    let total = 0;
    for (let sleep = 1; sleep < maxAttempts; sleep++) {
      total += getRetryDelayMs({
        attempt: 1,
        initialDelayMs: currentDelay,
        maxDelayMs,
        jitterRatio: 0.3,
        random,
      });
      currentDelay = Math.min(maxDelayMs, currentDelay * 2);
    }
    return total;
  };

  it('outlasts the transport retry ladder it has to survive', () => {
    const nominal = transportLadderMs(() => 0.5); // jitter cancels out
    const worstCase = transportLadderMs(() => 1); // every sleep +30%, then capped
    expect(nominal).toBe(76_500);
    expect(worstCase).toBe(89_250);
    // The window has to outlast the ladder on an UNLUCKY run, not just the
    // nominal sum: a `DEFAULT_STALL_MS` retuned into the (76.5s, 89.25s] band
    // would false-trip under jitter while a nominal-only assertion stayed green.
    expect(DEFAULT_STALL_MS).toBeGreaterThan(worstCase);
  });
});

describe('attachStallWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function watch(stallMs = 1000) {
    const emitter = new AgentEventEmitter();
    const controller = new AbortController();
    const wd = attachStallWatchdog(emitter, controller, stallMs);
    const emit = (type: AgentEventType) => emitter.emit(type, {} as never);
    return { controller, wd, emit };
  }

  it('fires after stallMs of silence once armed (ROUND_START)', () => {
    const { controller, wd, emit } = watch();
    // Not armed until the first progress event, so advancing past stallMs does
    // nothing. In a real dispatch that event is ROUND_START, fired before the
    // request reaches the wire (see `attachStallWatchdog`'s doc), so this is
    // only round 1's pre-generator work, NOT the time-to-first-token window,
    // which is watched (pinned below).
    vi.advanceTimersByTime(2000);
    expect(wd.stalled()).toBe(false);
    // ROUND_START arrives → watchdog arms; then silence trips it.
    emit(AgentEventType.ROUND_START);
    vi.advanceTimersByTime(999);
    expect(wd.stalled()).toBe(false);
    vi.advanceTimersByTime(2);
    expect(wd.stalled()).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('stalled');
    wd.dispose();
  });

  // Replaces a test that the watchdog does not fire during time-to-first-
  // response. It never emitted ROUND_START, so it only proved an unarmed
  // watchdog stays quiet, and it encoded a false model of the transport: in a
  // real dispatch `sendMessageStream` returns a lazily iterated generator, so
  // its `await` resolves before the request reaches the wire and agent-core
  // emits ROUND_START on the very next line. These two tests pin that.
  it('does not arm before the first progress event', () => {
    const { controller, wd } = watch();
    // Nothing emitted: the timer was never armed, so nothing can elapse.
    vi.advanceTimersByTime(10_000);
    expect(wd.stalled()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    wd.dispose();
  });

  it('DOES count the time-to-first-token window, because ROUND_START precedes the request', () => {
    const { controller, wd, emit } = watch();
    // Exactly what agent-core does: emit ROUND_START immediately after
    // `await sendMessageStream(...)` resolves — i.e. before any bytes are sent.
    emit(AgentEventType.ROUND_START);
    // The provider is still connecting/queueing/thinking; no deltas yet.
    vi.advanceTimersByTime(1001);
    expect(wd.stalled()).toBe(true);
    expect(controller.signal.reason).toBe('stalled');
    wd.dispose();
  });

  it('resets the timer on a progress event', () => {
    const { wd, emit } = watch();
    vi.advanceTimersByTime(800);
    emit(AgentEventType.STREAM_TEXT); // activity → reset
    vi.advanceTimersByTime(800);
    expect(wd.stalled()).toBe(false); // would have fired at 1000 without reset
    vi.advanceTimersByTime(300);
    expect(wd.stalled()).toBe(true);
    wd.dispose();
  });

  it('suspends the timer while a tool is in flight', () => {
    const { wd, emit } = watch();
    emit(AgentEventType.TOOL_CALL); // tool starts
    vi.advanceTimersByTime(5000); // long tool — must NOT count as stall
    expect(wd.stalled()).toBe(false);
    emit(AgentEventType.TOOL_RESULT); // tool done → re-arm
    vi.advanceTimersByTime(1001);
    expect(wd.stalled()).toBe(true);
    wd.dispose();
  });

  it('does not fire after dispose', () => {
    const { controller, wd } = watch();
    wd.dispose();
    vi.advanceTimersByTime(5000);
    expect(wd.stalled()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it('stallMs <= 0 returns an inert handle', () => {
    const { controller, wd } = watch(0);
    vi.advanceTimersByTime(100_000);
    expect(wd.stalled()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    wd.dispose();
  });
});

describe('runStallResilient', () => {
  const CANCELLED = 'did not complete (terminate mode: CANCELLED).';
  /**
   * Resolves once `signal` aborts. With `orNow`, also at once if it already
   * has; without it an already-aborted signal hangs, as the originals did.
   */
  const untilAborted = (signal: AbortSignal, orNow = true) =>
    new Promise<void>((resolve) => {
      if (orNow && signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });

  /**
   * A stalled attempt: emit ROUND_START so the watchdog arms (in a real
   * dispatch it fires before the request reaches the wire, so the
   * time-to-first-token window IS watched), go silent until the watchdog
   * aborts the signal, then throw the "did not complete" terminal.
   */
  async function stall(
    signal: AbortSignal,
    emitter: AgentEventEmitter,
    message = CANCELLED,
  ): Promise<never> {
    emitter.emit(AgentEventType.ROUND_START, {} as never);
    await untilAborted(signal);
    throw new Error(message);
  }

  it('returns the result on success (no stall, no retry)', async () => {
    let calls = 0;
    const result = await runStallResilient(
      async () => {
        calls += 1;
        return 'ok';
      },
      { stallMs: 1000 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on stall up to MAX_STALL_ATTEMPTS then abandons', async () => {
    let calls = 0;
    const attemptFn = (signal: AbortSignal, emitter: AgentEventEmitter) => {
      calls += 1;
      return stall(signal, emitter, `Workflow subagent ${CANCELLED}`);
    };
    // A tiny stallMs with real timers so the watchdog fires fast.
    const caught = await runStallResilient(attemptFn, {
      stallMs: 5,
      label: 'slow',
    }).catch((e: unknown) => e);
    expect(calls).toBe(MAX_STALL_ATTEMPTS);
    expect(isWorkflowAgentFailedError(caught)).toBe(true);
    expect((caught as WorkflowAgentFailedError).kind).toBe('stalled');
    expect(String(caught)).toMatch(/stalled on all 3 attempts/);
  });

  it('retries on stall then SUCCEEDS on a later attempt', async () => {
    let calls = 0;
    const attemptFn = async (
      signal: AbortSignal,
      emitter: AgentEventEmitter,
    ): Promise<string> => {
      calls += 1;
      if (calls < 2) return stall(signal, emitter); // first attempt stalls
      return 'recovered';
    };
    const result = await runStallResilient(attemptFn, { stallMs: 5 });
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('does NOT retry a non-stall failure (propagates immediately)', async () => {
    let calls = 0;
    const attemptFn = async (): Promise<string> => {
      calls += 1;
      throw new Error(
        'Workflow subagent did not complete (terminate mode: MAX_TURNS).',
      );
    };
    const caught = await runStallResilient(attemptFn, { stallMs: 1000 }).catch(
      (e: unknown) => e,
    );
    expect(calls).toBe(1);
    expect(String(caught)).toMatch(/MAX_TURNS/);
  });

  it('does NOT retry on parent abort (propagates)', async () => {
    const parent = new AbortController();
    let calls = 0;
    const attemptFn = async (signal: AbortSignal): Promise<string> => {
      calls += 1;
      await untilAborted(signal, false);
      throw new Error(CANCELLED);
    };
    const p = runStallResilient(attemptFn, {
      stallMs: 100_000, // watchdog won't fire
      signal: parent.signal,
    });
    parent.abort('user-cancel');
    const caught = await p.catch((e: unknown) => e);
    expect(calls).toBe(1); // no retry on parent abort
    expect(String(caught)).toMatch(/CANCELLED/);
  });

  it('parent abort propagates to the per-attempt signal', async () => {
    const parent = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const attemptFn = async (signal: AbortSignal): Promise<string> => {
      capturedSignal = signal;
      await untilAborted(signal, false);
      return 'aborted-and-returned';
    };
    const p = runStallResilient(attemptFn, {
      stallMs: 100_000,
      signal: parent.signal,
    });
    // Let the attempt start + register its listener.
    await Promise.resolve();
    expect(capturedSignal!.aborted).toBe(false);
    parent.abort('user-cancel');
    expect(capturedSignal!.aborted).toBe(true);
    await p;
  });

  it('stallMs=0 runs a single raw attempt with the parent signal', async () => {
    const parent = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    let calls = 0;
    await runStallResilient(
      async (signal) => {
        calls += 1;
        capturedSignal = signal;
        return 'ok';
      },
      { stallMs: 0, signal: parent.signal },
    );
    expect(calls).toBe(1);
    // With the watchdog disabled, the parent signal is threaded straight
    // through (same object).
    expect(capturedSignal).toBe(parent.signal);
  });
});
