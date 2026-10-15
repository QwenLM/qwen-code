/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ConnectionRegistry } from './connection-registry.js';
import { AcpPreAttachBudget } from './pre-attach-budget.js';
import type { DeliveryResult, TransportStream } from './transport-stream.js';
import { WsStream } from './ws-stream.js';

class FakeStream implements TransportStream {
  isClosed = false;
  /** Records every send so tests can assert the bus `id` is threaded. */
  readonly sent: Array<{ message: unknown; id?: number }> = [];

  constructor(readonly kind: 'sse' | 'ws') {}

  async send(message: unknown, id?: number): Promise<void> {
    this.sent.push({ message, id });
  }

  async sendSerialized(payload: Buffer, id?: number): Promise<DeliveryResult> {
    this.sent.push({ message: JSON.parse(payload.toString('utf8')), id });
    return this.isClosed ? 'closed' : 'delivered';
  }

  close(): void {
    this.isClosed = true;
  }
}

class ControlledStream implements TransportStream {
  isClosed = false;
  private settle: ((result: DeliveryResult) => void) | undefined;

  constructor(readonly kind: 'sse' | 'ws' = 'sse') {}

  async send(): Promise<void> {}

  sendSerialized(): Promise<DeliveryResult> {
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  complete(result: DeliveryResult): void {
    this.settle?.(result);
  }

  close(): void {
    this.isClosed = true;
  }
}

class PendingSessionStream implements TransportStream {
  isClosed = false;
  readonly sent: Array<{ message: unknown; id?: number }> = [];
  private readonly settles: Array<(result: DeliveryResult) => void> = [];

  readonly kind = 'sse' as const;

  async send(): Promise<void> {}

  sendSerialized(payload: Buffer, id?: number): Promise<DeliveryResult> {
    this.sent.push({ message: JSON.parse(payload.toString('utf8')), id });
    return new Promise((resolve) => this.settles.push(resolve));
  }

  completeAll(result: DeliveryResult): void {
    for (const settle of this.settles.splice(0)) settle(result);
  }

  close(): void {
    this.isClosed = true;
  }
}

class PendingWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  callback: ((err?: Error) => void) | undefined;

  send(_data: unknown, ...args: unknown[]): void {
    const callback = args.at(-1);
    this.callback =
      typeof callback === 'function'
        ? (callback as (err?: Error) => void)
        : undefined;
  }

  ping(): void {}

  close(): void {
    this.readyState = 3;
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

  it('keeps session frames buffered when only the connection SSE stream is live', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 4, maxBytes: 1024 });
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const connectionStream = new FakeStream('sse');
      conn.attachConnStream(connectionStream);
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      const eventDelivery = conn.sendSession('sess-1', { event: true }, 7);
      const replyDelivery = conn.sendSessionReply('sess-1', { reply: true });

      expect(connectionStream.sent).toEqual([]);
      expect(registry.getSnapshot()).toMatchObject({
        bufferedSessionFrames: 2,
        preAttachOwnedFrames: 2,
      });
      expect(budget.snapshot().usedFrames).toBe(2);

      const sessionStream = new FakeStream('sse');
      conn.attachSessionStream('sess-1', sessionStream, new AbortController());

      await expect(eventDelivery).resolves.toBe('delivered');
      await expect(replyDelivery).resolves.toBe('delivered');
      expect(sessionStream.sent).toEqual([
        { message: { event: true }, id: 7 },
        { message: { reply: true }, id: undefined },
      ]);
      expect(budget.snapshot().usedFrames).toBe(0);
    } finally {
      registry.dispose();
    }
  });

  it('hands pending gap replies to a replacement session stream without releasing their leases', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 4, maxBytes: 1024 });
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      const first = conn.sendSessionReply('sess-1', { reply: 1 });
      const second = conn.sendSessionReply('sess-1', { reply: 2 });
      const streamA = new PendingSessionStream();
      conn.attachSessionStream('sess-1', streamA, new AbortController());
      expect(streamA.sent).toEqual([
        { message: { reply: 1 }, id: undefined },
        { message: { reply: 2 }, id: undefined },
      ]);
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 2,
        pendingDeliveryFrames: 2,
      });

      const streamB = new PendingSessionStream();
      conn.attachSessionStream('sess-1', streamB, new AbortController());
      streamA.completeAll('outcome_unknown');
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 2,
        pendingDeliveryFrames: 2,
      });

      const streamC = new PendingSessionStream();
      conn.attachSessionStream('sess-1', streamC, new AbortController());
      streamB.completeAll('outcome_unknown');
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 2,
        pendingDeliveryFrames: 2,
      });
      streamC.completeAll('delivered');

      await expect(first).resolves.toBe('delivered');
      await expect(second).resolves.toBe('delivered');
      expect(streamC.sent).toEqual([
        { message: { reply: 1 }, id: undefined },
        { message: { reply: 2 }, id: undefined },
      ]);
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 0,
        usedBytes: 0,
        pendingDeliveryFrames: 0,
      });
    } finally {
      registry.dispose();
    }
  });

  it('hands a pending live reply to a replacement session stream', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      const streamA = new PendingSessionStream();
      conn.attachSessionStream('sess-1', streamA, new AbortController());

      const delivery = conn.sendSessionReply('sess-1', { reply: 'live' });
      expect(streamA.sent).toEqual([
        { message: { reply: 'live' }, id: undefined },
      ]);

      const streamB = new PendingSessionStream();
      conn.attachSessionStream('sess-1', streamB, new AbortController());
      streamA.completeAll('outcome_unknown');
      streamB.completeAll('delivered');

      await expect(delivery).resolves.toBe('delivered');
      expect(streamB.sent).toEqual([
        { message: { reply: 'live' }, id: undefined },
      ]);
      expect(registry.getSnapshot()).toMatchObject({
        preAttachOwnedFrames: 0,
        preAttachOwnedBytes: 0,
      });
    } finally {
      registry.dispose();
    }
  });

  it('buffers a pending live reply when disconnect precedes the replacement stream', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 4, maxBytes: 1024 });
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      const streamA = new PendingSessionStream();
      conn.attachSessionStream('sess-1', streamA, new AbortController());

      const delivery = conn.sendSessionReply('sess-1', { reply: 'live' }, 7);
      streamA.close();
      streamA.completeAll('outcome_unknown');
      conn.detachSessionStream('sess-1', streamA, 10_000);
      await Promise.resolve();
      expect(registry.getSnapshot()).toMatchObject({
        bufferedSessionFrames: 1,
        pendingDeliveryFrames: 1,
        preAttachOwnedFrames: 1,
        preAttachOwnedBytes: Buffer.byteLength('{"reply":"live"}'),
      });
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 1,
        pendingDeliveryFrames: 1,
      });

      const streamB = new PendingSessionStream();
      conn.attachSessionStream('sess-1', streamB, new AbortController(), 5);
      expect(streamB.sent).toEqual([]);
      conn.releaseDeferredSessionReplies('sess-1', 7);
      streamB.completeAll('delivered');

      await expect(delivery).resolves.toBe('delivered');
      expect(streamB.sent).toEqual([
        { message: { reply: 'live' }, id: undefined },
      ]);
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 0,
        usedBytes: 0,
        pendingDeliveryFrames: 0,
      });
    } finally {
      registry.dispose();
    }
  });

  it('defers handed-off gap replies behind a replacement stream replay', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 4, maxBytes: 1024 });
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      const delivery = conn.sendSessionReply('sess-1', { reply: true });
      const streamA = new PendingSessionStream();
      conn.attachSessionStream('sess-1', streamA, new AbortController());

      const streamB = new PendingSessionStream();
      conn.attachSessionStream('sess-1', streamB, new AbortController(), 5);
      streamA.completeAll('outcome_unknown');
      expect(streamB.sent).toEqual([]);
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 1,
        pendingDeliveryFrames: 1,
      });

      conn.endReplayDeferral('sess-1', 5);
      streamB.completeAll('delivered');
      await expect(delivery).resolves.toBe('delivered');
      expect(streamB.sent).toEqual([
        { message: { reply: true }, id: undefined },
      ]);
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 0,
        usedBytes: 0,
        pendingDeliveryFrames: 0,
      });
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

  it('retires the exact session instead of silently evicting a pre-attach frame', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      for (let i = 0; i < 256; i++) {
        void conn.sendSession('sess-1', { chunk: i }, i);
      }
      await expect(
        conn.sendSession('sess-1', { chunk: 256 }, 256),
      ).resolves.toBe('failed');
      expect(conn.sessions.has('sess-1')).toBe(false);
      expect(conn.destroyed).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('contains a throwing detach callback during session resource failure', async () => {
    const onDetach = vi.fn(() => {
      throw new Error('detach failed');
    });
    const registry = new ConnectionRegistry(undefined, onDetach);
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');
      for (let i = 0; i < 256; i++) {
        void conn.sendSession('sess-1', { chunk: i }, i);
      }

      await expect(
        conn.sendSession('sess-1', { chunk: 256 }, 256),
      ).resolves.toBe('failed');
      expect(onDetach).toHaveBeenCalledOnce();
      expect(conn.sessions.has('sess-1')).toBe(false);
      expect(registry.get(conn.connectionId)).toBe(conn);
    } finally {
      registry.dispose();
    }
  });

  it('retires the connection when its connection-scoped stream reaches the hard frame cap', async () => {
    const registry = new ConnectionRegistry(undefined, undefined, 2);
    try {
      const conn = registry.create(true);
      if (!conn) return;
      for (let i = 0; i < 256; i++) void conn.sendConn({ reply: i });
      await expect(conn.sendConn({ reply: 256 })).resolves.toBe('failed');
      expect(registry.get(conn.connectionId)).toBeUndefined();
      expect(conn.destroyed).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it('discards every provisional receipt when overflow retires a connection', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const delivered = vi.fn();
      const discarded = vi.fn();
      for (let i = 0; i < 256; i++) {
        void conn.sendConn({ reply: i }, { delivered, discarded });
      }
      await expect(
        conn.sendConn({ reply: 256 }, { delivered, discarded }),
      ).resolves.toBe('failed');
      expect(delivered).not.toHaveBeenCalled();
      expect(discarded).toHaveBeenCalledTimes(257);
    } finally {
      registry.dispose();
    }
  });

  it('bounds retained serialized payload bytes before stream attachment', async () => {
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      undefined,
      1024,
      1024,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      await expect(conn.sendConn({ value: 'x'.repeat(2048) })).resolves.toBe(
        'failed',
      );
      expect(conn.destroyed).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it('enforces the connection frame cap across distinct session streams', async () => {
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      undefined,
      2,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      for (const sessionId of ['sess-1', 'sess-2', 'sess-3']) {
        conn.ownSession(sessionId);
        conn.getOrCreateSession(sessionId);
      }
      void conn.sendSession('sess-1', { first: true });
      void conn.sendSession('sess-2', { second: true });

      await expect(
        conn.sendSession('sess-3', { overflow: true }),
      ).resolves.toBe('failed');
      expect(registry.get(conn.connectionId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('accepts the exact byte limit and rejects the next byte', async () => {
    const exactFrame = { value: 'exact' };
    const exactBytes = Buffer.byteLength(JSON.stringify(exactFrame));
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      undefined,
      1024,
      exactBytes,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      void conn.sendConn(exactFrame);
      expect(registry.getSnapshot().preAttachOwnedBytes).toBe(exactBytes);
      await expect(conn.sendConn('x')).resolves.toBe('failed');
      expect(conn.destroyed).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it('freezes a buffered frame at serialization time', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const frame = { value: 'before' };
      void conn.sendConn(frame);
      frame.value = 'after';
      const stream = new FakeStream('sse');
      conn.attachConnStream(stream);
      expect(stream.sent).toEqual([
        { message: { value: 'before' }, id: undefined },
      ]);
    } finally {
      registry.dispose();
    }
  });

  it('limits a live session serialization failure to its independent stream', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.attachSessionStream(
        'sess-1',
        new FakeStream('sse'),
        new AbortController(),
      );
      const frame: { self?: unknown } = {};
      frame.self = frame;
      await expect(conn.sendSession('sess-1', frame)).resolves.toBe('failed');
      expect(conn.sessions.has('sess-1')).toBe(false);
      expect(registry.get(conn.connectionId)).toBe(conn);
    } finally {
      registry.dispose();
    }
  });

  it.each([
    ['BigInt', { value: 1n }],
    ['undefined', undefined],
  ])(
    'retires the exact buffered owner for an unserializable %s frame',
    async (_, frame) => {
      const registry = new ConnectionRegistry();
      try {
        const conn = registry.create(true);
        if (!conn) return;
        conn.ownSession('sess-1');
        conn.getOrCreateSession('sess-1');

        await expect(conn.sendSession('sess-1', frame)).resolves.toBe('failed');
        expect(conn.sessions.has('sess-1')).toBe(false);
        expect(registry.get(conn.connectionId)).toBe(conn);
      } finally {
        registry.dispose();
      }
    },
  );

  it('shares the daemon budget across workspace registries', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 2, maxBytes: 1024 });
    const primary = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    const secondary = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const primaryConn = primary.create(true);
      const secondaryConn = secondary.create(true);
      if (!primaryConn || !secondaryConn) return;
      void primaryConn.sendConn({ source: 'primary' });
      void secondaryConn.sendConn({ source: 'secondary' });
      expect(budget.snapshot().usedFrames).toBe(2);

      await expect(
        secondaryConn.sendConn({ source: 'overflow' }),
      ).resolves.toBe('failed');
      expect(secondary.get(secondaryConn.connectionId)).toBeUndefined();
      expect(primary.get(primaryConn.connectionId)).toBe(primaryConn);
      expect(budget.snapshot().usedFrames).toBe(1);

      primary.dispose();
      expect(budget.snapshot().usedFrames).toBe(0);
    } finally {
      primary.dispose();
      secondary.dispose();
    }
  });

  it('shares the daemon byte budget across workspace registries', async () => {
    const frame = { value: 'payload' };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    const budget = new AcpPreAttachBudget({ maxFrames: 10, maxBytes: bytes });
    const primary = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    const secondary = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const primaryConn = primary.create(true);
      const secondaryConn = secondary.create(true);
      if (!primaryConn || !secondaryConn) return;
      void primaryConn.sendConn(frame);

      await expect(secondaryConn.sendConn(frame)).resolves.toBe('failed');
      expect(secondary.get(secondaryConn.connectionId)).toBeUndefined();
      expect(primary.get(primaryConn.connectionId)).toBe(primaryConn);
      expect(budget.snapshot().usedBytes).toBe(bytes);
    } finally {
      primary.dispose();
      secondary.dispose();
    }
  });

  it('keeps a lease until an in-flight delivery settles after teardown', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 4, maxBytes: 1024 });
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const delivery = conn.sendConn({ buffered: true });
      const stream = new ControlledStream();
      conn.attachConnStream(stream);
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 1,
        pendingDeliveryFrames: 1,
      });

      registry.delete(conn.connectionId);
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 1,
        pendingDeliveryFrames: 1,
      });

      stream.complete('closed');
      await expect(delivery).resolves.toBe('closed');
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 0,
        usedBytes: 0,
        pendingDeliveryFrames: 0,
      });
    } finally {
      registry.dispose();
    }
  });

  it('requeues a connection reply when its live stream closes before delivery', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 4, maxBytes: 1024 });
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const first = new ControlledStream();
      conn.attachConnStream(first);
      const delivered = vi.fn();
      const discarded = vi.fn();
      const frame = { id: 42, result: { ok: true } };
      const delivery = conn.sendConn(frame, { delivered, discarded });

      first.close();
      first.complete('closed');
      await vi.waitFor(() =>
        expect(registry.getSnapshot().bufferedConnectionFrames).toBe(1),
      );
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 1,
        usedBytes: Buffer.byteLength(JSON.stringify(frame)),
      });
      expect(delivered).not.toHaveBeenCalled();
      expect(discarded).not.toHaveBeenCalled();

      const replacement = new FakeStream('sse');
      conn.attachConnStream(replacement);
      await expect(delivery).resolves.toBe('delivered');
      expect(replacement.sent).toEqual([
        { message: { id: 42, result: { ok: true } }, id: undefined },
      ]);
      expect(delivered).toHaveBeenCalledOnce();
      expect(discarded).not.toHaveBeenCalled();
      expect(budget.snapshot()).toMatchObject({
        usedFrames: 0,
        usedBytes: 0,
        pendingDeliveryFrames: 0,
      });
    } finally {
      registry.dispose();
    }
  });

  it('settles a pending delivery against its original session binding', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 4, maxBytes: 1024 });
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      const original = conn.getOrCreateSession('sess-1');
      const originalDelivery = conn.sendSession('sess-1', { original: true });
      const stream = new ControlledStream();
      conn.attachSessionStream('sess-1', stream, new AbortController());

      conn.closeSessionStream('sess-1');
      conn.ownSession('sess-1');
      const replacement = conn.getOrCreateSession('sess-1');
      const replacementDelivery = conn.sendSession('sess-1', {
        replacement: true,
      });
      expect(original.ownedFrames).toBe(1);
      expect(replacement.ownedFrames).toBe(1);

      stream.complete('closed');
      await expect(originalDelivery).resolves.toBe('closed');
      expect(original.ownedFrames).toBe(0);
      expect(replacement.ownedFrames).toBe(1);
      expect(budget.snapshot().usedFrames).toBe(1);

      conn.closeSessionStream('sess-1');
      await expect(replacementDelivery).resolves.toBe('closed');
      expect(budget.snapshot().usedFrames).toBe(0);
    } finally {
      registry.dispose();
    }
  });

  it('tombstones session ownership before teardown callbacks can re-enter', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');
      const identity = conn.captureSessionOwnershipIdentity('sess-1');

      conn.closeSessionStream('sess-1');

      expect(conn.canCommitSessionOwnership('sess-1', identity)).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('rejects a deferred ownership grant after the same session was closed', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const first = conn.captureSessionOwnershipIdentity('sess-1');
      const deferred = conn.captureSessionOwnershipIdentity('sess-1');

      expect(conn.canCommitSessionOwnership('sess-1', first)).toBe(true);
      conn.getOrCreateSession('sess-1');
      conn.ownSession('sess-1');
      conn.releaseSessionOwnershipIdentity('sess-1', first);
      conn.closeSessionStream('sess-1');

      expect(conn.canCommitSessionOwnership('sess-1', deferred)).toBe(false);
      conn.releaseSessionOwnershipIdentity('sess-1', deferred);

      const replacement = conn.captureSessionOwnershipIdentity('sess-1');
      expect(conn.canCommitSessionOwnership('sess-1', replacement)).toBe(true);
      expect(replacement.generation).toBe(0);
      conn.releaseSessionOwnershipIdentity('sess-1', replacement);
    } finally {
      registry.dispose();
    }
  });

  it('rejects an ownership commit while session/close is in flight', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const identity = conn.captureSessionOwnershipIdentity('sess-1');
      conn.closingSessions.add('sess-1');

      expect(conn.canCommitSessionOwnership('sess-1', identity)).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('treats session overflow as connection-fatal on a shared WebSocket before lazy attachment', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');
      for (let i = 0; i < 256; i++) {
        void conn.sendSession('sess-1', { chunk: i }, i);
      }
      conn.attachConnStream(new ControlledStream('ws'));

      await expect(
        conn.sendSession('sess-1', { chunk: 256 }, 256),
      ).resolves.toBe('failed');
      expect(registry.get(conn.connectionId)).toBeUndefined();
      expect(conn.destroyed).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it('limits an independently attached SSE session without closing its WebSocket connection', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.attachConnStream(new FakeStream('ws'));
      conn.ownSession('sess-1');
      const sessionStream = new FakeStream('sse');
      conn.attachSessionStream('sess-1', sessionStream, new AbortController());
      const frame: { self?: unknown } = {};
      frame.self = frame;

      await expect(conn.sendSession('sess-1', frame)).resolves.toBe('failed');
      expect(conn.sessions.has('sess-1')).toBe(false);
      expect(registry.get(conn.connectionId)).toBe(conn);
      expect(conn.destroyed).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('limits a detached SSE session without closing its WebSocket connection', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const connectionStream = new FakeStream('ws');
      conn.attachConnStream(connectionStream);
      conn.ownSession('sess-1');
      const sessionStream = new FakeStream('sse');
      conn.attachSessionStream('sess-1', sessionStream, new AbortController());
      conn.detachSessionStream('sess-1', sessionStream, 10_000);
      const frame: { self?: unknown } = {};
      frame.self = frame;

      await expect(conn.sendSession('sess-1', frame)).resolves.toBe('failed');
      expect(conn.sessions.has('sess-1')).toBe(false);
      expect(registry.get(conn.connectionId)).toBe(conn);
      expect(connectionStream.isClosed).toBe(false);
      expect(conn.destroyed).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('discards a live provisional receipt when teardown beats delivery', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const stream = new ControlledStream();
      conn.attachConnStream(stream);
      const delivered = vi.fn();
      const discarded = vi.fn();
      const send = conn.sendConn(
        { sessionId: 'provisional' },
        { delivered, discarded },
      );

      registry.delete(conn.connectionId);
      await vi.waitFor(() => expect(discarded).toHaveBeenCalledOnce());
      expect(delivered).not.toHaveBeenCalled();

      stream.complete('delivered');
      await expect(send).resolves.toBe('delivered');
      expect(discarded).toHaveBeenCalledOnce();
      expect(delivered).not.toHaveBeenCalled();
    } finally {
      registry.dispose();
    }
  });

  it('commits a provisional receipt when local delivery is ambiguous', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const stream = new ControlledStream();
      conn.attachConnStream(stream);
      const delivered = vi.fn();
      const discarded = vi.fn();
      const send = conn.sendConn(
        { sessionId: 'provisional' },
        { delivered, discarded },
      );

      stream.complete('outcome_unknown');
      await expect(send).resolves.toBe('outcome_unknown');
      expect(delivered).toHaveBeenCalledOnce();
      expect(discarded).not.toHaveBeenCalled();
    } finally {
      registry.dispose();
    }
  });

  it('lets an ambiguous delivery settle before destroy discards receipts', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const stream = new ControlledStream();
      conn.attachConnStream(stream);
      const delivered = vi.fn();
      const discarded = vi.fn();
      const outcomeUnknown = vi.fn();
      const send = conn.sendConn(
        { sessionId: 'provisional' },
        { delivered, discarded, outcomeUnknown },
      );

      registry.delete(conn.connectionId);
      stream.complete('outcome_unknown');
      await expect(send).resolves.toBe('outcome_unknown');
      expect(outcomeUnknown).toHaveBeenCalledOnce();
      expect(delivered).not.toHaveBeenCalled();
      expect(discarded).not.toHaveBeenCalled();
    } finally {
      registry.dispose();
    }
  });

  it('preserves an active WebSocket receipt when close makes delivery ambiguous', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const socket = new PendingWebSocket();
      conn.attachConnStream(new WsStream(socket as never));
      const delivered = vi.fn();
      const discarded = vi.fn();
      const outcomeUnknown = vi.fn();
      const send = conn.sendConn(
        { sessionId: 'provisional' },
        { delivered, discarded, outcomeUnknown },
      );
      await vi.waitFor(() => expect(socket.callback).toBeDefined());

      registry.delete(conn.connectionId);

      await expect(send).resolves.toBe('outcome_unknown');
      expect(outcomeUnknown).toHaveBeenCalledOnce();
      expect(delivered).not.toHaveBeenCalled();
      expect(discarded).not.toHaveBeenCalled();
      socket.callback?.();
      expect(outcomeUnknown).toHaveBeenCalledOnce();
    } finally {
      registry.dispose();
    }
  });

  it('preserves an active WebSocket receipt when peer loss reaches the send callback first', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const socket = new PendingWebSocket();
      conn.attachConnStream(
        new WsStream(socket as never, () => registry.delete(conn.connectionId)),
      );
      const delivered = vi.fn();
      const discarded = vi.fn();
      const outcomeUnknown = vi.fn();
      const send = conn.sendConn(
        { sessionId: 'provisional' },
        { delivered, discarded, outcomeUnknown },
      );
      await vi.waitFor(() => expect(socket.callback).toBeDefined());

      socket.callback?.(new Error('socket closed'));
      socket.readyState = 3;
      socket.emit('close');

      await expect(send).resolves.toBe('outcome_unknown');
      expect(outcomeUnknown).toHaveBeenCalledOnce();
      expect(delivered).not.toHaveBeenCalled();
      expect(discarded).not.toHaveBeenCalled();
      expect(registry.get(conn.connectionId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it.each([
    ['live', { value: 1n }],
    [
      'buffered',
      (() => {
        const frame: { self?: unknown } = {};
        frame.self = frame;
        return frame;
      })(),
    ],
  ])(
    'contains a %s connection response serialization failure to one frame',
    async (mode, frame) => {
      const registry = new ConnectionRegistry();
      try {
        const conn = registry.create(true);
        if (!conn) return;
        for (const sessionId of ['sess-1', 'sess-2']) {
          conn.ownSession(sessionId);
          conn.getOrCreateSession(sessionId);
        }
        if (mode === 'live') conn.attachConnStream(new FakeStream('sse'));

        await expect(conn.sendConn(frame)).resolves.toBe('failed');
        expect(registry.get(conn.connectionId)).toBe(conn);
        expect(conn.destroyed).toBe(false);
        expect(conn.ownedSessions).toEqual(new Set(['sess-1', 'sess-2']));
        expect(conn.sessions.get('sess-1')?.abort.signal.aborted).toBe(false);
        expect(conn.sessions.get('sess-2')?.abort.signal.aborted).toBe(false);
      } finally {
        registry.dispose();
      }
    },
  );

  it('settles delivery when a delivered receipt callback throws', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 1, maxBytes: 1024 });
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const delivery = conn.sendConn(
        { reply: true },
        {
          delivered: () => {
            throw new Error('delivered callback failed');
          },
          discarded: vi.fn(),
        },
      );

      conn.attachConnStream(new FakeStream('sse'));

      await expect(delivery).resolves.toBe('delivered');
      expect(budget.snapshot().usedFrames).toBe(0);
    } finally {
      registry.dispose();
    }
  });

  it('continues teardown when a discarded receipt callback throws', async () => {
    const registry = new ConnectionRegistry();
    const conn = registry.create(true);
    if (!conn) return;
    const delivery = conn.sendConn(
      { reply: true },
      {
        delivered: vi.fn(),
        discarded: () => {
          throw new Error('discarded callback failed');
        },
      },
    );

    expect(() => registry.delete(conn.connectionId)).not.toThrow();
    await expect(delivery).resolves.toBe('closed');
    registry.dispose();
  });

  it('revalidates connection identity after serialization re-entry', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 4, maxBytes: 1024 });
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const frame = {
        toJSON: () => {
          registry.delete(conn.connectionId);
          return { stale: true };
        },
      };
      await expect(conn.sendConn(frame)).resolves.toBe('closed');
      expect(budget.snapshot()).toMatchObject({ usedFrames: 0, usedBytes: 0 });
      expect(registry.get(conn.connectionId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('revalidates connection identity after getter re-entry', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 4, maxBytes: 1024 });
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const frame = Object.defineProperty({}, 'value', {
        enumerable: true,
        get: () => {
          registry.delete(conn.connectionId);
          return 'stale';
        },
      });

      await expect(conn.sendConn(frame)).resolves.toBe('closed');
      expect(budget.snapshot()).toMatchObject({ usedFrames: 0, usedBytes: 0 });
      expect(registry.get(conn.connectionId)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });

  it('rejects a buffered frame when serialization re-entry replaces its stream', async () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 4, maxBytes: 1024 });
    const registry = new ConnectionRegistry(
      undefined,
      undefined,
      2,
      30 * 60_000,
      budget,
    );
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const replacement = new FakeStream('sse');
      const frame = Object.defineProperty({}, 'value', {
        enumerable: true,
        get: () => {
          conn.attachConnStream(replacement);
          return 'stale';
        },
      });

      await expect(conn.sendConn(frame)).resolves.toBe('closed');
      expect(replacement.sent).toEqual([]);
      expect(budget.snapshot()).toMatchObject({ usedFrames: 0, usedBytes: 0 });
    } finally {
      registry.dispose();
    }
  });

  it('does not fail a replacement stream when stale serialization re-entry throws', async () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      const replacement = new FakeStream('sse');
      const frame = {
        toJSON: () => {
          conn.attachConnStream(replacement);
          throw new Error('stale serialization failed');
        },
      };

      await expect(conn.sendConn(frame)).resolves.toBe('closed');
      expect(conn.destroyed).toBe(false);
      expect(conn.connStream).toBe(replacement);
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

  it('does not let a later reply overtake an earlier watermark-gated reply after replay completes', () => {
    const registry = new ConnectionRegistry();
    try {
      const conn = registry.create(true);
      if (!conn) return;
      conn.ownSession('sess-1');
      conn.getOrCreateSession('sess-1');

      const stream = new FakeStream('sse');
      conn.attachSessionStream('sess-1', stream, new AbortController(), 5);

      void conn.sendSessionReply('sess-1', { first: true }, 9);
      conn.endReplayDeferral('sess-1', 7);
      expect(stream.sent).toEqual([]);

      void conn.sendSessionReply('sess-1', { second: true }, 10);
      expect(stream.sent).toEqual([]);

      conn.releaseDeferredSessionReplies('sess-1', 9);
      expect(stream.sent).toEqual([
        { message: { first: true }, id: undefined },
      ]);

      conn.releaseDeferredSessionReplies('sess-1', 10);
      expect(stream.sent).toEqual([
        { message: { first: true }, id: undefined },
        { message: { second: true }, id: undefined },
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

  it('finds pending permissions across connections', () => {
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

      // findPendingPermission is a read-only locator; deletion is done by the
      // owning connection on its own map key (AcpDispatcher.dropOwnPendingPermission).
      connA.pending.delete(idA);
      expect(registry.findPendingClientRequest(idA)).toBeUndefined();
    } finally {
      registry.dispose();
    }
  });
});
