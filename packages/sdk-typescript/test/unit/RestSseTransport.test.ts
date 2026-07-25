/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { RestSseTransport } from '../../src/daemon/RestSseTransport.js';
import { DaemonTransportClosedError } from '../../src/daemon/DaemonTransport.js';
import { DaemonHttpError } from '../../src/daemon/DaemonHttpError.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal?: AbortSignal | null;
}

function recordingFetch(
  reply: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      }
      const body = typeof init?.body === 'string' ? init.body : null;
      const captured: CapturedRequest = {
        url,
        method,
        headers,
        body,
        signal: init?.signal ?? null,
      };
      calls.push(captured);
      return reply(captured);
    },
  ) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function heldOpenSseResponse(frames: string, onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RestSseTransport', () => {
  // ---- Static properties ------------------------------------------------

  describe('static properties', () => {
    it('type is "rest"', () => {
      const { fetch } = recordingFetch(() => jsonResponse(200, {}));
      const transport = new RestSseTransport('http://d', undefined, fetch);
      expect(transport.type).toBe('rest');
    });

    it('supportsReplay is true', () => {
      const { fetch } = recordingFetch(() => jsonResponse(200, {}));
      const transport = new RestSseTransport('http://d', undefined, fetch);
      expect(transport.supportsReplay).toBe(true);
    });

    it('connected is true before dispose', () => {
      const { fetch } = recordingFetch(() => jsonResponse(200, {}));
      const transport = new RestSseTransport('http://d', undefined, fetch);
      expect(transport.connected).toBe(true);
    });

    it('connected is false after dispose', () => {
      const { fetch } = recordingFetch(() => jsonResponse(200, {}));
      const transport = new RestSseTransport('http://d', undefined, fetch);
      transport.dispose();
      expect(transport.connected).toBe(false);
    });
  });

  // ---- fetch() ----------------------------------------------------------

  describe('fetch()', () => {
    it('delegates url and init to the injected fetch', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { ok: 1 }),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);

      const res = await transport.fetch('http://d/health', {
        method: 'GET',
        headers: { 'X-Custom': 'val' },
      });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://d/health');
      expect(calls[0].method).toBe('GET');
    });

    it('passes headers through', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const transport = new RestSseTransport('http://d', undefined, fetch);

      await transport.fetch('http://d/foo', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer xyz',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });

      expect(calls[0].headers['authorization']).toBe('Bearer xyz');
      expect(calls[0].headers['content-type']).toBe('application/json');
    });

    it('passes body through', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const transport = new RestSseTransport('http://d', undefined, fetch);

      const body = JSON.stringify({ prompt: 'hi' });
      await transport.fetch('http://d/session', {
        method: 'POST',
        body,
      });
      expect(calls[0].body).toBe(body);
    });

    it('returns the injected fetch response directly', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(201, { sessionId: 's1' }),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);

      const res = await transport.fetch('http://d/session', { method: 'POST' });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data).toEqual({ sessionId: 's1' });
    });

    it('throws DaemonTransportClosedError after dispose', async () => {
      const { fetch } = recordingFetch(() => jsonResponse(200, {}));
      const transport = new RestSseTransport('http://d', undefined, fetch);
      transport.dispose();
      await expect(
        transport.fetch('http://d/health', { method: 'GET' }),
      ).rejects.toThrow(DaemonTransportClosedError);
    });

    it('propagates fetch errors', async () => {
      const { fetch } = recordingFetch(() => {
        throw new Error('network down');
      });
      const transport = new RestSseTransport('http://d', undefined, fetch);
      await expect(
        transport.fetch('http://d/health', { method: 'GET' }),
      ).rejects.toThrow('network down');
    });
  });

  // ---- subscribeEvents() ------------------------------------------------

  describe('subscribeEvents()', () => {
    it('builds correct URL from baseUrl + sessionId', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport(
        'http://daemon:8080',
        undefined,
        fetch,
      );

      const gen = transport.subscribeEvents('session-42');
      const first = await gen.next();
      expect(first.done).toBe(false);
      expect(calls[0].url).toBe('http://daemon:8080/session/session-42/events');
    });

    it('sets Authorization header when token provided', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport(
        'http://d',
        'my-secret-token',
        fetch,
      );
      const gen = transport.subscribeEvents('s1');
      await gen.next();
      expect(calls[0].headers['authorization']).toBe('Bearer my-secret-token');
    });

    it('does not set Authorization header when no token', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');
      await gen.next();
      expect(calls[0].headers['authorization']).toBeUndefined();
    });

    it('sets Last-Event-ID header when lastEventId provided', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":2,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1', { lastEventId: 99 });
      await gen.next();
      expect(calls[0].headers['last-event-id']).toBe('99');
    });

    it('sends X-Qwen-Event-Epoch alongside the resume cursor', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":2,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1', {
        lastEventId: 99,
        epoch: 'epoch-abc',
      });
      await gen.next();
      expect(calls[0].headers['last-event-id']).toBe('99');
      expect(calls[0].headers['x-qwen-event-epoch']).toBe('epoch-abc');
    });

    it('does NOT send the epoch header without a resume cursor (meaningless alone)', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1', { epoch: 'epoch-abc' });
      await gen.next();
      expect(calls[0].headers['x-qwen-event-epoch']).toBeUndefined();
    });

    it('reports the response X-Qwen-Event-Epoch header via onEpoch', async () => {
      const { fetch } = recordingFetch(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"a","data":{},"id":1,"v":1}\n\n',
                  ),
                );
                controller.close();
              },
            }),
            {
              status: 200,
              headers: {
                'content-type': 'text/event-stream',
                'x-qwen-event-epoch': 'epoch-from-server',
              },
            },
          ),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const onEpoch = vi.fn();
      const gen = transport.subscribeEvents('s1', { onEpoch });
      await gen.next();
      expect(onEpoch).toHaveBeenCalledTimes(1);
      expect(onEpoch).toHaveBeenCalledWith('epoch-from-server');
    });

    it('does not invoke onEpoch when the response carries no epoch header', async () => {
      const { fetch } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const onEpoch = vi.fn();
      const gen = transport.subscribeEvents('s1', { onEpoch });
      await gen.next();
      expect(onEpoch).not.toHaveBeenCalled();
    });

    it('applies maxQueued query parameter', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1', { maxQueued: 50 });
      await gen.next();
      expect(calls[0].url).toContain('?maxQueued=50');
    });

    it('does not append maxQueued when not specified', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');
      await gen.next();
      expect(calls[0].url).not.toContain('maxQueued');
    });

    it('rejects non-SSE content-type', async () => {
      const { fetch, calls } = recordingFetch(
        () =>
          new Response('not sse', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');
      await expect(gen.next()).rejects.toThrow(DaemonHttpError);
      expect(calls[0].signal?.aborted).toBe(true);
    });

    it('throws DaemonHttpError on non-ok response', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(404, { error: 'session not found' }),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');
      await expect(gen.next()).rejects.toThrow(DaemonHttpError);
      expect(calls[0].signal?.aborted).toBe(true);
    });

    it('throws DaemonHttpError with correct status on non-ok response', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(401, { error: 'unauthorized' }),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');
      try {
        await gen.next();
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DaemonHttpError);
        expect((err as DaemonHttpError).status).toBe(401);
      }
    });

    it('throws when response has no body', async () => {
      const { fetch, calls } = recordingFetch(
        () =>
          new Response(null, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');
      await expect(gen.next()).rejects.toThrow('No SSE body');
      expect(calls[0].signal?.aborted).toBe(true);
    });

    it('parses SSE frames into DaemonEvents', async () => {
      const frames = [
        'data: {"type":"update","data":{"msg":"hello"},"id":1,"v":1}\n\n',
        'data: {"type":"done","data":{},"id":2,"v":1}\n\n',
      ].join('');
      const { fetch, calls } = recordingFetch(() => sseResponse(frames));
      const transport = new RestSseTransport('http://d', undefined, fetch);

      const events: unknown[] = [];
      for await (const event of transport.subscribeEvents('s1')) {
        events.push(event);
      }
      expect(events).toHaveLength(2);
      expect((events[0] as { type: string }).type).toBe('update');
      expect((events[1] as { type: string }).type).toBe('done');
      expect(calls[0].signal?.aborted).toBe(true);
    });

    it('aborts the request when the generator is returned early', async () => {
      const onCancel = vi.fn();
      const { fetch, calls } = recordingFetch(() =>
        heldOpenSseResponse(
          'data: {"type":"a","data":{},"id":1,"v":1}\n\n',
          onCancel,
        ),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');

      expect((await gen.next()).done).toBe(false);
      expect(calls[0].signal?.aborted).toBe(false);
      await gen.return(undefined);

      expect(calls[0].signal?.aborted).toBe(true);
      expect(onCancel).toHaveBeenCalledOnce();
    });

    it('aborts the request when for-await exits early', async () => {
      const onCancel = vi.fn();
      const { fetch, calls } = recordingFetch(() =>
        heldOpenSseResponse(
          'data: {"type":"a","data":{},"id":1,"v":1}\n\n',
          onCancel,
        ),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);

      for await (const _event of transport.subscribeEvents('s1')) {
        break;
      }

      expect(calls[0].signal?.aborted).toBe(true);
      expect(onCancel).toHaveBeenCalledOnce();
    });

    it('aborts the request when the generator is thrown into', async () => {
      const upstream = new Error('consumer stopped');
      const { fetch, calls } = recordingFetch(() =>
        heldOpenSseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');

      expect((await gen.next()).done).toBe(false);
      await expect(gen.throw(upstream)).rejects.toBe(upstream);

      expect(calls[0].signal?.aborted).toBe(true);
    });

    it('aborts the request without replacing a stream error', async () => {
      const upstream = new Error('upstream network drop');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(upstream);
        },
      });
      const { fetch, calls } = recordingFetch(
        () =>
          new Response(body, {
            headers: { 'content-type': 'text/event-stream' },
          }),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');

      await expect(gen.next()).rejects.toBe(upstream);
      expect(calls[0].signal?.aborted).toBe(true);
    });

    it('aborts the request without replacing a connection error', async () => {
      const upstream = new Error('connection refused');
      const { fetch, calls } = recordingFetch(() => {
        throw upstream;
      });
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');

      await expect(gen.next()).rejects.toBe(upstream);
      expect(calls[0].signal?.aborted).toBe(true);
    });

    it('URL-encodes sessionId in path', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('has space/slash');
      await gen.next();
      expect(calls[0].url).toContain('has%20space%2Fslash');
    });

    it('throws DaemonTransportClosedError after dispose', async () => {
      const { fetch } = recordingFetch(() => sseResponse(''));
      const transport = new RestSseTransport('http://d', undefined, fetch);
      transport.dispose();
      const gen = transport.subscribeEvents('s1');
      await expect(gen.next()).rejects.toThrow(DaemonTransportClosedError);
    });

    it('sets Accept header to text/event-stream', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');
      await gen.next();
      expect(calls[0].headers['accept']).toBe('text/event-stream');
    });

    it('connect-phase timeout triggers abort', async () => {
      // Create a fetch that hangs until aborted
      let capturedSignal: AbortSignal | null | undefined;
      const fetchFn = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedSignal = init?.signal;
          return new Promise<Response>((_, reject) => {
            if (init?.signal) {
              init.signal.addEventListener('abort', () => {
                reject(
                  new DOMException('The operation was aborted', 'AbortError'),
                );
              });
            }
          });
        },
      ) as unknown as typeof globalThis.fetch;

      const transport = new RestSseTransport('http://d', undefined, fetchFn);
      const gen = transport.subscribeEvents('s1', { connectTimeoutMs: 50 });
      await expect(gen.next()).rejects.toThrow();
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('does not apply the connect timeout to the SSE body', async () => {
      const { fetch, calls } = recordingFetch(() =>
        heldOpenSseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1', { connectTimeoutMs: 10 });

      expect((await gen.next()).done).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls[0].signal?.aborted).toBe(false);

      await gen.return(undefined);
      expect(calls[0].signal?.aborted).toBe(true);
    });

    it('signal abort prevents iteration', async () => {
      const ctrl = new AbortController();
      ctrl.abort();

      // When the signal is pre-aborted, the fetch call will receive
      // the aborted signal. The mock fetch proceeds anyway, but
      // parseSseStream sees the aborted signal and returns immediately.
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1', { signal: ctrl.signal });
      // With a pre-aborted signal, the generator should either throw
      // or return done immediately (no events yielded).
      const events: unknown[] = [];
      try {
        for await (const event of gen) {
          events.push(event);
        }
      } catch {
        // AbortError is acceptable too
      }
      // Either way, no events should be yielded
      expect(events).toHaveLength(0);
      expect(calls[0].signal?.aborted).toBe(true);
    });

    it('signal abort ends an active iteration', async () => {
      const ctrl = new AbortController();
      const onCancel = vi.fn();
      const { fetch, calls } = recordingFetch(() =>
        heldOpenSseResponse(
          'data: {"type":"a","data":{},"id":1,"v":1}\n\n',
          onCancel,
        ),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1', { signal: ctrl.signal });

      expect((await gen.next()).done).toBe(false);
      ctrl.abort();
      expect((await gen.next()).done).toBe(true);

      expect(calls[0].signal?.aborted).toBe(true);
      expect(onCancel).toHaveBeenCalledOnce();
    });

    it('aborts the underlying fetch when the consumer breaks early without a caller signal', async () => {
      // Regression for #7238: a consumer that opens a subscription,
      // receives an event, and `break`s out — without supplying
      // opts.signal — must still tear down the fetch/TCP connection so
      // the daemon EventBus subscriber is released. Previously the
      // request-lifetime controller was never aborted on normal iterator
      // exit, so the fetch signal stayed unaborted and the connection
      // leaked.
      const frames = [
        'data: {"type":"a","data":{},"id":1,"v":1}\n\n',
        'data: {"type":"b","data":{},"id":2,"v":1}\n\n',
      ].join('');
      const { fetch, calls } = recordingFetch(() => sseResponse(frames));
      const transport = new RestSseTransport('http://d', undefined, fetch);

      const events: unknown[] = [];
      for await (const event of transport.subscribeEvents('s1')) {
        events.push(event);
        break; // exit after the first event, no caller signal
      }

      expect(events).toHaveLength(1);
      expect(calls[0].signal).not.toBeNull();
      expect(calls[0].signal?.aborted).toBe(true);
    });

    it('aborts the underlying fetch after the stream completes normally', async () => {
      // The request-lifetime controller must be aborted on every exit
      // path, including normal end-of-stream, so no fetch/TCP connection
      // is left dangling.
      const { fetch, calls } = recordingFetch(() =>
        sseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);

      const events: unknown[] = [];
      for await (const event of transport.subscribeEvents('s1')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(calls[0].signal?.aborted).toBe(true);
    });
  });

  // ---- dispose() --------------------------------------------------------

  describe('dispose()', () => {
    it('does not throw on first call', () => {
      const { fetch } = recordingFetch(() => jsonResponse(200, {}));
      const transport = new RestSseTransport('http://d', undefined, fetch);
      expect(() => transport.dispose()).not.toThrow();
    });

    it('is idempotent', () => {
      const { fetch } = recordingFetch(() => jsonResponse(200, {}));
      const transport = new RestSseTransport('http://d', undefined, fetch);
      transport.dispose();
      expect(() => transport.dispose()).not.toThrow();
    });

    it('aborts every active SSE request', async () => {
      const { fetch, calls } = recordingFetch(() =>
        heldOpenSseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const first = transport.subscribeEvents('s1');
      const second = transport.subscribeEvents('s2');

      await Promise.all([first.next(), second.next()]);
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.signal?.aborted === false)).toBe(true);

      transport.dispose();

      expect(calls.every((call) => call.signal?.aborted === true)).toBe(true);
      await Promise.all([first.return(undefined), second.return(undefined)]);
    });

    it('unblocks a pending iterator read', async () => {
      const { fetch } = recordingFetch(() =>
        heldOpenSseResponse('data: {"type":"a","data":{},"id":1,"v":1}\n\n'),
      );
      const transport = new RestSseTransport('http://d', undefined, fetch);
      const gen = transport.subscribeEvents('s1');

      expect((await gen.next()).done).toBe(false);
      const pending = gen.next();
      transport.dispose();

      await expect(pending).resolves.toEqual({ done: true, value: undefined });
    });

    it('aborts a request that is still connecting', async () => {
      const aborted = new DOMException(
        'The operation was aborted',
        'AbortError',
      );
      let capturedSignal: AbortSignal | null | undefined;
      const fetchFn = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedSignal = init?.signal;
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(aborted), {
              once: true,
            });
          });
        },
      ) as unknown as typeof globalThis.fetch;
      const transport = new RestSseTransport('http://d', undefined, fetchFn);
      const gen = transport.subscribeEvents('s1');

      const pending = gen.next();
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());
      transport.dispose();

      expect(capturedSignal?.aborted).toBe(true);
      await expect(pending).rejects.toBe(aborted);
    });
  });
});
