/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  ManagedRuntimeTerminals,
  MANAGED_RUNTIME_TERMINAL_ROUTE,
  MAX_MANAGED_SESSION_TERMINALS,
  TERMINAL_RELEASE_EXIT_CODE,
} from './managed-runtime-terminal.js';
import {
  WebTerminalRegistry,
  WEB_TERMINAL_FAILURE_EXIT_CODE,
} from '@qwen-code/qwen-code-core/services/web-terminal-registry.js';

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
        'X-Qwen-Managed-Lease-Id': 'other-lease',
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
      let refused = false;
      ws.once('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(404);
        refused = true;
        resolve();
      });
      ws.once('open', () => reject(new Error('unknown path upgraded')));
      // A client error only settles the test once the 404 refusal was asserted;
      // an error alone would otherwise pass without verifying the refusal.
      ws.once('error', () => {
        if (refused) resolve();
        else reject(new Error('upgrade failed without a 404 refusal'));
      });
    });
  });

  it('refuses a malformed upgrade target without killing the worker', async () => {
    const port = await start();
    // "//[" is accepted by llhttp and emitted as an upgrade, but the WHATWG
    // URL parser throws on it; the refusal must not escape the listener.
    const response = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(port, '127.0.0.1', () => {
        socket.write(
          'GET //[ HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        );
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
      setTimeout(() => {
        socket.destroy();
        resolve(data);
      }, 5_000).unref();
    });
    expect(response).toContain('400');
    // The worker survived and still serves upgrades.
    const ws = await attachAndEcho(port, 'after-malformed', 'session-a');
    expect(ws.readyState).toBe(WebSocket.OPEN);
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

  it('keeps ownership after a release so another Session cannot take over', async () => {
    const port = await start();
    const first = await attachAndEcho(port, 'retained', 'session-a');
    // Release removes the snapshot but retains the owner record.
    first.send('\x00{"type":"release"}');
    await new Promise<void>((resolve) => first.once('close', () => resolve()));
    // A second Session must not claim the released id even though no live
    // snapshot exists.
    await expect(connect(port, 'retained', 'session-b')).rejects.toMatchObject({
      status: 409,
    });
    // The owning Session can still re-attach its own terminal.
    const again = await connect(port, 'retained', 'session-a');
    expect(again.readyState).toBe(WebSocket.OPEN);
  });

  it('counts terminals still being created against the Session cap', async () => {
    const port = await start();
    const internals = terminals as unknown as {
      registry: WebTerminalRegistry;
      owners: Map<string, string>;
    };
    // Seed the Session's budget with in-flight creations (no snapshot yet).
    const pending: Array<Promise<unknown>> = [];
    for (let i = 0; i < MAX_MANAGED_SESSION_TERMINALS; i += 1) {
      const id = `creating-${i}`;
      internals.owners.set(id, 'session-a');
      pending.push(
        internals.registry.create({
          terminalId: id,
          workspaceCwd: WORKSPACE_CWD,
          env: process.env,
        }),
      );
    }
    expect(internals.registry.isCreating('creating-0')).toBe(true);
    // A further upgrade for the same Session is refused while they create.
    await expect(
      connect(port, 'creating-over', 'session-a'),
    ).rejects.toMatchObject({ status: 429 });
    await Promise.all(pending);
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

  it('admission reads lifecycle state without joining the scrollback', async () => {
    const port = await start();
    const registry = (terminals as unknown as { registry: WebTerminalRegistry })
      .registry;
    // Settle the first connection fully (echo proves its replay readSnapshot
    // already ran) before spying, so the spy only sees the refused upgrade.
    const first = await attachAndEcho(port, 'readstate-pin', WORKSPACE_CWD);
    const readSnapshot = vi.spyOn(registry, 'readSnapshot');
    // A conflicting selector is refused at admission (409) before the
    // connection handler ever runs, so the replay readSnapshot must not be
    // touched: admission uses readState. Reverting it to readSnapshot would
    // join the buffer here and red this assertion.
    await expect(
      connect(port, 'readstate-pin', '/another/cwd'),
    ).rejects.toMatchObject({ status: 409 });
    expect(readSnapshot).not.toHaveBeenCalled();
    first.close();
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
    // The hold's wire contract requires a running answer to name its unit and
    // an exited answer to carry non-null exit evidence; a bare state or an
    // all-null evidence is rejected and would wedge the hold forever.
    expect(
      terminals!.control(op('terminal-status', 'ctl-1', 'session-a')),
    ).toEqual({ operationId: 'ctl-1', state: 'running', unitName: 'ctl-1' });
    expect(
      terminals!.control(op('terminal-terminate', 'ctl-1', 'session-a')),
    ).toEqual({
      operationId: 'ctl-1',
      state: 'exited',
      evidence: { exitCode: TERMINAL_RELEASE_EXIT_CODE, exitSignal: null },
    });
    expect(
      terminals!.control(op('terminal-status', 'ctl-1', 'session-a')),
    ).toEqual({
      operationId: 'ctl-1',
      state: 'exited',
      evidence: { exitCode: TERMINAL_RELEASE_EXIT_CODE, exitSignal: null },
    });
    ws.terminate();
  });

  it('settles a natively exited terminal with its own exit code', async () => {
    const port = await start();
    const ws = await attachAndEcho(port, 'native-exit', 'session-a');
    // Let the shell exit natively with a distinct code; the native-exit arm of
    // control() must report that code, not the synthetic release receipt.
    ws.send('exit 7\r');
    await vi.waitFor(() => {
      expect(
        terminals!.control(op('terminal-status', 'native-exit', 'session-a')),
      ).toEqual({
        operationId: 'native-exit',
        state: 'exited',
        evidence: { exitCode: 7, exitSignal: null },
      });
    });
    ws.terminate();
  });

  it('pins the release exit code to the registry release receipt', async () => {
    // The worker answers a released terminal with TERMINAL_RELEASE_EXIT_CODE;
    // read the producer's actual receipt so the two sides cannot drift.
    const registry = new WebTerminalRegistry();
    const created = await registry.create({
      terminalId: 'pin-release',
      workspaceCwd: WORKSPACE_CWD,
      env: process.env,
    });
    expect('error' in created).toBe(false);
    let receipt: { exitCode: number; signal?: number } | undefined;
    registry.addExitListener('pin-release', (e) => {
      receipt = e;
    });
    registry.release('pin-release', WORKSPACE_CWD);
    expect(receipt?.exitCode).toBe(TERMINAL_RELEASE_EXIT_CODE);
    registry.dispose();
  });

  it('keeps the hold for status and cancels creation for terminate mid-create', async () => {
    await start();
    const internals = terminals as unknown as {
      registry: WebTerminalRegistry;
      owners: Map<string, string>;
    };
    // The upgrade admits ownership before the asynchronous create completes.
    internals.owners.set('pending-1', 'session-a');
    const pending = internals.registry.create({
      terminalId: 'pending-1',
      workspaceCwd: WORKSPACE_CWD,
      env: process.env,
    });
    // Admitted but not yet registered: a missing snapshot here is not a proven
    // exit. Status must keep the hold, not settle it under a pending shell.
    expect(internals.registry.isCreating('pending-1')).toBe(true);
    expect(
      terminals!.control(op('terminal-status', 'pending-1', 'session-a')),
    ).toEqual({ operationId: 'pending-1', state: 'unknown' });
    // Terminate cancels the pending creation so the shell can never start
    // after the hold is discharged, and answers the release receipt.
    expect(
      terminals!.control(op('terminal-terminate', 'pending-1', 'session-a')),
    ).toEqual({
      operationId: 'pending-1',
      state: 'exited',
      evidence: { exitCode: TERMINAL_RELEASE_EXIT_CODE, exitSignal: null },
    });
    await expect(pending).resolves.toMatchObject({
      error: 'Web terminal creation cancelled',
    });
    expect(internals.registry.readSnapshot('pending-1')).toBeUndefined();
    expect(internals.registry.isCreating('pending-1')).toBe(false);
    // The cancelled creation left a release receipt, so a later status poll
    // settles the hold with a proven end instead of answering unknown forever.
    expect(
      terminals!.control(op('terminal-status', 'pending-1', 'session-a')),
    ).toEqual({
      operationId: 'pending-1',
      state: 'exited',
      evidence: { exitCode: TERMINAL_RELEASE_EXIT_CODE, exitSignal: null },
    });
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

  it('settles a terminal the backend ended by failure', async () => {
    const port = await start();
    const ws = await attachAndEcho(port, 'failed-backend', 'session-a');
    const internals = terminals as unknown as {
      registry: WebTerminalRegistry;
    };
    const sessions = (
      internals.registry as unknown as {
        sessions: Map<string, { failure?: { message: string } }>;
      }
    ).sessions;
    // The backend tore the tree down and reported a failure: no exit code, but
    // a definitively dead terminal.
    sessions.get('failed-backend')!.failure = { message: 'backend failure' };
    expect(
      terminals!.control(op('terminal-status', 'failed-backend', 'session-a')),
    ).toEqual({
      operationId: 'failed-backend',
      state: 'exited',
      evidence: { exitCode: WEB_TERMINAL_FAILURE_EXIT_CODE, exitSignal: null },
    });
    ws.terminate();
  });

  it('settles a failed spawn with a failure end, never a clean exit', async () => {
    await start();
    const internals = terminals as unknown as {
      owners: Map<string, string>;
      registry: WebTerminalRegistry;
    };
    // A failed load/spawn leaves an owner but no session and was never released;
    // finishCreating records a failure end receipt for it.
    internals.owners.set('failed-spawn', 'session-a');
    (
      internals.registry as unknown as { failedCreations: Set<string> }
    ).failedCreations.add('failed-spawn');
    for (const kind of ['terminal-status', 'terminal-terminate'] as const) {
      const view = terminals!.control(op(kind, 'failed-spawn', 'session-a'));
      expect(view).toEqual({
        operationId: 'failed-spawn',
        state: 'exited',
        evidence: {
          exitCode: WEB_TERMINAL_FAILURE_EXIT_CODE,
          exitSignal: null,
        },
      });
      // A failure end must never be the clean release code.
      expect(view.evidence?.exitCode).not.toBe(TERMINAL_RELEASE_EXIT_CODE);
    }
  });

  it('revokes a stale release receipt when the same terminal id is re-admitted', async () => {
    await start();
    const internals = terminals as unknown as { registry: WebTerminalRegistry };
    const registry = internals.registry;
    // A prior lifecycle released this id (the Web Shell reuses one id per
    // Session across panel reopenings).
    (registry as unknown as { released: Set<string> }).released.add('reuse-id');
    expect(registry.isReleased('reuse-id')).toBe(true);
    // Re-admitting the id must revoke the stale receipt so a later failed
    // re-spawn is not certified as the prior clean exit.
    await registry.create({
      terminalId: 'reuse-id',
      workspaceCwd: WORKSPACE_CWD,
    });
    expect(registry.isReleased('reuse-id')).toBe(false);
    registry.release('reuse-id');
  });
});
