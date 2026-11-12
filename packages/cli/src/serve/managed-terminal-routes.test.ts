/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { WebSocket } from 'ws';
import { MANAGED_TERMINAL_ROUTE } from '@qwen-code/qwen-code-core/managed-runtime/managed-terminal-protocol.js';
import type { WebTerminalRegistry } from '@qwen-code/qwen-code-core/services/web-terminal-registry.js';
import {
  ManagedRuntimeTerminals,
  MANAGED_RUNTIME_TERMINAL_ROUTE,
} from './managed-runtime-terminal.js';
import {
  MANAGED_TERMINAL_WORKER_ROUTE,
  registerManagedTerminalRoutes,
} from './managed-terminal-routes.js';

// The shared envelope fixture is also consumed by the Java validator test
// (ManagedTerminalProtocolTest), so a key rename on either side reds its own
// suite instead of drifting into a runtime managed_terminal_response_invalid.
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-terminal-control-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  path: string;
  runtimeSessionId: string;
  cases: Array<{
    name: string;
    request: {
      protocolVersion: number;
      runtimeSessionId: string;
      operation: {
        kind: string;
        operationId: string;
        sessionKey: { tenantId: string; sessionId: string };
        targetOperationId: string;
      };
    };
    response: {
      protocolVersion: number;
      runtimeSessionId: string;
      operation: { operationId: string; state: string };
    };
  }>;
};

const IDENTITY = { token: 'test-token', leaseId: 'lease-1', epoch: 7 };
const AUTH_HEADERS = {
  Authorization: 'Bearer test-token',
  'Cache-Control': 'no-store',
  'X-Qwen-Managed-Lease-Id': 'lease-1',
  'X-Qwen-Managed-Lease-Epoch': '7',
  'Content-Type': 'application/json',
};
const SESSION_ID = 'session-a';

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

async function start(): Promise<string> {
  terminals = new ManagedRuntimeTerminals(IDENTITY, process.cwd(), process.env);
  const app = express();
  registerManagedTerminalRoutes(app, IDENTITY, terminals);
  server = createServer(app);
  terminals.register(server);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function post(
  origin: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(origin + MANAGED_TERMINAL_WORKER_ROUTE.path, {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function connect(origin: string, terminalId: string): Promise<WebSocket> {
  const url =
    origin.replace('http://', 'ws://') +
    `${MANAGED_RUNTIME_TERMINAL_ROUTE.path}?terminalId=${terminalId}` +
    `&cwd=${encodeURIComponent(SESSION_ID)}&replay=1`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: AUTH_HEADERS });
    sockets.push(ws);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('terminal attach timed out'));
    }, 15_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function attachAndEcho(
  origin: string,
  terminalId: string,
): Promise<WebSocket> {
  const ws = await connect(origin, terminalId);
  const echoed = new Promise<void>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('output marker timed out'));
    }, 15_000);
    const onMessage = (data: Buffer | string) => {
      buffer += data.toString();
      if (buffer.includes('mwt-echo-ok')) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve();
      }
    };
    ws.on('message', onMessage);
  });
  ws.send('echo mwt-echo-ok\r');
  await echoed;
  return ws;
}

/** Drives the real producer into the state each fixture case names. */
async function prepare(
  name: string,
  terminalId: string,
  origin: string,
): Promise<void> {
  switch (name) {
    case 'running-status':
      await attachAndEcho(origin, terminalId);
      return;
    case 'released-terminate':
      await attachAndEcho(origin, terminalId);
      return;
    case 'released-status':
      // The preceding released-terminate case already released this id.
      return;
    case 'failed-spawn-status': {
      const internals = terminals as unknown as {
        owners: Map<string, string>;
        registry: WebTerminalRegistry;
      };
      internals.owners.set(terminalId, SESSION_ID);
      (
        internals.registry as unknown as { failedCreations: Set<string> }
      ).failedCreations.add(terminalId);
      return;
    }
    case 'unknown-status':
      return;
    default:
      throw new Error(`unknown fixture case: ${name}`);
  }
}

describe('managed terminal control route envelope conformance', () => {
  it('pins the route path to the shared fixture the Java validator reads', () => {
    expect(MANAGED_TERMINAL_WORKER_ROUTE.path).toBe(fixtures.path);
    expect(MANAGED_TERMINAL_ROUTE).toBe(fixtures.path);
  });

  it('answers every shared case with the exact fixture body', async () => {
    const origin = await start();
    for (const testCase of fixtures.cases) {
      const terminalId = testCase.request.operation.targetOperationId;
      await prepare(testCase.name, terminalId, origin);
      const answer = await post(origin, testCase.request);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual(testCase.response);
      expect(
        (answer.body as { operation: { operationId: string } }).operation
          .operationId,
      ).toBe(terminalId);
    }
  });

  const valid = fixtures.cases[0].request;
  const operation = valid.operation;
  it.each([
    ['an empty object', {}],
    ['an array body', []],
    [
      'a missing operation',
      { protocolVersion: 1, runtimeSessionId: valid.runtimeSessionId },
    ],
    ['an extra envelope key', { ...valid, extra: true }],
    ['a wrong protocol version', { ...valid, protocolVersion: 2 }],
    ['an empty runtimeSessionId', { ...valid, runtimeSessionId: '' }],
    ['a non-string runtimeSessionId', { ...valid, runtimeSessionId: 7 }],
    [
      'an unknown operation kind',
      { ...valid, operation: { ...operation, kind: 'terminal-reboot' } },
    ],
    [
      'a missing session key',
      {
        ...valid,
        operation: {
          kind: operation.kind,
          operationId: operation.operationId,
          targetOperationId: operation.targetOperationId,
        },
      },
    ],
    [
      'an empty target operation id',
      { ...valid, operation: { ...operation, targetOperationId: '' } },
    ],
    [
      'an oversized operation id',
      { ...valid, operation: { ...operation, operationId: 'x'.repeat(513) } },
    ],
  ])('refuses %s with managed_terminal_invalid', async (_name, body) => {
    const origin = await start();
    const answer = await post(origin, body);
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ code: 'managed_terminal_invalid' });
  });
});
