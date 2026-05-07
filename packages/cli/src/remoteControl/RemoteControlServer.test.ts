/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RemoteControlServer } from './RemoteControlServer.js';
import type {
  RemoteSessionRunnerLike,
  SessionRegistryOptions,
} from './SessionRegistry.js';
import type { RemoteEnvelope, RemoteToolResponsePayload } from './protocol.js';

class FakeRunner implements RemoteSessionRunnerLike {
  readonly submitted: string[] = [];
  readonly toolResponses: RemoteToolResponsePayload[] = [];

  start(): void {}
  getPid(): number | undefined {
    return 4321;
  }
  getInitializeRequestId(): string | null {
    return null;
  }
  submit(text: string): void {
    this.submitted.push(text);
  }
  respondToTool(payload: RemoteToolResponsePayload): void {
    this.toolResponses.push(payload);
  }
  interrupt(): string {
    return 'interrupt-request';
  }
  setModel(): string {
    return 'set-model-request';
  }
  setPermissionMode(): string {
    return 'set-permission-request';
  }
  getContextUsage(): string {
    return 'context-request';
  }
  close(): void {}
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitForType(
  ws: WebSocket,
  type: string,
): Promise<RemoteEnvelope<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const envelope = JSON.parse(data.toString()) as RemoteEnvelope<
        Record<string, unknown>
      >;
      if (envelope.type === type) {
        ws.off('message', onMessage);
        resolve(envelope);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('RemoteControlServer', () => {
  let server: RemoteControlServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('authenticates clients and routes prompt submission to a worker session', async () => {
    const runners: FakeRunner[] = [];
    const registryOptions: Partial<SessionRegistryOptions> = {
      runnerFactory: () => {
        const runner = new FakeRunner();
        runners.push(runner);
        return runner;
      },
    };
    server = new RemoteControlServer({
      host: '127.0.0.1',
      port: 0,
      cwd: process.cwd(),
      cliEntryPath: '/tmp/qwen/dist/index.js',
      registryOptions,
    });
    const info = await server.start();
    const ws = new WebSocket(info.wsUrl);
    await waitForOpen(ws);

    ws.send(
      JSON.stringify({
        v: 1,
        type: 'auth/pair',
        payload: { token: info.pairingToken },
      }),
    );
    const auth = await waitForType(ws, 'auth/result');
    expect(auth.payload?.['ok']).toBe(true);

    ws.send(JSON.stringify({ v: 1, type: 'session/create', payload: {} }));
    const state = await waitForType(ws, 'session/state');
    const sessionId = state.sessionId ?? (state.payload?.['id'] as string);
    expect(sessionId).toBeTruthy();

    ws.send(
      JSON.stringify({
        v: 1,
        type: 'user/submit',
        sessionId,
        payload: { text: 'hello remote' },
      }),
    );
    await waitForType(ws, 'command/ack');

    expect(runners[0]?.submitted).toEqual(['hello remote']);
    ws.close();
  });

  it('rejects LAN binds unless explicitly allowed', () => {
    expect(
      () =>
        new RemoteControlServer({
          host: '0.0.0.0',
          port: 0,
          cwd: process.cwd(),
          cliEntryPath: '/tmp/qwen/dist/index.js',
        }),
    ).toThrow('--allow-lan');
  });

  it('reports explicit LAN host URLs when LAN mode is enabled', () => {
    server = new RemoteControlServer({
      host: '192.168.1.23',
      port: 7373,
      allowLan: true,
      cwd: process.cwd(),
      cliEntryPath: '/tmp/qwen/dist/index.js',
    });

    expect(server.getInfo()).toMatchObject({
      url: 'http://192.168.1.23:7373',
      lanUrls: ['http://192.168.1.23:7373'],
    });
  });
});
