/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import '../test-utils/mock-undici-fetch-with-global.js';
import { downloadVerifiedZip } from './verifiedZipDownload.js';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

it('退出取消尚未结束的响应流', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  global.fetch = vi.fn().mockResolvedValue(new Response(body));
  const controller = new AbortController();
  const pending = downloadVerifiedZip({
    url: 'https://example.com/p.zip',
    sha256: '0'.repeat(64),
    maxBytes: 16,
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancel).toHaveBeenCalledOnce();
});

it('已取消时不发起下载', async () => {
  global.fetch = vi.fn();
  await expect(
    downloadVerifiedZip({
      url: 'https://example.com/p.zip',
      sha256: '0'.repeat(64),
      maxBytes: 16,
      signal: AbortSignal.abort(),
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(global.fetch).not.toHaveBeenCalled();
});

it('verifies an archive without a declared size and accepts uppercase SHA256', async () => {
  const bytes = new TextEncoder().encode('archive');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  global.fetch = vi.fn().mockResolvedValue(new Response(bytes));
  const result = await downloadVerifiedZip({
    url: 'https://example.com/p.zip',
    sha256: sha256.toUpperCase(),
    maxBytes: 16,
  });
  try {
    const slug = process.env['BRAND_TEMP_PATH_SLUG'] || 'qwen-code';
    expect(basename(result.zipPath).startsWith(`${slug}-plugin-`)).toBe(true);
    expect(result.bytes).toBe(bytes.length);
    if (process.platform !== 'win32') {
      expect((await stat(result.zipPath)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(result.zipPath)).toEqual(Buffer.from(bytes));
  } finally {
    await rm(result.zipPath);
  }
});

it('cancels a stream that exceeds the limit without Content-Length', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
    },
    cancel,
  });
  global.fetch = vi.fn().mockResolvedValue(new Response(body));
  await expect(
    downloadVerifiedZip({
      url: 'https://example.com/p.zip',
      sha256: '0'.repeat(64),
      maxBytes: 4,
    }),
  ).rejects.toThrow(/too large/);
  expect(cancel).toHaveBeenCalledOnce();
});

it('rejects invalid digest and expected size before making a request', async () => {
  global.fetch = vi.fn();
  for (const options of [
    { sha256: 'short', expectedSize: 1 },
    { sha256: '0'.repeat(64), expectedSize: 0 },
    { sha256: '0'.repeat(64), expectedSize: 5 },
  ]) {
    await expect(
      downloadVerifiedZip({
        url: 'https://example.com/p.zip',
        maxBytes: 4,
        ...options,
      }),
    ).rejects.toThrow();
  }
  expect(global.fetch).not.toHaveBeenCalled();
});
