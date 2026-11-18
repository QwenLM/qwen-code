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
      `/v1/agents/workspaces/workspace/extensions/imports${index === 0 ? '/preview' : ''}`,
    );
    // The Workspace rides in the path now; the metadata query stays camel.
    expect(url.searchParams.get('workspaceId')).toBeNull();
    expect(JSON.parse(url.searchParams.get('metadata')!)).toEqual(metadata);
    expect(init?.method).toBe('POST');
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
      String(url).includes('/sessions/session/extensions/operations/lookup')
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
    `/v1/agents/workspaces/workspace/extensions/${pin.extensionId}/packages/${pin.packageRevision}/inspection`,
    '/v1/agents/workspaces/workspace/extensions/operations/lookup',
    '/v1/agents/sessions/session/extensions/operations/lookup',
  ]);
  expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual([
    'GET',
    'POST',
    'POST',
  ]);
  // Inspection is a GET carrying the digest as a query parameter; the
  // lookups keep their camelCase bodies but drop the path identifiers.
  expect(
    new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get(
      'packageDigest',
    ),
  ).toBe(pin.packageDigest);
  expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
  expect(
    fetchImpl.mock.calls
      .slice(1)
      .map(([, init]) => JSON.parse(String(init?.body))),
  ).toEqual([
    { kind: 'settings', idempotencyKey: 'settings-key' },
    { idempotencyKey: 'apply-key' },
  ]);
});
