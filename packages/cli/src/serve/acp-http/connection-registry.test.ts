/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ConnectionRegistry } from './connection-registry.js';
import type { TransportStream } from './transport-stream.js';

class FakeStream implements TransportStream {
  isClosed = false;

  constructor(readonly kind: 'sse' | 'ws') {}

  async send(_message: unknown): Promise<void> {}

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
});
