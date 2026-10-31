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

function makeFakeDaemon(opts: { notFound?: Set<string> } = {}) {
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
    const { fetch, connections } = makeFakeDaemon();
    const transport = new RestSseTransport('http://daemon', undefined, fetch);

    const gens = ['A', 'B', 'C', 'D'].map((id) =>
      transport.subscribeEvents(id),
    );
    for (const gen of gens) await pump(gen, 1);

    // Pane E reconnects with a cursor: 4 slots are held, so it must not
    // open a 5th persistent stream. Instead it does a catch-up cycle
    // (replay from id 5) and the temporary connection is closed after
    // the replay boundary.
    const itE = transport.subscribeEvents('E', { lastEventId: 5 });
    const got = await pump(itE, 8); // ids 6..12 + replay_complete
    expect(got.map((e) => e.id)).toEqual([6, 7, 8, 9, 10, 11, 12, undefined]);
    expect(got[7].type).toBe('replay_complete');
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

  it('holds at most 4 live streams + 1 catch-up for 6 panes (below the 6-connection pool)', async () => {
    const { fetch, connections } = makeFakeDaemon();
    const transport = new RestSseTransport('http://daemon', undefined, fetch);

    const gens = ['A', 'B', 'C', 'D'].map((id) =>
      transport.subscribeEvents(id),
    );
    for (const gen of gens) await pump(gen, 1);

    // E (no cursor): catch-up cycle — the fake daemon is live-only for
    // cursorless connections, so E consumes the initial frames and
    // parks inside the cycle (the connection is the temporary one).
    const itE = transport.subscribeEvents('E');
    await pump(itE, 12);

    // F: no fetch at all — E's cycle is in flight, so F only waits.
    const itF = transport.subscribeEvents('F');
    void itF.next();
    await drain();

    expect(connsFor(connections, 'F')).toHaveLength(0);
    // 4 live (A-D) + 1 catch-up (E) = 5 open, under the pool cap of 6.
    expect(openConns(connections)).toHaveLength(5);
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
});

// ---------------------------------------------------------------------------
// Promotion from the advanced cursor
// ---------------------------------------------------------------------------

describe('RestSseTransport SSE budget promotion', () => {
  it('a background pane promoted after a slot frees connects live from the catch-up cursor', async () => {
    vi.useFakeTimers();
    try {
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

      // E reconnects with a cursor and catches up (6..12 + boundary).
      const itE = transport.subscribeEvents('E', { lastEventId: 5 });
      await pump(itE, 8);

      // A pane closes: its slot is released.
      await itA.return();
      expect(connsFor(connections, 'A')[0].closed).toBe(true);

      // E resumes: the catch-up body is cancelled, the retry wait
      // (2.5 s) elapses, and E takes the freed slot LIVE — resuming
      // from the furthest id its catch-up delivered (12).
      const nextE = itE.next();
      await vi.advanceTimersByTimeAsync(2_500);
      const rE = await nextE;
      expect(rE.done).toBe(false);

      const eConns = connsFor(connections, 'E');
      expect(eConns).toHaveLength(2);
      expect(eConns[0].lastEventId).toBe(5);
      expect(eConns[0].closed).toBe(true);
      expect(eConns[1].lastEventId).toBe(12);
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

    // The failed cycle was released: F's catch-up works.
    const itF = transport.subscribeEvents('F', { lastEventId: 5 });
    const rF = await itF.next();
    expect(rF.done).toBe(false);
    expect(rF.value?.id).toBe(6);
    expect(connsFor(connections, 'F')[0].lastEventId).toBe(5);
  });
});
