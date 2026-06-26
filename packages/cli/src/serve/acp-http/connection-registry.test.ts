/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ConnectionRegistry } from './connection-registry.js';
import type { TransportStream } from './transport-stream.js';

class FakeStream implements TransportStream {
  isClosed = false;
  /** Records every send so tests can assert the bus `id` is threaded. */
  readonly sent: Array<{ message: unknown; id?: number }> = [];

  constructor(readonly kind: 'sse' | 'ws') {}

  async send(message: unknown, id?: number): Promise<void> {
    this.sent.push({ message, id });
  }

  close(): void {
    this.isClosed = true;
  }
}

describe('ConnectionRegistry.getSnapshot', () => {
  it('counts SSE streams and redacts full connection ids', () => {
    const registry = new ConnectionRegistry(undefined, undefined, 2);
    try {
      const conn = registry.create(true);
      expect(conn).toBeDefined();
      if (!conn) return;

      conn.attachConnStream(new FakeStream('sse'));
      conn.ownSession('sess-1');
      conn.attachSessionStream(
        'sess-1',
        new FakeStream('sse'),
        new AbortController(),
      );
      conn.pending.set('request-1', {
        sessionId: 'sess-1',
        bridgeRequestId: 'permission-1',
        kind: 'permission',
      });

      const snapshot = registry.getSnapshot();

      expect(snapshot).toMatchObject({
        connectionCount: 1,
        connectionCap: 2,
        connectionStreams: 1,
        sessionStreams: 1,
        sseStreams: 2,
        wsStreams: 0,
        pendingClientRequests: 1,
      });
      expect(snapshot.connections[0]).toMatchObject({
        connectionIdPrefix: conn.connectionId.slice(0, 8),
        fromLoopback: true,
        ownedSessionCount: 1,
        sessionBindingCount: 1,
        pendingClientRequests: 1,
      });
      expect(snapshot.connections[0]?.connectionIdPrefix).toHaveLength(8);
      expect(JSON.stringify(snapshot)).not.toContain(conn.connectionId);
    } finally {
      registry.dispose();
    }
  });

  it('counts a shared WebSocket stream once while tracking session bindings', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(false);
      expect(conn).toBeDefined();
      if (!conn) return;

      const stream = new FakeStream('ws');
      conn.attachConnStream(stream);
      conn.ownSession('sess-1');
      conn.attachSessionStream('sess-1', stream, new AbortController());
      conn.ownSession('sess-2');
      conn.attachSessionStream('sess-2', stream, new AbortController());

      const snapshot = registry.getSnapshot();

      expect(snapshot.connectionStreams).toBe(1);
      expect(snapshot.sessionStreams).toBe(2);
      expect(snapshot.wsStreams).toBe(1);
      expect(snapshot.sseStreams).toBe(0);
    } finally {
      registry.dispose();
    }
  });

  it('non-resume attach flushes all pre-attach buffered frames WITH their bus id', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1'); // binding exists, no stream yet
      // Buffered before any stream attaches (id-bearing + an id-less frame).
      conn.sendSession('sess-1', { a: 1 }, 5);
      conn.sendSession('sess-1', { b: 2 }); // response frame, no bus id
      conn.sendSession('sess-1', { c: 3 }, 8);

      const stream = new FakeStream('sse');
      const binding = conn.attachSessionStream(
        'sess-1',
        stream,
        new AbortController(),
      );

      // Non-resume attach (no Last-Event-ID): flush EVERYTHING, each frame
      // keeping its id across the buffer → stream handoff (a regression to
      // `send(frame)` would drop the cursor for early §1.8 frames).
      expect(stream.sent).toEqual([
        { message: { a: 1 }, id: 5 },
        { message: { b: 2 }, id: undefined },
        { message: { c: 3 }, id: 8 },
      ]);
      // The binding no longer carries a `lastFlushedEventId` — the resume cursor
      // is the client's Last-Event-ID verbatim (see the resume test below).
      expect(
        (binding as unknown as { lastFlushedEventId?: number })
          .lastFlushedEventId,
      ).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('on resume, skips id-bearing buffered frames (ring owns them) AND defers id-less replies until flushBufferedSessionFrames (post-replay order)', () => {
    // Two regressions in one path:
    //  (1) silent-frame-loss: a frame sent to the dead socket (id below the
    //      buffer's ids, above the client cursor) must come back via ring
    //      replay — so the buffer must NOT flush bus events on resume.
    //  (2) out-of-order completion: an id-less `session/prompt` result buffered
    //      during the gap must NOT be flushed at attach (it would arrive BEFORE
    //      the ring replays the content chunks that preceded it). It's deferred
    //      and released by the pump after `replay_complete`.
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');
      // Gap buffer holds two bus events (ids 6, 7) and one id-less reply.
      conn.sendSession('sess-1', { a: 1 }, 6);
      conn.sendSession('sess-1', { reply: true }); // JSON-RPC reply, no bus id
      conn.sendSession('sess-1', { c: 3 }, 7);

      const stream = new FakeStream('sse');
      // Client resumes from id 3 (it never saw frame 4, lost in-flight).
      conn.attachSessionStream('sess-1', stream, new AbortController(), 3);

      // At attach: NOTHING is sent. Bus events (6,7) belong to the ring replay;
      // the id-less reply is deferred so it can't jump ahead of replayed content.
      expect(stream.sent).toEqual([]);

      // The pump calls this once the replay boundary passes → the deferred
      // reply is released, after the (replayed) content chunks.
      conn.flushBufferedSessionFrames('sess-1');
      expect(stream.sent).toEqual([
        { message: { reply: true }, id: undefined },
      ]);
    } finally {
      registry.dispose();
    }
  });

  it('detachSessionStream is a no-op for a stale stream after reclaim (identity guard)', () => {
    // The CONTRACT at the attach site marks this guard load-bearing: once a
    // reclaim installs s2, the OLD stream s1 closing must NOT tear down or
    // re-arm grace on the fresh binding — that would be frame loss
    // indistinguishable from a network drop.
    vi.useFakeTimers();
    const detached: string[] = [];
    const registry = new ConnectionRegistry(undefined, (sid) =>
      detached.push(sid),
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      const s1 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s1, new AbortController());
      conn.detachSessionStream('sess-1', s1, 10_000); // grace armed for s1
      const s2 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s2, new AbortController()); // reclaim
      const graceAfterReclaim = conn.sessions.get('sess-1')?.graceTimer;
      expect(graceAfterReclaim).toBeUndefined(); // reclaim cleared the timer

      // The stale s1 close arrives late — must be a pure no-op.
      conn.detachSessionStream('sess-1', s1, 10_000);
      expect(conn.sessions.get('sess-1')?.stream).toBe(s2); // s2 still bound
      expect(conn.sessions.get('sess-1')?.graceTimer).toBeUndefined(); // no re-arm
      expect(conn.ownsSession('sess-1')).toBe(true);

      // And no teardown fires from the stale close.
      vi.advanceTimersByTime(20_000);
      expect(detached).not.toContain('sess-1');
      expect(conn.sessions.get('sess-1')?.stream).toBe(s2);
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });

  it('detachSessionStream keeps ownership/prompt across the grace window, then tears down on expiry', () => {
    vi.useFakeTimers();
    const detached: string[] = [];
    const registry = new ConnectionRegistry(undefined, (sid) =>
      detached.push(sid),
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      const stream = new FakeStream('sse');
      const binding = conn.attachSessionStream(
        'sess-1',
        stream,
        new AbortController(),
      );
      const promptAbort = new AbortController();
      binding.promptAbort = promptAbort;

      // Transport-level close → detach with grace (NOT teardown).
      conn.detachSessionStream('sess-1', stream, 10_000);
      expect(conn.ownsSession('sess-1')).toBe(true);
      expect(conn.sessions.has('sess-1')).toBe(true);
      expect(promptAbort.signal.aborted).toBe(false); // prompt survives
      expect(binding.stream).toBeUndefined(); // frames buffer until reconnect

      // No reconnect within the window → full teardown.
      vi.advanceTimersByTime(10_000);
      expect(conn.ownsSession('sess-1')).toBe(false);
      expect(conn.sessions.has('sess-1')).toBe(false);
      expect(promptAbort.signal.aborted).toBe(true);
      expect(detached).toContain('sess-1');
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });

  it('attachSessionStream within the grace window reclaims (cancels the pending teardown)', () => {
    vi.useFakeTimers();
    const detached: string[] = [];
    const registry = new ConnectionRegistry(undefined, (sid) =>
      detached.push(sid),
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      const s1 = new FakeStream('sse');
      const binding = conn.attachSessionStream(
        'sess-1',
        s1,
        new AbortController(),
      );
      const promptAbort = new AbortController();
      binding.promptAbort = promptAbort;

      conn.detachSessionStream('sess-1', s1, 10_000);
      // Reconnect within grace.
      const s2 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s2, new AbortController());

      // Past the original grace — teardown must NOT fire (timer cleared).
      vi.advanceTimersByTime(20_000);
      expect(conn.ownsSession('sess-1')).toBe(true);
      expect(promptAbort.signal.aborted).toBe(false);
      expect(detached).not.toContain('sess-1');
      expect(conn.sessions.get('sess-1')?.stream).toBe(s2);
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });

  it('buffers events produced during the detach gap and flushes them exactly once on reattach', () => {
    // End-to-end of the PR's core value prop at the registry layer: detach →
    // produce gap events (no stream attached → buffered) → reattach → the gap
    // events flush exactly once, in order. (A resuming reattach instead leaves
    // id-bearing frames to the ring replay — covered by the resume test above.)
    vi.useFakeTimers();
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      const s1 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s1, new AbortController());

      // Transport-level close → detach with grace; stream is gone, ownership
      // and the binding survive so subsequent frames buffer.
      conn.detachSessionStream('sess-1', s1, 10_000);
      expect(conn.sessions.get('sess-1')?.stream).toBeUndefined();

      // Gap events arrive while detached — they must buffer, not drop.
      conn.sendSession('sess-1', { chunk: 'a' }, 10);
      conn.sendSession('sess-1', { chunk: 'b' }, 11);
      expect(s1.sent).toEqual([]); // old stream is gone — nothing leaks to it

      // Non-resume reattach (no Last-Event-ID) → flush the whole gap buffer once.
      const s2 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s2, new AbortController());
      expect(s2.sent).toEqual([
        { message: { chunk: 'a' }, id: 10 },
        { message: { chunk: 'b' }, id: 11 },
      ]);

      // The buffer is drained — a second reattach delivers nothing again.
      const s3 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s3, new AbortController());
      expect(s3.sent).toEqual([]);
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });

  it('aborts the connection signal when the connection is deleted', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(false);
      expect(conn).toBeDefined();
      if (!conn) return;

      expect(conn.abortSignal.aborted).toBe(false);
      registry.delete(conn.connectionId);

      expect(conn.abortSignal.aborted).toBe(true);
    } finally {
      registry.dispose();
    }
  });
});
