import { describe, expect, it, vi } from 'vitest';
import { JavaManagedAgentClient } from './java-managed-agent-client.js';

describe('JavaManagedAgentClient.clientFilesTransport', () => {
  it('builds the WebShell base and attaches auth headers per call', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ registered: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new JavaManagedAgentClient({
      baseUrl: 'http://control-plane.test',
      fetch: fetchImpl as unknown as typeof fetch,
      getHeaders: async () => ({ Authorization: 'Bearer token-1' }),
    });
    const transport = client.clientFilesTransport();
    expect(transport.baseUrl).toBe(
      'http://control-plane.test/api/agent/web-shell/v1',
    );
    const response = await transport.fetch(
      `${transport.baseUrl}/client-files/register`,
      { method: 'POST', body: '{"sessionId":"s"}' },
    );
    expect(response.ok).toBe(true);
    expect(calls[0].url).toBe(
      'http://control-plane.test/api/agent/web-shell/v1/client-files/register',
    );
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('authorization')).toBe('Bearer token-1');
    expect(headers.get('content-type')).toBe('application/json');
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
    await transport.fetch(`${transport.baseUrl}/client-files/responses`, {
      method: 'POST',
      headers: { 'X-Custom': 'yes' },
      body: '{}',
    });
    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.get('x-custom')).toBe('yes');
    expect(headers.get('authorization')).toBe('Bearer t');
  });
});
