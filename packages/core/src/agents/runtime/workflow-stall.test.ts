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
  it('falls back to default when nothing set', () => {
    expect(resolveStallMs(undefined, {})).toBe(DEFAULT_STALL_MS);
  });
  it('ignores a negative per-call value (falls through to default)', () => {
    expect(resolveStallMs(-5, {})).toBe(DEFAULT_STALL_MS);
  });
});

describe('attachStallWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires after stallMs of no activity once the first response has arrived', () => {
    const emitter = new AgentEventEmitter();
    const controller = new AbortController();
    const wd = attachStallWatchdog(emitter, controller, 1000);
    // #8: not armed until the first progress event (the time-to-first-response
    // window is not a stall) — so advancing past stallMs here does nothing.
    vi.advanceTimersByTime(2000);
    expect(wd.stalled()).toBe(false);
    // First response arrives → watchdog arms; then silence trips it.
    emitter.emit(AgentEventType.ROUND_START, {} as never);
    vi.advanceTimersByTime(999);
    expect(wd.stalled()).toBe(false);
    vi.advanceTimersByTime(2);
    expect(wd.stalled()).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('stalled');
    wd.dispose();
  });

  it('does NOT fire during the time-to-first-response window (#8)', () => {
    const emitter = new AgentEventEmitter();
    const controller = new AbortController();
    const wd = attachStallWatchdog(emitter, controller, 1000);
    // A reasoning model thinking for a long time before the first token emits
    // no events; that must not be treated as a stall.
    vi.advanceTimersByTime(10_000);
    expect(wd.stalled()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
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
      // Emit a first response event so the watchdog arms (#8: the time-to-
      // first-response window is not a stall), then go silent → it trips.
      emitter.emit(AgentEventType.ROUND_START, {} as never);
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('Workflow subagent did not complete (terminate mode: CANCELLED).');
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
        // First attempt stalls: emit a first response event to arm the
        // watchdog (#8), then go silent until it aborts.
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
      throw new Error('Workflow subagent did not complete (terminate mode: MAX_TURNS).');
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
