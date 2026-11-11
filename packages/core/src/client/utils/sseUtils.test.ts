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

  it('can treat keepalive comments as timeout-resetting activity', async () => {
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
      firstPayloadTimeoutMs: 50,
      resetTimeoutOnStreamActivity: true,
    });
    const next = iterator.next();

    await vi.advanceTimersByTimeAsync(40);
    streamController.enqueue(new TextEncoder().encode(':keepalive\n\n'));
    await vi.advanceTimersByTimeAsync(40);
    streamController.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
    streamController.close();

    await expect(next).resolves.toEqual({ done: false, value: { ok: true } });
    await iterator.return(undefined);
  });
});
