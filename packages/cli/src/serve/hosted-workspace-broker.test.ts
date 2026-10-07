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
    const url = new URL(req.url!, 'http://fixture');
    const response = handler(
      url.pathname,
      body ? JSON.parse(body) : Object.fromEntries(url.searchParams),
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

it('preserves payload identity separately from the explicitly selected v3 input digest', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const broker = await fixture((path, body) => {
    requests.push(body);
    return {
      body: {
        ...identity,
        ...(path.endsWith(':publisher')
          ? { installed: true, bindingGeneration: '7' }
          : {
              executionCallId: 'execution',
              status: { state: 'prepared' },
            }),
      },
    };
  });
  expect(
    await broker.registerPublisher({
      url: 'http://127.0.0.1:99/internal/hosted-shell-publisher/v1',
      token: 'x'.repeat(43),
    }),
  ).toBe('7');
  await broker.prepare(
    'runtime-call',
    `sha256:${'a'.repeat(64)}`,
    'b'.repeat(64),
  );
  expect(requests[1]).toMatchObject({
    requestDigest: `sha256:${'a'.repeat(64)}`,
    reference: {
      sessionId: 'turn',
      promptId: 'turn',
      callId: 'runtime-call',
      argsDigest: `sha256:${'a'.repeat(64)}`,
      runtimeProtocol: 3,
      inputDigest: 'b'.repeat(64),
    },
  });
});

it.each([undefined, 'b'.repeat(64)])(
  'keeps the original Runtime owner separate from the prompt and input digest (%s)',
  async (inputDigest) => {
    const requests: Array<Record<string, unknown>> = [];
    const broker = await fixture((_path, body) => {
      requests.push(body);
      return {
        body: {
          ...identity,
          executionCallId: 'execution',
          status: { state: 'prepared' },
        },
      };
    });
    await broker.prepare('call', 'sha256:payload', inputDigest, 'next-prompt');
    expect(requests[0]).toMatchObject({
      runtimeSessionId: 'turn',
      turnId: 'next-prompt',
      idempotencyKey: 'turn:call',
      requestDigest: 'sha256:payload',
    });
    expect(requests[0]['reference']).toEqual({
      sessionId: 'turn',
      promptId: 'next-prompt',
      callId: 'call',
      argsDigest: 'sha256:payload',
      ...(inputDigest ? { runtimeProtocol: 3, inputDigest } : {}),
    });
  },
);

it('requires confirmation for the exact Shell receipt acknowledgement', async () => {
  const broker = await fixture((_path, body) => {
    expect(body['receipt']).toMatchObject({
      executionCallId: 'execution',
      deliveryStatus: 'blocked',
      historyRevision: null,
    });
    expect(body['receipt']).not.toHaveProperty('outcomeRef');
    return {
      body: { ...identity, executionCallId: 'other', acknowledged: true },
    };
  });
  await expect(
    broker.acknowledge('execution', {
      executionCallId: 'execution',
      manifest: null,
      deliveryStatus: 'blocked',
      historyRevision: null,
      outcomeRef: {
        resourceId: 'outcome',
        kind: 'managed-tool-outcome',
        schemaVersion: 1,
        byteLength: 0,
        digest: 'a'.repeat(64),
      },
    }),
  ).rejects.toThrow('acknowledge');
});

it('replays a Shell receipt acknowledgement whose reply was lost', async () => {
  const attempts: Array<Record<string, unknown>> = [];
  const broker = await fixture((_path, body) => {
    attempts.push(body);
    // The Broker applies the acknowledgement, but the reply never arrives.
    if (attempts.length === 1) return { drop: true };
    return {
      body: { ...identity, executionCallId: 'execution', acknowledged: true },
    };
  });
  await expect(
    broker.acknowledge('execution', {
      executionCallId: 'execution',
      manifest: null,
      deliveryStatus: 'blocked',
      historyRevision: null,
      outcomeRef: {
        resourceId: 'outcome',
        kind: 'managed-tool-outcome',
        schemaVersion: 1,
        byteLength: 0,
        digest: 'a'.repeat(64),
      },
    }),
  ).resolves.toBeUndefined();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual({
    ...attempts[0],
    requestId: expect.any(String),
  });
  expect((attempts[1] as Record<string, unknown>)['receipt']).toEqual(
    attempts[0]!['receipt'],
  );
});

it('does not replay a refused Shell receipt acknowledgement', async () => {
  const attempts: Array<Record<string, unknown>> = [];
  const broker = await fixture((_path, body) => {
    attempts.push(body);
    return {
      code: 409,
      body: { code: 'runtime_execution_conflict', message: 'conflict' },
    };
  });
  await expect(
    broker.acknowledge('execution', {
      executionCallId: 'execution',
      manifest: null,
      deliveryStatus: 'blocked',
      historyRevision: null,
      outcomeRef: {
        resourceId: 'outcome',
        kind: 'managed-tool-outcome',
        schemaVersion: 1,
        byteLength: 0,
        digest: 'a'.repeat(64),
      },
    }),
  ).rejects.toBeInstanceOf(HostedWorkspaceBrokerRejection);
  expect(attempts).toHaveLength(1);
});

it('accepts the Broker acknowledgement envelope for a remote v3 receipt', async () => {
  const broker = await fixture((_path, body) => {
    expect(body['receipt']).toEqual({
      executionCallId: 'execution',
      manifest: null,
      deliveryStatus: 'blocked',
      historyRevision: null,
    });
    return {
      body: {
        ...identity,
        executionCallId: 'execution',
        acknowledged: true,
        status: { state: 'settled' },
      },
    };
  });
  await expect(
    broker.acknowledgeV3('execution', {
      executionCallId: 'execution',
      manifest: null,
      deliveryStatus: 'blocked',
      historyRevision: null,
    }),
  ).resolves.toBeUndefined();
});

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
  const broker = await fixture((path, fields) => {
    paths.push(path);
    expect(fields).not.toHaveProperty('reconcile');
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

it('observes a late original result after unknown cancellation without starting again', async () => {
  const paths: string[] = [];
  const queries: Array<Record<string, unknown>> = [];
  let observations = 0;
  const broker = await fixture((path, fields) => {
    paths.push(path);
    if (!path.endsWith(':cancel')) queries.push(fields);
    if (path.endsWith(':cancel') || observations++ === 0)
      return { code: 409, body: { code: 'runtime_broker_execution_unknown' } };
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
  const abort = new AbortController();
  abort.abort();
  await expect(
    broker.execute('execution', '{}', abort.signal, 5000, true),
  ).resolves.toMatchObject({ executionStatus: 'success' });
  expect(paths.filter((path) => path.endsWith(':cancel'))).toHaveLength(1);
  expect(paths.filter((path) => path.endsWith(':start'))).toHaveLength(0);
  expect(paths.filter((path) => path.endsWith('/execution'))).toHaveLength(2);
  for (const query of queries)
    expect(query).toMatchObject({
      reconcile: 'true',
      harnessSessionId: 'session',
      runtimeSessionId: 'turn',
    });
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

it('restarts the same Tool v3 reservation after an uncertain start leaves it prepared', async () => {
  let starts = 0;
  const broker = await fixture((path, body) => {
    if (path.endsWith(':start')) {
      starts++;
      expect(body['payloadJson']).toBe(
        '{"toolName":"run_shell_command","input":{}}',
      );
      if (starts === 1)
        return { code: 503, body: { code: 'runtime_execution_failed' } };
    }
    return {
      body: {
        ...identity,
        executionCallId: 'execution',
        status:
          starts < 2
            ? { state: 'prepared' }
            : {
                state: 'settled',
                result: { executionStatus: 'success', responseParts: [] },
              },
      },
    };
  });
  await expect(
    broker.executeV3(
      'execution',
      '{"toolName":"run_shell_command","input":{}}',
      'publication',
      'token',
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ executionStatus: 'success' });
  expect(starts).toBe(2);
});

it('preserves an explicit unsupported Tool v3 start rejection', async () => {
  let statusReads = 0;
  const broker = await fixture((path) => {
    if (path.endsWith(':start'))
      return { code: 501, body: { code: 'runtime_tool_v3_unsupported' } };
    statusReads++;
    return { body: { ...identity, status: { state: 'prepared' } } };
  });
  await expect(
    broker.executeV3(
      'execution',
      '{"toolName":"run_shell_command","input":{}}',
      'publication',
      'token',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    status: 501,
    code: 'runtime_tool_v3_unsupported',
  });
  expect(statusReads).toBe(0);
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

it('retries a cancellation whose transport reply was lost without restarting', async () => {
  const paths: string[] = [];
  let cancellations = 0;
  const broker = await fixture((path) => {
    paths.push(path);
    if (path.endsWith(':cancel') && ++cancellations === 1)
      return { drop: true };
    return {
      body: {
        ...identity,
        executionCallId: 'execution',
        status: {
          state: 'settled',
          result: { executionStatus: 'cancelled' },
        },
      },
    };
  });
  const abort = new AbortController();
  abort.abort();
  await expect(
    broker.execute('execution', '{}', abort.signal, 3000, true),
  ).resolves.toMatchObject({ executionStatus: 'cancelled' });
  expect(paths.filter((entry) => entry.endsWith(':cancel'))).toHaveLength(2);
  expect(paths.some((entry) => entry.endsWith(':start'))).toBe(false);
});

it('stops observation immediately when the original execution is terminally unknown', async () => {
  const paths: string[] = [];
  const broker = await fixture((path) => {
    paths.push(path);
    return {
      code: 409,
      body: {
        code: 'runtime_broker_execution_unknown',
        details: { terminal: true, reason: 'runtime_lost' },
      },
    };
  });
  const abort = new AbortController();
  abort.abort();
  await expect(
    broker.execute('execution', '{}', abort.signal, 500, true),
  ).rejects.toMatchObject({
    code: 'runtime_broker_execution_unknown',
    details: { terminal: true, reason: 'runtime_lost' },
  });
  expect(paths).toHaveLength(1);
});

it('forwards hook recovery to the original owner and rejects a changed receipt identity', async () => {
  let changed = false;
  const broker = await fixture((path, body) => {
    expect(path).toBe('/internal/runtime-broker/v1/tool-sessions/turn/control');
    expect(body['operation']).toMatchObject({
      kind: 'hook-status',
      targetOperationId: 'original-hook',
    });
    return {
      body: {
        ...identity,
        result: {
          operationId: changed ? 'different-hook' : 'original-hook',
          state: 'outcome_unknown',
        },
      },
    };
  });
  const control = {
    kind: 'hook-status' as const,
    sessionKey: {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
    operationId: 'lookup',
    targetOperationId: 'original-hook',
  };
  expect(await broker.hookControl(control)).toEqual({
    operationId: 'original-hook',
    state: 'outcome_unknown',
  });
  changed = true;
  await expect(broker.hookControl(control)).rejects.toThrow(
    'Hook response identity',
  );
});

it('preserves a worker history refusal reason', async () => {
  const broker = await fixture(() => ({
    code: 409,
    body: {
      code: 'managed_runtime_provider_operation_failed',
      error: 'ordinary files only',
    },
  }));
  await expect(
    broker.fileHistory({
      kind: 'raw-file-history',
      action: 'prepare',
      promptId: 'prompt',
      paths: ['dir'],
    }),
  ).rejects.toMatchObject({
    status: 409,
    code: 'managed_runtime_provider_operation_failed',
    reason: 'ordinary files only',
  });
});

it('reads Workspace context on its own tool-session route, through the result parser', async () => {
  // The parser is the only gate between the Broker's reply and the system
  // instruction: a name outside the closed list must not get through.
  const paths: string[] = [];
  let files: unknown = [{ name: 'QWEN.md', text: 'project rules' }];
  const broker = await fixture((path) => {
    paths.push(path);
    return { body: { ...identity, result: { files } } };
  });
  await expect(broker.workspaceContext()).resolves.toEqual([
    { name: 'QWEN.md', text: 'project rules' },
  ]);
  expect(paths[0]).toBe(
    '/internal/runtime-broker/v1/tool-sessions/turn/control',
  );
  files = [{ name: '../etc/passwd', text: 'host' }];
  await expect(broker.workspaceContext()).rejects.toThrow(
    'Invalid Workspace context result.',
  );
});

it('resolves a durable execution status for recovery reports', async () => {
  const broker = await fixture(() => ({
    body: {
      ...identity,
      executionCallId: 'execution',
      status: {
        state: 'settled',
        result: { executionStatus: 'success', responseParts: [] },
      },
    },
  }));
  await expect(broker.status('execution')).resolves.toEqual({
    state: 'settled',
  });
});

it('distinguishes unknown outcomes from definitive not-found records', async () => {
  const missing = await fixture(() => ({
    code: 404,
    body: { code: 'runtime_execution_not_found' },
  }));
  await expect(missing.status('execution')).resolves.toBeUndefined();

  const abandoned = await fixture(() => ({
    code: 409,
    body: {
      code: 'runtime_broker_execution_unknown',
      details: { terminal: true },
    },
  }));
  await expect(abandoned.status('execution')).resolves.toEqual({
    state: 'unknown',
  });

  const unknown = await fixture(() => ({
    code: 409,
    body: { code: 'runtime_broker_execution_unknown' },
  }));
  await expect(unknown.status('execution')).resolves.toEqual({
    state: 'unknown',
  });

  const failing = await fixture(() => ({
    code: 500,
    body: { code: 'runtime_broker_internal_error' },
  }));
  await expect(failing.status('execution')).rejects.toEqual(
    new HostedWorkspaceBrokerRejection(500, 'runtime_broker_internal_error'),
  );

  const busy = await fixture(() => ({
    code: 409,
    body: { code: 'workspace_busy' },
  }));
  await expect(busy.status('execution')).rejects.toEqual(
    new HostedWorkspaceBrokerRejection(409, 'workspace_busy'),
  );
});

it('refuses a runtime state it cannot name', async () => {
  const broker = await fixture(() => ({
    body: {
      ...identity,
      executionCallId: 'execution',
      status: { state: 'mystery' },
    },
  }));
  await expect(broker.status('execution')).rejects.toThrow(
    'Runtime execution outcome is unknown.',
  );
});

it('refuses a status answer for a different execution', async () => {
  const broker = await fixture(() => ({
    body: {
      ...identity,
      executionCallId: 'other',
      status: { state: 'settled' },
    },
  }));
  await expect(broker.status('execution')).rejects.toThrow(
    'Runtime execution identity changed.',
  );
});
