/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_LIVE_SSE_STREAMS,
  getSseBudgetRegistry,
  resetSseBudgetRegistry,
  setSseBudgetFocus,
  SseBudgetRegistry,
  type SseCatchUpCursor,
} from '../../src/daemon/SseBudget.js';
import { DaemonHttpError } from '../../src/daemon/DaemonHttpError.js';
import type { DaemonEvent } from '../../src/daemon/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function sseFrame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * A `text/event-stream` Response whose body emits `frames` up front and
 * then stays OPEN (a live stream) until the client cancels it.
 */
function sseResponse(frames: string[], onBodyCancel?: () => void): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      // Intentionally not closed: live streams stay open.
    },
    cancel() {
      onBodyCancel?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect(
  gen: AsyncGenerator<DaemonEvent>,
): Promise<DaemonEvent[]> {
  const out: DaemonEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

afterEach(() => {
  vi.useRealTimers();
  resetSseBudgetRegistry();
});

// ---------------------------------------------------------------------------
// Slot accounting
// ---------------------------------------------------------------------------

describe('SseBudgetRegistry slot accounting', () => {
  it('uses 4 live streams by default', () => {
    expect(DEFAULT_MAX_LIVE_SSE_STREAMS).toBe(4);
    expect(new SseBudgetRegistry().max).toBe(4);
  });

  it('grants `max` slots and denies the next background acquire', () => {
    const reg = new SseBudgetRegistry(4);
    const ctrls = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ];
    for (let i = 0; i < 4; i++) {
      expect(reg.acquire(`k${i}`, `s${i}`, false, ctrls[i])).toBe(true);
    }
    // A 5th subscription without focus priority is denied: it must do a
    // catch-up cycle instead of opening a live stream.
    expect(reg.acquire('k4', 's4', false, ctrls[4])).toBe(false);
  });

  it('re-acquiring an existing key keeps the slot (touch, no growth)', () => {
    const reg = new SseBudgetRegistry(1);
    const a = new AbortController();
    const b = new AbortController();
    expect(reg.acquire('k', 's', false, a)).toBe(true);
    // Same key again — the slot is touched, not re-taken.
    expect(reg.acquire('k', 's', false, b)).toBe(true);
    // A different session cannot get a slot.
    expect(reg.acquire('other', 's2', false, new AbortController())).toBe(
      false,
    );
  });

  it('release frees the slot for the next acquire', () => {
    const reg = new SseBudgetRegistry(1);
    const a = new AbortController();
    const b = new AbortController();
    expect(reg.acquire('kA', 'sA', false, a)).toBe(true);
    expect(reg.acquire('kB', 'sB', false, b)).toBe(false);
    reg.release('kA');
    expect(reg.acquire('kB', 'sB', false, b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Focus eviction (LRU)
// ---------------------------------------------------------------------------

describe('SseBudgetRegistry focus eviction', () => {
  it('a focused acquire evicts the least-recently active background holder', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const reg = new SseBudgetRegistry(2);
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    reg.acquire('kA', 'A', false, ctrlA); // lastActiveAt = 1000
    vi.setSystemTime(new Date(2_000));
    reg.acquire('kB', 'B', false, ctrlB); // lastActiveAt = 2000
    vi.setSystemTime(new Date(3_000));
    reg.touch('kA'); // A becomes more recent than B
    reg.setFocus('C');
    const ctrlC = new AbortController();
    expect(reg.acquire('kC', 'C', true, ctrlC)).toBe(true);
    // B is the LRU background holder: its live request is aborted with
    // an AbortError named "preempted" so the consumer reconnects (and
    // lands in the catch-up loop).
    expect(ctrlB.signal.aborted).toBe(true);
    expect(ctrlB.signal.reason).toBeInstanceOf(DOMException);
    const reason = ctrlB.signal.reason as DOMException;
    expect(reason.name).toBe('AbortError');
    expect(reason.message).toBe('preempted');
    // A and C keep their slots.
    expect(ctrlA.signal.aborted).toBe(false);
    vi.useRealTimers();
  });

  it('touch changes the LRU eviction order', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const reg = new SseBudgetRegistry(2);
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    reg.acquire('kA', 'A', false, ctrlA);
    reg.acquire('kB', 'B', false, ctrlB); // same timestamp as A
    vi.setSystemTime(new Date(2_000));
    reg.touch('kB'); // B is now the most recent holder
    reg.setFocus('C');
    expect(reg.acquire('kC', 'C', true, new AbortController())).toBe(true);
    // A (the untouched one) was evicted instead of B.
    expect(ctrlA.signal.aborted).toBe(true);
    expect(ctrlB.signal.aborted).toBe(false);
    vi.useRealTimers();
  });

  it('a focused acquire is denied when no background holder is evictable', () => {
    const reg = new SseBudgetRegistry(1);
    // Two subscriptions of the SAME session hold... the one slot is full
    // with a holder whose sid equals the focus, so nothing is evictable.
    reg.acquire('k1', 'A', false, new AbortController());
    reg.setFocus('A');
    expect(reg.acquire('k2', 'B', true, new AbortController())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Catch-up cycle serialization + wait
// ---------------------------------------------------------------------------

describe('SseBudgetRegistry cycle and wait', () => {
  it('serializes catch-up cycles', () => {
    const reg = new SseBudgetRegistry(4);
    expect(reg.startCycle()).toBe(true);
    expect(reg.startCycle()).toBe(false);
    reg.endCycle();
    expect(reg.startCycle()).toBe(true);
    reg.endCycle();
  });

  it('wait resolves after ms', async () => {
    vi.useFakeTimers();
    const reg = new SseBudgetRegistry(4);
    let resolved = false;
    const done = reg.wait(60_000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(resolved).toBe(true);
  });

  it('wait resolves early when the signal aborts', async () => {
    vi.useFakeTimers();
    const reg = new SseBudgetRegistry(4);
    const ctrl = new AbortController();
    let resolved = false;
    const done = reg.wait(60_000, ctrl.signal).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolved).toBe(false);
    ctrl.abort();
    await done;
    expect(resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-context singleton + focus hook
// ---------------------------------------------------------------------------

describe('per-context registry singleton', () => {
  it('getSseBudgetRegistry returns the same instance per context', () => {
    const a = getSseBudgetRegistry();
    const b = getSseBudgetRegistry();
    expect(a).toBe(b);
    expect(a.max).toBe(DEFAULT_MAX_LIVE_SSE_STREAMS);
  });

  it('setSseBudgetFocus writes the focused pane for eviction priority', () => {
    const reg = getSseBudgetRegistry();
    setSseBudgetFocus('pane-1');
    expect(reg.focus).toBe('pane-1');
    setSseBudgetFocus(null);
    expect(reg.focus).toBeNull();
  });

  it('resetSseBudgetRegistry drops the instance (test hook)', () => {
    const a = getSseBudgetRegistry();
    resetSseBudgetRegistry();
    const b = getSseBudgetRegistry();
    expect(b).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// catchUp (one catch-up cycle)
// ---------------------------------------------------------------------------

describe('SseBudgetRegistry.catchUp', () => {
  it('sends the cursor as Last-Event-ID, advances it, stops at replay_complete, and cancels the body', async () => {
    const reg = new SseBudgetRegistry(4);
    const cursor: SseCatchUpCursor = { value: 10 };
    let seenLastEventId: string | null = null;
    let bodyCancelled = false;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenLastEventId = new Headers(init?.headers).get('last-event-id');
      return sseResponse(
        [
          sseFrame({ v: 1, type: 'session_update', data: {}, id: 11 }),
          sseFrame({ v: 1, type: 'session_update', data: {}, id: 12 }),
          // No id: synthetic boundary frame.
          sseFrame({
            v: 1,
            type: 'replay_complete',
            data: { replayedCount: 2 },
          }),
          // After the boundary the cycle must stop: this frame is never
          // yielded.
          sseFrame({ v: 1, type: 'session_update', data: {}, id: 13 }),
        ],
        () => {
          bodyCancelled = true;
        },
      );
    }) as typeof globalThis.fetch;

    const events = await collect(
      reg.catchUp(
        fetchFn,
        'http://daemon/session/s1/events',
        { Accept: 'text/event-stream' },
        new AbortController().signal,
        cursor,
      ),
    );

    expect(seenLastEventId).toBe('10');
    expect(events.map((e) => e.id)).toEqual([11, 12, undefined]);
    expect(events[2].type).toBe('replay_complete');
    // The cursor advanced to the last replayed id (not the boundary).
    expect(cursor.value).toBe(12);
    // The temporary replay connection is closed after the boundary.
    expect(bodyCancelled).toBe(true);
  });

  it('omits Last-Event-ID when the cursor has no value', async () => {
    const reg = new SseBudgetRegistry(4);
    let seenLastEventId: string | null = null;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenLastEventId = new Headers(init?.headers).get('last-event-id');
      return sseResponse([
        sseFrame({ v: 1, type: 'replay_complete', data: { replayedCount: 0 } }),
      ]);
    }) as typeof globalThis.fetch;

    await collect(
      reg.catchUp(
        fetchFn,
        'http://daemon/session/s1/events',
        { Accept: 'text/event-stream' },
        new AbortController().signal,
        {},
      ),
    );
    expect(seenLastEventId).toBeNull();
  });

  it('throws DaemonHttpError with the daemon error field on non-2xx', async () => {
    const reg = new SseBudgetRegistry(4);
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;

    const gen = reg.catchUp(
      fetchFn,
      'http://daemon/session/s1/events',
      { Accept: 'text/event-stream' },
      new AbortController().signal,
      { value: 5 },
    );
    let error: unknown;
    try {
      await collect(gen);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DaemonHttpError);
    expect((error as DaemonHttpError).status).toBe(404);
    expect((error as DaemonHttpError).message).toContain(
      'GET /session/:id/events: not found',
    );
  });

  it('throws DaemonHttpError when the response is not text/event-stream', async () => {
    const reg = new SseBudgetRegistry(4);
    const fetchFn = (async () =>
      new Response('<html>proxy</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as typeof globalThis.fetch;

    const gen = reg.catchUp(
      fetchFn,
      'http://daemon/session/s1/events',
      { Accept: 'text/event-stream' },
      new AbortController().signal,
      { value: 5 },
    );
    await expect(collect(gen)).rejects.toThrow(
      'expected content-type text/event-stream',
    );
  });
});
