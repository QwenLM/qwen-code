import { expect, it, vi } from 'vitest';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';

const pin = {
  extensionId: 'ext_00000000-0000-4000-8000-000000000001',
  packageRevision: 1,
  packageDigest: 'a'.repeat(64),
};
const metadata = {
  sourceKind: 'skill' as const,
  target: { platform: 'linux' as const, arch: 'x64' as const },
  sourceDigest: 'b'.repeat(64),
  compilerVersion: 1 as const,
};
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });

it('streams original inputs with scoped credentials and leaves pure preview without a command key', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => response({}));
  const provider = createJavaManagedAgentProvider({
    baseUrl: 'https://product.example',
    getHeaders: () => ({ authorization: 'Bearer scoped' }),
    fetch: fetchImpl,
  });
  const source = new Blob(['archive']);
  const abort = new AbortController();
  const options = { clientId: 'client', signal: abort.signal };
  await provider.extensions!.previewPackage!(
    'workspace',
    metadata,
    source,
    options,
  );
  await provider.extensions!.importPackage!(
    'workspace',
    undefined,
    metadata,
    source,
    { ...options, idempotencyKey: 'publish-key' },
  );
  for (const [index, [raw, init]] of fetchImpl.mock.calls.entries()) {
    const url = new URL(String(raw));
    expect(url.pathname).toBe(
      `/api/agent/web-shell/v1/workspace-extensions/imports${index === 0 ? '/preview' : ''}`,
    );
    expect(url.searchParams.get('workspaceId')).toBe('workspace');
    expect(JSON.parse(url.searchParams.get('metadata')!)).toEqual(metadata);
    expect(init?.body).toBe(source);
    expect(init?.signal).toBe(abort.signal);
    expect(init?.credentials).toBe('include');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer scoped');
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('idempotency-key')).toBe(
      index === 0 ? null : 'publish-key',
    );
  }
});

it('looks up publication/settings and apply receipts without replaying mutations', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    response(
      String(url).includes('session-extensions')
        ? {
            sessionId: 'session',
            supported: true,
            revision: 0,
            extensions: [],
            requestedExtensions: [],
          }
        : {},
    ),
  );
  const provider = createJavaManagedAgentProvider({
    baseUrl: 'https://product.example',
    fetch: fetchImpl,
  });
  const request = { clientId: 'client' };
  await provider.extensions!.inspect!('workspace', pin, request);
  await provider.extensions!.lookupPackageOperation!(
    'workspace',
    'settings',
    'settings-key',
    request,
  );
  await provider.extensions!.lookupApplyOperation!(
    'session',
    'apply-key',
    request,
  );
  expect(
    fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname),
  ).toEqual([
    '/api/agent/web-shell/v1/workspace-extensions/inspection/query',
    '/api/agent/web-shell/v1/workspace-extensions/operations/lookup',
    '/api/agent/web-shell/v1/session-extensions/operations/lookup',
  ]);
  expect(
    fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
  ).toEqual([
    { workspaceId: 'workspace', pin },
    {
      workspaceId: 'workspace',
      kind: 'settings',
      idempotencyKey: 'settings-key',
    },
    { sessionId: 'session', idempotencyKey: 'apply-key' },
  ]);
});
