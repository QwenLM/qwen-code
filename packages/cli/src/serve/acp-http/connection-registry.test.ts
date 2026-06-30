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

  it('flushBufferedSessionFrames leaves frames buffered when the stream is already closed (no drop onto a dead socket)', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');
      conn.sendSession('sess-1', { reply: true }); // id-less reply

      const s1 = new FakeStream('sse');
      // Resume attach defers the id-less reply into the buffer (s1 stays empty).
      conn.attachSessionStream('sess-1', s1, new AbortController(), 3);
      expect(s1.sent).toEqual([]);

      // Socket dies before the pump reaches the replay boundary.
      s1.close();
      conn.flushBufferedSessionFrames('sess-1');
      expect(s1.sent).toEqual([]); // nothing dropped onto the dead stream

      // The reply is still buffered: a fresh reconnect (non-resume) delivers it.
      conn.detachSessionStream('sess-1', s1, 10_000);
      const s2 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s2, new AbortController());
      expect(s2.sent).toEqual([{ message: { reply: true }, id: undefined }]);
    } finally {
      registry.dispose();
    }
  });

  it('under a content flood the pre-attach buffer evicts id-bearing (ring-replayable) frames and keeps the irreplaceable id-less reply', () => {
    // The buffer cap (256) is shared between id-bearing bus events (the ring
    // redelivers them on reconnect) and id-less deferred JSON-RPC replies (the
    // ring does NOT track them). A fast model flooding content during a detach
    // gap must not evict the `session/prompt` reply — that would hang the
    // caller. Eviction must prefer the replayable id-bearing frames.
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      // One irreplaceable id-less reply lands first, then a flood of id-bearing
      // content frames well past the 256 cap.
      conn.sendSessionReply('sess-1', { promptResult: true });
      for (let i = 1; i <= 400; i++)
        conn.sendSession('sess-1', { chunk: i }, i);

      // Fresh reconnect flushes whatever survived. The id-less reply must be
      // among the flushed frames (id-bearing frames were evicted preferentially).
      const s = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s, new AbortController());
      const replyDelivered = s.sent.some(
        (x) =>
          (x.message as { promptResult?: boolean }).promptResult === true &&
          x.id === undefined,
      );
      expect(replyDelivered).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it('never evicts an irreplaceable id-less reply even when the buffer is ENTIRELY id-less replies (no id-bearing frame to drop)', () => {
    // Degenerate case wenshao flagged: if the gap buffer fills with only id-less
    // deferred replies, there is no replayable frame to evict — dropping one
    // would silently hang its caller. So pushCapped must NOT drop; it lets the
    // irreplaceable replies exceed the soft cap (they're bounded by real
    // in-flight RPC count, not a content flood). Every reply must survive.
    const registry = new ConnectionRegistry();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      // Far past the 256 soft cap but under the 1024 hard cap: ALL id-less
      // replies (no id-bearing frames).
      const N = 300;
      for (let i = 0; i < N; i++) conn.sendSessionReply('sess-1', { reply: i });

      // Fresh reconnect flushes everything — not one reply was evicted.
      const s = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s, new AbortController());
      const replyIds = s.sent
        .map((x) => (x.message as { reply?: number }).reply)
        .filter((v) => typeof v === 'number');
      expect(replyIds).toHaveLength(N);
      expect(new Set(replyIds).size).toBe(N); // all distinct, none lost

      // The soft-cap warning is the operator's only signal it was exceeded —
      // assert it fired (exactly once, at the transition, not per push).
      const softCapLogs = stderr.mock.calls.filter((c) =>
        String(c[0]).includes('pre-attach buffer over soft cap'),
      );
      expect(softCapLogs).toHaveLength(1);
    } finally {
      stderr.mockRestore();
      registry.dispose();
    }
  });

  it('enforces a HARD ceiling on all-id-less buffer growth (defense-in-depth) — drops oldest and logs loudly past 4× the soft cap', () => {
    // The soft cap never drops id-less replies, but an UNBOUNDED heap is worse
    // than a hung caller — so past the 1024 hard cap pushCapped drops the oldest
    // id-less reply and logs loudly. Bounds a pathological / buggy producer.
    const registry = new ConnectionRegistry();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      const N = 1100; // past the 1024 hard cap
      for (let i = 0; i < N; i++) conn.sendSessionReply('sess-1', { reply: i });

      const s = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s, new AbortController());
      const replyIds = s.sent
        .map((x) => (x.message as { reply?: number }).reply)
        .filter((v): v is number => typeof v === 'number');

      // Buffer bounded at the hard cap (1024); the OLDEST were dropped, so the
      // most-recent survive.
      expect(replyIds).toHaveLength(1024);
      expect(replyIds).toContain(N - 1); // newest kept
      expect(replyIds).not.toContain(0); // oldest dropped
      expect(
        stderr.mock.calls.some((c) =>
          String(c[0]).includes('HARD buffer cap breached'),
        ),
      ).toBe(true);
    } finally {
      stderr.mockRestore();
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

  it('defers an out-of-band reply that finishes DURING the replay window until replay_complete (sendSessionReply + replayPending)', () => {
    // wenshao MsOpj: the gap-buffer deferral alone isn't enough — a prompt that
    // finishes AFTER the resumptive attach but BEFORE replay drains would, via
    // the plain live-send path, overtake replay frames not yet sent. The
    // `replayPending` flag keeps `sendSessionReply` deferring through that
    // window too.
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      // Resumptive attach (cursor present) → replayPending armed.
      const s = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s, new AbortController(), 5);

      // A prompt finishes mid-replay → out-of-band reply. Must NOT be sent yet.
      conn.sendSessionReply('sess-1', { promptResult: true });
      expect(s.sent).toEqual([]);

      // The pump replays content (bus events) live, in order.
      conn.sendSession('sess-1', { chunk: 'a' }, 6);
      conn.sendSession('sess-1', { chunk: 'b' }, 7);
      expect(s.sent).toEqual([
        { message: { chunk: 'a' }, id: 6 },
        { message: { chunk: 'b' }, id: 7 },
      ]);

      // replay_complete → flush deferred reply AFTER the replayed content, and
      // clear replayPending.
      conn.flushBufferedSessionFrames('sess-1');
      expect(s.sent).toEqual([
        { message: { chunk: 'a' }, id: 6 },
        { message: { chunk: 'b' }, id: 7 },
        { message: { promptResult: true }, id: undefined },
      ]);

      // Past the boundary, a later reply is delivered live (no longer deferred).
      conn.sendSessionReply('sess-1', { later: true });
      expect(s.sent.at(-1)).toEqual({
        message: { later: true },
        id: undefined,
      });
    } finally {
      registry.dispose();
    }
  });

  it('hasRecoverableSession() is true while a session grace timer is armed, so the connection reaper treats it as active', () => {
    // wenshao MsOpl: a detached-but-recoverable session (graceTimer armed,
    // stream undefined) must count as connection activity, else the conn reaper
    // can delete the whole connection mid SESSION_GRACE_MS and 404 the resume.
    vi.useFakeTimers();
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      const s1 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s1, new AbortController());
      expect(conn.hasLiveSessionStream()).toBe(true);
      expect(conn.hasRecoverableSession()).toBe(false);

      // Transport close → detach with grace: no live stream, but recoverable.
      conn.detachSessionStream('sess-1', s1, 10_000);
      expect(conn.hasLiveSessionStream()).toBe(false);
      expect(conn.hasRecoverableSession()).toBe(true);

      // Reclaim within grace → no longer in a grace window.
      const s2 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s2, new AbortController());
      expect(conn.hasRecoverableSession()).toBe(false);
      expect(conn.hasLiveSessionStream()).toBe(true);
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });

  it('clears replayPending on a fresh re-attach after an aborted resume (MsyIq/MylZ4) — a later reply is delivered live, not stranded behind a replay boundary that never arrives', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      // Resumptive attach arms replayPending.
      const s1 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s1, new AbortController(), 5);
      expect(conn.sessions.get('sess-1')?.replayPending).toBe(true);

      // The resume is aborted before replay_complete (the normal reclaim path
      // skips the flush, so no boundary clears the flag). A FRESH reconnect with
      // no cursor must reset it from the current attach mode.
      const s2 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s2, new AbortController());
      expect(conn.sessions.get('sess-1')?.replayPending).toBe(false);

      // A later prompt result reaches the wire immediately — not buffered behind
      // a replay boundary this live-only subscription will never emit.
      conn.sendSessionReply('sess-1', { promptResult: true });
      expect(s2.sent).toEqual([
        { message: { promptResult: true }, id: undefined },
      ]);
    } finally {
      registry.dispose();
    }
  });

  it('logs a stderr breadcrumb when a resume arms replay deferral, and stays silent on a fresh connect', () => {
    const registry = new ConnectionRegistry();
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      // Fresh connect (no cursor): nothing to defer → no breadcrumb.
      conn.attachSessionStream(
        'sess-1',
        new FakeStream('sse'),
        new AbortController(),
      );
      expect(
        stderr.mock.calls.some((c) =>
          String(c[0]).includes('replay deferral armed'),
        ),
      ).toBe(false);

      // Resumptive attach (cursor present): arming the deferral logs once with
      // the session id and the cursor it resumed from.
      conn.attachSessionStream(
        'sess-1',
        new FakeStream('sse'),
        new AbortController(),
        5,
      );
      const armed = stderr.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('replay deferral armed'));
      expect(armed).toHaveLength(1);
      expect(armed[0]).toContain('from id 5');
    } finally {
      stderr.mockRestore();
      registry.dispose();
    }
  });

  it('holds a deferred reply until the pump delivers through its anchor (MsyIt) — a result produced during a slow replay lands after live tail content, not at replay_complete', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      // Resume from cursor 5 while the turn is STILL running: its tail content
      // (ids 8,9) will arrive as LIVE events AFTER replay_complete.
      const s = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s, new AbortController(), 5);

      // Replay redelivers the in-ring content (ids 6,7); the pump releases any
      // replies it has caught up to after each frame.
      conn.sendSession('sess-1', { chunk: 6 }, 6);
      conn.releaseDeferredSessionReplies('sess-1', 6);
      conn.sendSession('sess-1', { chunk: 7 }, 7);
      conn.releaseDeferredSessionReplies('sess-1', 7);

      // The prompt finishes mid-replay, anchored to the bus head (9) — two tail
      // events (8,9) are still to come.
      conn.sendSessionReply('sess-1', { promptResult: true }, 9);
      expect(s.sent).toEqual([
        { message: { chunk: 6 }, id: 6 },
        { message: { chunk: 7 }, id: 7 },
      ]);

      // replay_complete releases only replies anchored within the replayed range
      // (≤ 7). The reply (anchor 9) must STAY deferred — flushing it here is
      // exactly the MsyIt reordering bug.
      conn.endReplayDeferral('sess-1', 7);
      expect(conn.sessions.get('sess-1')?.replayPending).toBe(false);
      const hasReply = () =>
        s.sent.some(
          (f) => (f.message as { promptResult?: boolean }).promptResult,
        );
      expect(hasReply()).toBe(false);

      // Live tail flows; the reply waits until id 9 is actually delivered.
      conn.sendSession('sess-1', { chunk: 8 }, 8);
      conn.releaseDeferredSessionReplies('sess-1', 8);
      expect(hasReply()).toBe(false);

      conn.sendSession('sess-1', { chunk: 9 }, 9);
      conn.releaseDeferredSessionReplies('sess-1', 9);
      expect(s.sent).toEqual([
        { message: { chunk: 6 }, id: 6 },
        { message: { chunk: 7 }, id: 7 },
        { message: { chunk: 8 }, id: 8 },
        { message: { chunk: 9 }, id: 9 },
        { message: { promptResult: true }, id: undefined },
      ]);
    } finally {
      registry.dispose();
    }
  });

  it('releases ALL deferred replies at replay_complete when the replay evicted frames (state_resync_required) — no cascading freeze on an unreachable anchor', () => {
    // doudouOUC's cascading-freeze: a reply anchored ABOVE the surviving range
    // (its anchor event was evicted from the ring on overflow) would otherwise
    // wait for an id the pump never delivers — and because `sendSessionReply`
    // gates inline delivery on an EMPTY buffer, every later reply piles up
    // behind it forever. When the replay carried a `state_resync_required`, the
    // ordering guarantee is void, so endReplayDeferral must release everything.
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      const s = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s, new AbortController(), 5); // resume

      // Two replies anchored at id 9 — but the ring evicted everything, so no
      // event with id ≥ 9 will ever be delivered.
      conn.sendSessionReply('sess-1', { promptResult: true }, 9);
      conn.sendSessionReply('sess-1', { second: true }, 9);
      expect(s.sent).toEqual([]); // both deferred

      // replay_complete WITH eviction (lastReplayed 4 < anchor 9): release all.
      conn.endReplayDeferral('sess-1', 4, true);
      expect(s.sent).toEqual([
        { message: { promptResult: true }, id: undefined },
        { message: { second: true }, id: undefined },
      ]);

      // Cascade broken: buffer empty + replayPending cleared → a later reply
      // reaches the wire immediately instead of stranding.
      conn.sendSessionReply('sess-1', { third: true });
      expect(s.sent).toContainEqual({
        message: { third: true },
        id: undefined,
      });
    } finally {
      registry.dispose();
    }
  });

  it('holds an UNANCHORED deferred reply during replay (Branch A) and releases it once the boundary clears replayPending (Branch B) (M3w6e)', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');
      const s = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s, new AbortController(), 5); // replayPending

      // An unanchored reply (anchorId undefined — the getSessionLastEventId
      // teardown-race fallback) buffered during replay.
      conn.sendSessionReply('sess-1', { promptResult: true });

      // Branch A: replayPending true → a watermark release must NOT emit it
      // (releasing mid-replay would risk landing it ahead of replay content).
      conn.releaseDeferredSessionReplies('sess-1', 99);
      expect(s.sent).toEqual([]);

      // Branch B: the boundary clears replayPending → the unanchored reply is
      // released unconditionally.
      conn.endReplayDeferral('sess-1', 5);
      expect(s.sent).toEqual([
        { message: { promptResult: true }, id: undefined },
      ]);
    } finally {
      registry.dispose();
    }
  });

  it('clearGraceTimer resets connGraceExpired so a stale expiry verdict cannot carry into a new window (M3w6f)', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      // Simulate the conn grace timer having fired earlier.
      conn.connGraceExpired = true;
      // A reconnect (attachConnStream) cancels the pending reap via clearGraceTimer.
      conn.attachConnStream(new FakeStream('sse'));
      expect(conn.connGraceExpired).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('invokes onSessionGraceExpired when a session reclaim grace expires (drives the deferred connection reap, MsyIs)', () => {
    vi.useFakeTimers();
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      const s1 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s1, new AbortController());

      const onExpired = vi.fn();
      conn.onSessionGraceExpired = onExpired;

      conn.detachSessionStream('sess-1', s1, 10_000);
      expect(onExpired).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10_000);
      expect(onExpired).toHaveBeenCalledTimes(1);
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });

  it('grace-expiry teardown swallows a throwing detach callback (MylZ8) — the setTimeout never crashes the process', () => {
    vi.useFakeTimers();
    const onDetach = vi.fn(() => {
      throw new Error('boom');
    });
    const registry = new ConnectionRegistry(undefined, onDetach);
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      const s1 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s1, new AbortController());
      conn.detachSessionStream('sess-1', s1, 10_000);

      // Grace expiry → closeSessionStream → teardownBinding → onDetach throws.
      // The try/catch must contain it so the bare setTimeout can't take the
      // daemon down.
      expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
      expect(onDetach).toHaveBeenCalled();
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });

  it('grace-expiry swallows a throwing onSessionGraceExpired callback (M4i9z) — the setTimeout never crashes the process', () => {
    vi.useFakeTimers();
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      const s1 = new FakeStream('sse');
      conn.attachSessionStream('sess-1', s1, new AbortController());
      const onExpired = vi.fn(() => {
        throw new Error('boom');
      });
      conn.onSessionGraceExpired = onExpired;
      conn.detachSessionStream('sess-1', s1, 10_000);

      // onSessionGraceExpired runs from the bare setTimeout; its own try/catch
      // must contain a throw so it can't take the daemon down.
      expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
      expect(onExpired).toHaveBeenCalledTimes(1);
      // Teardown still completed (the callback runs after it).
      expect(conn.sessions.has('sess-1')).toBe(false);
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

  it('finds and deletes pending permissions across connections', () => {
    const registry = new ConnectionRegistry();
    try {
      const connA = registry.create(false);
      const connB = registry.create(false);
      expect(connA).toBeDefined();
      expect(connB).toBeDefined();
      if (!connA || !connB) return;

      const idA = connA.nextId();
      const idB = connB.nextId();
      expect(idA).not.toBe(idB);
      // Pin the connection-qualified format `_qwen_perm_<connectionId>_<N>` —
      // it's the collision-prevention guarantee of this change, so a
      // regression to the old `_qwen_perm_<N>` format must fail here, not just
      // an "ids differ" check that the old format would also pass.
      expect(idA).toMatch(/^_qwen_perm_.+_1$/);
      expect(idA).toContain(connA.connectionId);
      expect(idB).toContain(connB.connectionId);

      connA.pending.set(idA, {
        sessionId: 'sess-1',
        bridgeRequestId: 'perm-1',
        kind: 'permission',
      });

      expect(registry.findPendingClientRequest(idA)?.conn).toBe(connA);
      expect(registry.findPendingPermission('perm-1', 'sess-1')?.id).toBe(idA);
      // The `sessionId === undefined` branch (relied on by dispatch's
      // `session/permission` handler when no sessionId is supplied) matches on
      // requestId alone, while a mismatched sessionId must not match.
      expect(registry.findPendingPermission('perm-1')?.id).toBe(idA);
      expect(
        registry.findPendingPermission('perm-1', 'wrong-session'),
      ).toBeUndefined();

      registry.deletePendingPermission('perm-1', 'sess-1');

      expect(registry.findPendingClientRequest(idA)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });
});
