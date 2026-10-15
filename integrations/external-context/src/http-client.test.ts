/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RESPONSE_BYTES,
  postJson,
  validateProviderBaseUrl,
} from './http-client.js';

// Behavioral net for readBoundedBody's reader loop. The loop was rewritten
// from `for await (const chunk of response.body)` to an explicit getReader()
// loop — async-iterating a ReadableStream needs [Symbol.asyncIterator] on the
// TYPE, and that resolution flipped underneath the file when #8693's
// @types/jsdom install dragged lib.dom into this program (TS2504 on the
// `for await`). These tests pin what the rewrite must preserve: bounded
// accumulation, the oversize rejection, and — the easy one to drop —
// cancelling the stream on early exit, which `for await` used to do
// implicitly via iterator return().

function streamingResponse(
  chunks: Uint8Array[],
  onCancel: () => void,
): Response {
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) {
        controller.enqueue(chunks[next]);
        next += 1;
      } else {
        controller.close();
      }
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestArgs() {
  return {
    url: new URL('https://provider.example/'),
    credentialHeader: {
      name: 'authorization' as const,
      value: 'Bearer test',
    },
    body: { q: 'x' },
    signal: new AbortController().signal,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postJson bounded body reading', () => {
  it('assembles a multi-chunk body and parses it', async () => {
    const encoder = new TextEncoder();
    const payload = JSON.stringify({ answer: 42, pad: 'y'.repeat(4096) });
    const mid = Math.floor(payload.length / 2);
    const cancelled = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse(
          [
            encoder.encode(payload.slice(0, mid)),
            encoder.encode(payload.slice(mid)),
          ],
          cancelled,
        ),
      ),
    );

    await expect(postJson(requestArgs())).resolves.toEqual({
      answer: 42,
      pad: 'y'.repeat(4096),
    });
    // A fully-drained stream is closed, not cancelled.
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('accepts a body of exactly MAX_RESPONSE_BYTES', async () => {
    // The bound is `total > MAX`, so a payload landing exactly on it passes.
    const exact = `["${'a'.repeat(MAX_RESPONSE_BYTES - 4)}"]`;
    expect(exact.length).toBe(MAX_RESPONSE_BYTES);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse([new TextEncoder().encode(exact)], vi.fn()),
      ),
    );

    await expect(postJson(requestArgs())).resolves.toEqual([
      'a'.repeat(MAX_RESPONSE_BYTES - 4),
    ]);
  });

  it('rejects an over-budget stream AND cancels it', async () => {
    // No content-length header, so only the streaming bound can catch it.
    const chunk = new Uint8Array(512 * 1024);
    const cancelled = vi.fn();
    let enqueued = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Endless stream: the reject must come from the byte budget, and the
        // cancel is what stops this producer.
        controller.enqueue(chunk);
        enqueued += 1;
      },
      cancel() {
        cancelled();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    await expect(postJson(requestArgs())).rejects.toThrow(
      'External context provider returned an invalid response.',
    );
    // `for await` cancelled the stream via its implicit iterator return();
    // the reader loop must do the same or the producer keeps running.
    expect(cancelled).toHaveBeenCalledTimes(1);
    // Budget is 1 MiB: two 512 KiB chunks reach it, the third crosses it.
    expect(enqueued).toBeLessThanOrEqual(4);
  });

  it('holds the oversize reject until a deferred cancellation settles', async () => {
    // `for await` awaited iterator return() before propagating, so a caller
    // retrying immediately could not overlap the old transport's teardown.
    let resolveCancel!: () => void;
    const cancelBarrier = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    let cancelSeen!: () => void;
    const cancelCalled = new Promise<void>((resolve) => {
      cancelSeen = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512 * 1024));
      },
      cancel() {
        cancelSeen();
        return cancelBarrier;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    let rejected = false;
    let rejection: unknown;
    const pending = postJson(requestArgs()).catch((error: unknown) => {
      rejected = true;
      rejection = error;
    });

    await cancelCalled;
    // Let any racing microtasks land; the reject must still be on hold.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejected).toBe(false);

    resolveCancel();
    await pending;
    expect(rejected).toBe(true);
    expect((rejection as Error).message).toBe(
      'External context provider returned an invalid response.',
    );
  });

  it('maps a mid-stream read failure after partial data to a transport error', async () => {
    // The provider disconnects after sending part of the JSON: read() rejects
    // with the partial chunk already accumulated.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"answer":'));
      },
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    await expect(postJson(requestArgs())).rejects.toThrow(
      'External context provider request did not complete.',
    );
    // Cleanup must still run: the reader lock is released on mid-read errors.
    expect(body.locked).toBe(false);
  });

  it('rejects a body that is not valid UTF-8', async () => {
    const cancelled = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        // `{"a":"<invalid byte>"}`: the invalid byte sits inside otherwise-
        // valid JSON, so only fatal decoding rejects it — lax decoding would
        // resolve `{ a: '\uFFFD' }` and accept corrupted provider content.
        streamingResponse(
          [
            new Uint8Array([
              0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
            ]),
          ],
          cancelled,
        ),
      ),
    );

    await expect(postJson(requestArgs())).rejects.toThrow(
      'External context provider returned an invalid response.',
    );
  });
});

describe('validateProviderBaseUrl', () => {
  it('accepts HTTPS and loopback HTTP by default', () => {
    expect(validateProviderBaseUrl('https://mem0.example.com').protocol).toBe(
      'https:',
    );
    expect(validateProviderBaseUrl('http://127.0.0.1:8080').hostname).toBe(
      '127.0.0.1',
    );
    expect(validateProviderBaseUrl('http://localhost:8080').hostname).toBe(
      'localhost',
    );
    expect(validateProviderBaseUrl('http://[::1]:8080').hostname).toBe('[::1]');
  });

  it('points at the allowInsecureHttp opt-in when the provider offers one', () => {
    expect(() =>
      validateProviderBaseUrl('http://192.0.2.1:8080', {
        allowInsecureHttpHint: true,
      }),
    ).toThrow('set "allowInsecureHttp": true');
  });

  it('does not suggest the HTTP opt-in for non-HTTP schemes', () => {
    expect(() =>
      validateProviderBaseUrl('wss://mem0.internal:8443', {
        allowInsecureHttpHint: true,
      }),
    ).toThrow('Provider URL must use HTTPS or loopback HTTP.');
  });

  it('rejects non-loopback HTTP unless explicitly allowed', () => {
    expect(() => validateProviderBaseUrl('http://192.0.2.1:8080')).toThrow(
      'Provider URL must use HTTPS or loopback HTTP.',
    );
    expect(
      validateProviderBaseUrl('http://192.0.2.1:8080', {
        allowInsecureHttp: true,
      }).hostname,
    ).toBe('192.0.2.1');
  });

  it('still rejects credentialed and pathed URLs when HTTP is allowed', () => {
    expect(() =>
      validateProviderBaseUrl('http://key@192.0.2.1:8080', {
        allowInsecureHttp: true,
      }),
    ).toThrow('Provider URL must not contain credentials');
    expect(() =>
      validateProviderBaseUrl('http://192.0.2.1:8080/prefix', {
        allowInsecureHttp: true,
      }),
    ).toThrow('Provider URL must not contain credentials, path');
  });
});
