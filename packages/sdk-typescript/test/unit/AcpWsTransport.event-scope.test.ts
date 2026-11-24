/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpWsTransport } from '../../src/daemon/AcpWsTransport.js';

class FakeWebSocket {
  static latest: FakeWebSocket;
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeWebSocket.latest = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string) {
    const message = JSON.parse(data);
    if (message.method === 'initialize') {
      queueMicrotask(() =>
        this.receive({ jsonrpc: '2.0', id: message.id, result: {} }),
      );
    }
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close() {
    this.onclose?.({ code: 1000, reason: 'closed' });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ACP notification envelope session scope', () => {
  it.each([
    [
      'session/update',
      { type: 'session_update', data: { text: 'own session' } },
    ],
    ['_qwen/notify', { type: 'model_switched', data: { modelId: 'own' } }],
    ['_qwen/notify', { kind: 'model_switched', data: { modelId: 'own' } }],
    [
      'session/update',
      { update: { sessionUpdate: 'agent_message_chunk', text: 'own' } },
    ],
  ])(
    'delivers %s envelopes to their owning session',
    async (method, payload) => {
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const transport = new AcpWsTransport('ws://daemon/acp');
      const abort = new AbortController();
      const iterator = transport.subscribeEvents('target', {
        signal: abort.signal,
      });
      const next = iterator.next();
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        FakeWebSocket.latest.receive({
          jsonrpc: '2.0',
          method,
          params: { ...payload, sessionId: 'target' },
        });
        FakeWebSocket.latest.receive({
          jsonrpc: '2.0',
          method: 'workspace_changed',
          params: { marker: 'after-own-event' },
        });
        expect((await next).value).toMatchObject({
          data: { sessionId: 'target' },
        });
      } finally {
        abort.abort();
        await iterator.return(undefined);
        transport.dispose();
      }
    },
  );

  it.each([
    ['workspace_changed', { marker: 'workspace' }],
    ['_qwen/notify', { kind: 'settings_changed', data: { key: 'modelName' } }],
  ])(
    'continues delivering %s workspace notifications to every subscribed session',
    async (method, params) => {
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const transport = new AcpWsTransport('ws://daemon/acp');
      const abort = new AbortController();
      const iterators = ['first', 'second'].map((sessionId) =>
        transport.subscribeEvents(sessionId, { signal: abort.signal }),
      );
      const pending = iterators.map((iterator) => iterator.next());
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        FakeWebSocket.latest.receive({
          jsonrpc: '2.0',
          method,
          params,
        });
        for (const message of await Promise.all(pending)) {
          expect(message.value).toMatchObject({
            type: method === '_qwen/notify' ? 'settings_changed' : method,
            data: 'data' in params ? params.data : params,
          });
        }
      } finally {
        abort.abort();
        await Promise.all(
          iterators.map((iterator) => iterator.return(undefined)),
        );
        transport.dispose();
      }
    },
  );

  it.each([
    'mcp_budget_warning',
    'mcp_child_refused_batch',
    'history_truncated',
    'terminal_sequence',
    'settings_changed',
    'approval_mode_changed',
  ])('routes %s to its recipient on a shared socket', async (kind) => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const transport = new AcpWsTransport('ws://daemon/acp');
    const abort = new AbortController();
    const iterators = ['owner', 'foreign'].map((sessionId) =>
      transport.subscribeEvents(sessionId, { signal: abort.signal }),
    );
    const pending = iterators.map((iterator) => iterator.next());
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const payloadScoped = kind === 'settings_changed';
      FakeWebSocket.latest.receive({
        jsonrpc: '2.0',
        method: '_qwen/notify',
        params: {
          kind,
          ...(payloadScoped ? {} : { sessionId: 'owner' }),
          data: {
            marker: kind,
            ...(payloadScoped ? { sessionId: 'owner' } : {}),
          },
        },
      });
      FakeWebSocket.latest.receive({
        jsonrpc: '2.0',
        method: 'workspace_changed',
        params: { marker: 'sentinel' },
      });
      const [owner, foreign] = await Promise.all(pending);
      expect(owner!.value).toMatchObject({
        type: kind,
        data: { sessionId: 'owner', marker: kind },
      });
      expect(foreign!.value).toMatchObject({
        type: 'workspace_changed',
        data: { marker: 'sentinel' },
      });
    } finally {
      abort.abort();
      await Promise.all(
        iterators.map((iterator) => iterator.return(undefined)),
      );
      transport.dispose();
    }
  });

  it('delivers approval-mode fanout once to each addressed session and preserves its origin', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const transport = new AcpWsTransport('ws://daemon/acp');
    const abort = new AbortController();
    const iterators = ['origin', 'peer', 'foreign'].map((sessionId) =>
      transport.subscribeEvents(sessionId, { signal: abort.signal }),
    );
    const pending = iterators.map((iterator) => iterator.next());
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      for (const sessionId of ['origin', 'peer']) {
        FakeWebSocket.latest.receive({
          jsonrpc: '2.0',
          method: '_qwen/notify',
          params: {
            sessionId,
            kind: 'approval_mode_changed',
            data: {
              sessionId: 'origin',
              originSessionId: 'origin',
              previous: 'default',
              next: 'yolo',
              persisted: true,
            },
          },
        });
      }
      FakeWebSocket.latest.receive({
        jsonrpc: '2.0',
        method: 'workspace_changed',
        params: { marker: 'sentinel' },
      });
      const [origin, peer, foreign] = await Promise.all(pending);
      for (const [sessionId, received] of [
        ['origin', origin],
        ['peer', peer],
      ] as const) {
        expect(received!.value).toMatchObject({
          type: 'approval_mode_changed',
          data: {
            sessionId,
            originSessionId: 'origin',
            previous: 'default',
            next: 'yolo',
            persisted: true,
          },
        });
      }
      expect(foreign!.value?.type).toBe('workspace_changed');
      for (const iterator of iterators.slice(0, 2)) {
        expect((await iterator.next()).value?.type).toBe('workspace_changed');
      }
    } finally {
      abort.abort();
      await Promise.all(
        iterators.map((iterator) => iterator.return(undefined)),
      );
      transport.dispose();
    }
  });

  it.each([
    [
      'session/update',
      { type: 'session_update', data: { text: 'other session' } },
    ],
    ['_qwen/notify', { type: 'model_switched', data: { modelId: 'other' } }],
    ['_qwen/notify', { kind: 'model_switched', data: { modelId: 'other' } }],
    [
      'session/update',
      { update: { sessionUpdate: 'agent_message_chunk', text: 'other' } },
    ],
  ])(
    'keeps %s envelopes scoped when payloads omit sessionId',
    async (method, payload) => {
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const transport = new AcpWsTransport('ws://daemon/acp');
      const abort = new AbortController();
      const iterator = transport.subscribeEvents('target', {
        signal: abort.signal,
      });
      const next = iterator.next();
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        FakeWebSocket.latest.receive({
          jsonrpc: '2.0',
          method,
          params: { ...payload, sessionId: 'other' },
        });
        FakeWebSocket.latest.receive({
          jsonrpc: '2.0',
          method: 'workspace_changed',
          params: { marker: 'workspace' },
        });
        expect((await next).value?.type).toBe('workspace_changed');
      } finally {
        abort.abort();
        await iterator.return(undefined);
        transport.dispose();
      }
    },
  );
});
