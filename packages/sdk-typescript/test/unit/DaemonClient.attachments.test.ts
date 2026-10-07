/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonClient,
  DaemonHttpError,
} from '../../src/daemon/DaemonClient.js';
import { DaemonAttachmentUploadError } from '../../src/daemon/DaemonAttachmentUploadError.js';
import type { DaemonTransport } from '../../src/daemon/DaemonTransport.js';

const CHUNK = 512 * 1024;
const ID = '12345678-1234-4234-8234-123456789abc';
const large = new Blob([new Uint8Array(CHUNK + 3).fill(0xa7)]);
const reference = {
  type: 'resource',
  attachmentId: 'file.bin',
  mimeType: 'application/octet-stream',
  size: large.size,
};
const json = (value: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
interface Call {
  url: string;
  init: RequestInit;
}
function setup(
  reply?: (
    call: Call,
    index: number,
  ) => Response | Promise<Response> | undefined,
) {
  const calls: Call[] = [];
  const fetch = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const call = { url: String(input), init };
      calls.push(call);
      const overridden = await reply?.(call, calls.length - 1);
      if (overridden) return overridden;
      if (call.url.endsWith('/capabilities'))
        return json({ features: ['session_attachment_chunk_upload'] });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (call.url.endsWith('/attachment-uploads'))
        return json({ uploadId: ID }, 201);
      if (call.url.includes('/chunks?'))
        return json({
          offset:
            Number(new URL(call.url).searchParams.get('offset')) +
            (init.body as Blob).size,
        });
      return json(reference);
    },
  );
  const client = new DaemonClient({
    baseUrl: 'http://daemon',
    token: 'secret',
    fetch: fetch as typeof globalThis.fetch,
  });
  const upload = (signal?: AbortSignal) =>
    client.uploadSessionAttachment(
      'session 1',
      large,
      'file.bin',
      'application/octet-stream',
      { signal, clientId: 'client-1' },
    );
  return { client, upload, calls, fetch };
}
afterEach(() => vi.useRealTimers());

describe('session attachment chunk client', () => {
  it('sends byte-exact sequential chunks with identity and validates completion', async () => {
    const { upload, calls } = setup();
    await expect(upload()).resolves.toEqual(reference);
    expect(calls).toHaveLength(5);
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      name: 'file.bin',
      mimeType: 'application/octet-stream',
      size: large.size,
    });
    expect(
      new Headers(calls[1]!.init.headers).get('Content-Type')?.split(';')[0],
    ).toBe('application/json');
    const chunks = calls.filter(({ url }) => url.includes('/chunks?'));
    expect(chunks.map(({ init }) => (init.body as Blob).size)).toEqual([
      CHUNK,
      3,
    ]);
    expect(
      new Uint8Array(
        await new Blob(
          chunks.map(({ init }) => init.body as Blob),
        ).arrayBuffer(),
      ),
    ).toEqual(new Uint8Array(await large.arrayBuffer()));
    for (const { init } of chunks) {
      expect(new Headers(init.headers).get('Content-Type')?.split(';')[0]).toBe(
        'application/octet-stream',
      );
    }
    for (const { init } of calls) {
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'Bearer secret',
      );
    }
    for (const { init } of calls.slice(1)) {
      expect(new Headers(init.headers).get('X-Qwen-Client-Id')).toBe(
        'client-1',
      );
    }
  });

  it('uses direct REST with ACP transport for discovery, chunks and small uploads', async () => {
    const { fetch, calls } = setup();
    const transportFetch = vi.fn(async () => {
      throw new Error('Must use REST');
    });
    const transport: DaemonTransport = {
      type: 'acp-http',
      supportsReplay: true,
      connected: true,
      fetch: transportFetch,
      restFetch: fetch as typeof globalThis.fetch,
      async *subscribeEvents() {},
      dispose() {},
    };
    const client = new DaemonClient({ baseUrl: 'http://daemon', transport });
    await client.uploadSessionAttachment(
      's',
      large,
      'file.bin',
      'application/octet-stream',
    );
    await client.uploadSessionAttachment(
      's',
      new Blob(['small']),
      'file.bin',
      'application/octet-stream',
    );
    expect(transportFetch).not.toHaveBeenCalled();
    expect(calls.at(-1)!.url).toContain('/attachments?');
  });

  it('uses one raw POST for small files and negotiated old daemons', async () => {
    const { client, calls } = setup(({ url }) =>
      url.endsWith('/capabilities')
        ? json({ features: ['session_attachments'] })
        : undefined,
    );
    await client.uploadSessionAttachment(
      's',
      new Blob([new Uint8Array(CHUNK)]),
      'x.bin',
      'application/octet-stream',
    );
    expect(calls).toHaveLength(1);
    await client.uploadSessionAttachment(
      's',
      large,
      'x.bin',
      'application/octet-stream',
    );
    expect(calls).toHaveLength(3);
    expect(calls[2]!.url).toContain('/attachments?');
  });

  it('coalesces discovery and caches only valid results for sixty seconds', async () => {
    vi.useFakeTimers();
    const { upload, calls } = setup();
    await Promise.all([upload(), upload(), upload()]);
    expect(
      calls.filter(({ url }) => url.endsWith('/capabilities')),
    ).toHaveLength(1);
    vi.setSystemTime(Date.now() + 60_001);
    await upload();
    expect(
      calls.filter(({ url }) => url.endsWith('/capabilities')),
    ).toHaveLength(2);
  });

  it('ignores an in-flight discovery result after disposal', async () => {
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let discoveries = 0;
    const { fetch, calls } = setup(({ url }) => {
      if (!url.endsWith('/capabilities')) return undefined;
      discoveries += 1;
      return discoveries === 1 ? first : json({ features: [] });
    });
    const transportFetch = vi.fn(async () => {
      throw new Error('Must use REST');
    });
    const transport: DaemonTransport = {
      type: 'acp-http',
      supportsReplay: true,
      connected: true,
      fetch: transportFetch,
      restFetch: fetch as typeof globalThis.fetch,
      async *subscribeEvents() {},
      dispose() {},
    };
    const client = new DaemonClient({ baseUrl: 'http://daemon', transport });
    const upload = () =>
      client.uploadSessionAttachment(
        's',
        large,
        'file.bin',
        'application/octet-stream',
      );

    const pending = upload();
    await vi.waitFor(() => expect(discoveries).toBe(1));
    client.dispose();
    await upload();
    resolveFirst(json({ features: ['session_attachment_chunk_upload'] }));
    await pending;
    await upload();

    expect(discoveries).toBe(2);
    expect(calls.at(-1)!.url).toContain('/attachments?');
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it.each([
    json({ features: null }),
    json({ error: 'not found' }, 404),
    json({ error: 'unauthorized' }, 401),
  ])('never silently falls back on failed discovery', async (response) => {
    const { upload, calls } = setup(() => response);
    await expect(upload()).rejects.toBeInstanceOf(DaemonAttachmentUploadError);
    expect(calls).toHaveLength(1);
  });

  it('retries discovery on the next upload after a failed probe', async () => {
    let discoveries = 0;
    const { upload, calls } = setup(({ url }) =>
      url.endsWith('/capabilities') && discoveries++ === 0
        ? json({ error: 'unavailable' }, 503)
        : undefined,
    );
    await expect(upload()).rejects.toBeInstanceOf(DaemonAttachmentUploadError);
    await expect(upload()).resolves.toEqual(reference);
    expect(discoveries).toBe(2);
    expect(calls.at(-1)!.url).toContain('/complete');
  });

  it('retries identical append and complete after lost responses without creating again', async () => {
    vi.useFakeTimers();
    const seen = new Map<string, number>();
    const { upload, calls } = setup(({ url }) => {
      const count = seen.get(url) ?? 0;
      seen.set(url, count + 1);
      if (
        (url.includes('/chunks?offset=0') || url.endsWith('/complete')) &&
        count === 0
      )
        throw new TypeError('connection lost after commit');
      return undefined;
    });
    const result = upload();
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual(reference);
    expect(
      calls.filter(({ url }) => url.endsWith('/attachment-uploads')),
    ).toHaveLength(1);
    const retried = calls.filter(({ url }) => url.includes('/chunks?offset=0'));
    expect(retried).toHaveLength(2);
    expect(retried[0]!.init.body).toBe(retried[1]!.init.body);
    expect(calls.filter(({ url }) => url.endsWith('/complete'))).toHaveLength(
      2,
    );
  });

  it.each([400, 404, 409, 413, 415])(
    'fails chunk HTTP %s immediately and cleans up without legacy fallback',
    async (status) => {
      const { upload, calls } = setup(({ url }) =>
        url.includes('/chunks?') ? json({ code: 'failed' }, status) : undefined,
      );
      const failure = await upload().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DaemonAttachmentUploadError);
      expect(failure).not.toBeInstanceOf(DaemonHttpError);
      expect((failure as DaemonAttachmentUploadError).status).toBe(
        status === 404 ? undefined : status,
      );
      expect((failure as DaemonAttachmentUploadError).httpStatus).toBe(status);
      expect(calls.at(-1)!.init.method).toBe('DELETE');
      expect(calls.filter(({ url }) => url.includes('/chunks?'))).toHaveLength(
        1,
      );
      expect(calls.some(({ url }) => url.includes('/attachments?'))).toBe(
        false,
      );
    },
  );

  it('points generic chunk 413 responses to a request-body limit', async () => {
    const { upload } = setup(({ url }) =>
      url.includes('/chunks?')
        ? new Response('<html>413 Request Entity Too Large</html>', {
            status: 413,
          })
        : undefined,
    );
    const failure = await upload().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaemonAttachmentUploadError);
    expect((failure as DaemonAttachmentUploadError).cause).toMatchObject({
      message: expect.stringContaining('reverse proxy'),
    });
  });

  it('preserves the daemon size error without a proxy hint', async () => {
    const { upload } = setup(({ url }) =>
      url.includes('/chunks?')
        ? json({ code: 'attachment_upload_too_large' }, 413)
        : undefined,
    );
    const failure = await upload().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaemonAttachmentUploadError);
    expect((failure as DaemonAttachmentUploadError).cause).not.toMatchObject({
      message: expect.stringContaining('reverse proxy'),
    });
  });

  it('preserves definitive pre-ID invalid_client_id for repair but never replays after an ID exists', async () => {
    const rejected = json({ code: 'invalid_client_id' }, 400);
    const first = setup(({ url }) =>
      url.endsWith('/attachment-uploads') ? rejected : undefined,
    );
    await expect(first.upload()).rejects.toBeInstanceOf(DaemonHttpError);
    const second = setup(({ url }) =>
      url.includes('/chunks?')
        ? json({ code: 'invalid_client_id' }, 400)
        : undefined,
    );
    await expect(second.upload()).rejects.toBeInstanceOf(
      DaemonAttachmentUploadError,
    );
  });

  it('does not retry ambiguous create or capacity exhaustion', async () => {
    for (const response of [
      undefined,
      json({ code: 'attachment_upload_capacity_exceeded' }, 429, {
        'Retry-After': '1',
      }),
    ]) {
      const { upload, calls } = setup(({ url }) => {
        if (!url.endsWith('/attachment-uploads')) return undefined;
        if (response) return response;
        throw new TypeError('lost response');
      });
      await expect(upload()).rejects.toBeInstanceOf(
        DaemonAttachmentUploadError,
      );
      expect(calls).toHaveLength(2);
    }
  });

  it('honors Retry-After for definite rate rejection and stops at the deadline', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { upload } = setup(({ url }) =>
      url.endsWith('/attachment-uploads') && attempts++ === 0
        ? json({ error: 'rate' }, 429, { 'Retry-After': '1' })
        : undefined,
    );
    const result = upload();
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(reference);
    const second = setup(({ url }) =>
      url.includes('/chunks?')
        ? json({ error: 'rate' }, 429, { 'Retry-After': '600' })
        : undefined,
    );
    await expect(second.upload()).rejects.toBeInstanceOf(
      DaemonAttachmentUploadError,
    );
  });

  it('retries a response-body timeout using the identical chunk', async () => {
    vi.useFakeTimers();
    let stalled = false;
    const { fetch, calls } = setup(({ url, init }) => {
      if (!url.includes('/chunks?') || stalled) return undefined;
      stalled = true;
      return new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener(
              'abort',
              () =>
                controller.error(
                  new DOMException('body aborted', 'AbortError'),
                ),
              { once: true },
            );
          },
        }),
      );
    });
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch: fetch as typeof globalThis.fetch,
      fetchTimeoutMs: 20,
    });
    const result = client.uploadSessionAttachment(
      's',
      large,
      'file.bin',
      'application/octet-stream',
    );
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual(reference);
    const chunks = calls.filter(({ url }) => url.includes('/chunks?offset=0'));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.init.body).toBe(chunks[1]!.init.body);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds transient retries at two and aborts a hung transfer at five minutes', async () => {
    vi.useFakeTimers();
    const first = setup(({ url }) =>
      url.includes('/chunks?')
        ? json({ error: 'unavailable' }, 503)
        : undefined,
    );
    const rejected = first.upload().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await rejected).toMatchObject({ httpStatus: 503 });
    expect(
      first.calls.filter(({ url }) => url.includes('/chunks?')),
    ).toHaveLength(3);
    const second = setup(({ url, init }) =>
      url.includes('/chunks?')
        ? new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason),
              { once: true },
            ),
          )
        : undefined,
    );
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch: second.fetch as typeof globalThis.fetch,
      fetchTimeoutMs: 0,
    });
    const timedOut = client
      .uploadSessionAttachment(
        's',
        large,
        'file.bin',
        'application/octet-stream',
      )
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await timedOut).toMatchObject({
      cause: expect.objectContaining({ name: 'TimeoutError' }),
    });
    expect(second.calls.at(-1)!.init.method).toBe('DELETE');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has two FIFO slots and cancelling a queued file creates no server upload', async () => {
    const gates: Array<() => void> = [];
    const { upload, calls } = setup(({ url }) =>
      url.endsWith('/complete')
        ? new Promise<Response>((resolve) =>
            gates.push(() => resolve(json(reference))),
          )
        : undefined,
    );
    const a = upload();
    const b = upload();
    const controller = new AbortController();
    const reason = new Error('queued cancellation');
    const c = upload(controller.signal);
    const check = c.catch((error: unknown) => error);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    controller.abort(reason);
    expect(await check).toBe(reason);
    expect(
      calls.filter(({ url }) => url.endsWith('/attachment-uploads')),
    ).toHaveLength(2);
    gates.splice(0).forEach((resolve) => resolve());
    await Promise.all([a, b]);
    const d = upload();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!();
    await d;
  });

  it('preserves caller abort reason and uses independent cleanup signal', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel');
    const { upload, calls } = setup(({ url }) => {
      if (url.includes('/chunks?')) {
        controller.abort(reason);
        throw reason;
      }
      return undefined;
    });
    await expect(upload(controller.signal)).rejects.toBe(reason);
    const cleanup = calls.at(-1)!;
    expect(cleanup.init.method).toBe('DELETE');
    expect(cleanup.init.signal?.aborted).toBe(false);
  });

  it('rejects invalid acknowledgements and file limits without silent success', async () => {
    for (const suffix of ['/chunks?offset=0', '/complete']) {
      const { upload, calls } = setup(({ url }) =>
        url.endsWith(suffix)
          ? json({ offset: 5, ...reference, size: 1 })
          : undefined,
      );
      await expect(upload()).rejects.toBeInstanceOf(
        DaemonAttachmentUploadError,
      );
      expect(calls.at(-1)!.init.method).toBe('DELETE');
    }
    const { client, calls } = setup();
    await expect(
      client.uploadSessionAttachment(
        's',
        new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]),
        'x.bin',
        'application/octet-stream',
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });
});
