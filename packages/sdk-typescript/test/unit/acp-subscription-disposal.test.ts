/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { AcpHttpTransport } from '../../src/daemon/AcpHttpTransport.js';

async function setup(holdHeaders = false) {
  const signals: AbortSignal[] = [];
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const cancelled = vi.fn();
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const transport = new AcpHttpTransport(
    'https://daemon.example',
    undefined,
    async (url, init = {}) => {
      if (String(url).endsWith('/capabilities')) {
        return Response.json({ v: 1, features: [] });
      }
      if (init.method === 'POST') {
        const request = JSON.parse(String(init.body)) as { id: number };
        return Response.json({ jsonrpc: '2.0', id: request.id, result: {} });
      }
      const signal = init.signal!;
      signals.push(signal);
      opened();
      if (holdHeaders) {
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
          },
          cancel: cancelled,
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  );
  await transport.fetch('https://daemon.example/capabilities', {});
  return { transport, signals, controllers, cancelled, ready };
}

function sendEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  count = 1,
) {
  controller.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-a',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        },
      })}\n\n`.repeat(count),
    ),
  );
}

describe('ACP HTTP session subscription disposal', () => {
  it.each(['initialize', 'capabilities'] as const)(
    'aborts shared initialization while waiting for %s',
    async (heldStep) => {
      let opened!: () => void;
      const ready = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let heldSignal: AbortSignal | undefined;
      let release!: () => void;
      const transport = new AcpHttpTransport(
        'https://daemon.example',
        undefined,
        async (url, init = {}) => {
          const isCapabilities = String(url).endsWith('/capabilities');
          if (!isCapabilities && init.method !== 'POST') {
            return new Response('', {
              headers: { 'Content-Type': 'text/event-stream' },
            });
          }
          const response = isCapabilities
            ? Response.json({ v: 1, features: [] })
            : Response.json({ jsonrpc: '2.0', id: 1, result: {} });
          if (isCapabilities !== (heldStep === 'capabilities')) return response;
          heldSignal = init.signal ?? undefined;
          opened();
          return new Promise<Response>((resolve, reject) => {
            release = () => resolve(response);
            heldSignal?.addEventListener(
              'abort',
              () => reject(heldSignal!.reason),
              { once: true },
            );
          });
        },
      );
      const iterator = transport.subscribeEvents('session-a');
      const pending = iterator.next();
      const outcome = pending.catch((error: unknown) => error);
      try {
        await ready;
        transport.dispose();
        expect(heldSignal?.aborted).toBe(true);
        expect(await outcome).toBeInstanceOf(Error);
      } finally {
        release();
        await outcome;
        await iterator.return();
        transport.dispose();
      }
    },
  );

  it.each([false, true])(
    'aborts an idle event stream with caller signal=%s',
    async (withCallerSignal) => {
      const { transport, signals, controllers, cancelled, ready } =
        await setup();
      const caller = new AbortController();
      const iterator = transport.subscribeEvents('session-a', {
        signal: withCallerSignal ? caller.signal : undefined,
      });
      const pending = iterator.next();
      const outcome = pending.then(
        () => 'resolved',
        () => 'rejected',
      );
      try {
        await ready;
        await nextTurn();
        transport.dispose();
        await nextTurn();
        expect(signals[0]!.aborted).toBe(true);
        expect(await outcome).toBe('rejected');
        expect(cancelled).toHaveBeenCalledOnce();
        expect(caller.signal.aborted).toBe(false);
      } finally {
        caller.abort();
        for (const controller of controllers) {
          try {
            controller.close();
          } catch {
            // A successful disposal already cancelled the stream.
          }
        }
        await pending.catch(() => {});
        await iterator.return();
        transport.dispose();
      }
    },
  );

  it('aborts the session request before response headers arrive', async () => {
    const { transport, signals, ready } = await setup(true);
    const caller = new AbortController();
    const iterator = transport.subscribeEvents('session-a', {
      signal: caller.signal,
    });
    const pending = iterator.next();
    const outcome = pending.catch((error: unknown) => error);
    try {
      await ready;
      transport.dispose();
      expect(signals[0]!.aborted).toBe(true);
      expect(await outcome).toBeInstanceOf(Error);
      expect(caller.signal.aborted).toBe(false);
    } finally {
      caller.abort();
      await outcome;
      await iterator.return();
      transport.dispose();
    }
  });

  it('aborts the fetch when the consumer returns after an event', async () => {
    const { transport, signals, controllers, cancelled, ready } = await setup();
    const iterator = transport.subscribeEvents('session-a');
    const pending = iterator.next();
    try {
      await ready;
      sendEvent(controllers[0]!);
      expect((await pending).done).toBe(false);
      await iterator.return();
      expect(signals[0]!.aborted).toBe(true);
      expect(cancelled).toHaveBeenCalledOnce();
    } finally {
      await iterator.return();
      transport.dispose();
    }
  });

  it('continues to honor an explicit caller abort', async () => {
    const { transport, signals, cancelled, ready } = await setup();
    const caller = new AbortController();
    const iterator = transport.subscribeEvents('session-a', {
      signal: caller.signal,
    });
    const pending = iterator.next();
    const outcome = pending.catch((error: unknown) => error);
    try {
      await ready;
      await nextTurn();
      caller.abort();
      expect(await outcome).toBeInstanceOf(Error);
      expect(signals[0]!.aborted).toBe(true);
      expect(cancelled).toHaveBeenCalledOnce();
    } finally {
      await iterator.return();
      transport.dispose();
    }
  });

  it('stops buffered events after disposal between iterator reads', async () => {
    const { transport, controllers, ready } = await setup();
    const iterator = transport.subscribeEvents('session-a');
    const first = iterator.next();
    try {
      await ready;
      sendEvent(controllers[0]!, 2);
      expect((await first).done).toBe(false);
      transport.dispose();
      expect((await iterator.next()).done).toBe(true);
    } finally {
      await iterator.return();
      transport.dispose();
    }
  });
});
