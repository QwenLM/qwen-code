/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWsSocket, ownsRelayProcess } from './runtime.js';

const servers: Server[] = [];
const sockets = new Set<Socket>();

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.on('connection', (socket) => sockets.add(socket));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port');
  return `ws://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe('ownsRelayProcess', () => {
  it('requires the process title as well as a live pid', async () => {
    const identity = `qwen-relay-test-${process.pid}`;
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.title=${JSON.stringify(identity)};process.stdout.write('ready');setTimeout(()=>{},30000)`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await once(child.stdout, 'data');
    try {
      expect(ownsRelayProcess(child.pid!, identity)).toBe(true);
      expect(ownsRelayProcess(child.pid!, `${identity}-other`)).toBe(false);
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
});

describe('openWsSocket', () => {
  it.each([
    { reject: true, message: 'Unexpected server response: 403' },
    { reject: false, message: 'Opening handshake has timed out' },
  ])(
    'reports an unsuccessful upgrade: $message',
    async ({ reject, message }) => {
      const server = createServer();
      server.on('upgrade', (_request, socket) => {
        if (reject) socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      });
      const url = await listen(server);
      const opened = vi.fn();
      const closed = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          openWsSocket(
            url,
            {},
            {
              open: opened,
              message: vi.fn(),
              close: (code, reason) => resolve({ code, reason }),
            },
          );
        },
      );
      await expect(closed).resolves.toEqual({ code: 1006, reason: message });
      expect(opened).not.toHaveBeenCalled();
    },
  );

  it('renews liveness on daemon pings and terminates a silent connection', async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const url = await listen(server);
    const connected = once(wss, 'connection');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finish: (value: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      finish = resolve;
    });
    const ended = vi.fn();
    const opened = new Promise<void>((resolve) => {
      openWsSocket(
        url,
        {},
        {
          open: resolve,
          message: vi.fn(),
          close: (code, reason) => {
            ended();
            finish({ code, reason });
          },
        },
      );
    });
    const [peer] = await connected;
    await opened;
    await vi.advanceTimersByTimeAsync(30_000);
    const pong = once(peer, 'pong');
    peer.ping();
    await pong;
    await vi.advanceTimersByTimeAsync(34_999);
    expect(ended).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(closed).resolves.toEqual({
      code: 1006,
      reason: 'The daemon stopped sending heartbeat pings.',
    });
    expect(vi.getTimerCount()).toBe(0);
    wss.close();
  });
});
