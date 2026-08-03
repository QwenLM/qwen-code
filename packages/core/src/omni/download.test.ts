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
