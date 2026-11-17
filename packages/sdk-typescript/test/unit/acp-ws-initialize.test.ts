/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpWsTransport } from '../../src/daemon/AcpWsTransport.js';

interface Request {
  id: number;
  method: string;
}

class ControlledWebSocket {
  static OPEN = 1;
  static instances: ControlledWebSocket[] = [];
  readyState = 0;
  sent: Request[] = [];
  deferClose = false;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: (event: { code: number; reason: string }) => void;

  constructor() {
    ControlledWebSocket.instances.push(this);
  }

  open() {
    this.readyState = ControlledWebSocket.OPEN;
    this.onopen?.();
  }

  reply(id: number, response: Record<string, unknown>) {
    this.onmessage?.({
      data: JSON.stringify({ jsonrpc: '2.0', id, ...response }),
    });
  }

  send(payload: string) {
    const request = JSON.parse(payload) as Request;
    this.sent.push(request);
    if (request.method !== 'initialize') {
      queueMicrotask(() =>
        this.reply(request.id, { result: { sessionId: 'created' } }),
      );
    }
  }

  close() {
    this.readyState = 3;
    if (!this.deferClose) this.finishClose();
  }

  finishClose() {
    this.onclose?.({ code: 1000, reason: 'closed' });
  }
}

describe('ACP WebSocket initialization', () => {
  let transport: AcpWsTransport;

  beforeEach(() => {
    ControlledWebSocket.instances = [];
    vi.stubGlobal('WebSocket', ControlledWebSocket);
    transport = new AcpWsTransport('ws://daemon.example/acp');
  });

  afterEach(() => {
    transport.dispose();
    vi.unstubAllGlobals();
  });

  const request = () => ({ method: 'POST', body: '{}' });

  it('keeps concurrent requests behind the initialize response', async () => {
    const first = transport.fetch('https://daemon.example/session', request());
    const socket = ControlledWebSocket.instances[0]!;
    socket.open();
    const connectedBeforeInitialization = transport.connected;
    const second = transport.fetch('https://daemon.example/session', request());
    await nextTurn();
    const methodsBeforeInitialization = socket.sent.map(
      (message) => message.method,
    );
    socket.reply(socket.sent[0]!.id, { result: { protocolVersion: 1 } });
    const responses = await Promise.all([first, second]);

    expect(connectedBeforeInitialization).toBe(false);
    expect(methodsBeforeInitialization).toEqual(['initialize']);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(transport.connected).toBe(true);
  });

  it('rejects failed initialization and allows a new attempt before the old close event', async () => {
    const first = transport.fetch('https://daemon.example/session', request());
    const oldSocket = ControlledWebSocket.instances[0]!;
    oldSocket.deferClose = true;
    oldSocket.open();
    oldSocket.reply(oldSocket.sent[0]!.id, {
      error: { code: -32000, message: 'Initialization refused' },
    });
    await expect(first).rejects.toThrow('Initialization refused');
    expect(oldSocket.sent.map((message) => message.method)).toEqual([
      'initialize',
    ]);
    expect(oldSocket.readyState).toBe(3);
    expect(transport.connected).toBe(false);

    const retry = transport.fetch('https://daemon.example/session', request());
    const newSocket = ControlledWebSocket.instances[1]!;
    newSocket.open();
    newSocket.reply(newSocket.sent[0]!.id, { result: { protocolVersion: 1 } });
    expect((await retry).status).toBe(200);
    oldSocket.finishClose();

    expect(transport.connected).toBe(true);
    expect(
      (await transport.fetch('https://daemon.example/session', request()))
        .status,
    ).toBe(200);
    expect(ControlledWebSocket.instances).toHaveLength(2);
  });

  it('allows an ordinary request after successful initialization', async () => {
    const pending = transport.fetch(
      'https://daemon.example/session',
      request(),
    );
    const socket = ControlledWebSocket.instances[0]!;
    socket.open();
    socket.reply(socket.sent[0]!.id, { result: { protocolVersion: 1 } });
    expect((await pending).status).toBe(200);
    expect(socket.sent.map((message) => message.method)).toEqual([
      'initialize',
      'session/new',
    ]);
  });
});
