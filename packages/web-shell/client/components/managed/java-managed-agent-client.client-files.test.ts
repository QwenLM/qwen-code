import { describe, expect, it, vi } from 'vitest';
import { JavaManagedAgentClient } from './java-managed-agent-client.js';

describe('JavaManagedAgentClient.clientFilesTransport', () => {
  it('supplies the origin base and resolves auth headers per call', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ connection_id: 'conn-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    // A fresh credential on every resolution: a single fetch could not tell
    // per-call resolution from a header cached at construction, so issue a
    // different token per call and fetch twice.
    let issued = 0;
    const client = new JavaManagedAgentClient({
      baseUrl: 'http://control-plane.test',
      fetch: fetchImpl as unknown as typeof fetch,
      getHeaders: async () => ({ Authorization: `Bearer token-${++issued}` }),
    });
    const transport = client.clientFilesTransport();
    // The transport base is the origin root without any API prefix: the
    // bridge appends /v1/agents/sessions/{id}/client-files itself.
    expect(transport.baseUrl).toBe('http://control-plane.test');
    const sessionBase = `${transport.baseUrl}/v1/agents/sessions/s1/client-files`;
    const response = await transport.fetch(`${sessionBase}/register`, {
      method: 'POST',
      body: '{"connection_id":"conn-1"}',
    });
    expect(response.ok).toBe(true);
    await transport.fetch(`${sessionBase}?connection_id=conn-1`, {
      method: 'GET',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      'http://control-plane.test/v1/agents/sessions/s1/client-files/register',
    );
    expect(calls[1].url).toBe(
      'http://control-plane.test/v1/agents/sessions/s1/client-files?connection_id=conn-1',
    );
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe(
      'Bearer token-1',
    );
    expect(new Headers(calls[1].init?.headers).get('authorization')).toBe(
      'Bearer token-2',
    );
    expect(new Headers(calls[0].init?.headers).get('content-type')).toBe(
      'application/json',
    );
  });

  it('preserves caller-supplied headers', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('{}', { status: 200 }),
    );
    const client = new JavaManagedAgentClient({
      baseUrl: 'http://control-plane.test',
      fetch: fetchImpl as unknown as typeof fetch,
      getHeaders: async () => ({ Authorization: 'Bearer t' }),
    });
    const transport = client.clientFilesTransport();
    await transport.fetch(
      `${transport.baseUrl}/v1/agents/sessions/s1/client-files/responses`,
      {
        method: 'POST',
        headers: { 'X-Custom': 'yes' },
        body: '{}',
      },
    );
    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.get('x-custom')).toBe('yes');
    expect(headers.get('authorization')).toBe('Bearer t');
  });
});
