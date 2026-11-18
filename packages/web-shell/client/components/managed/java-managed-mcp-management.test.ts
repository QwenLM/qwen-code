import { expect, it, vi } from 'vitest';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';
import type { ManagedMcpManagementSnapshot } from './managed-mcp-management-types';

const snapshot: ManagedMcpManagementSnapshot = {
  sessionId: 'session-a',
  revision: 1,
  supported: true,
  availableServers: [],
  servers: [],
  operation: {
    operationId: 'operation-a',
    action: 'restart',
    serverId: 'docs',
    revision: 1,
    state: 'settled',
  },
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

it('connects all management actions to authenticated, cancellable Public REST routes', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => response(snapshot));
  const provider = createJavaManagedAgentProvider({
    baseUrl: 'https://product.example',
    getHeaders: () => ({ authorization: 'Bearer scoped' }),
    fetch: fetchImpl,
  });
  const abort = new AbortController();
  const request = { clientId: 'client', signal: abort.signal };
  await provider.mcpManagement!.query('session-a', request);
  await provider.mcpManagement!.submit(
    'session-a',
    { action: 'restart', serverId: 'docs', expectedRevision: 0 },
    {
      ...request,
      requestId: 'original-request',
      idempotencyKey: 'original-command',
    },
  );
  await provider.mcpManagement!.operation('session-a', 'operation-a', request);
  const calls = fetchImpl.mock.calls;
  expect(calls.map(([url]) => url)).toEqual([
    'https://product.example/v1/agents/sessions/session-a/mcp-management',
    'https://product.example/v1/agents/sessions/session-a/mcp-management/commands',
    'https://product.example/v1/agents/sessions/session-a/mcp-management/commands/operation-a',
  ]);
  expect(calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'GET']);
  for (const [, init] of calls) {
    expect(init?.signal).toBe(abort.signal);
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer scoped',
    );
  }
  // Reads are GETs without a body; the command body keeps the camelCase
  // server-pin fields, carries the key as a header, and drops the requestId
  // trace echo (the server assigns its own X-Request-Id).
  expect(calls[0][1]?.body).toBeUndefined();
  expect(calls[2][1]?.body).toBeUndefined();
  expect(JSON.parse(String(calls[1][1]?.body))).toEqual({
    action: 'restart',
    serverId: 'docs',
    expectedRevision: 0,
  });
  expect(new Headers(calls[1][1]?.headers).get('idempotency-key')).toBe(
    'original-command',
  );
  expect(new Headers(calls[1][1]?.headers).get('x-request-id')).toBeNull();
});

it('sends exact published pins and rejects a different Session or operation identity', async () => {
  let body: unknown = {
    ...snapshot,
    operation: { ...snapshot.operation!, action: 'edit' },
  };
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => response(body));
  const provider = createJavaManagedAgentProvider({
    baseUrl: 'https://product.example',
    fetch: fetchImpl,
  });
  const pin = {
    serverId: 'docs',
    serverRevision: 7,
    definitionDigest: 'd'.repeat(64),
  };
  await provider.mcpManagement!.submit(
    'session-a',
    {
      action: 'edit',
      serverId: pin.serverId,
      expectedRevision: 0,
      server: pin,
    },
    { clientId: 'client', requestId: 'request', idempotencyKey: 'key' },
  );
  expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).server).toEqual(
    pin,
  );
  body = { ...snapshot, sessionId: 'session-b' };
  await expect(
    provider.mcpManagement!.query('session-a', { clientId: 'client' }),
  ).rejects.toThrow('Session identity mismatch');
  body = {
    ...snapshot,
    operation: { ...snapshot.operation!, operationId: 'another-operation' },
  };
  await expect(
    provider.mcpManagement!.operation('session-a', 'operation-a', {
      clientId: 'client',
    }),
  ).rejects.toThrow('operation identity mismatch');
  body = {
    ...snapshot,
    operation: { ...snapshot.operation!, serverId: 'another-server' },
  };
  await expect(
    provider.mcpManagement!.submit(
      'session-a',
      { action: 'restart', serverId: 'docs', expectedRevision: 0 },
      { clientId: 'client', requestId: 'request', idempotencyKey: 'key' },
    ),
  ).rejects.toThrow('operation identity mismatch');
});

it('preserves unsupported management snapshots as an explicit capability result', async () => {
  const unsupported = { ...snapshot, supported: false, operation: undefined };
  const provider = createJavaManagedAgentProvider({
    baseUrl: 'https://product.example',
    fetch: vi.fn<typeof fetch>().mockResolvedValue(response(unsupported)),
  });
  expect(
    await provider.mcpManagement!.query('session-a', { clientId: 'client' }),
  ).toEqual(unsupported);
});

it('enables tab command persistence only for an explicit tenant and actor product scope', () => {
  const provider = createJavaManagedAgentProvider({
    baseUrl: 'https://product.example',
    productScope: 'tenant:actor-a',
  });
  const other = createJavaManagedAgentProvider({
    baseUrl: 'https://product.example',
    productScope: 'tenant:actor-b',
  });
  expect(provider.mcpManagement?.storageScope).toBe(provider.storageKey);
  expect(other.mcpManagement?.storageScope).not.toBe(
    provider.mcpManagement?.storageScope,
  );
});

it('does not persist pending commands under a default scope', () => {
  for (const productScope of [undefined, '  ']) {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope,
    });
    expect(provider.mcpManagement?.storageScope).toBeUndefined();
  }
});
