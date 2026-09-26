import { afterEach, describe, expect, it, vi } from 'vitest';
import { JavaManagedAgentClient } from './java-managed-agent-client';
import type { JavaManagedAgentHttpError } from './java-managed-agent-client';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('JavaManagedAgentClient', () => {
  it('binds the default browser fetch to the global object', async () => {
    const fetchImpl = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(jsonResponse({ data: [], hasMore: false }));
    });
    vi.stubGlobal('fetch', fetchImpl);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
    });

    await client.listSessions({ limit: 20 });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('uses the private gateway with product credentials and headers', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [], hasMore: false }));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example/',
      fetch: fetchImpl,
      getHeaders: () => ({ authorization: 'Bearer short-lived' }),
    });

    await client.listSessions({ limit: 20 });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://product.example/api/agent/web-shell/v1/sessions/query',
    );
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer short-lived',
    );
    expect(JSON.parse(String(init?.body))).toEqual({ limit: 20 });
  });

  it('parses chunked CRLF SSE frames and ignores heartbeats', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      ': keepalive\r\n\r\nid: 7\r\nevent: item.output_text.delta\r\ndata: {"sequence":7,"eventId":"evt_7",',
      '"sessionId":"session-1","turnId":"turn-1","type":"item.output_text.delta","createdAt":7,"data":{"text":"hi"},"terminal":false}\r\n\r\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 200 }));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 6,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ sequence: 7, data: { text: 'hi' } }),
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      sessionId: 'session-1',
      afterSequence: 6,
    });
  });

  it('maps the stable Java error envelope', async () => {
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'agent_api_idempotency_conflict',
              message: 'conflict',
            },
          },
          409,
        ),
      ),
    });

    await expect(
      client.createSession({
        requestId: 'r1',
        idempotencyKey: 'key-1',
        agentId: 'dataworks_data_agent',
        input: [{ type: 'text', text: 'hello' }],
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<JavaManagedAgentHttpError>>({
        status: 409,
        code: 'agent_api_idempotency_conflict',
        message: 'conflict',
      }),
    );
  });
});
