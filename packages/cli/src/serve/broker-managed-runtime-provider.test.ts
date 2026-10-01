/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ManagedToolInvocationReference } from '@qwen-code/qwen-code-core';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
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

  it.each([
    ['File path must be absolute', ' File path must be absolute'],
    ['', ''],
    ['x'.repeat(4096), ` ${'x'.repeat(4096)}`],
    ['x'.repeat(4097), ''],
    ['invalid\0reason', ''],
    [null, ''],
  ])('preserves bounded Broker error reasons (%#)', async (reason, suffix) => {
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: vi.fn<typeof fetch>(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return body['operation']
          ? new Response(
              JSON.stringify({
                code: 'managed_runtime_tool_invalid',
                error: reason,
                retryable: false,
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            )
          : json(envelope({ acquired: true }));
      }),
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.manifest()).rejects.toMatchObject({
      message: `Managed Runtime Broker returned HTTP 400.${suffix}`,
      status: 400,
      code: 'managed_runtime_tool_invalid',
      retryable: false,
    });
  });

  it.each<[Record<string, unknown>, string]>([
    [{ error: 'untrusted' }, 'application/json'],
    [{ code: '', error: 'untrusted', retryable: false }, 'application/json'],
    [
      {
        code: 'managed_runtime_tool_invalid',
        error: 'untrusted',
        retryable: 'false',
      },
      'application/json',
    ],
    [
      {
        code: 'managed_runtime_tool_invalid',
        error: 'untrusted',
        retryable: false,
        extra: true,
      },
      'application/json',
    ],
    [
      {
        code: 'managed_runtime_tool_invalid',
        error: 'untrusted',
        retryable: false,
      },
      'text/plain',
    ],
    ...['not an object', null, []].map(
      (details): [Record<string, unknown>, string] => [
        {
          code: 'managed_runtime_tool_invalid',
          error: 'untrusted',
          retryable: false,
          details,
        },
        'application/json',
      ],
    ),
  ])(
    'does not display a reason outside the Broker error envelope (%#)',
    async (body, contentType) => {
      const provider = new BrokerManagedRuntimeProvider({
        baseUrl: 'http://127.0.0.1:8080',
        token: 'secret',
        fetch: vi.fn<typeof fetch>(
          async () =>
            new Response(JSON.stringify(body), {
              status: 400,
              headers: { 'content-type': contentType },
            }),
        ),
      });
      await expect(
        provider.getToolV2Client(request(), { harnessSessionId }),
      ).rejects.toMatchObject({
        message: 'Managed Runtime Broker returned HTTP 400.',
      });
    },
  );

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

  it('retries a failed acquisition and invalidates issued clients after release', async () => {
    let acquisitions = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire')) {
        acquisitions++;
        return acquisitions === 1
          ? new Response('{}', { status: 503 })
          : json(envelope({ acquired: true }));
      }
      if (url.endsWith(':release')) return json(envelope({ released: true }));
      throw new Error(`Unexpected request ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    await expect(
      provider.getToolV2Client(request(), { harnessSessionId }),
    ).rejects.toThrow('503');
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    expect(acquisitions).toBe(2);
    await provider.release(runtimeSessionId, request(), { terminal: true });
    const requests = fetchImpl.mock.calls.length;
    await expect(client.manifest()).rejects.toThrow('closed');
    await expect(client.execute(reference())).rejects.toThrow('closed');
    expect(fetchImpl).toHaveBeenCalledTimes(requests);
    provider.dispose();
  });

  it('keeps cleanup reachable when the acquire response is lost', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('tool-sessions:acquire')) {
        throw new TypeError('connection closed after acquire');
      }
      if (String(input).endsWith(':release')) {
        return json(envelope({ released: true }));
      }
      throw new Error('Unexpected request');
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    await expect(
      provider.getToolV2Client(request(), { harnessSessionId }),
    ).rejects.toThrow('connection closed');
    await expect(
      provider.release(runtimeSessionId, request(), { terminal: true }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      provider.getToolV2Client(request(), { harnessSessionId }),
    ).rejects.toThrow('permanently closed');
    provider.dispose();
  });

  it('reserves a durable execution identity before starting it', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    let droppedExecutionResponse = false;
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
    const preparedStatus = {
      ...executing,
      state: 'prepared',
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
              capabilityDigest: managedToolDigest([]),
              policyRevision: 'policy-1',
            },
          }),
        );
      }
      if (url.endsWith('/executions:prepare')) {
        if (!droppedExecutionResponse) {
          droppedExecutionResponse = true;
          throw new TypeError('response connection closed');
        }
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start')) {
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
    const reservation = await client.prepareExecution!(reference());
    expect(reservation).toEqual({
      executionCallId: 'execution-1',
      invocationBindingId: runtimeSessionId,
    });
    expect(
      calls.some((call) => call.url.endsWith('/executions/execution-1:start')),
    ).toBe(false);
    await expect(
      client.startExecution!(reference(), reservation.executionCallId),
    ).resolves.toMatchObject({
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
    const executions = calls.filter((call) =>
      call.url.endsWith('/executions:prepare'),
    );
    expect(executions).toHaveLength(2);
    expect(executions[0].body).toMatchObject({
      harnessSessionId,
      runtimeSessionId,
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      requestDigest: 'b'.repeat(64),
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(executions[1].body).toEqual(executions[0].body);
    expect(
      calls.filter((call) =>
        call.url.endsWith('/executions/execution-1:start'),
      ),
    ).toHaveLength(1);
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

  it('rejects foreign control identities before contacting the Broker', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json(envelope({ acquired: true })),
    );
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    const {
      invocationId: _invocationId,
      argsDigest: _argsDigest,
      ...identity
    } = reference();
    await expect(
      client.beginTurn({ ...identity, sessionId: harnessSessionId }),
    ).rejects.toThrow('Session identity conflicts');
    await expect(
      client.confirmation({ ...reference(), sessionId: harnessSessionId }),
    ).rejects.toThrow('Session identity conflicts');
    expect(fetchImpl).toHaveBeenCalledOnce();
    provider.dispose();
  });

  it('rejects malformed execution references before reserving them', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json(envelope({ acquired: true })),
    );
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(
      client.execute({ ...reference(), argsDigest: 'b'.repeat(63) }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
    provider.dispose();
  });

  it('requires a null acknowledgement for void provider controls', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      json(
        envelope(
          String(url).endsWith('tool-sessions:acquire')
            ? { acquired: true }
            : {},
        ),
      ),
    );
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    const {
      invocationId: _invocationId,
      argsDigest: _argsDigest,
      ...identity
    } = reference();
    await expect(client.beginTurn(identity)).rejects.toThrow();
    provider.dispose();
  });

  it('reserves replacement prepared invocations independently', async () => {
    const keys: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const target = String(url);
      if (target.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (target.endsWith(':release'))
        return json(envelope({ released: true }));
      const body = JSON.parse(String(init?.body)) as { idempotencyKey: string };
      keys.push(body.idempotencyKey);
      return json(
        envelope({
          executionCallId: `execution-${keys.length}`,
          status: {
            state: 'prepared',
            cancelRequested: false,
            lastSeq: 0,
            firstAvailableSeq: 1,
            progressGap: false,
            progress: [],
          },
        }),
      );
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await client.prepareExecution!(reference());
    await client.prepareExecution!({
      ...reference(),
      invocationId: 'replacement-invocation',
    });
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    await provider.release(runtimeSessionId, request());
    const reconnected = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await reconnected.prepareExecution!(reference());
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[0]);
    provider.dispose();
  });

  it('inspects a durable execution without recreating a process-local Runtime entry', async () => {
    let unknown = false;
    const status = {
      state: 'executing',
      cancelRequested: false,
      lastSeq: 4,
      firstAvailableSeq: 5,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.method).toBe('GET');
      const url = String(input);
      expect(url).toContain('/executions/execution-recovery?');
      expect(url).toContain(`harnessSessionId=${harnessSessionId}`);
      expect(url).toContain(`runtimeSessionId=${runtimeSessionId}`);
      expect(url).toContain('afterSeq=3');
      if (unknown) {
        return new Response(
          JSON.stringify({
            error: 'Tool execution outcome is unknown.',
            code: 'runtime_broker_execution_unknown',
            retryable: true,
          }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return json(envelope({ executionCallId: 'execution-recovery', status }));
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const identity = {
      harnessSessionId,
      runtimeSessionId,
      executionCallId: 'execution-recovery',
      afterSeq: 3,
    };

    await expect(provider.inspectExecution(identity)).resolves.toEqual({
      outcome: 'known',
      status,
    });
    unknown = true;
    await expect(provider.inspectExecution(identity)).resolves.toEqual({
      outcome: 'unknown',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps the reason of an error that carries details, such as a terminal answer', async () => {
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              error: 'Runtime execution outcome is permanently unknown.',
              code: 'runtime_broker_execution_unknown',
              retryable: false,
              details: {
                terminal: true,
                reason: 'runtime_lost',
                executionCallId: 'abandoned',
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    });
    await expect(
      provider.getToolV2Client(request(), { harnessSessionId }),
    ).rejects.toMatchObject({
      message:
        'Managed Runtime Broker returned HTTP 409. Runtime execution outcome is permanently unknown.',
      code: 'runtime_broker_execution_unknown',
      retryable: false,
      abandoned: true,
    });
  });

  it.each([
    'inspectExecution',
    'reconcileExecution',
    'cancelExecution',
  ] as const)(
    '%s preserves terminal uncertainty without acquiring, starting or polling',
    async (method) => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              code: 'runtime_broker_execution_unknown',
              retryable: false,
              details: { terminal: true, reason: 'runtime_lost' },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      );
      const provider = new BrokerManagedRuntimeProvider({
        baseUrl: 'http://127.0.0.1:8080',
        token: 'secret',
        fetch: fetchImpl,
      });
      await expect(
        provider[method]({
          harnessSessionId,
          runtimeSessionId,
          executionCallId: 'abandoned',
        }),
      ).resolves.toEqual({
        outcome: 'unknown',
        terminal: true,
        reason: 'runtime_lost',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0][0])).toContain(
        '/executions/abandoned',
      );
    },
  );

  it('cancels and waits for the original execution without starting or acquiring', async () => {
    const pending = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const cancelling = {
      ...pending,
      state: 'cancel_requested' as const,
      cancelRequested: true,
    };
    const settled = {
      ...cancelling,
      state: 'settled' as const,
      result: { executionStatus: 'cancelled' as const },
    };
    let reads = 0;
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url.includes('/executions/execution-recovery?')) {
        reads++;
        return json(
          envelope({
            executionCallId: 'execution-recovery',
            status: reads === 1 ? pending : settled,
          }),
        );
      }
      if (url.endsWith('/executions/execution-recovery:cancel')) {
        return json(
          envelope({
            executionCallId: 'execution-recovery',
            status: cancelling,
          }),
        );
      }
      throw new Error(`Unexpected Broker request: ${method} ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });

    await expect(
      provider.cancelExecution({
        harnessSessionId,
        runtimeSessionId,
        executionCallId: 'execution-recovery',
        afterSeq: 0,
      }),
    ).resolves.toEqual({ outcome: 'known', status: settled });

    expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
      expect.objectContaining({ method: 'GET' }),
      expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining('/executions/execution-recovery:cancel'),
      }),
      expect.objectContaining({ method: 'GET' }),
    ]);
    expect(calls.some((call) => call.url.includes(':start'))).toBe(false);
    expect(
      calls.some((call) => call.url.includes('tool-sessions:acquire')),
    ).toBe(false);
  });

  it('reconciles the original execution to settlement without acquiring a new Runtime', async () => {
    const result = {
      executionStatus: 'success' as const,
      result: {
        llmContent: 'recovered output',
        returnDisplay: 'recovered output',
      },
    };
    const prepared = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const executing = { ...prepared, state: 'executing' as const };
    const settled = {
      ...executing,
      state: 'settled' as const,
      result,
    };
    let reads = 0;
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url.includes('/executions/execution-recovery?')) {
        reads++;
        return json(
          envelope({
            executionCallId: 'execution-recovery',
            status: reads === 1 ? prepared : settled,
          }),
        );
      }
      if (url.endsWith('/executions/execution-recovery:start')) {
        return json(
          envelope({
            executionCallId: 'execution-recovery',
            status: executing,
          }),
        );
      }
      throw new Error(`Unexpected Broker request: ${method} ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });

    await expect(
      provider.reconcileExecution({
        harnessSessionId,
        runtimeSessionId,
        executionCallId: 'execution-recovery',
        afterSeq: 0,
      }),
    ).resolves.toEqual({ outcome: 'known', status: settled });

    expect(calls).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: expect.stringContaining('/executions/execution-recovery?'),
      }),
      expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining('/executions/execution-recovery:start'),
      }),
      expect.objectContaining({
        method: 'GET',
        url: expect.stringContaining('/executions/execution-recovery?'),
      }),
    ]);
    expect(
      calls.some((call) => call.url.includes('tool-sessions:acquire')),
    ).toBe(false);
  });

  it('resolves an unknown execution through the broker without re-executing it', async () => {
    const settled = {
      state: 'settled' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
      result: {
        executionStatus: 'not_started',
        resolution: 'confirmed_not_executed',
      },
    };
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body
        ? (JSON.parse(String(init.body)) as unknown)
        : undefined;
      calls.push({ method, url, ...(body === undefined ? {} : { body }) });
      if (url.endsWith('/executions/execution-recovery:resolve')) {
        return json(
          envelope({
            executionCallId: 'execution-recovery',
            status: settled,
          }),
        );
      }
      throw new Error(`Unexpected Broker request: ${method} ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });

    await expect(
      provider.resolveExecution(
        {
          harnessSessionId,
          runtimeSessionId,
          executionCallId: 'execution-recovery',
        },
        'confirmed_not_executed',
      ),
    ).resolves.toEqual({ outcome: 'known', status: settled });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(
      'http://127.0.0.1:8080/internal/runtime-broker/v1/executions/execution-recovery:resolve',
    );
    expect(calls[0].body).toMatchObject({
      protocolVersion: 1,
      harnessSessionId,
      runtimeSessionId,
      resolution: 'confirmed_not_executed',
      requestId: expect.any(String),
    });
  });
});
