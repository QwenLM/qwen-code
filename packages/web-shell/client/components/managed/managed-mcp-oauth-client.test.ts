import { expect, it, vi } from 'vitest';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';

it('keeps OAuth completion and revocation authenticated without adding unsupported command fields', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () =>
        new Response('{}', { headers: { 'content-type': 'application/json' } }),
    );
  const provider = createJavaManagedAgentProvider({
    baseUrl: 'https://product.example',
    getHeaders: () => ({ authorization: 'Bearer actor' }),
    fetch: fetchImpl,
  });
  const abort = new AbortController();
  const request = { clientId: 'client', signal: abort.signal };
  const nonce = 'a'.repeat(64);
  await provider.mcpOAuth!.query('session', [], request);
  await provider.mcpOAuth!.start(
    'session',
    { serverId: 'tools', browserNonce: nonce },
    { ...request, idempotencyKey: 'start-key' },
  );
  await provider.mcpOAuth!.status('session', 'attempt', request);
  await provider.mcpOAuth!.complete(
    'session',
    { attemptId: 'attempt', browserNonce: nonce },
    request,
  );
  await provider.mcpOAuth!.revoke(
    'session',
    { credentialId: 'credential', expectedGeneration: 3 },
    request,
  );
  expect(
    fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname),
  ).toEqual(
    ['query', 'start', 'status', 'complete', 'revoke'].map(
      (action) => `/api/agent/web-shell/v1/session-mcp-oauth/${action}`,
    ),
  );
  expect(
    fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
  ).toEqual([
    { sessionId: 'session', extensions: [] },
    {
      sessionId: 'session',
      serverId: 'tools',
      browserNonce: nonce,
      idempotencyKey: 'start-key',
    },
    { sessionId: 'session', attemptId: 'attempt' },
    { sessionId: 'session', attemptId: 'attempt', browserNonce: nonce },
    { sessionId: 'session', credentialId: 'credential', expectedGeneration: 3 },
  ]);
  for (const [, init] of fetchImpl.mock.calls) {
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer actor',
    );
    expect(init?.signal).toBe(abort.signal);
  }
});
