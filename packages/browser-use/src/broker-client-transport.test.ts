/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrokerClientTransport } from './broker-client-transport.js';
import { CHROME_BRIDGE_PROTOCOL_VERSION } from './bridge/protocol.js';
import { encodeFrame, FrameDecoder } from './bridge/transport/framing.js';

const roots: string[] = [];
const transports: BrokerClientTransport[] = [];
const brokers: TestBroker[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const broker of brokers.splice(0)) await broker.stop();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('BrokerClientTransport', () => {
  it('starts a missing broker, handshakes, and correlates responses', async () => {
    const socketPath = temporarySocketPath();
    const hello = vi.fn();
    const broker = new TestBroker(socketPath, (socket, message) => {
      if (!isMessage(message)) return;
      if (message.type === 'client.hello') {
        hello(message);
        socket.write(
          encodeFrame({
            type: 'client.welcome',
            protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
            extensionConnected: true,
          }),
        );
      } else if (message.type === 'request') {
        socket.write(
          encodeFrame({
            type: 'response',
            id: message.id,
            ok: true,
            result: { method: message.method, params: message.params },
          }),
        );
      }
    });
    brokers.push(broker);
    const ensureBroker = vi.fn(async () => broker.start());
    const transport = new BrokerClientTransport({
      socketPath,
      clientId: 'client-a',
      connectTimeoutMs: 1_000,
      ensureBroker,
    });
    transports.push(transport);

    await expect(
      transport.request('tabs.list', { includeUrls: true }),
    ).resolves.toEqual({
      method: 'tabs.list',
      params: { includeUrls: true },
    });
    expect(ensureBroker).toHaveBeenCalledOnce();
    expect(ensureBroker).toHaveBeenCalledWith(socketPath);
    expect(hello).toHaveBeenCalledWith({
      type: 'client.hello',
      protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      clientId: 'client-a',
    });
    expect(transport.isConnected()).toBe(true);
  });

  it('tracks extension state, waits for recovery, and forwards events', async () => {
    const socketPath = temporarySocketPath();
    let client: Socket | undefined;
    const broker = new TestBroker(socketPath, (socket, message) => {
      if (!isMessage(message)) return;
      if (message.type === 'client.hello') {
        client = socket;
        socket.write(
          encodeFrame({
            type: 'client.welcome',
            protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
            extensionConnected: false,
          }),
        );
      } else if (message.type === 'request') {
        socket.write(
          encodeFrame({
            type: 'response',
            id: message.id,
            ok: true,
            result: 'ready',
          }),
        );
      }
    });
    brokers.push(broker);
    await broker.start();
    const transport = new BrokerClientTransport({
      socketPath,
      connectTimeoutMs: 1_000,
    });
    transports.push(transport);
    const connections: boolean[] = [];
    const events: unknown[] = [];
    transport.onConnectionChange((connected) => connections.push(connected));
    transport.onEvent((event) => events.push(event));

    const request = transport.request('tabs.list');
    await vi.waitFor(() => expect(client).toBeDefined());
    expect(transport.isConnected()).toBe(false);
    client?.write(
      Buffer.concat([
        encodeFrame({ type: 'connection', connected: true }),
        encodeFrame({
          type: 'event',
          tabId: 7,
          method: 'Runtime.consoleAPICalled',
          params: { type: 'log' },
        }),
      ]),
    );

    await expect(request).resolves.toBe('ready');
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(connections).toEqual([true]);
    expect(events).toEqual([
      {
        type: 'event',
        tabId: 7,
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log' },
      },
    ]);
  });

  it.each([
    'BROWSER_DISCONNECTED',
    'TAB_ALREADY_CLAIMED',
    'TAB_NOT_OWNED',
  ] as const)('preserves the %s broker error', async (code) => {
    const socketPath = temporarySocketPath();
    const broker = respondingBroker(socketPath, (message) => ({
      type: 'response',
      id: message.id,
      ok: false,
      error: { code, message: `broker rejected: ${code}` },
    }));
    brokers.push(broker);
    await broker.start();
    const transport = new BrokerClientTransport({ socketPath });
    transports.push(transport);

    await expect(transport.request('tabs.claim')).rejects.toMatchObject({
      code,
      message: `broker rejected: ${code}`,
    });
  });

  it('fails pending work closed and reconnects on the next request', async () => {
    const socketPath = temporarySocketPath();
    const connections: Socket[] = [];
    const broker = new TestBroker(socketPath, (socket, message) => {
      if (!isMessage(message)) return;
      if (message.type === 'client.hello') {
        connections.push(socket);
        socket.write(
          encodeFrame({
            type: 'client.welcome',
            protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
            extensionConnected: true,
          }),
        );
      } else if (message.type === 'request' && connections.length === 1) {
        socket.destroy();
      } else if (message.type === 'request') {
        socket.write(
          encodeFrame({
            type: 'response',
            id: message.id,
            ok: true,
            result: 'reconnected',
          }),
        );
      }
    });
    brokers.push(broker);
    await broker.start();
    const ensureBroker = vi.fn();
    const transport = new BrokerClientTransport({
      socketPath,
      connectTimeoutMs: 1_000,
      ensureBroker,
    });
    transports.push(transport);
    const connectionStates: boolean[] = [];
    transport.onConnectionChange((connected) => {
      connectionStates.push(connected);
    });

    await expect(transport.request('first')).rejects.toMatchObject({
      code: 'BROWSER_DISCONNECTED',
    });
    await expect(transport.request('second')).resolves.toBe('reconnected');
    expect(connections).toHaveLength(2);
    expect(connectionStates).toEqual([true, false, true]);
    expect(ensureBroker).not.toHaveBeenCalled();
  });
});

class TestBroker {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();

  constructor(
    readonly socketPath: string,
    onMessage: (socket: Socket, message: unknown) => void,
  ) {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      const decoder = new FrameDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) onMessage(socket, message);
      });
      socket.on('error', () => undefined);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<void> {
    if (this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function respondingBroker(
  socketPath: string,
  response: (message: TestRequest) => unknown,
): TestBroker {
  return new TestBroker(socketPath, (socket, message) => {
    if (!isMessage(message)) return;
    if (message.type === 'client.hello') {
      socket.write(
        encodeFrame({
          type: 'client.welcome',
          protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
          extensionConnected: true,
        }),
      );
    } else if (isTestRequest(message)) {
      socket.write(encodeFrame(response(message)));
    }
  });
}

interface TestRequest {
  id: string;
  method: string;
}

function isTestRequest(
  value: Record<string, unknown>,
): value is TestRequest & Record<string, unknown> {
  return (
    value.type === 'request' &&
    typeof value.id === 'string' &&
    typeof value.method === 'string'
  );
}

function isMessage(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function temporarySocketPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-broker-client-'));
  roots.push(root);
  return path.join(root, 'broker.sock');
}
