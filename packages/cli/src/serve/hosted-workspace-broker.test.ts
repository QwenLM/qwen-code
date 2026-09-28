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
  ) => { code?: number; body?: unknown; drop?: boolean },
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
    if (response.drop) {
      res.destroy();
      return;
    }
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

it('retries a lost prepare reply with the original reservation', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const broker = await fixture((path, body) => {
    expect(path).toBe('/internal/runtime-broker/v1/executions:prepare');
    requests.push(body);
    return requests.length === 1
      ? { drop: true }
      : {
          body: {
            ...identity,
            executionCallId: 'reserved',
            status: { state: 'prepared' },
          },
        };
  });
  await expect(broker.prepare('call', 'sha256:original')).resolves.toBe(
    'reserved',
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual({
    ...requests[0],
    requestId: expect.any(String),
  });
  expect(requests[0]).toMatchObject({
    idempotencyKey: 'turn:call',
    toolCallId: 'call',
    requestDigest: 'sha256:original',
    reference: {
      sessionId: 'turn',
      promptId: 'turn',
      callId: 'call',
      argsDigest: 'sha256:original',
    },
  });
});

it('stops after two lost prepare replies', async () => {
  let requests = 0;
  const broker = await fixture(() => {
    requests++;
    return { drop: true };
  });
  await expect(broker.prepare('call', 'digest')).rejects.toThrow();
  expect(requests).toBe(2);
});

it.each([
  { code: 409, body: { code: 'runtime_idempotency_conflict' } },
  { code: 503, body: { code: 'runtime_unavailable' } },
  { body: { ...identity, harnessSessionId: 'wrong' } },
  { body: { ...identity, status: { state: 'prepared' } } },
])('does not retry a definite or invalid prepare reply: %j', async (reply) => {
  let requests = 0;
  const broker = await fixture(() => {
    requests++;
    return reply;
  });
  await expect(broker.prepare('call', 'digest')).rejects.toThrow();
  expect(requests).toBe(1);
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

it.each(['runtime_idempotency_conflict', 'runtime_execution_conflict'])(
  'preserves a definite %s start rejection without polling',
  async (code) => {
    const paths: string[] = [];
    const broker = await fixture((path) => {
      paths.push(path);
      return { code: 409, body: { code } };
    });
    await expect(
      broker.execute('execution', '{}', new AbortController().signal),
    ).rejects.toEqual(new HostedWorkspaceBrokerRejection(409, code));
    expect(paths).toEqual([
      '/internal/runtime-broker/v1/executions/execution:start',
    ]);
  },
);

it('queries the original identity when start reports an unknown execution', async () => {
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

it('queries the original identity after an uncertain start failure', async () => {
  const paths: string[] = [];
  const broker = await fixture((path) => {
    paths.push(path);
    if (path.endsWith(':start'))
      return { code: 503, body: { code: 'runtime_execution_failed' } };
    return {
      body: {
        ...identity,
        executionCallId: 'execution',
        status: {
          state: 'settled',
          result: { executionStatus: 'success', responseParts: [] },
        },
      },
    };
  });
  await expect(
    broker.execute('execution', '{}', new AbortController().signal),
  ).resolves.toMatchObject({ executionStatus: 'success' });
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
