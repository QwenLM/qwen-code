/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Downloader } from './downloader.js';

vi.mock('./runLogger.js', () => ({
  runLogger: {
    debug: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Downloader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envprep-download-test-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes to .part and renames to destination on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello', { headers: { 'content-length': '5' } })),
    );
    const destPath = path.join(tmpDir, 'download.bin');

    await new Downloader().download('https://example.test/file', destPath);

    expect(fs.readFileSync(destPath, 'utf8')).toBe('hello');
    expect(fs.existsSync(destPath + '.part')).toBe(false);
  });

  it('throws and removes .part when content-length does not match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello', { headers: { 'content-length': '6' } })),
    );
    const destPath = path.join(tmpDir, 'download.bin');

    await expect(
      new Downloader().download('https://example.test/file', destPath),
    ).rejects.toThrow('Download incomplete');

    expect(fs.existsSync(destPath)).toBe(false);
    expect(fs.existsSync(destPath + '.part')).toBe(false);
  });

  it('enforces a streaming hard cap even without a Content-Length header', async () => {
    // Body streams 300 bytes in chunks, but no content-length header is sent,
    // so the cap must be enforced on actual streamed bytes.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
        controller.enqueue(new Uint8Array(100));
        controller.enqueue(new Uint8Array(100));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    const destPath = path.join(tmpDir, 'download.bin');

    await expect(
      new Downloader({ maxSize: 150 }).download(
        'https://example.test/file',
        destPath,
      ),
    ).rejects.toThrow('File too large');

    expect(fs.existsSync(destPath)).toBe(false);
    expect(fs.existsSync(destPath + '.part')).toBe(false);
  });
});
