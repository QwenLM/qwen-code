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

  it('flushes pre-attach buffered frames WITH their bus id and records the max', () => {
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

      // Each frame keeps its id across the buffer → stream handoff (a regression
      // to `send(frame)` would drop the cursor for early §1.8 frames).
      expect(stream.sent).toEqual([
        { message: { a: 1 }, id: 5 },
        { message: { b: 2 }, id: undefined },
        { message: { c: 3 }, id: 8 },
      ]);
      // Max flushed id feeds the resume-cursor advance (no replay double-send).
      expect(binding.lastFlushedEventId).toBe(8);
    } finally {
      registry.dispose();
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
