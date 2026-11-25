/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamJsonSse, streamSse } from './sseUtils.js';

describe('streamSse', () => {
  it('preserves data, event, and id from each complete frame', async () => {
    const response = new Response(
      'id: event-1\nevent: update\ndata: {"ok":true}\n\ndata: [DONE]\n\n',
    );

    const frames = [];
    for await (const frame of streamSse(response, 'stream')) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      { id: 'event-1', event: 'update', data: '{"ok":true}' },
      { data: '[DONE]' },
    ]);
  });
});

describe('streamJsonSse', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('decodes a payload within the first-payload budget', async () => {
    const response = new Response('data: {"ok":true}\n\n');

    const values: unknown[] = [];
    for await (const value of streamJsonSse(response, 'stream', {
      firstPayloadTimeoutMs: 50,
    })) {
      values.push(value);
    }

    expect(values).toEqual([{ ok: true }]);
  });

  it('fails when no first payload arrives before its budget', async () => {
    vi.useFakeTimers();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start() {},
      }),
    );
    const iterator = streamJsonSse(response, 'stream', {
      firstPayloadTimeoutMs: 50,
    });
    const next = iterator.next();
    const rejection = (async () => {
      await expect(next).rejects.toThrow('stream: first payload timeout');
    })();

    await vi.advanceTimersByTimeAsync(50);

    await rejection;
  });

  it('keeps payload-based timeout semantics by default', async () => {
    vi.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
    );
    const iterator = streamJsonSse(response, 'stream', {
      firstPayloadTimeoutMs: 50,
    });
    const next = iterator.next();
    const rejection = (async () => {
      await expect(next).rejects.toThrow('stream: first payload timeout');
    })();

    await vi.advanceTimersByTimeAsync(40);
    streamController.enqueue(new TextEncoder().encode(':keepalive\n\n'));
    await vi.advanceTimersByTimeAsync(10);

    await rejection;
  });

  it('does not extend the first-payload budget with keepalive comments', async () => {
    vi.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
    );
    const iterator = streamJsonSse(response, 'stream', {
      firstPayloadTimeoutMs: 50,
      resetTimeoutOnStreamActivity: true,
    });
    const nextError = iterator.next().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(40);
    streamController.enqueue(new TextEncoder().encode(':keepalive\n\n'));
    await vi.advanceTimersByTimeAsync(20);

    await expect(nextError).resolves.toMatchObject({
      message: 'stream: first payload timeout',
      phase: 'first_payload',
    });
  });

  it('fails after the body-idle budget once a payload has arrived', async () => {
    vi.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
    );
    const iterator = streamJsonSse(response, 'stream', {
      firstPayloadTimeoutMs: 50,
      bodyIdleTimeoutMs: 50,
    });

    const first = iterator.next();
    streamController.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
    await expect(first).resolves.toEqual({
      done: false,
      value: { ok: true },
    });

    const next = iterator.next();
    const nextError = next.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);

    await expect(nextError).resolves.toMatchObject({
      message: 'stream: stream idle timeout',
      phase: 'stream_idle',
    });
  });

  it('resets the body-idle budget on keepalive activity', async () => {
    vi.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
    );
    const iterator = streamJsonSse<{ ok: boolean }>(response, 'stream', {
      firstPayloadTimeoutMs: 200,
      bodyIdleTimeoutMs: 50,
      resetTimeoutOnStreamActivity: true,
    });

    const first = iterator.next();
    streamController.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
    await expect(first).resolves.toEqual({
      done: false,
      value: { ok: true },
    });

    const next = iterator.next();
    await vi.advanceTimersByTimeAsync(40);
    streamController.enqueue(new TextEncoder().encode(':keepalive\n\n'));
    await vi.advanceTimersByTimeAsync(40);
    streamController.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));

    await expect(next).resolves.toEqual({
      done: false,
      value: { ok: true },
    });
    await iterator.return(undefined);
  });
});
