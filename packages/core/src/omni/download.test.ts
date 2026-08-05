/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadMediaUrl, OmniDownloadError } from './download.js';

// Keep the suite hermetic: the SSRF gate resolves hostnames, and tests that
// do not inject a resolver must not depend on (or wait for) real DNS.
const dnsLookupMock = vi.hoisted(() =>
  vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
);
vi.mock('node:dns/promises', () => ({
  default: { lookup: dnsLookupMock },
}));

let downloadsDir: string;

beforeEach(async () => {
  downloadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-dl-'));
});

afterEach(async () => {
  await fs.rm(downloadsDir, { recursive: true, force: true });
});

function fetchOk(
  body: Buffer | string,
  headers: Record<string, string> = {},
): typeof fetch {
  return vi.fn(async () => new Response(body, { status: 200, headers }));
}

async function listParts(): Promise<string[]> {
  return (await fs.readdir(downloadsDir)).filter((f) => f.endsWith('.part'));
}

describe('downloadMediaUrl', () => {
  it('streams to a .part file and hashes while writing', async () => {
    const bytes = Buffer.from('media-bytes-here');
    const result = await downloadMediaUrl({
      url: 'https://media.example.com/a.mp4',
      downloadsDir,
      maxBytes: 1_000_000,
      fetchFn: fetchOk(bytes, { 'content-type': 'video/mp4' }),
    });
    expect(result.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(result.sizeBytes).toBe(bytes.length);
    expect(result.contentType).toBe('video/mp4');
    await expect(fs.readFile(result.partPath)).resolves.toEqual(bytes);
  });

  it('refuses private/loopback hosts (SSRF)', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const url of [
      'http://127.0.0.1:8734/x.mp4',
      'http://localhost:8734/x.mp4',
      'http://10.0.0.5/x.mp4',
      'http://internal.lan/x.mp4',
    ]) {
      await expect(
        downloadMediaUrl({ url, downloadsDir, maxBytes: 1000, fetchFn }),
      ).rejects.toThrow(/not publicly routable/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await listParts()).toEqual([]);
  });

  it('refuses a public-looking host that resolves to a private address', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    // DNS rebinding / split horizon: the name is syntactically public, so
    // the text-level gate passes; only resolution reveals the target.
    for (const address of ['127.0.0.1', '169.254.169.254', '10.1.2.3']) {
      await expect(
        downloadMediaUrl({
          url: 'https://media.example.com/clip.mp4',
          downloadsDir,
          maxBytes: 1_000_000,
          fetchFn,
          resolver: async () => [address],
        }),
      ).rejects.toThrow(/not publicly routable.*resolves to/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await listParts()).toEqual([]);
  });

  it('refuses when ANY resolved address is private (mixed A records)', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      downloadMediaUrl({
        url: 'https://media.example.com/clip.mp4',
        downloadsDir,
        maxBytes: 1_000_000,
        fetchFn,
        // The connect may pick either address, so one bad entry is fatal.
        resolver: async () => ['93.184.216.34', '127.0.0.1'],
      }),
    ).rejects.toThrow(/resolves to 127\.0\.0\.1/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('allows a host resolving to public addresses', async () => {
    const result = await downloadMediaUrl({
      url: 'https://media.example.com/a.mp4',
      downloadsDir,
      maxBytes: 1_000_000,
      fetchFn: fetchOk(Buffer.from('ok-bytes')),
      resolver: async () => ['93.184.216.34', '2606:4700:4700::1111'],
    });
    expect(result.sizeBytes).toBe(8);
  });

  it('re-checks resolution at every redirect hop', async () => {
    // Hop 1 resolves public; the same-host redirect target resolves private
    // (rebinding between hops) and must be refused before the second fetch.
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://media.example.com/real.mp4' },
        }),
    );
    let call = 0;
    await expect(
      downloadMediaUrl({
        url: 'https://media.example.com/a.mp4',
        downloadsDir,
        maxBytes: 1_000_000,
        fetchFn,
        resolver: async () => (++call === 1 ? ['93.184.216.34'] : ['10.0.0.9']),
      }),
    ).rejects.toThrow(/resolves to 10\.0\.0\.9/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await listParts()).toEqual([]);
  });

  it('proceeds when DNS resolution fails (the connect reports it instead)', async () => {
    // Failing closed here would turn a resolver blip into an unactionable
    // error; the fetch that follows surfaces the real failure.
    const result = await downloadMediaUrl({
      url: 'https://media.example.com/a.mp4',
      downloadsDir,
      maxBytes: 1_000_000,
      fetchFn: fetchOk(Buffer.from('bytes')),
      resolver: async () => {
        throw new Error('EAI_AGAIN');
      },
    });
    expect(result.sizeBytes).toBe(5);
  });

  it('defaults to the global fetch when no fetchFn is injected', async () => {
    // Guards the `?? fetch` fallback: every other test injects a mock, so
    // deleting that fallback would otherwise leave the suite green.
    const globalSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(Buffer.from('via-global')));
    try {
      const result = await downloadMediaUrl({
        url: 'https://media.example.com/a.mp4',
        downloadsDir,
        maxBytes: 1_000_000,
        resolver: async () => ['93.184.216.34'],
      });
      expect(globalSpy).toHaveBeenCalledTimes(1);
      expect(result.sizeBytes).toBe(10);
    } finally {
      globalSpy.mockRestore();
    }
  });

  it('resolves via dns.lookup when no resolver is injected', async () => {
    // The `resolver` param is a test seam; production must go through DNS.
    // Injecting a resolver in every other test would leave that wiring
    // (and the {all: true} option the multi-address check depends on)
    // completely unexercised.
    dnsLookupMock.mockClear();
    await expect(
      downloadMediaUrl({
        url: 'https://media.example.com/a.mp4',
        downloadsDir,
        maxBytes: 1_000_000,
        fetchFn: fetchOk(Buffer.from('ok')),
      }),
    ).resolves.toMatchObject({ sizeBytes: 2 });
    expect(dnsLookupMock).toHaveBeenCalledWith('media.example.com', {
      all: true,
      verbatim: true,
    });
  });

  it('rejects oversized Content-Length before reading the body', async () => {
    await expect(
      downloadMediaUrl({
        url: 'https://m.example.com/big.mp4',
        downloadsDir,
        maxBytes: 10,
        fetchFn: fetchOk(Buffer.alloc(100), { 'content-length': '100' }),
      }),
    ).rejects.toThrow(/Content-Length 100 > 10 bytes/);
    expect(await listParts()).toEqual([]);
  });

  it('enforces the byte cap on actual bytes even without Content-Length', async () => {
    // Streamed response with no content-length header.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });
    const fetchFn = vi.fn(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      downloadMediaUrl({
        url: 'https://m.example.com/nolen.mp4',
        downloadsDir,
        maxBytes: 100,
        fetchFn,
      }),
    ).rejects.toThrow(/>100 bytes received/);
    expect(await listParts()).toEqual([]); // .part cleaned on failure
  });

  it('surfaces HTTP errors with status and host, cleaning the .part', async () => {
    await expect(
      downloadMediaUrl({
        url: 'https://m.example.com/nope.mp4',
        downloadsDir,
        maxBytes: 1000,
        fetchFn: vi.fn(async () => new Response('gone', { status: 404 })),
      }),
    ).rejects.toThrow(/HTTP 404 from m\.example\.com/);
    expect(await listParts()).toEqual([]);
  });

  it('follows same-origin redirects and refuses cross-origin ones', async () => {
    const bytes = Buffer.from('after-redirect');
    const sameOrigin = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://m.example.com/real.mp4' },
        }),
      )
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const ok = await downloadMediaUrl({
      url: 'https://m.example.com/a.mp4',
      downloadsDir,
      maxBytes: 1000,
      fetchFn: sameOrigin,
    });
    expect(ok.finalUrl).toBe('https://m.example.com/real.mp4');
    expect(ok.sizeBytes).toBe(bytes.length);

    const crossOrigin = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.net/x.mp4' },
        }),
    ) as unknown as typeof fetch;
    await expect(
      downloadMediaUrl({
        url: 'https://m.example.com/a.mp4',
        downloadsDir,
        maxBytes: 1000,
        fetchFn: crossOrigin,
      }),
    ).rejects.toThrow(/Cross-origin redirect refused/);
  });

  it('propagates user aborts and cleans up', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;
    const err = await downloadMediaUrl({
      url: 'https://m.example.com/a.mp4',
      downloadsDir,
      maxBytes: 1000,
      signal: controller.signal,
      fetchFn,
    }).catch((e: Error) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(OmniDownloadError);
    expect(await listParts()).toEqual([]);
  });
});
