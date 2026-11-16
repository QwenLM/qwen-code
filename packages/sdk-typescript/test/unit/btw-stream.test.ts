import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import type { DaemonTransport } from '../../src/daemon/DaemonTransport.js';

function snapshots(
  requestId: string,
  events: Array<{
    type: string;
    answer?: string;
    code?: string;
    message?: string;
  }>,
) {
  return new Response(
    events
      .map(
        (event) => `data: ${JSON.stringify({ v: 1, requestId, ...event })}\n\n`,
      )
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function body(init?: RequestInit) {
  return JSON.parse(String(init?.body)) as {
    requestId: string;
    question: string;
    resume?: boolean;
  };
}

afterEach(() => vi.useRealTimers());

describe('BTW answer stream', () => {
  it('uses native REST with ACP transports and preserves complete answer snapshots', async () => {
    const restFetch = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        snapshots(body(init).requestId, [
          { type: 'answer', answer: 'First' },
          { type: 'done', answer: 'First second' },
        ]),
    );
    const rpcFetch = vi.fn();
    const transport = {
      restFetch,
      fetch: rpcFetch,
    } as unknown as DaemonTransport;
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      transport,
      token: 'token',
    });
    const events = [];
    for await (const event of client.streamSessionBtw('session/1', 'Question', {
      clientId: 'client-1',
    }))
      events.push(event);
    expect(
      events.map((event) => event.type !== 'error' && event.answer),
    ).toEqual(['First', 'First second']);
    expect(rpcFetch).not.toHaveBeenCalled();
    expect(restFetch).toHaveBeenCalledOnce();
    expect(restFetch.mock.calls[0]?.[0]).toBe(
      'http://daemon/session/session%2F1/btw/stream',
    );
    const headers = new Headers(restFetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer token');
    expect(headers.get('X-Qwen-Client-Id')).toBe('client-1');
  });

  it('reconnects an interrupted stream with the same request ID and resume flag', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { requestId } = body(init);
      return snapshots(
        requestId,
        ++attempts === 1
          ? [{ type: 'answer', answer: 'First' }]
          : [
              { type: 'answer', answer: 'First second' },
              { type: 'done', answer: 'First second' },
            ],
      );
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const stream = client.streamSessionBtw('session-1', 'Question');
    expect((await stream.next()).value).toMatchObject({
      type: 'answer',
      answer: 'First',
    });
    const next = stream.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await next).value).toMatchObject({
      type: 'answer',
      answer: 'First second',
    });
    expect((await stream.next()).value).toMatchObject({
      type: 'done',
      answer: 'First second',
    });
    await stream.next();
    expect(body(fetch.mock.calls[0]?.[1])).toEqual({
      question: 'Question',
      requestId: expect.any(String),
    });
    expect(body(fetch.mock.calls[1]?.[1])).toEqual({
      ...body(fetch.mock.calls[0]?.[1]),
      resume: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['network error', 429, 503] as const)(
    'retries before acceptance with the same request ID after %s',
    async (failure) => {
      vi.useFakeTimers();
      let attempts = 0;
      const fetch = vi.fn(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          if (++attempts === 1) {
            if (failure === 'network error')
              throw new TypeError('network lost');
            return new Response('{}', { status: failure });
          }
          const { requestId, resume } = body(init);
          if (resume) return new Response('{}', { status: 410 });
          return snapshots(requestId, [{ type: 'done', answer: 'Recovered' }]);
        },
      );
      const stream = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
      }).streamSessionBtw('s', 'Question');
      const next = stream.next();
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await next).value).toMatchObject({
        type: 'done',
        answer: 'Recovered',
      });
      await stream.next();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(body(fetch.mock.calls[1]?.[1])).toEqual(
        body(fetch.mock.calls[0]?.[1]),
      );
      expect(body(fetch.mock.calls[1]?.[1])).not.toHaveProperty('resume');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('reuses accepted model work when its first response was lost before headers', async () => {
    vi.useFakeTimers();
    const requests = new Set<string>();
    let generations = 0;
    let attempts = 0;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { requestId } = body(init);
      if (!requests.has(requestId)) {
        requests.add(requestId);
        generations++;
      }
      if (++attempts === 1) throw new TypeError('response lost');
      return snapshots(requestId, [{ type: 'done', answer: 'One generation' }]);
    });
    const stream = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
    }).streamSessionBtw('s', 'Question');
    const next = stream.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await next).value).toMatchObject({
      type: 'done',
      answer: 'One generation',
    });
    await stream.next();
    expect(generations).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(body(fetch.mock.calls[1]?.[1])).toEqual(
      body(fetch.mock.calls[0]?.[1]),
    );
    expect(body(fetch.mock.calls[1]?.[1])).not.toHaveProperty('resume');
  });

  it.each(['headers only', 'partial snapshot'] as const)(
    'does not recreate an expired request accepted with %s',
    async (stage) => {
      vi.useFakeTimers();
      let attempts = 0;
      const fetch = vi.fn(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'DELETE')
            return new Response(null, { status: 204 });
          if (++attempts === 1)
            return snapshots(
              body(init).requestId,
              stage === 'partial snapshot'
                ? [{ type: 'answer', answer: 'Partial' }]
                : [],
            );
          return new Response('{}', { status: 410 });
        },
      );
      const stream = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
      }).streamSessionBtw('s', 'Question');
      if (stage === 'partial snapshot') {
        expect((await stream.next()).value).toMatchObject({
          type: 'answer',
          answer: 'Partial',
        });
      }
      const failed = stream.next().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await failed).toMatchObject({ status: 410 });
      const posts = fetch.mock.calls.filter(
        (call) => call[1]?.method === 'POST',
      );
      expect(posts).toHaveLength(2);
      expect(body(posts[1]?.[1])).toEqual({
        ...body(posts[0]?.[1]),
        resume: true,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[2]?.[1]?.method).toBe('DELETE');
    },
  );

  it.each([false, true])(
    'cancels during reconnect backoff without another connection (accepted=%s)',
    async (accepted) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const fetch = vi.fn(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'DELETE')
            return new Response(null, { status: 204 });
          if (!accepted) throw new TypeError('network lost');
          return snapshots(body(init).requestId, [
            { type: 'answer', answer: 'First' },
          ]);
        },
      );
      const stream = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
      }).streamSessionBtw('s', 'Question', { signal: controller.signal });
      let next = stream.next();
      if (accepted) {
        await next;
        next = stream.next();
      }
      const failed = next.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      expect(await failed).toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1]?.[1]?.method).toBe('DELETE');
      expect(String(fetch.mock.calls[1]?.[0])).toContain(
        body(fetch.mock.calls[0]?.[1]).requestId,
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('cancels generation when a consumer stops reading before done', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : snapshots(body(init).requestId, [
            { type: 'answer', answer: 'First' },
          ]),
    );
    const stream = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
    }).streamSessionBtw('s', 'Question');
    await stream.next();
    await stream.return(undefined);
    expect(fetch.mock.calls[1]?.[1]?.method).toBe('DELETE');
  });

  it('does not retry application errors', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      snapshots(body(init).requestId, [
        { type: 'error', code: 'failed', message: 'Model failed' },
      ]),
    );
    const stream = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
    }).streamSessionBtw('s', 'Question');
    expect((await stream.next()).value).toMatchObject({
      type: 'error',
      message: 'Model failed',
    });
    expect((await stream.next()).done).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('keeps a quiet model connected while heartbeat bytes continue arriving', async () => {
    vi.useFakeTimers();
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    let requestId = '';
    const encoder = new TextEncoder();
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestId = body(init).requestId;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            writer = controller;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ v: 1, type: 'answer', requestId, answer: '' })}\n\n`,
              ),
            );
          },
        }),
      );
    });
    const stream = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
    }).streamSessionBtw('s', 'Question');
    await stream.next();
    const done = stream.next();
    for (let n = 0; n < 5; n++) {
      await vi.advanceTimersByTimeAsync(15_000);
      writer.enqueue(encoder.encode(': heartbeat\n\n'));
    }
    expect(fetch).toHaveBeenCalledOnce();
    writer.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ v: 1, type: 'done', requestId, answer: 'Slow answer' })}\n\n`,
      ),
    );
    expect((await done).value).toMatchObject({
      type: 'done',
      answer: 'Slow answer',
    });
    await stream.next();
  });

  it('reconnects when the connection silently stops delivering bytes', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const requestId = body(init).requestId;
      if (++attempts > 1)
        return snapshots(requestId, [{ type: 'done', answer: 'Recovered' }]);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ v: 1, type: 'answer', requestId, answer: 'Partial' })}\n\n`,
              ),
            );
          },
        }),
      );
    });
    const stream = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
    }).streamSessionBtw('s', 'Question');
    await stream.next();
    const done = stream.next();
    await vi.advanceTimersByTimeAsync(46_000);
    expect((await done).value).toMatchObject({
      type: 'done',
      answer: 'Recovered',
    });
    await stream.next();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(body(fetch.mock.calls[1]?.[1]).resume).toBe(true);
  });

  it.each(['network', 'http'] as const)(
    'does not start another POST at the reconnect deadline after %s failure',
    async (failure) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const posts: number[] = [];
      const unavailable = new TypeError('Daemon unreachable');
      const fetch = vi.fn(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === 'DELETE')
            return new Response(null, { status: 204 });
          posts.push(Date.now());
          if (failure === 'network') throw unavailable;
          return new Response('{}', { status: 503 });
        },
      );
      const stream = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
      }).streamSessionBtw('s', 'Question');
      let settled = false;
      const failed = stream.next().catch((error: unknown) => {
        settled = true;
        return error;
      });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      const attemptsBeforeDeadline = posts.length;
      await vi.advanceTimersByTimeAsync(1);
      const error = await failed;
      if (failure === 'network') expect(error).toBe(unavailable);
      else expect(error).toMatchObject({ status: 503 });
      expect(posts).not.toHaveLength(0);
      expect(posts.every((at) => at < 60_000)).toBe(true);
      expect(posts).toHaveLength(attemptsBeforeDeadline);
      expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('bounds reconnect attempts when the daemon remains unavailable', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Response(null, { status: init?.method === 'DELETE' ? 204 : 503 }),
    );
    const stream = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
    }).streamSessionBtw('s', 'Question');
    const failed = stream.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await failed).toMatchObject({ status: 503 });
    const posts = fetch.mock.calls.filter((call) => call[1]?.method === 'POST');
    expect(posts.length).toBeLessThan(20);
    expect(posts.every((call) => body(call[1]).resume === undefined)).toBe(
      true,
    );
    expect(new Set(posts.map((call) => body(call[1]).requestId)).size).toBe(1);
    expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
    expect(vi.getTimerCount()).toBe(0);
  });
});
