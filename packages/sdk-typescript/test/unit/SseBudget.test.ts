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

/**
 * Pull `gen` until it ends, but never longer than `deadlineMs`: a
 * mutation that keeps the stream open after `replay_complete` would
 * block an unbounded `for await` forever, and a hung test file reads
 * as an infrastructure timeout instead of a deterministic failure.
 *
 * On the deadline, abort `signal` (the signal the generator was
 * given) rather than calling `gen.return()`: a `return()` while a
 * `next()` is still pending never settles in V8, which would deadlock
 * the very deadline path it is meant to protect. The abort drives the
 * stream's cancel, the parked read resolves, and the generator ends.
 */
async function collectBounded(
  gen: AsyncGenerator<DaemonEvent>,
  abort: () => void,
  deadlineMs = 1_500,
): Promise<DaemonEvent[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deadlineMs);
  });
  const out: DaemonEvent[] = [];
  try {
    for (;;) {
      const r = await Promise.race([gen.next(), deadline]);
      if (r === 'timeout') {
        abort();
        // Drain the now-unparking generator; bounded, so a mutant that
        // also breaks the abort wiring still fails fast.
        await Promise.race([
          gen.next(),
          new Promise((res) => setTimeout(res, 250)),
        ]);
        throw new Error(
          `collectBounded: generator did not end within ${deadlineMs}ms ` +
            '(stream kept open after replay_complete?)',
        );
      }
      if (r.done) break;
      out.push(r.value);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
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

  it('holderCount reflects the held slots (including eviction reuse)', () => {
    const reg = new SseBudgetRegistry(4);
    const ctrl = new AbortController();
    expect(reg.holderCount).toBe(0);
    for (let i = 0; i < 4; i++) {
      reg.acquire(`k${i}`, `s${i}`, false, ctrl);
    }
    expect(reg.holderCount).toBe(4);
    // Focus eviction reuses a slot — the count stays at max.
    reg.setFocus('s5');
    expect(reg.acquire('k4', 's5', true, new AbortController())).toBe(true);
    expect(reg.holderCount).toBe(4);
    reg.release('k4');
    expect(reg.holderCount).toBe(3);
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

  it('wait resolves immediately when the signal is already aborted', async () => {
    // The DOM abort event is not replayed to a listener attached after
    // the fact — an already-aborted signal must not start the timer.
    const reg = new SseBudgetRegistry(4);
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    await reg.wait(60_000, ctrl.signal);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('wait removes its abort listener on every exit path', () => {
    // A subscription-lifetime signal outlives many retry waits; a
    // listener leak here would accumulate one listener per 2.5 s wait.
    const reg = new SseBudgetRegistry(4);
    let adds = 0;
    let removes = 0;
    const wrap = (sig: AbortSignal): void => {
      const origAdd = sig.addEventListener.bind(sig);
      const origRemove = sig.removeEventListener.bind(sig);
      (sig as unknown as { addEventListener: unknown }).addEventListener = (
        type: string,
        listener: EventListener,
        options?: AddEventListenerOptions | boolean,
      ) => {
        adds++;
        origAdd(type, listener, options);
      };
      (sig as unknown as { removeEventListener: unknown }).removeEventListener =
        (
          type: string,
          listener: EventListener,
          options?: EventListenerOptions | boolean,
        ) => {
          removes++;
          origRemove(type, listener, options);
        };
    };

    const signal = new AbortController().signal;
    wrap(signal);
    return (async () => {
      for (let i = 0; i < 50; i++) {
        await reg.wait(10, signal);
      }
      // Timer path: 50 attached, 50 detached.
      expect(adds).toBe(50);
      expect(removes).toBe(50);

      // Abort path: the listener is detached when the wait resolves early.
      const ctrl = new AbortController();
      wrap(ctrl.signal);
      const pending = reg.wait(60_000, ctrl.signal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(adds).toBe(51);
      ctrl.abort();
      await pending;
      expect(removes).toBe(51);
    })();
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

  it('module registry is dormant until the first focus call', () => {
    const reg = getSseBudgetRegistry();
    expect(reg.active).toBe(false);
    const ctrl = new AbortController();
    // Dormant: no tracking, no cap — a host without a split-view focus
    // concept (serve-bridge, adaptors) must never be throttled.
    for (let i = 0; i < 5; i++) {
      expect(reg.acquire(`d${i}`, `ds${i}`, false, ctrl)).toBe(true);
    }
    expect(reg.holderCount).toBe(0);

    // The first focus hook activates the cap.
    reg.setFocus('s1');
    expect(reg.active).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect(reg.acquire(`a${i}`, `as${i}`, false, ctrl)).toBe(true);
    }
    expect(reg.acquire('a4', 'as4', false, ctrl)).toBe(false);
    reg.release('a0');
    expect(reg.acquire('a4', 'as4', false, ctrl)).toBe(true);
    expect(reg.holderCount).toBe(4);
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

    // Bounded: the stream stays open after the boundary, so a mutant
    // that ignores `replay_complete` must fail the deadline instead of
    // hanging the runner.
    const ctrl = new AbortController();
    const events = await collectBounded(
      reg.catchUp(
        fetchFn,
        'http://daemon/session/s1/events',
        { Accept: 'text/event-stream' },
        ctrl.signal,
        cursor,
      ),
      () => ctrl.abort(),
    );

    expect(seenLastEventId).toBe('10');
    expect(events.map((e) => e.id)).toEqual([11, 12, undefined]);
    expect(events[2].type).toBe('replay_complete');
    // The cursor advanced to the last replayed id (not the boundary).
    expect(cursor.value).toBe(12);
    // The temporary replay connection is closed after the boundary.
    expect(bodyCancelled).toBe(true);
  });

  it('sends Last-Event-ID 0 when the cursor has no value', async () => {
    const reg = new SseBudgetRegistry(4);
    let seenLastEventId: string | null = null;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenLastEventId = new Headers(init?.headers).get('last-event-id');
      return sseResponse([
        sseFrame({ v: 1, type: 'replay_complete', data: { replayedCount: 0 } }),
      ]);
    }) as typeof globalThis.fetch;

    // Bounded: after the boundary the stream stays open; a mutant that
    // ignores `replay_complete` must fail the deadline, not hang.
    // A MISSING Last-Event-ID means live-only for the daemon (a
    // permanent hole), so a cursorless catch-up must send `0`.
    const ctrl = new AbortController();
    await collectBounded(
      reg.catchUp(
        fetchFn,
        'http://daemon/session/s1/events',
        { Accept: 'text/event-stream' },
        ctrl.signal,
        {},
      ),
      () => ctrl.abort(),
    );
    expect(seenLastEventId).toBe('0');
  });

  it('throws DaemonHttpError with the daemon error field on non-2xx', async () => {
    const reg = new SseBudgetRegistry(4);
    const response = new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
    const cancelSpy = vi.spyOn(
      response.body as ReadableStream<Uint8Array>,
      'cancel',
    );
    const fetchFn = (async () => response) as typeof globalThis.fetch;

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
    // The error path never reaches the stream reader, so the cycle's
    // own finally is the body's only teardown: the cancel must have
    // happened before the error left the generator.
    expect(cancelSpy).toHaveBeenCalled();
    cancelSpy.mockRestore();
  });

  it('throws DaemonHttpError when the response is not text/event-stream', async () => {
    const reg = new SseBudgetRegistry(4);
    const response = new Response('<html>proxy</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const cancelSpy = vi.spyOn(
      response.body as ReadableStream<Uint8Array>,
      'cancel',
    );
    const fetchFn = (async () => response) as typeof globalThis.fetch;

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
    // The mis-typed body must be released by the cycle before the
    // error propagates — a held body would pin the connection.
    expect(cancelSpy).toHaveBeenCalled();
    cancelSpy.mockRestore();
  });

  it('ends a silent body within the frame window (wall-clock bound)', async () => {
    // A body that never sends another frame must not park the cycle
    // (and its context-wide lock) forever: the per-cycle controller
    // aborts after the frame window and the reader unwinds cleanly.
    vi.useFakeTimers();
    try {
      const reg = new SseBudgetRegistry(4);
      const ctrl = new AbortController();
      const gen = reg.catchUp(
        async () => sseResponse([], () => {}),
        'http://daemon/session/s1/events',
        {},
        ctrl.signal,
        { value: 10 },
      );
      const r = await Promise.race([
        gen.next(),
        vi.advanceTimersByTimeAsync(6_000).then(() => 'TIMEOUT' as const),
      ]);
      expect(r).not.toBe('TIMEOUT');
      expect((r as IteratorResult<DaemonEvent>).done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the x-qwen-event-epoch header through onEpoch', async () => {
    const reg = new SseBudgetRegistry(4);
    let epoch: string | undefined;
    const encoder = new TextEncoder();
    const boundary =
      'data: ' +
      JSON.stringify({
        v: 1,
        type: 'replay_complete',
        data: { replayedCount: 0 },
      }) +
      '\n\n';
    const fetchFn = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(boundary));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-qwen-event-epoch': 'epoch-42',
          },
        },
      )) as typeof globalThis.fetch;

    const gen = reg.catchUp(
      fetchFn,
      'http://daemon/session/s1/events',
      {},
      new AbortController().signal,
      { value: 0 },
      (value) => {
        epoch = value;
      },
    );
    await collect(gen);
    expect(epoch).toBe('epoch-42');
  });

  it('aborts a hanging connect after the connect timeout', async () => {
    // A fetch that never settles must not park the cycle (and its
    // context-wide lock) until the TCP layer gives up: the connect
    // timeout fires on the per-cycle controller and unwinds the
    // request with an AbortError the retry loop can act on.
    vi.useFakeTimers();
    const reg = new SseBudgetRegistry(4);
    const gen = reg.catchUp(
      (async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () =>
            reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });
        })) as typeof globalThis.fetch,
      'http://daemon/session/s1/events',
      {},
      new AbortController().signal,
      { value: 10 },
    );
    const r = await Promise.race([
      gen.next().then(
        () => 'RESOLVED' as const,
        (e: unknown) => `REJECTED:${(e as Error).name}` as const,
      ),
      vi.advanceTimersByTimeAsync(9_000).then(() => 'DEADLINE' as const),
    ]);
    expect(r).toBe('REJECTED:AbortError');
  });

  it('ends the cycle cleanly when the caller aborts mid-cycle', async () => {
    // A caller abort while the replay body is still open must end the
    // cycle without throwing: the consumer sees a clean `done`, the
    // temporary body is cancelled, and no read stays parked.
    const reg = new SseBudgetRegistry(4);
    let bodyCancelled = false;
    const ctrl = new AbortController();
    const gen = reg.catchUp(
      async () =>
        sseResponse(
          [sseFrame({ v: 1, type: 'session_update', data: {}, id: 1 })],
          () => {
            bodyCancelled = true;
          },
        ),
      'http://daemon/session/s1/events',
      {},
      ctrl.signal,
      { value: 0 },
    );
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect((first.value as DaemonEvent).id).toBe(1);
    ctrl.abort();
    const second = await Promise.race([
      gen.next().then(
        (result) => result as IteratorResult<DaemonEvent>,
        (e: unknown) => ({ done: `REJECTED:${(e as Error).name}` }) as never,
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('cycle did not end on caller abort')),
          2_000,
        ),
      ),
    ]);
    expect(second.done).toBe(true);
    expect(bodyCancelled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Abort-signal hygiene (fallback compose path)
// ---------------------------------------------------------------------------

describe('SseBudgetRegistry signal hygiene', () => {
  it('detaches fallback compose listeners from the caller signal', async () => {
    // Without native AbortSignal.any, the composed catch-up signal is
    // wired with per-input 'abort' listeners. Every catch-up cycle must
    // detach them again — otherwise a long-lived subscription signal
    // accumulates one listener per cycle.
    const nativeAny = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    try {
      const reg = new SseBudgetRegistry(4);
      const outer = new AbortController();
      let adds = 0;
      let removes = 0;
      const origAdd = outer.signal.addEventListener.bind(outer.signal);
      const origRemove = outer.signal.removeEventListener.bind(outer.signal);
      (
        outer.signal as unknown as { addEventListener: unknown }
      ).addEventListener = (
        type: string,
        listener: EventListener,
        options?: AddEventListenerOptions | boolean,
      ) => {
        adds++;
        origAdd(type, listener, options);
      };
      (
        outer.signal as unknown as { removeEventListener: unknown }
      ).removeEventListener = (
        type: string,
        listener: EventListener,
        options?: EventListenerOptions | boolean,
      ) => {
        removes++;
        origRemove(type, listener, options);
      };

      const gen = reg.catchUp(
        async () => sseResponse([], () => {}),
        'http://daemon/session/s1/events',
        {},
        outer.signal,
        { value: 0 },
      );
      void gen.next();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(adds).toBeGreaterThan(0);

      outer.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(removes).toBe(adds);
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = nativeAny;
    }
  });
});

// ---------------------------------------------------------------------------
// Same-session takeover
// ---------------------------------------------------------------------------

describe('SseBudgetRegistry same-session takeover', () => {
  it('a second view of a held session takes the slot instead of blocking', () => {
    const reg = new SseBudgetRegistry(4);
    const mainCtrl = new AbortController();
    expect(reg.acquire('main', 'S', false, mainCtrl)).toBe(true);
    for (let i = 1; i <= 3; i++) {
      reg.acquire(`p${i}`, `s${i}`, false, new AbortController());
    }
    expect(reg.holderCount).toBe(4);

    // A split pane rendering the same session S takes over main's
    // slot; main is demoted with an AbortError the transport treats
    // as a clean end (it then resumes losslessly via catch-up).
    const paneCtrl = new AbortController();
    expect(reg.acquire('pane0', 'S', false, paneCtrl)).toBe(true);
    expect(mainCtrl.signal.aborted).toBe(true);
    const reason = mainCtrl.signal.reason as DOMException;
    expect(reason.name).toBe('AbortError');
    expect(reason.message).toContain('demoted');
    expect(reg.holderCount).toBe(4);

    // The budget did not grow: a fifth, different session is still
    // denied — the extra slot came from removing the duplicate, not
    // from enlarging the cap.
    expect(reg.acquire('p5', 's5', false, new AbortController())).toBe(false);
  });

  it('the per-key cooldown stops two views trading the slot', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    try {
      const reg = new SseBudgetRegistry(4);
      const mainCtrl = new AbortController();
      reg.acquire('main', 'S', false, mainCtrl);
      for (let i = 2; i <= 4; i++) {
        reg.acquire(`p${i}`, `s${i}`, false, new AbortController());
      }

      const paneCtrl = new AbortController();
      expect(reg.acquire('pane', 'S', false, paneCtrl)).toBe(true);
      expect(mainCtrl.signal.aborted).toBe(true);

      // main's immediate re-acquire: its key is cooling down, so it
      // must not take the slot back (the two views would otherwise
      // trade it on every 2.5 s catch-up probe).
      expect(reg.acquire('main', 'S', false, new AbortController())).toBe(
        false,
      );
      expect(paneCtrl.signal.aborted).toBe(false);
      expect(reg.holderCount).toBe(4);

      vi.setSystemTime(new Date(1_031_000));
      expect(reg.acquire('main', 'S', false, new AbortController())).toBe(true);
      expect(paneCtrl.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
