import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import type { DaemonTransport } from '../../src/daemon/DaemonTransport.js';

const event = {
  id: 12,
  at: 1234,
  type: 'assistant_delta',
  sessionId: 'managed-one',
  promptId: 'prompt-one',
  data: { text: 'Hello' },
};

describe('Managed Session SDK', () => {
  it('uses native REST for every Managed operation with an ACP-configured client', async () => {
    const restFetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('{}'),
    );
    const transport: DaemonTransport = {
      type: 'acp-http',
      restFetch,
      fetch: vi.fn(),
      async *subscribeEvents() {},
      connected: true,
      supportsReplay: true,
      dispose() {},
    };
    const client = new DaemonClient({
      baseUrl: 'http://daemon/',
      token: 'operator-token',
      transport,
    });
    const opts = {
      clientId: 'stable-correlation',
      idempotencyKey: 'attempt-1',
    };
    const request = { prompt: [{ type: 'text' as const, text: 'hello' }] };
    await client.listManagedSessions({
      ...opts,
      cwd: '/a b',
      cursor: 'next/1',
      limit: 20,
    });
    await client.getManagedSession('id/a', opts);
    await client.getManagedSessionTranscript('id/a', {
      ...opts,
      before: '100',
      limit: 50,
    });
    await client.createManagedSession({ ...request, cwd: '/a b' }, opts);
    await client.sendManagedPrompt('id/a', request, opts);
    await client.cancelManagedPrompt('id/a', 'captured-prompt', opts);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(
      restFetch.mock.calls.map(([url, init]) => [url, init?.method]),
    ).toEqual([
      [
        'http://daemon/managed/sessions?cwd=%2Fa+b&limit=20&cursor=next%2F1',
        'GET',
      ],
      ['http://daemon/managed/sessions/id%2Fa', 'GET'],
      [
        'http://daemon/managed/sessions/id%2Fa/transcript?before=100&limit=50',
        'GET',
      ],
      ['http://daemon/managed/sessions', 'POST'],
      ['http://daemon/managed/sessions/id%2Fa/prompts', 'POST'],
      ['http://daemon/managed/sessions/id%2Fa/cancel', 'POST'],
    ]);
    for (const [, init] of restFetch.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer operator-token');
      expect(headers.get('X-Qwen-Managed-Client-Id')).toBe(
        'stable-correlation',
      );
    }
    expect(
      new Headers(restFetch.mock.calls[3]?.[1]?.headers).get('Idempotency-Key'),
    ).toBe('attempt-1');
    expect(
      new Headers(restFetch.mock.calls[4]?.[1]?.headers).get('Idempotency-Key'),
    ).toBe('attempt-1');
    expect(JSON.parse(String(restFetch.mock.calls[5]?.[1]?.body))).toEqual({
      promptId: 'captured-prompt',
    });
  });

  it('reads Managed events without an ACP version field and carries resume/auth headers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          `: heartbeat\r\n\r\ndata: ${JSON.stringify(event)}\r\n\r\ndata: ${JSON.stringify({ ...event, id: 13, type: 'stream_gap' })}\n\n`,
        ),
    );
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      token: 'secret',
      fetch,
    });
    const seen = [];
    for await (const item of client.subscribeManagedSessionEvents(
      'managed-one',
      { clientId: 'same', lastEventId: 11 },
    ))
      seen.push(item);
    expect(seen).toEqual([event, { ...event, id: 13, type: 'stream_gap' }]);
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('Last-Event-ID')).toBe('11');
    expect(new Headers(init?.headers).get('X-Qwen-Managed-Client-Id')).toBe(
      'same',
    );
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer secret',
    );
    expect(init?.signal?.aborted).toBe(true);
  });

  it('cancels the body and fetch on iterator return without sending a turn cancellation', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            },
            cancel,
          }),
        ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    for await (const item of client.subscribeManagedSessionEvents(
      'managed-one',
      { clientId: 'same' },
    )) {
      expect(item.id).toBe(12);
      break;
    }
    expect(cancel).toHaveBeenCalled();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('unblocks an idle stream when aborted and rejects events from another session', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(new ReadableStream({ cancel })),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const abort = new AbortController();
    const stream = client.subscribeManagedSessionEvents('managed-one', {
      clientId: 'same',
      signal: abort.signal,
    });
    const next = stream.next();
    await Promise.resolve();
    abort.abort();
    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalled();
    fetch.mockImplementationOnce(
      async () =>
        new Response(
          `data: ${JSON.stringify({ ...event, sessionId: 'foreign' })}\n\n`,
        ),
    );
    await expect(
      client
        .subscribeManagedSessionEvents('managed-one', { clientId: 'same' })
        .next(),
    ).rejects.toThrow('Invalid Managed session event');
  });
});
