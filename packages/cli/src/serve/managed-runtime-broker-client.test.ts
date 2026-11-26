/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ManagedToolInvocationReference } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { ManagedRuntimeBrokerClient } from './managed-runtime-broker-client.js';

const harnessSessionId = '550e8400-e29b-41d4-a716-446655440301';
const runtimeSessionId = '550e8400-e29b-41d4-a716-446655440302';
const reference: ManagedToolInvocationReference = {
  sessionId: runtimeSessionId,
  promptId: 'turn-1',
  callId: 'tool-1',
  capabilityDigest: 'a'.repeat(64),
  policyRevision: 'policy-1',
  invocationId: 'invocation-1',
  argsDigest: 'b'.repeat(64),
};
const status = {
  state: 'prepared',
  cancelRequested: false,
  lastSeq: 0,
  firstAvailableSeq: 0,
  progressGap: false,
  progress: [],
};

function response(fields: Record<string, unknown>): Response {
  return Response.json({
    protocolVersion: 1,
    harnessSessionId,
    runtimeSessionId,
    ...fields,
  });
}

function client(fetchImpl: typeof fetch): ManagedRuntimeBrokerClient {
  return new ManagedRuntimeBrokerClient({
    baseUrl: 'http://127.0.0.1:8080',
    token: 'secret',
    fetch: fetchImpl,
  });
}

describe('ManagedRuntimeBrokerClient', () => {
  it('acquires using the Harness identity without forwarding workspace claims', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({ acquired: true }),
    );
    await client(fetchImpl).acquire(
      {
        protocolVersion: 1,
        tenantId: 'tenant',
        workspaceId: 'workspace',
        workspaceCwd: '/workspace',
        sessionId: runtimeSessionId,
        turnKind: 'bootstrap',
      },
      harnessSessionId,
      new AbortController().signal,
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'http://127.0.0.1:8080/internal/runtime-broker/v1/tool-sessions:acquire',
    );
    expect(init?.headers).toEqual({
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      protocolVersion: 1,
      requestId: expect.any(String),
      harnessSessionId,
      runtimeSessionId,
      turnKind: 'bootstrap',
    });
  });

  it('retries an interrupted reservation with the same idempotency identity', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('connection closed'))
      .mockResolvedValueOnce(
        response({ executionCallId: 'execution-1', status }),
      );
    const result = await client(fetchImpl).prepareExecution(
      runtimeSessionId,
      harnessSessionId,
      reference,
      new AbortController().signal,
    );
    expect(result).toEqual({ executionCallId: 'execution-1', status });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1]?.body).toBe(
      fetchImpl.mock.calls[0][1]?.body,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/u),
      reference,
    });
  });

  it('does not retry a reservation the Broker declared permanent', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          code: 'runtime_admission_closed',
          error: 'Closed.',
          retryable: false,
        },
        { status: 503 },
      ),
    );
    await expect(
      client(fetchImpl).prepareExecution(
        runtimeSessionId,
        harnessSessionId,
        reference,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Closed.');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects a response from another runtime Session', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({
        runtimeSessionId: 'another-session',
        executionCallId: 'execution-1',
        status,
      }),
    );
    await expect(
      client(fetchImpl).getExecution(
        runtimeSessionId,
        harnessSessionId,
        'execution-1',
        undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow('response identity changed');
  });

  it('requires an explicit release acknowledgement', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({}));
    await expect(
      client(fetchImpl).release(
        runtimeSessionId,
        harnessSessionId,
        new AbortController().signal,
      ),
    ).resolves.toBe(false);
  });
});
