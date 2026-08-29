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
import { DEFAULT_RETRY_OPTIONS } from '../../utils/retry.js';
import { getRetryDelayMs } from '../../utils/retryPolicy.js';

describe('resolveStallMs', () => {
  it('uses the per-call override when positive', () => {
    expect(resolveStallMs(5000, {})).toBe(5000);
  });
  it('per-call 0 disables the watchdog', () => {
    expect(resolveStallMs(0, {})).toBe(0);
  });
  it('falls back to env seconds when no per-call override', () => {
    expect(
      resolveStallMs(undefined, { [MAX_WORKFLOW_STALL_MS_ENV]: '30' }),
    ).toBe(30_000);
  });
  it('env 0 disables', () => {
    expect(
      resolveStallMs(undefined, { [MAX_WORKFLOW_STALL_MS_ENV]: '0' }),
    ).toBe(0);
  });
  it.each(['0x10', '1e3', '1.0', '2.5', '0x0'])(
    'ignores malformed env seconds %j',
    (value) => {
      expect(
        resolveStallMs(undefined, { [MAX_WORKFLOW_STALL_MS_ENV]: value }),
      ).toBe(DEFAULT_STALL_MS);
    },
  );
  it('falls back to default when nothing set', () => {
    expect(resolveStallMs(undefined, {})).toBe(DEFAULT_STALL_MS);
  });
  it('ignores a negative per-call value (falls through to default)', () => {
    expect(resolveStallMs(-5, {})).toBe(DEFAULT_STALL_MS);
  });

  // The default is not an arbitrary round number: it has to outlast the
  // transport's own silent retry ladder, or a request that is retrying exactly
  // as designed reads as a stall. `DEFAULT_RETRY_OPTIONS` in utils/retry.ts
  // sleeps 1.5s, 3s, 6s, 12s, 24s, 30s between attempts, and agent-core
  // consumes each `retry` stream event without emitting anything the watchdog
  // counts as progress — so the whole ladder is one silent stretch.
  //
  // Asserting the relationship rather than the literal keeps this meaningful if
  // either number is retuned later.
  //
  // The ladder is DERIVED from `DEFAULT_RETRY_OPTIONS`, not hand-copied: a
  // local literal would keep this test green while a retune of the real
  // options pushed the real ladder past the window — the exact false-stall
  // regression this test exists to prevent. Mirrors retryWithBackoff's error
  // path: `maxAttempts - 1` sleeps, `currentDelay` doubling from
  // `initialDelayMs` under the `maxDelayMs` cap, each sleep run through
  // `getRetryDelayMs` with the ±30% jitter that path applies.
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

  it('fires after stallMs of silence once armed (ROUND_START)', () => {
    const emitter = new AgentEventEmitter();
    const controller = new AbortController();
    const wd = attachStallWatchdog(emitter, controller, 1000);
    // Not armed until the first progress event — so advancing past stallMs
    // here does nothing. In a real dispatch that event is ROUND_START, which
    // fires before the request reaches the wire (see the doc comment on
    // `attachStallWatchdog`), so this pre-arm silence is only round 1's
    // pre-generator work, NOT the time-to-first-token window — that window is
    // watched, and is pinned by the test below.
    vi.advanceTimersByTime(2000);
    expect(wd.stalled()).toBe(false);
    // ROUND_START arrives → watchdog arms; then silence trips it.
    emitter.emit(AgentEventType.ROUND_START, {} as never);
    vi.advanceTimersByTime(999);
    expect(wd.stalled()).toBe(false);
    vi.advanceTimersByTime(2);
    expect(wd.stalled()).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('stalled');
    wd.dispose();
  });

  // Replaces a test that asserted the watchdog does not fire during the
  // time-to-first-response window. That test never emitted ROUND_START, so it
  // only proved that a silent emitter does not trip a watchdog that was never
  // armed — and it encoded a model of the transport that is not true. In a real
  // dispatch ROUND_START has already fired by this point: `sendMessageStream`
  // returns a lazily iterated generator, so the `await` on it resolves before
  // the request reaches the wire, and agent-core emits ROUND_START on the very
  // next line. These two tests pin what actually happens.
  it('does not arm before the first progress event', () => {
    const emitter = new AgentEventEmitter();
    const controller = new AbortController();
    const wd = attachStallWatchdog(emitter, controller, 1000);
    // Nothing emitted: the timer was never armed, so nothing can elapse.
    vi.advanceTimersByTime(10_000);
    expect(wd.stalled()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    wd.dispose();
  });

  it('DOES count the time-to-first-token window, because ROUND_START precedes the request', () => {
    const emitter = new AgentEventEmitter();
    const controller = new AbortController();
    const wd = attachStallWatchdog(emitter, controller, 1000);
    // Exactly what agent-core does: emit ROUND_START immediately after
    // `await sendMessageStream(...)` resolves — i.e. before any bytes are sent.
    emitter.emit(AgentEventType.ROUND_START, {} as never);
    // The provider is still connecting/queueing/thinking; no deltas yet.
    vi.advanceTimersByTime(1001);
    expect(wd.stalled()).toBe(true);
    expect(controller.signal.reason).toBe('stalled');
    wd.dispose();
  });

  it('resets the timer on a progress event', () => {
    const emitter = new AgentEventEmitter();
    const controller = new AbortController();
    const wd = attachStallWatchdog(emitter, controller, 1000);
    vi.advanceTimersByTime(800);
    emitter.emit(AgentEventType.STREAM_TEXT, {} as never); // activity → reset
    vi.advanceTimersByTime(800);
    expect(wd.stalled()).toBe(false); // would have fired at 1000 without reset
    vi.advanceTimersByTime(300);
    expect(wd.stalled()).toBe(true);
    wd.dispose();
  });

  it('suspends the timer while a tool is in flight', () => {
    const emitter = new AgentEventEmitter();
    const controller = new AbortController();
    const wd = attachStallWatchdog(emitter, controller, 1000);
    emitter.emit(AgentEventType.TOOL_CALL, {} as never); // tool starts
    vi.advanceTimersByTime(5000); // long tool — must NOT count as stall
    expect(wd.stalled()).toBe(false);
    emitter.emit(AgentEventType.TOOL_RESULT, {} as never); // tool done → re-arm
    vi.advanceTimersByTime(1001);
    expect(wd.stalled()).toBe(true);
    wd.dispose();
  });

  it('does not fire after dispose', () => {
    const emitter = new AgentEventEmitter();
    const controller = new AbortController();
    const wd = attachStallWatchdog(emitter, controller, 1000);
    wd.dispose();
    vi.advanceTimersByTime(5000);
    expect(wd.stalled()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it('stallMs <= 0 returns an inert handle', () => {
    const emitter = new AgentEventEmitter();
    const controller = new AbortController();
    const wd = attachStallWatchdog(emitter, controller, 0);
    vi.advanceTimersByTime(100_000);
    expect(wd.stalled()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    wd.dispose();
  });
});

describe('runStallResilient', () => {
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
    // Each attempt stalls immediately: the attemptFn waits for the watchdog
    // to abort its signal, then throws the "did not complete" terminal.
    const attemptFn = async (
      signal: AbortSignal,
      emitter: AgentEventEmitter,
    ): Promise<string> => {
      calls += 1;
      // Emit ROUND_START so the watchdog arms — in a real dispatch that fires
      // before the request reaches the wire, so the time-to-first-token window
      // IS watched — then go silent → it trips.
      emitter.emit(AgentEventType.ROUND_START, {} as never);
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error(
        'Workflow subagent did not complete (terminate mode: CANCELLED).',
      );
    };
    // Use a tiny stallMs with real timers so the watchdog fires fast.
    let caught: unknown;
    try {
      await runStallResilient(attemptFn, { stallMs: 5, label: 'slow' });
    } catch (e) {
      caught = e;
    }
    expect(calls).toBe(MAX_STALL_ATTEMPTS);
    expect(String(caught)).toMatch(/stalled on all 3 attempts/);
  });

  it('retries on stall then SUCCEEDS on a later attempt', async () => {
    let calls = 0;
    const attemptFn = async (
      signal: AbortSignal,
      emitter: AgentEventEmitter,
    ): Promise<string> => {
      calls += 1;
      if (calls < 2) {
        // First attempt stalls: emit ROUND_START to arm the watchdog — in a
        // real dispatch that fires before the request reaches the wire — then
        // go silent until it aborts.
        emitter.emit(AgentEventType.ROUND_START, {} as never);
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('did not complete (terminate mode: CANCELLED).');
      }
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
    let caught: unknown;
    try {
      await runStallResilient(attemptFn, { stallMs: 1000 });
    } catch (e) {
      caught = e;
    }
    expect(calls).toBe(1);
    expect(String(caught)).toMatch(/MAX_TURNS/);
  });

  it('does NOT retry on parent abort (propagates)', async () => {
    const parent = new AbortController();
    let calls = 0;
    const attemptFn = async (signal: AbortSignal): Promise<string> => {
      calls += 1;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('did not complete (terminate mode: CANCELLED).');
    };
    const p = runStallResilient(attemptFn, {
      stallMs: 100_000, // watchdog won't fire
      signal: parent.signal,
    });
    parent.abort('user-cancel');
    let caught: unknown;
    try {
      await p;
    } catch (e) {
      caught = e;
    }
    expect(calls).toBe(1); // no retry on parent abort
    expect(String(caught)).toMatch(/CANCELLED/);
  });

  it('parent abort propagates to the per-attempt signal', async () => {
    const parent = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const attemptFn = async (signal: AbortSignal): Promise<string> => {
      capturedSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
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
