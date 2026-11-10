/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  ManagedRuntimeTerminals,
  MANAGED_RUNTIME_TERMINAL_ROUTE,
  MAX_MANAGED_SESSION_TERMINALS,
} from './managed-runtime-terminal.js';

const IDENTITY = { token: 'test-token', leaseId: 'lease-1', epoch: 7 };
const WORKSPACE_CWD = process.cwd();

const AUTH_HEADERS = {
  Authorization: 'Bearer test-token',
  'Cache-Control': 'no-store',
  'X-Qwen-Managed-Lease-Id': 'lease-1',
  'X-Qwen-Managed-Lease-Epoch': '7',
};

let server: Server | undefined;
let terminals: ManagedRuntimeTerminals | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.terminate();
    } catch {
      // already gone
    }
  }
  terminals?.dispose();
  terminals = undefined;
  if (server) {
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve) => {
      closing.close(() => resolve());
      closing.closeAllConnections();
    });
  }
});

async function start(): Promise<number> {
  terminals = new ManagedRuntimeTerminals(IDENTITY, WORKSPACE_CWD, process.env);
  server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  terminals.register(server);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server!.address() as AddressInfo).port;
}

function terminalUrl(
  port: number,
  terminalId: string,
  selector: string,
): string {
  return (
    `ws://127.0.0.1:${port}${MANAGED_RUNTIME_TERMINAL_ROUTE.path}` +
    `?terminalId=${terminalId}&cwd=${encodeURIComponent(selector)}&replay=1`
  );
}

function connect(
  port: number,
  terminalId: string,
  selector: string,
  headers: Record<string, string> = AUTH_HEADERS,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(terminalUrl(port, terminalId, selector), {
      headers,
    });
    sockets.push(ws);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('terminal attach timed out'));
    }, 15_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(
        Object.assign(new Error('upgrade refused'), { status: res.statusCode }),
      );
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Waits until the terminal echoed the marker text. */
function waitForOutput(ws: WebSocket, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`output marker ${marker} timed out`));
    }, 15_000);
    const onMessage = (data: Buffer | string) => {
      // Terminal output arrives as binary UTF-8 frames; control frames are
      // NUL-prefixed text and never contain the marker.
      buffer += data.toString();
      if (buffer.includes(marker)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(buffer);
      }
    };
    ws.on('message', onMessage);
  });
}

async function attachAndEcho(
  port: number,
  terminalId: string,
  selector: string,
): Promise<WebSocket> {
  const ws = await connect(port, terminalId, selector);
  const echoed = waitForOutput(ws, 'mwt-echo-ok');
  ws.send('echo mwt-echo-ok\r');
  await echoed;
  return ws;
}

describe('ManagedRuntimeTerminals', () => {
  it('refuses upgrades without the worker bearer/lease identity', async () => {
    const port = await start();
    await expect(
      connect(port, 't1', 'session-a', {
        ...AUTH_HEADERS,
        Authorization: 'Bearer wrong',
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      connect(port, 't1', 'session-a', {
        ...AUTH_HEADERS,
        'X-Qwen-Managed-Lease-Epoch': '8',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      connect(port, 't1', 'session-a', {
        ...AUTH_HEADERS,
        'Cache-Control': 'max-age=0',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an unknown upgrade path', async () => {
    const port = await start();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/internal/managed-runtime/v3/other`,
      { headers: AUTH_HEADERS },
    );
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(404);
        resolve();
      });
      ws.once('open', () => reject(new Error('unknown path upgraded')));
      ws.once('error', () => resolve());
    });
  });

  it('creates a terminal in the workspace and echoes input', async () => {
    const port = await start();
    const ws = await attachAndEcho(port, 't1', 'session-a');
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('caps live terminals per Session and frees the slot on release', async () => {
    const port = await start();
    const attached: WebSocket[] = [];
    for (let i = 0; i < MAX_MANAGED_SESSION_TERMINALS; i += 1) {
      attached.push(await attachAndEcho(port, `cap-${i}`, 'session-a'));
    }
    await expect(connect(port, 'cap-over', 'session-a')).rejects.toMatchObject({
      status: 429,
    });
    // Another Session keeps its own budget within the worker-wide limit.
    const other = await attachAndEcho(port, 'cap-other', 'session-b');
    expect(other.readyState).toBe(WebSocket.OPEN);
    // Releasing one terminal frees the Session's slot.
    attached[0].send('\x00{"type":"release"}');
    await new Promise<void>((resolve) =>
      attached[0].once('close', () => resolve()),
    );
    const replacement = await attachAndEcho(port, 'cap-new', 'session-a');
    expect(replacement.readyState).toBe(WebSocket.OPEN);
  });

  it("refuses attaching to another Session's terminal", async () => {
    const port = await start();
    await attachAndEcho(port, 'owned', 'session-a');
    await expect(connect(port, 'owned', 'session-b')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('replays scrollback on reconnect of the same Session', async () => {
    const port = await start();
    const first = await attachAndEcho(port, 'replay', 'session-a');
    first.terminate();
    const second = await connect(port, 'replay', 'session-a');
    const replayed = waitForOutput(second, 'mwt-echo-ok');
    // The snapshot replay carries the earlier output without new input.
    await replayed;
  });
});

describe('ManagedRuntimeTerminals control', () => {
  const op = (kind: string, terminalId: string, sessionId: string) => ({
    kind,
    operationId: `terminal-attach:${terminalId}:process`,
    sessionKey: { tenantId: 'tenant', sessionId },
    targetOperationId: terminalId,
  });

  it('reports running live, exited after terminate, and stays exited', async () => {
    const port = await start();
    const ws = await attachAndEcho(port, 'ctl-1', 'session-a');
    expect(
      terminals!.control(op('terminal-status', 'ctl-1', 'session-a')),
    ).toMatchObject({ state: 'running' });
    expect(
      terminals!.control(op('terminal-terminate', 'ctl-1', 'session-a')),
    ).toMatchObject({ state: 'exited' });
    expect(
      terminals!.control(op('terminal-status', 'ctl-1', 'session-a')),
    ).toMatchObject({ state: 'exited' });
    ws.terminate();
  });

  it('answers unknown for a terminal it never admitted', async () => {
    await start();
    expect(
      terminals!.control(op('terminal-status', 'never', 'session-a')),
    ).toMatchObject({ state: 'unknown' });
  });

  it('does not answer for another Session’s terminal', async () => {
    const port = await start();
    const ws = await attachAndEcho(port, 'ctl-2', 'session-a');
    expect(
      terminals!.control(op('terminal-status', 'ctl-2', 'session-b')),
    ).toMatchObject({ state: 'unknown' });
    ws.terminate();
  });

  it('rejects a malformed operation', async () => {
    await start();
    expect(() => terminals!.control({ kind: 'terminal-status' })).toThrow();
  });
});
