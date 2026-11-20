/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behavioral tests for the per-context live-stream budget
 * (QwenLM/qwen-code#13908): with 4-5 split-view panes the browser's
 * per-origin HTTP/1.1 pool (6 connections in WebKit) must not be
 * saturated by persistent SSE streams. At most 4 live streams stay
 * open; the excess subscriptions do serialized catch-up cycles
 * (replay with Last-Event-ID until `replay_complete`) and the focused
 * pane may evict the least-recently active background holder.
 *
 * NEGATIVE CONTROL: against the pre-fix transport (no budget
 * integration) the cap tests in this file fail — every pane opens its
 * own persistent live connection (5 open for 5 panes, no catch-up
 * cycle, no eviction).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RestSseTransport } from '../../src/daemon/RestSseTransport.js';
import {
  SSE_CATCH_UP_RETRY_DELAY_MS,
  resetSseBudgetRegistry,
  setSseBudgetFocus,
} from '../../src/daemon/SseBudget.js';
import { DaemonHttpError } from '../../src/daemon/DaemonHttpError.js';
import type { DaemonEvent } from '../../src/daemon/types.js';

// ---------------------------------------------------------------------------
// Fake daemon
// ---------------------------------------------------------------------------

interface FakeConn {
  sessionId: string;
  lastEventId: number | undefined;
  closed: boolean;
  lateTimer?: ReturnType<typeof setTimeout>;
}

/**
 * A minimal `GET /session/:id/events` fake:
 *   - cursor-based connections (Last-Event-ID) replay the events above
 *     the cursor and emit the `replay_complete` boundary — the daemon's
 *     EventBus behavior for a resuming consumer;
 *   - cursorless connections are live-only (no boundary), like a fresh
 *     subscription;
 *   - every stream stays OPEN after its initial frames until the client
 *     cancels the body (a live SSE connection);
 *   - a late live frame arrives LATE_FRAME_DELAY_MS after connect: an
 *     active session keeps producing, so a parked reader eventually gets
 *     a frame — pre-fix code (every pane on its own silent live stream)
 *     then fails the assertions instead of hanging the runner.
 */

/** Delay of the late live frame (see makeFakeDaemon). */
const LATE_FRAME_DELAY_MS = 500;

function makeFakeDaemon(
  opts: {
    notFound?: Set<string>;
    override?: (
      sessionId: string,
      lastEventId: number | undefined,
    ) => Response | undefined;
  } = {},
) {
  const connections: FakeConn[] = [];
  const encoder = new TextEncoder();
  const fetchImpl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = url.match(/\/session\/([^/]+)\/events/);
    const sessionId = match ? decodeURIComponent(match[1]) : 'unknown';
    const leRaw = new Headers(init?.headers).get('last-event-id');
    const lastEventId = leRaw === null ? undefined : Number(leRaw);
    const conn: FakeConn = { sessionId, lastEventId, closed: false };
    connections.push(conn);
    const overridden = opts.override?.(sessionId, lastEventId);
    if (overridden) return overridden;
    if (opts.notFound?.has(sessionId)) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const total = 12;
    const frames: string[] = [];
    for (let id = (lastEventId ?? 0) + 1; id <= total; id++) {
      frames.push(
        `data: ${JSON.stringify({ v: 1, type: 'session_update', data: {}, id })}\n\n`,
      );
    }
    if (lastEventId !== undefined) {
      frames.push(
        `data: ${JSON.stringify({ v: 1, type: 'replay_complete', data: { replayedCount: total - (lastEventId ?? 0) } })}\n\n`,
      );
    }
    const lateFrame = `data: ${JSON.stringify({ v: 1, type: 'session_update', data: {}, id: total + 1 })}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        const lateTimer = setTimeout(() => {
          if (conn.closed) return;
          try {
            controller.enqueue(encoder.encode(lateFrame));
          } catch {
            /* body cancelled between timer setup and fire */
          }
        }, LATE_FRAME_DELAY_MS);
        (lateTimer as { unref?: () => void }).unref?.();
        conn.lateTimer = lateTimer;
        // Live streams stay open until the client cancels the body.
      },
      cancel() {
        conn.closed = true;
        if (conn.lateTimer !== undefined) clearTimeout(conn.lateTimer);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return {
    fetch: fetchImpl as typeof globalThis.fetch,
    connections,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const connsFor = (conns: FakeConn[], sessionId: string) =>
  conns.filter((c) => c.sessionId === sessionId);

const openConns = (conns: FakeConn[]) => conns.filter((c) => !c.closed);

async function pump(
  gen: AsyncGenerator<DaemonEvent>,
  count: number,
): Promise<DaemonEvent[]> {
  const out: DaemonEvent[] = [];
  for (let i = 0; i < count; i++) {
    const r = await gen.next();
    expect(r.done).toBe(false);
    out.push(r.value as DaemonEvent);
  }
  return out;
}

/** Let pending microtasks (e.g. a body cancel) settle. */
const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetSseBudgetRegistry();
});

// ---------------------------------------------------------------------------
// Cap + catch-up
// ---------------------------------------------------------------------------

describe('RestSseTransport SSE budget', () => {
  it('keeps 4 live streams open; the 5th pane catches up via Last-Event-ID and closes its temporary connection', async () => {
    // Activate the (dormant) module registry: the web shell's first
    // focus hook does this; tests without a focus hook must do it
    // explicitly, otherwise no cap is enforced at all.
    setSseBudgetFocus(null);
    const { fetch, connections } = makeFakeDaemon();
    const transport = new RestSseTransport('http://daemon', undefined, fetch);

    const gens = ['A', 'B', 'C', 'D'].map((id) =>
      transport.subscribeEvents(id),
    );
    for (const gen of gens) await pump(gen, 1);

    // Pane E reconnects with a cursor: 4 slots are held, so it must not
    // open a 5th persistent stream. Instead it does a catch-up cycle
    // (replay from id 5) and the temporary connection is closed after
    // the replay boundary (the boundary itself is swallowed — it must
    // not reach the consumer as a live reconnect marker).
    const itE = transport.subscribeEvents('E', { lastEventId: 5 });
    const got = await pump(itE, 7); // ids 6..12, boundary swallowed
    expect(got.map((e) => e.id)).toEqual([6, 7, 8, 9, 10, 11, 12]);
    // Resume the cycle: the catch-up generator breaks at the boundary,
    // cancels the body, then parks on the retry wait.
    void itE.next();
    await drain();

    const eConns = connsFor(connections, 'E');
    expect(eConns).toHaveLength(1);
    expect(eConns[0].lastEventId).toBe(5);
    expect(eConns[0].closed).toBe(true);
    for (const id of ['A', 'B', 'C', 'D']) {
      const c = connsFor(connections, id);
      expect(c).toHaveLength(1);
      expect(c[0].lastEventId).toBeUndefined();
      expect(c[0].closed).toBe(false);
    }
    // 4 live connections — the 5th pane adds no persistent stream.
    expect(openConns(connections)).toHaveLength(4);
  });

  it('holds at most 4 live streams for 6 panes (at, never above, the 6-connection pool)', async () => {
    setSseBudgetFocus(null);
    const { fetch, connections } = makeFakeDaemon();
    const transport = new RestSseTransport('http://daemon', undefined, fetch);

    const gens = ['A', 'B', 'C', 'D'].map((id) =>
      transport.subscribeEvents(id),
    );
    for (const gen of gens) await pump(gen, 1);

    // E (no cursor): catch-up cycle — a cursorless catch-up sends
    // Last-Event-ID 0, so the fake daemon replays the whole ring
    // (ids 1..12); E consumes them and parks on the retry wait at the
    // (swallowed) boundary. The connection is the temporary one.
    const itE = transport.subscribeEvents('E');
    await pump(itE, 12);

    // The cycle lock is released at E's first frame (it bounds the
    // replay request, not the consumer's drain), so F starts its own
    // cycle right away. That is the only overlap possible — a third
    // over-budget pane finds F's cycle in flight and only waits — so
    // the open-connection peak is 4 live + 2 temporary = the pool cap.
    const itF = transport.subscribeEvents('F');
    const rF = await itF.next();
    expect(rF.done).toBe(false);
    expect(rF.value?.id).toBe(1);
    await drain();

    for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) {
      expect(connsFor(connections, id).every((c) => c.closed)).toBe(false);
    }
    expect(openConns(connections)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Focus eviction
// ---------------------------------------------------------------------------

describe('RestSseTransport SSE budget focus eviction', () => {
  it('the focused pane evicts the least-recently active background holder', async () => {
    setSseBudgetFocus('E');
    const { fetch, connections } = makeFakeDaemon();
    const transport = new RestSseTransport('http://daemon', undefined, fetch);

    const itA = transport.subscribeEvents('A');
    const itB = transport.subscribeEvents('B');
    const itC = transport.subscribeEvents('C');
    const itD = transport.subscribeEvents('D');
    // Pumped in order, so A is the least-recently active holder.
    await pump(itA, 1);
    await pump(itB, 1);
    await pump(itC, 1);
    await pump(itD, 1);

    const itE = transport.subscribeEvents('E');
    const rE = await itE.next();
    expect(rE.done).toBe(false);

    // A's live request was aborted ("preempted"): its generator
    // completes cleanly, and the connection is closed.
    const rA = await itA.next();
    expect(rA.done).toBe(true);
    expect(connsFor(connections, 'A')[0].closed).toBe(true);

    const eConns = connsFor(connections, 'E');
    expect(eConns).toHaveLength(1);
    expect(eConns[0].lastEventId).toBeUndefined();
    expect(eConns[0].closed).toBe(false);
    // Still exactly 4 live streams — now B, C, D and E.
    const open = openConns(connections)
      .map((c) => c.sessionId)
      .sort();
    expect(open).toEqual(['B', 'C', 'D', 'E']);
  });

  it('a pane that is not the focused session never evicts (background acquires are denied)', async () => {
    // Focus belongs to an unrelated session: E !== 'Z' and focus is not
    // null, so E must take the background path (catch-up) and no
    // existing holder may be preempted.
    setSseBudgetFocus('Z');
    const { fetch, connections } = makeFakeDaemon();
    const transport = new RestSseTransport('http://daemon', undefined, fetch);

    const gens = ['A', 'B', 'C', 'D'].map((id) =>
      transport.subscribeEvents(id),
    );
    for (const gen of gens) await pump(gen, 1);

    const itE = transport.subscribeEvents('E', { lastEventId: 5 });
    const rE = await itE.next();
    expect(rE.done).toBe(false);
    // E took the catch-up path (replay from id 5)...
    expect(rE.value?.id).toBe(6);
    expect(connsFor(connections, 'E')[0].lastEventId).toBe(5);
    // ...and nobody was evicted: all 4 background holders stay live.
    for (const id of ['A', 'B', 'C', 'D']) {
      expect(connsFor(connections, id)[0].closed).toBe(false);
    }
  });

  it('live frames refresh LRU order, so a recently active pane survives focus eviction', async () => {
    vi.useFakeTimers();
    try {
      setSseBudgetFocus('E');
      const { fetch, connections } = makeFakeDaemon();
      const transport = new RestSseTransport('http://daemon', undefined, fetch);

      // A acquires first, so by acquire-time it is the LRU holder.
      const itA = transport.subscribeEvents('A');
      const itB = transport.subscribeEvents('B');
      const itC = transport.subscribeEvents('C');
      const itD = transport.subscribeEvents('D');
      await pump(itA, 1);
      await pump(itB, 1);
      await pump(itC, 1);
      await pump(itD, 1);

      // A keeps delivering frames, so the frame-level touch makes A the
      // MOST recently active holder (B is the LRU one now).
      await vi.advanceTimersByTimeAsync(1_000);
      await pump(itA, 2);

      const itE = transport.subscribeEvents('E');
      const rE = await itE.next();
      expect(rE.done).toBe(false);

      // B (least recently active) is evicted, A survives the eviction.
      const rB = await itB.next();
      expect(rB.done).toBe(true);
      expect(connsFor(connections, 'B')[0].closed).toBe(true);
      for (const id of ['A', 'C', 'D', 'E']) {
        expect(connsFor(connections, id)[0].closed).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Promotion from the advanced cursor
// ---------------------------------------------------------------------------

describe('RestSseTransport SSE budget promotion', () => {
  it('a background pane promoted after a slot frees connects live from the catch-up cursor', async () => {
    vi.useFakeTimers();
    try {
      setSseBudgetFocus(null);
      const { fetch, connections } = makeFakeDaemon();
      const transport = new RestSseTransport('http://daemon', undefined, fetch);

      const itA = transport.subscribeEvents('A');
      const itB = transport.subscribeEvents('B');
      const itC = transport.subscribeEvents('C');
      const itD = transport.subscribeEvents('D');
      await pump(itA, 1);
      await pump(itB, 1);
      await pump(itC, 1);
      await pump(itD, 1);

      // E reconnects with a cursor and catches up (6..12; the
      // boundary is swallowed by the transport and ends the cycle).
      const itE = transport.subscribeEvents('E', { lastEventId: 5 });
      await pump(itE, 7);

      // A pane closes: its slot is released.
      await itA.return();
      expect(connsFor(connections, 'A')[0].closed).toBe(true);

      // E resumes: the catch-up body is cancelled, the retry wait
      // (2.5 s) elapses, and E takes the freed slot LIVE — resuming
      // from the furthest id its catch-up delivered (12). Bounded: if
      // the freed slot is never observed (e.g. teardown does not
      // release it, or the catch-up cycle lock is never ended) E must
      // fail the deadline instead of hanging the runner.
      const nextE = itE.next();
      const rE = await Promise.race([
        nextE,
        vi
          .advanceTimersByTimeAsync(3 * SSE_CATCH_UP_RETRY_DELAY_MS)
          .then(() => 'TIMEOUT' as const),
      ]);
      expect(rE).not.toBe('TIMEOUT');
      expect((rE as IteratorResult<DaemonEvent>).done).toBe(false);

      const eConns = connsFor(connections, 'E');
      expect(eConns).toHaveLength(2);
      expect(eConns[0].lastEventId).toBe(5);
      expect(eConns[0].closed).toBe(true);
      expect(eConns[1].lastEventId).toBe(12);
      expect(eConns[1].closed).toBe(false);

      // The promoted connection must be LIVE, not a catch-up cycle:
      // drive one more step — a catch-up would have broken at the
      // replay boundary and cancelled its body by now.
      void itE.next();
      await vi.advanceTimersByTimeAsync(0);
      expect(eConns[1].closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Catch-up error parity with the live path
// ---------------------------------------------------------------------------

describe('RestSseTransport SSE budget catch-up errors', () => {
  it('a failed catch-up fails the subscription (DaemonHttpError) and frees the cycle', async () => {
    // Nobody is focused: no pane may evict, so both E and F must go
    // through catch-up cycles.
    setSseBudgetFocus('Z');
    const { fetch, connections } = makeFakeDaemon({ notFound: new Set(['E']) });
    const transport = new RestSseTransport('http://daemon', undefined, fetch);

    const gens = ['A', 'B', 'C', 'D'].map((id) =>
      transport.subscribeEvents(id),
    );
    for (const gen of gens) await pump(gen, 1);

    const itE = transport.subscribeEvents('E', { lastEventId: 5 });
    let error: unknown;
    try {
      await itE.next();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DaemonHttpError);
    expect((error as DaemonHttpError).status).toBe(404);

    // The failed cycle was released: F's catch-up works. Bounded: if
    // the cycle lock were never ended, F would sit in the retry wait
    // forever — the deadline turns that hang into a deterministic fail.
    vi.useFakeTimers();
    try {
      const itF = transport.subscribeEvents('F', { lastEventId: 5 });
      const rF = await Promise.race([
        itF.next(),
        vi
          .advanceTimersByTimeAsync(3 * SSE_CATCH_UP_RETRY_DELAY_MS)
          .then(() => 'TIMEOUT' as const),
      ]);
      expect(rF).not.toBe('TIMEOUT');
      expect((rF as IteratorResult<DaemonEvent>).done).toBe(false);
      expect((rF as IteratorResult<DaemonEvent>).value?.id).toBe(6);
      expect(connsFor(connections, 'F')[0].lastEventId).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// R3 round: retryable failures, boundary handling, slow consumers
// ---------------------------------------------------------------------------

describe('RestSseTransport SSE budget retries and boundaries', () => {
  it('a 5xx catch-up fails the cycle and retries, keeping the subscription alive', async () => {
    vi.useFakeTimers();
    try {
      setSseBudgetFocus(null);
      let attempts = 0;
      const { fetch } = makeFakeDaemon({
        override: (sessionId) => {
          if (sessionId === 'E' && ++attempts === 1) {
            return new Response(JSON.stringify({ error: 'bad gateway' }), {
              status: 502,
              headers: { 'content-type': 'application/json' },
            });
          }
          return undefined;
        },
      });
      const transport = new RestSseTransport('http://daemon', undefined, fetch);
      const gens = ['A', 'B', 'C', 'D'].map((id) =>
        transport.subscribeEvents(id),
      );
      for (const gen of gens) await pump(gen, 1);

      // The first cycle dies with a 502 (retryable: transient proxy
      // failure). The retry wait elapses and the second cycle replays
      // from the same cursor — the subscription itself never fails.
      const itE = transport.subscribeEvents('E', { lastEventId: 5 });
      const nextE = itE.next();
      const rE = await Promise.race([
        nextE,
        vi
          .advanceTimersByTimeAsync(3 * SSE_CATCH_UP_RETRY_DELAY_MS)
          .then(() => 'TIMEOUT' as const),
      ]);
      expect(rE).not.toBe('TIMEOUT');
      expect((rE as IteratorResult<DaemonEvent>).value?.id).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('catch-up boundaries are swallowed; the promoted live stream forwards its boundary', async () => {
    vi.useFakeTimers();
    try {
      setSseBudgetFocus(null);
      const { fetch } = makeFakeDaemon();
      const transport = new RestSseTransport('http://daemon', undefined, fetch);
      const itA = transport.subscribeEvents('A');
      const itB = transport.subscribeEvents('B');
      const itC = transport.subscribeEvents('C');
      const itD = transport.subscribeEvents('D');
      await pump(itA, 1);
      await pump(itB, 1);
      await pump(itC, 1);
      await pump(itD, 1);

      // The replay boundary (after id 12) must not reach the consumer:
      // forwarding it would make every catch-up cycle look like a live
      // reconnect (turn-index polling, assistant-block splits).
      const itE = transport.subscribeEvents('E', { lastEventId: 5 });
      const got = await pump(itE, 7);
      expect(got.map((e) => e.id)).toEqual([6, 7, 8, 9, 10, 11, 12]);

      // A slot frees: E is promoted LIVE from cursor 12 — that
      // connection's `replay_complete` is the live-path reconnect
      // marker and must be forwarded.
      await itA.return();
      const nextE = itE.next();
      const rE = await Promise.race([
        nextE,
        vi
          .advanceTimersByTimeAsync(3 * SSE_CATCH_UP_RETRY_DELAY_MS)
          .then(() => 'TIMEOUT' as const),
      ]);
      expect(rE).not.toBe('TIMEOUT');
      expect((rE as IteratorResult<DaemonEvent>).value?.type).toBe(
        'replay_complete',
      );
      expect((rE as IteratorResult<DaemonEvent>).value?.id).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a slow consumer does not block the next pane from catching up', async () => {
    vi.useFakeTimers();
    try {
      setSseBudgetFocus(null);
      const { fetch, connections } = makeFakeDaemon();
      const transport = new RestSseTransport('http://daemon', undefined, fetch);
      const gens = ['A', 'B', 'C', 'D'].map((id) =>
        transport.subscribeEvents(id),
      );
      for (const gen of gens) await pump(gen, 1);

      // E catches up, but its consumer never drains past the first frame.
      const itE = transport.subscribeEvents('E', { lastEventId: 5 });
      const rE = await itE.next();
      expect(rE.value?.id).toBe(6);

      // F proceeds immediately — the cycle lock is released as soon as
      // E's first frame is yielded, not when E drains the replay — and
      // runs its own cycle.
      const itF = transport.subscribeEvents('F', { lastEventId: 5 });
      const nextF = itF.next();
      const rF = await Promise.race([
        nextF,
        vi.advanceTimersByTimeAsync(12_000).then(() => 'TIMEOUT' as const),
      ]);
      expect(rF).not.toBe('TIMEOUT');
      expect((rF as IteratorResult<DaemonEvent>).value?.id).toBe(6);
      expect(connsFor(connections, 'F')[0].lastEventId).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Same-session takeover (transport level)
// ---------------------------------------------------------------------------

describe('RestSseTransport SSE budget same-session takeover', () => {
  it('a pane showing the main session takes over its stream; all panes stay live', async () => {
    setSseBudgetFocus(null);
    const { fetch, connections } = makeFakeDaemon();
    const transport = new RestSseTransport('http://daemon', undefined, fetch);

    // Main view holds session S; the other three panes hold their own
    // sessions. The budget is full: S + P1 + P2 + P3.
    const itMain = transport.subscribeEvents('S');
    await pump(itMain, 1);
    const gens = ['P1', 'P2', 'P3'].map((id) => transport.subscribeEvents(id));
    for (const gen of gens) await pump(gen, 1);
    expect(openConns(connections)).toHaveLength(4);

    // Pane 0 renders the same session S: it takes the slot over — main
    // is demoted (clean end), and all four panes end up live on the
    // same four slots (the duplicate view needs no catch-up cycle).
    const itPane0 = transport.subscribeEvents('S');
    const rPane0 = await itPane0.next();
    expect(rPane0.done).toBe(false);
    expect(rPane0.value?.id).toBe(1);
    await drain();

    const rMain = await itMain.next();
    expect(rMain.done).toBe(true);
    expect(connsFor(connections, 'S')[0].closed).toBe(true);

    const open = openConns(connections)
      .map((c) => c.sessionId)
      .sort();
    expect(open).toEqual(['P1', 'P2', 'P3', 'S']);
  });
});
