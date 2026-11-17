/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { AcpHttpTransport } from '../../src/daemon/AcpHttpTransport.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'acp-connection-id': 'connection-1',
    },
  });
}

describe('ACP HTTP acknowledgement ordering', () => {
  it.each(['abort', 'dispose'])(
    'cleans up when %s occurs before POST acknowledgement',
    async (action) => {
      const posted = deferred();
      const ack = deferred();
      let streamsOpened = 0;
      const transport = new AcpHttpTransport(
        'https://daemon.example',
        undefined,
        async (url, init = {}) => {
          if (String(url).endsWith('/capabilities')) return json({ v: 1 });
          if ((init.method ?? 'GET') === 'GET') {
            streamsOpened += 1;
            return new Response(new ReadableStream(), {
              headers: { 'content-type': 'text/event-stream' },
            });
          }
          const request = JSON.parse(String(init.body)) as {
            id: number;
            method: string;
          };
          if (request.method === 'initialize') {
            return json({ jsonrpc: '2.0', id: request.id, result: { v: 1 } });
          }
          posted.resolve();
          await ack.promise;
          return new Response(null, { status: 202 });
        },
      );
      const abort = new AbortController();
      const pending = transport.fetch('https://daemon.example/session', {
        method: 'POST',
        body: '{}',
        signal: abort.signal,
      });
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await posted.promise;
        if (action === 'abort') abort.abort(new Error('cancelled before ack'));
        else transport.dispose();
        await nextTurn();
        ack.resolve();
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect(streamsOpened).toBe(0);
        expect(
          (transport as unknown as { pending: Map<number, unknown> }).pending
            .size,
        ).toBe(0);
      } finally {
        ack.resolve();
        abort.abort();
        transport.dispose();
        await outcome;
      }
    },
  );

  it.each(['json', 'http-error', 'network-error'])(
    'releases the response registration when POST returns %s',
    async (outcome) => {
      const transport = new AcpHttpTransport(
        'https://daemon.example',
        undefined,
        async (url, init = {}) => {
          if (String(url).endsWith('/capabilities')) return json({ v: 1 });
          const request = JSON.parse(String(init.body)) as {
            id: number;
            method: string;
          };
          if (request.method === 'initialize') {
            return json({ jsonrpc: '2.0', id: request.id, result: { v: 1 } });
          }
          if (outcome === 'network-error') throw new Error('POST failed');
          if (outcome === 'http-error')
            return new Response('unavailable', { status: 503 });
          return json({
            jsonrpc: '2.0',
            id: request.id,
            result: { sessionId: 'created' },
          });
        },
      );
      const abort = new AbortController();
      const removeListener = vi.spyOn(abort.signal, 'removeEventListener');
      try {
        const response = transport.fetch('https://daemon.example/session', {
          method: 'POST',
          body: '{}',
          signal: abort.signal,
        });
        if (outcome === 'network-error') {
          await expect(response).rejects.toThrow('POST failed');
        } else {
          expect((await response).status).toBe(outcome === 'json' ? 200 : 503);
        }
        expect(
          (transport as unknown as { pending: Map<number, unknown> }).pending
            .size,
        ).toBe(0);
        expect(removeListener).toHaveBeenCalledWith(
          'abort',
          expect.any(Function),
        );
      } finally {
        transport.dispose();
      }
    },
  );

  it.each([true, false])(
    'correlates replies delivered before acknowledgement: %s',
    async (beforeAck) => {
      const ack = deferred();
      const earlyReply = deferred();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let firstRequestId: number;
      let requests = 0;
      const encoder = new TextEncoder();
      const send = (id: number) =>
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              id,
              result: { sessionId: `session-${id}` },
            })}\n\n`,
          ),
        );
      const transport = new AcpHttpTransport(
        'https://daemon.example',
        undefined,
        async (url, init = {}) => {
          if (String(url).endsWith('/capabilities')) return json({ v: 1 });
          if ((init.method ?? 'GET') === 'GET') {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(stream) {
                  controller = stream;
                  send(firstRequestId);
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            );
          }
          const request = JSON.parse(String(init.body)) as {
            id: number;
            method: string;
          };
          if (request.method === 'initialize') {
            return json({ jsonrpc: '2.0', id: request.id, result: { v: 1 } });
          }
          requests += 1;
          if (requests === 1) {
            firstRequestId = request.id;
            return new Response(null, { status: 202 });
          }
          if (beforeAck) {
            send(request.id);
            await nextTurn();
            earlyReply.resolve();
            await ack.promise;
          } else {
            void nextTurn().then(() => send(request.id));
          }
          return new Response(null, { status: 202 });
        },
      );
      const abort = new AbortController();
      let pending: Promise<void> | undefined;
      try {
        const first = await transport.fetch('https://daemon.example/session', {
          method: 'POST',
          body: '{}',
        });
        expect(first.status).toBe(200);
        let response: Response | undefined;
        pending = transport
          .fetch('https://daemon.example/session', {
            method: 'POST',
            body: '{}',
            signal: abort.signal,
          })
          .then((result) => {
            response = result;
          });
        if (beforeAck) {
          await earlyReply.promise;
          ack.resolve();
        }
        await vi.waitFor(() => expect(response?.status).toBe(200));
        await expect(response!.json()).resolves.toMatchObject({
          sessionId: expect.stringMatching(/^session-/),
        });
      } finally {
        ack.resolve();
        abort.abort();
        await pending?.catch(() => {});
        transport.dispose();
      }
    },
  );
});
