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
    const first = await client.prepareExecution!(reference());
    const replacement = await client.prepareExecution!({
      ...reference(),
      invocationId: 'replacement-invocation',
    });
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    // The Broker-assigned call ids are stored and forwarded faithfully — the
    // mock answers each reservation with a fresh one.
    expect(first.executionCallId).toBe('execution-1');
    expect(replacement.executionCallId).toBe('execution-2');
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

  it('does not re-send an execution the Broker declared non-retryable', async () => {
    let prepares = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        prepares++;
        return new Response(
          JSON.stringify({
            code: 'runtime_broker_overloaded',
            error: 'Overloaded.',
            retryable: false,
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('503');
    expect(prepares).toBe(1);
    // The refusal stays cached: a second execute and even a pure status
    // read surface the same answer without re-sending the reservation.
    await expect(client.execute(reference())).rejects.toThrow('503');
    await expect(client.status(reference())).rejects.toThrow('503');
    expect(prepares).toBe(1);
    provider.dispose();
  });

  it('does not re-drive a start the Broker declared non-retryable', async () => {
    let prepares = 0;
    let starts = 0;
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        prepares++;
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start')) {
        starts++;
        return new Response(
          JSON.stringify({
            code: 'runtime_execution_conflict',
            error: 'Refused.',
            retryable: false,
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('409');
    // The declared refusal stays cached: a second execute surfaces the same
    // answer without re-driving the start or re-sending the reservation.
    await expect(client.execute(reference())).rejects.toThrow('409');
    expect(starts).toBe(1);
    expect(prepares).toBe(1);
    provider.dispose();
  });

  it('re-drives a start the Broker answered execution_unknown on', async () => {
    let prepares = 0;
    let starts = 0;
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const settledStatus = {
      ...preparedStatus,
      state: 'settled' as const,
      result: { executionStatus: 'success' },
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        prepares++;
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start')) {
        // execution_unknown without the terminal abandoned detail is
        // reconcilable — the record can still settle — so the invocation
        // must re-drive rather than replay the 409 for the session's life.
        if (++starts === 1)
          return new Response(
            JSON.stringify({
              code: 'runtime_broker_execution_unknown',
              error: 'Execution unknown.',
              retryable: false,
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        return json(
          envelope({ executionCallId: 'execution-1', status: settledStatus }),
        );
      }
      if (url.includes('/executions/execution-1?'))
        return json(
          envelope({ executionCallId: 'execution-1', status: settledStatus }),
        );
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('409');
    await expect(client.execute(reference())).resolves.toMatchObject({
      executionStatus: 'success',
    });
    expect(starts).toBe(2);
    expect(prepares).toBe(2);
    await expect(client.status(reference())).resolves.toMatchObject({
      state: 'settled',
    });
    provider.dispose();
  });

  it('keeps a start the Broker declared abandoned permanently cached', async () => {
    let prepares = 0;
    let starts = 0;
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        prepares++;
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start')) {
        starts++;
        // The terminal runtime_lost variant is not reconcilable: the
        // invocation stays cached rather than re-driving a start the Broker
        // has declared permanently unknown.
        return new Response(
          JSON.stringify({
            code: 'runtime_broker_execution_unknown',
            error: 'Runtime execution outcome is permanently unknown.',
            retryable: false,
            details: { terminal: true, reason: 'runtime_lost' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toMatchObject({
      code: 'runtime_broker_execution_unknown',
      abandoned: true,
    });
    await expect(client.execute(reference())).rejects.toMatchObject({
      code: 'runtime_broker_execution_unknown',
      abandoned: true,
    });
    expect(starts).toBe(1);
    expect(prepares).toBe(1);
    provider.dispose();
  });

  it('re-prepares an execution after a transient reservation failure', async () => {
    let prepares = 0;
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        if (++prepares <= 2) return new Response('{}', { status: 503 });
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start'))
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'success' },
            },
          }),
        );
      if (url.includes('/executions/execution-1?'))
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'success' },
            },
          }),
        );
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('503');
    expect(prepares).toBe(2);
    // A changed-digest read against the tombstone is an identity conflict,
    // not a replay of the recorded failure — and it must not write.
    const changed = { ...reference(), argsDigest: 'c'.repeat(64) };
    await expect(client.status(changed)).rejects.toMatchObject({
      code: 'managed_runtime_identity_conflict',
    });
    await expect(client.cancel(changed)).rejects.toMatchObject({
      code: 'managed_runtime_identity_conflict',
    });
    expect(prepares).toBe(2);
    // A pure status read must not re-create the reservation the transient
    // failure evicted: it surfaces the recorded rejection without a POST.
    await expect(client.status(reference())).rejects.toThrow('503');
    expect(prepares).toBe(2);
    await expect(client.execute(reference())).resolves.toMatchObject({
      executionStatus: 'success',
    });
    expect(prepares).toBe(3);
    // After the successful re-drive the invocation holds BOTH a live
    // execution and the stale tombstone; a read must resolve from the live
    // one. Reading the tombstone first would re-throw the recorded 503 for
    // an invocation that already succeeded.
    await expect(client.status(reference())).resolves.toMatchObject({
      state: 'settled',
    });
    provider.dispose();
  });

  it('re-prepares an execution after a transport failure', async () => {
    let prepares = 0;
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        // A lost connection rejects with TypeError on the first attempt and
        // on the in-band retry alike; the rejected reservation must be
        // evicted, not cached for the session's life.
        if (++prepares <= 2) throw new TypeError('fetch failed');
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start'))
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'success' },
            },
          }),
        );
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('fetch failed');
    expect(prepares).toBe(2);
    await expect(client.execute(reference())).resolves.toMatchObject({
      executionStatus: 'success',
    });
    expect(prepares).toBe(3);
    provider.dispose();
  });

  it('re-prepares an execution after an undecodable Broker response', async () => {
    let prepares = 0;
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        // An HTTP 200 whose body cannot be decoded (an LB drain page, a
        // truncated reply) is a transport-shaped fault: the in-band retry
        // fails too, then the next execute re-prepares rather than
        // replaying the dead answer.
        if (++prepares <= 2)
          return new Response('not json', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start'))
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'success' },
            },
          }),
        );
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('invalid JSON');
    expect(prepares).toBe(2);
    await expect(client.execute(reference())).resolves.toMatchObject({
      executionStatus: 'success',
    });
    expect(prepares).toBe(3);
    provider.dispose();
  });

  it('re-prepares an execution after a transport fault on a live request signal', async () => {
    let prepares = 0;
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        // A DOMException rejection while the request signal is still live —
        // not the request timeout: a real timeout aborts the composite
        // signal before fetch rejects, and the gate then skips the in-band
        // retry. Transport-shaped, so the rejected reservation must be
        // evicted, not cached for the session.
        if (++prepares <= 2)
          throw new DOMException(
            'The operation was aborted due to timeout',
            'TimeoutError',
          );
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start'))
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'success' },
            },
          }),
        );
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow(
      'aborted due to timeout',
    );
    expect(prepares).toBe(2);
    await expect(client.execute(reference())).resolves.toMatchObject({
      executionStatus: 'success',
    });
    expect(prepares).toBe(3);
    provider.dispose();
  });

  it('does not re-drive a prepare in-band after its signal aborts', async () => {
    let prepares = 0;
    let rejectPrepare: ((reason?: unknown) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return Promise.resolve(json(envelope({ acquired: true })));
      if (url.endsWith('/executions:prepare')) {
        // The first prepare parks until dispose() aborts the request signal;
        // a later prepare rejects at once, so a missing signal.aborted gate
        // fails as a second prepare instead of hanging.
        if (++prepares === 1)
          return new Promise<Response>((_resolve, reject) => {
            rejectPrepare = reject;
          });
        return Promise.reject(
          new DOMException(
            'The operation was aborted due to timeout',
            'TimeoutError',
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected Broker request: ${url}`));
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    const execution = client.execute(reference());
    expect(rejectPrepare).toBeDefined();
    provider.dispose();
    rejectPrepare?.(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    );
    await expect(execution).rejects.toThrow('aborted due to timeout');
    expect(prepares).toBe(1);
  });

  it.each([
    ['declared content-length', true, 200] as const,
    ['streamed body', false, 200] as const,
    ['streamed 5xx body', false, 503] as const,
  ])(
    'caches an over-limit Broker body (%s) instead of re-driving it',
    async (_label, declareLength, status) => {
      let prepares = 0;
      const overLimit = () => {
        if (declareLength)
          return new Response('{}', {
            status,
            headers: {
              'content-type': 'application/json',
              'content-length': String(9 * 1024 * 1024),
            },
          });
        const chunk = new Uint8Array(1024 * 1024).fill(120);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < 9; i++) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status, headers: { 'content-type': 'application/json' } },
        );
      };
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('tool-sessions:acquire'))
          return json(envelope({ acquired: true }));
        if (url.endsWith('/executions:prepare')) {
          prepares++;
          return overLimit();
        }
        throw new Error(`Unexpected Broker request: ${url}`);
      });
      const provider = new BrokerManagedRuntimeProvider({
        baseUrl: 'http://127.0.0.1:8080',
        token: 'secret',
        fetch: fetchImpl,
      });
      const client = await provider.getToolV2Client(request(), {
        harnessSessionId,
      });
      // The size limit is a deterministic property of the response, not the
      // transport: both the in-band retry and every later execute replay
      // the recorded refusal instead of re-transferring a doomed body.
      await expect(client.execute(reference())).rejects.toMatchObject({
        name: 'BrokerWireError',
        message: expect.stringContaining('exceeded its limit'),
      });
      expect(prepares).toBe(1);
      await expect(client.execute(reference())).rejects.toMatchObject({
        name: 'BrokerWireError',
        message: expect.stringContaining('exceeded its limit'),
      });
      expect(prepares).toBe(1);
      provider.dispose();
    },
  );

  it('re-prepares an execution the Broker marked retryable below 500', async () => {
    let prepares = 0;
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        prepares++;
        // Defensive: no shipped Broker answers a sub-500 body carrying
        // retryable: true, but if one ever does, the declared retryability
        // must be honored rather than cached. A sub-500 answer skips the
        // in-band retry, so each execute is exactly one prepare.
        if (prepares === 1)
          return new Response(
            JSON.stringify({
              code: 'runtime_broker_throttled',
              error: 'Slow down.',
              retryable: true,
            }),
            { status: 429, headers: { 'content-type': 'application/json' } },
          );
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start'))
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'success' },
            },
          }),
        );
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('429');
    expect(prepares).toBe(1);
    await expect(client.execute(reference())).resolves.toMatchObject({
      executionStatus: 'success',
    });
    expect(prepares).toBe(2);
    provider.dispose();
  });

  it('cancels and reads an evicted execution by its reserved call id while releasing', async () => {
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const requests: string[] = [];
    let cancelled = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare'))
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      if (url.endsWith('/executions/execution-1:start'))
        return new Response('{}', { status: 503 });
      if (url.endsWith('/executions/execution-1:cancel')) {
        cancelled = true;
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'cancelled' },
            },
          }),
        );
      }
      if (url.includes('/executions/execution-1?'))
        // The cancel above terminalized the receipt: the honest wire answer
        // is the settled transcript, not the prepared one.
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'cancelled' },
            },
          }),
        );
      if (url.endsWith(':release')) {
        // The Broker still counts the PREPARED execution as active until the
        // cancel terminalizes it.
        if (!cancelled)
          return new Response(
            JSON.stringify({
              code: 'runtime_session_busy',
              error: 'Busy.',
              retryable: false,
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        return json(envelope({ released: true }));
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('503');
    // The start failure evicted the cached execution; the release is refused
    // while the Broker still counts the PREPARED receipt as active.
    await expect(provider.release(runtimeSessionId, request())).rejects.toThrow(
      '409',
    );
    // The tombstone kept the reserved call id, so the draining cancel reaches
    // it instead of rejecting managed_runtime_unavailable.
    await expect(client.cancel(reference())).resolves.toMatchObject({
      state: 'settled',
    });
    expect(requests.filter((url) => url.endsWith(':cancel'))).toEqual([
      expect.stringContaining('/executions/execution-1:cancel'),
    ]);
    await expect(client.status(reference())).resolves.toMatchObject({
      state: 'settled',
    });
    // The tombstoned read reached the wire: a locally answered read must
    // not satisfy this assertion.
    expect(
      requests.filter((url) => url.includes('/executions/execution-1?')),
    ).toHaveLength(1);
    await expect(provider.release(runtimeSessionId, request())).resolves.toBe(
      true,
    );
    // Both the refused and the confirmed release are wire calls: a locally
    // resolved retry would leave this count at one.
    expect(requests.filter((url) => url.endsWith(':release'))).toHaveLength(2);
    provider.dispose();
  });

  it('keeps the reserved call id across a second transient failure', async () => {
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const requests: string[] = [];
    let prepares = 0;
    let cancelled = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        // The first reservation succeeds; the re-drive's prepare fails on
        // both in-band attempts while the outage is still on.
        if (++prepares > 1) return new Response('{}', { status: 503 });
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start'))
        return new Response('{}', { status: 503 });
      if (url.includes('/executions/execution-1?'))
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      if (url.endsWith('/executions/execution-1:cancel')) {
        cancelled = true;
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'cancelled' },
            },
          }),
        );
      }
      if (url.endsWith(':release')) {
        // The Broker still counts the PREPARED execution as active until the
        // cancel terminalizes it.
        if (!cancelled)
          return new Response(
            JSON.stringify({
              code: 'runtime_session_busy',
              error: 'Busy.',
              retryable: false,
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        return json(envelope({ released: true }));
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    // The start failure evicts with the reserved call id tombstoned. The
    // eviction settles before this read returns, so the re-drive below
    // really re-prepares instead of replaying the rejected start.
    await expect(client.execute(reference())).rejects.toThrow('503');
    await expect(client.status(reference())).resolves.toMatchObject({
      state: 'prepared',
    });
    // The re-drive's prepare failure must not overwrite the call id away.
    await expect(client.execute(reference())).rejects.toThrow('503');
    expect(prepares).toBe(3);
    await expect(client.cancel(reference())).resolves.toMatchObject({
      state: 'settled',
    });
    expect(requests.filter((url) => url.endsWith(':cancel'))).toEqual([
      expect.stringContaining('/executions/execution-1:cancel'),
    ]);
    await expect(provider.release(runtimeSessionId, request())).resolves.toBe(
      true,
    );
    provider.dispose();
  });

  it('rejects a read for an invocation the Session never saw without a write', async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    const unknown = { ...reference(), invocationId: 'invocation-unknown' };
    await expect(client.status(unknown)).rejects.toMatchObject({
      code: 'managed_runtime_unavailable',
    });
    await expect(client.cancel(unknown)).rejects.toMatchObject({
      code: 'managed_runtime_unavailable',
    });
    // A read must never create a reservation: no prepare left the client.
    expect(
      requests.filter((url) => url.endsWith('/executions:prepare')),
    ).toEqual([]);
    provider.dispose();
  });

  it('rejects a changed-digest read against a cached execution without a write', async () => {
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const requests: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare'))
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      if (url.endsWith('/executions/execution-1:start'))
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'success' },
            },
          }),
        );
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).resolves.toMatchObject({
      executionStatus: 'success',
    });
    const changed = { ...reference(), argsDigest: 'c'.repeat(64) };
    const callsBefore = requests.length;
    await expect(client.status(changed)).rejects.toMatchObject({
      code: 'managed_runtime_identity_conflict',
    });
    await expect(client.cancel(changed)).rejects.toMatchObject({
      code: 'managed_runtime_identity_conflict',
    });
    expect(requests.length).toBe(callsBefore);
    provider.dispose();
  });

  it('does not re-send an execution refused by an unclassified 4xx', async () => {
    let prepares = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        prepares++;
        return new Response('denied', {
          status: 403,
          headers: { 'content-type': 'text/plain' },
        });
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('403');
    // An unparseable 4xx cannot carry the Broker's retryable flag, so the
    // refusal is deterministic and stays cached: no re-drive, and even a
    // pure status read replays it without a write.
    await expect(client.execute(reference())).rejects.toThrow('403');
    await expect(client.status(reference())).rejects.toThrow('403');
    expect(prepares).toBe(1);
    provider.dispose();
  });

  it('does not re-drive an execution after a client-side protocol failure', async () => {
    let prepares = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        prepares++;
        // A decodable but foreign envelope is a deterministic protocol
        // failure: the next answer within the session cannot differ.
        return json(envelope({ protocolVersion: -1 }));
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow(
      'identity changed',
    );
    // The failure is deterministic, so the rejection stays cached for
    // later calls instead of re-driving a doomed prepare.
    expect(prepares).toBe(1);
    await expect(client.execute(reference())).rejects.toThrow(
      'identity changed',
    );
    expect(prepares).toBe(1);
    provider.dispose();
  });

  it('rejects a release after dispose instead of reporting nothing held', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json(envelope({ acquired: true })),
    );
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    await provider.getToolV2Client(request(), { harnessSessionId });
    provider.dispose();
    await expect(provider.release(runtimeSessionId, request())).rejects.toThrow(
      'disposed',
    );
  });

  it('refuses a cached execution once the provider is disposed', async () => {
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare'))
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      if (url.endsWith('/executions/execution-1:start'))
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'success' },
            },
          }),
        );
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).resolves.toMatchObject({
      executionStatus: 'success',
    });
    provider.dispose();
    // The settled execution is cached, but the provider no longer holds the
    // Session: execute/prepareExecution must join status, cancel and
    // manifest in refusing rather than resolving from the stale cache.
    await expect(client.execute(reference())).rejects.toThrow('disposed');
    await expect(client.prepareExecution!(reference())).rejects.toThrow(
      'disposed',
    );
  });

  it('re-drives an execution after a transient start failure', async () => {
    let prepares = 0;
    let starts = 0;
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        prepares++;
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start')) {
        if (++starts === 1) return new Response('{}', { status: 503 });
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'success' },
            },
          }),
        );
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('503');
    await expect(client.execute(reference())).resolves.toMatchObject({
      executionStatus: 'success',
    });
    expect(starts).toBe(2);
    expect(prepares).toBe(2);
    provider.dispose();
  });

  it('re-prepares when the retry begins in the rejection continuation', async () => {
    let prepares = 0;
    let starts = 0;
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        prepares++;
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start')) {
        if (++starts === 1) return new Response('{}', { status: 503 });
        return json(
          envelope({
            executionCallId: 'execution-1',
            status: {
              ...preparedStatus,
              state: 'settled',
              result: { executionStatus: 'success' },
            },
          }),
        );
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    // The retry begins in the SAME continuation that observes the rejection;
    // the rejects/resolves assertions would yield the extra microtasks an
    // asynchronous eviction handler needs, hiding a replay of the stale
    // rejection, so drive the pair with try/catch instead.
    try {
      await client.execute(reference());
      throw new Error('expected the first execute to reject');
    } catch {
      await expect(client.execute(reference())).resolves.toMatchObject({
        executionStatus: 'success',
      });
    }
    expect(prepares).toBe(2);
    expect(starts).toBe(2);
    provider.dispose();
  });

  it('rejects a changed-args retry after an evicted start', async () => {
    let prepares = 0;
    let starts = 0;
    const preparedStatus = {
      state: 'prepared' as const,
      cancelRequested: false,
      lastSeq: 0,
      firstAvailableSeq: 1,
      progressGap: false,
      progress: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        prepares++;
        return json(
          envelope({ executionCallId: 'execution-1', status: preparedStatus }),
        );
      }
      if (url.endsWith('/executions/execution-1:start')) {
        starts++;
        return new Response('{}', { status: 503 });
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('503');
    expect(starts).toBe(1);
    expect(prepares).toBe(1);
    // The start-path tombstone refuses the rebuilt call locally: the Broker
    // cannot dedup it, since the idempotency key hashes the args digest.
    await expect(
      client.execute({ ...reference(), argsDigest: 'c'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'managed_runtime_identity_conflict' });
    expect(starts).toBe(1);
    expect(prepares).toBe(1);
    provider.dispose();
  });

  it('rejects a changed-args retry after an evicted reservation', async () => {
    let prepares = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith('/executions:prepare')) {
        if (++prepares <= 2) return new Response('{}', { status: 503 });
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    const client = await provider.getToolV2Client(request(), {
      harnessSessionId,
    });
    await expect(client.execute(reference())).rejects.toThrow('503');
    expect(prepares).toBe(2);
    await expect(
      client.execute({ ...reference(), argsDigest: 'c'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'managed_runtime_identity_conflict' });
    expect(prepares).toBe(2);
    provider.dispose();
  });

  it('rejects a release the Broker does not confirm and keeps it retryable', async () => {
    let confirm = false;
    let releases = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('tool-sessions:acquire'))
        return json(envelope({ acquired: true }));
      if (url.endsWith(':release')) {
        releases++;
        return json(envelope({ released: confirm }));
      }
      throw new Error(`Unexpected Broker request: ${url}`);
    });
    const provider = new BrokerManagedRuntimeProvider({
      baseUrl: 'http://127.0.0.1:8080',
      token: 'secret',
      fetch: fetchImpl,
    });
    await provider.getToolV2Client(request(), { harnessSessionId });
    await expect(
      provider.release(runtimeSessionId, request()),
    ).rejects.toMatchObject({
      code: 'managed_runtime_unavailable',
      retryable: true,
      message: expect.stringContaining('did not confirm'),
    });
    confirm = true;
    await expect(
      provider.release(runtimeSessionId, request(), { terminal: true }),
    ).resolves.toBe(true);
    // The retry reached the Broker: the non-confirmation left the Session
    // unsealed rather than recording a permanent closure.
    expect(releases).toBe(2);
    provider.dispose();
  });
});
