/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ManagedToolInvocationReference } from '@qwen-code/qwen-code-core';
import {
  BrokerManagedRuntimeProvider,
  MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION,
} from './broker-managed-runtime-provider.js';
import type { ManagedRuntimePrepareRequest } from './managed-runtime-protocol.js';

const harnessSessionId = '550e8400-e29b-41d4-a716-446655440301';
const runtimeSessionId = '550e8400-e29b-41d4-a716-446655440302';

function request(): ManagedRuntimePrepareRequest {
  return {
    protocolVersion: 1,
    tenantId: 'tenant-must-not-cross-the-broker-boundary',
    workspaceId: 'workspace-must-not-cross-the-broker-boundary',
    workspaceCwd: '/workspace/must-not-cross-the-broker-boundary',
    sessionId: runtimeSessionId,
    turnKind: 'bootstrap',
  };
}

function reference(): ManagedToolInvocationReference {
  return {
    sessionId: runtimeSessionId,
    promptId: 'turn-1',
    callId: 'tool-1',
    capabilityDigest: 'a'.repeat(64),
    policyRevision: 'policy-1',
    invocationId: 'invocation-1',
    argsDigest: 'b'.repeat(64),
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function envelope(fields: Record<string, unknown>) {
  return {
    protocolVersion: MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION,
    harnessSessionId,
    runtimeSessionId,
    ...fields,
  };
}

describe('BrokerManagedRuntimeProvider', () => {
  it('requires a credential and HTTPS for a remote Broker', () => {
    expect(
      () =>
        new BrokerManagedRuntimeProvider({
          baseUrl: 'http://broker.example.com',
          token: 'secret',
        }),
    ).toThrow('must use HTTPS');
    expect(
      () =>
        new BrokerManagedRuntimeProvider({
          baseUrl: 'http://127.0.0.1:8080',
          token: ' ',
        }),
    ).toThrow('token is required');
  });

  it('acquires by Harness identity without forwarding tenant or workspace claims', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      return json(envelope({ acquired: true }));
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });

    await provider.getToolV2Client(request(), { harnessSessionId });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'http://127.0.0.1:8080/internal/runtime-broker/v1/tool-sessions:acquire',
    );
    expect(bodies[0]).toMatchObject({
      protocolVersion: 1,
      harnessSessionId,
      runtimeSessionId,
      turnKind: 'bootstrap',
      requestId: expect.any(String),
    });
    expect(bodies[0]).not.toHaveProperty('tenantId');
    expect(bodies[0]).not.toHaveProperty('workspaceId');
    expect(bodies[0]).not.toHaveProperty('workspaceCwd');
  });

  it('routes typed control and durable execution identities through the Broker', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const settled = {
      state: 'settled',
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
      result: {
        executionStatus: 'success',
        result: { llmContent: 'ok', returnDisplay: 'ok' },
      },
    };
    const executing = {
      ...settled,
      state: 'executing',
      result: undefined,
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body
        ? (JSON.parse(String(init.body)) as unknown)
        : undefined;
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (url.endsWith('tool-sessions:acquire')) {
        return json(envelope({ acquired: true }));
      }
      if (url.endsWith(`/tool-sessions/${runtimeSessionId}/control`)) {
        return json(
          envelope({
            result: {
              tools: [],
              capabilityDigest: 'a'.repeat(64),
              policyRevision: 'policy-1',
            },
          }),
        );
      }
      if (url.endsWith('/executions')) {
        return json(
          envelope({ executionCallId: 'execution-1', status: executing }),
        );
      }
      if (url.includes('/executions/execution-1?')) {
        return json(
          envelope({ executionCallId: 'execution-1', status: settled }),
        );
      }
      if (url.endsWith(`/tool-sessions/${runtimeSessionId}:release`)) {
        return json(envelope({ released: true }));
      }
      throw new Error(`Unexpected Broker request: ${method} ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const prepared = request();
    const client = await provider.getToolV2Client(prepared, {
      harnessSessionId,
    });

    await expect(client.manifest()).resolves.toMatchObject({
      policyRevision: 'policy-1',
    });
    await expect(client.execute(reference())).resolves.toMatchObject({
      executionStatus: 'success',
    });
    await expect(client.execute(reference())).resolves.toMatchObject({
      executionStatus: 'success',
    });
    await expect(
      provider.release(runtimeSessionId, prepared, { terminal: true }),
    ).resolves.toBe(true);

    const control = calls.find((call) => call.url.endsWith('/control'));
    expect(control?.body).toMatchObject({
      harnessSessionId,
      operation: { kind: 'manifest' },
    });
    const executions = calls.filter((call) => call.url.endsWith('/executions'));
    expect(executions).toHaveLength(1);
    expect(executions[0].body).toMatchObject({
      harnessSessionId,
      runtimeSessionId,
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      requestDigest: 'b'.repeat(64),
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const status = calls.find((call) =>
      call.url.includes('/executions/execution-1?'),
    );
    expect(status?.url).toContain(
      `harnessSessionId=${encodeURIComponent(harnessSessionId)}`,
    );
    expect(status?.url).toContain(
      `runtimeSessionId=${encodeURIComponent(runtimeSessionId)}`,
    );
  });

  it('fails closed when Broker response identity changes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json({
        protocolVersion: 1,
        harnessSessionId: 'another-session',
        runtimeSessionId,
        acquired: true,
      }),
    );
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });

    await expect(
      provider.getToolV2Client(request(), { harnessSessionId }),
    ).rejects.toThrow('response identity changed');
  });
});
