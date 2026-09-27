/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import {
  HostedWorkspaceBroker,
  HostedWorkspaceBrokerRejection,
} from './hosted-workspace-broker.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';

let server: Server;
afterEach(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
const identity = {
  protocolVersion: 1,
  harnessSessionId: 'session',
  runtimeSessionId: 'turn',
};
async function fixture(
  handler: (
    path: string,
    body: Record<string, unknown>,
  ) => { code?: number; body: unknown },
) {
  server = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe('Bearer test');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const response = handler(
      new URL(req.url!, 'http://fixture').pathname,
      body ? JSON.parse(body) : {},
    );
    res.writeHead(response.code ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture listener');
  return new HostedWorkspaceBroker(
    { baseUrl: `http://127.0.0.1:${address.port}`, token: 'test' },
    { tenantId: 'tenant', workspaceId: 'workspace', sessionId: 'session' },
    'turn',
  );
}

it.each(['tenantId', 'workspaceId', 'capabilityDigest'])(
  'rejects a mismatched %s at acquisition',
  async (field) => {
    const broker = await fixture(() => ({
      body: {
        ...identity,
        acquired: true,
        scope: {
          tenantId: 'tenant',
          workspaceId: 'workspace',
          capabilityDigest: WORKSPACE_CAPABILITY_DIGEST,
          [field]: 'wrong',
        },
      },
    }));
    await expect(broker.acquire()).rejects.toThrow('scope');
  },
);

it('waits for original terminal evidence after a cancellation request', async () => {
  let cancelled = false;
  let stopped = false;
  let starts = 0;
  const broker = await fixture((path) => {
    if (path.endsWith(':start')) starts++;
    if (path.endsWith(':cancel')) cancelled = true;
    return {
      body: {
        ...identity,
        executionCallId: 'execution',
        status: {
          state: stopped
            ? 'settled'
            : cancelled
              ? 'cancel_requested'
              : 'executing',
          ...(stopped ? { result: { executionStatus: 'cancelled' } } : {}),
        },
      },
    };
  });
  const abort = new AbortController();
  let finished = false;
  const execution = broker
    .execute('execution', '{}', abort.signal)
    .then((value) => {
      finished = true;
      return value;
    });
  await vi.waitFor(() => expect(starts).toBe(1));
  abort.abort();
  await vi.waitFor(() => expect(cancelled).toBe(true));
  expect(finished).toBe(false);
  stopped = true;
  await expect(execution).resolves.toMatchObject({
    executionStatus: 'cancelled',
    responseParts: [],
  });
  expect(starts).toBe(1);
});

it('never starts a pre-cancelled reservation', async () => {
  const paths: string[] = [];
  const broker = await fixture((path) => {
    paths.push(path);
    return {
      body: {
        ...identity,
        executionCallId: 'execution',
        status: { state: 'settled', result: { executionStatus: 'cancelled' } },
      },
    };
  });
  await expect(
    broker.execute('execution', '{}', AbortSignal.abort()),
  ).resolves.toMatchObject({ executionStatus: 'cancelled' });
  expect(paths).toEqual([
    '/internal/runtime-broker/v1/executions/execution:cancel',
  ]);
});

it('queries the original identity after a lost start and refuses unknown status', async () => {
  const paths: string[] = [];
  const broker = await fixture((path) => {
    paths.push(path);
    return { code: 409, body: { code: 'runtime_broker_execution_unknown' } };
  });
  await expect(
    broker.execute('execution', '{}', new AbortController().signal),
  ).rejects.toThrow('409');
  expect(paths).toEqual([
    '/internal/runtime-broker/v1/executions/execution:start',
    '/internal/runtime-broker/v1/executions/execution',
  ]);
});

it('preserves a definite acquisition refusal from the HTTP response', async () => {
  const broker = await fixture(() => ({
    code: 409,
    body: { code: 'workspace_busy' },
  }));
  await expect(broker.acquire()).rejects.toEqual(
    new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
  );
});
