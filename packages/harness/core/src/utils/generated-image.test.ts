/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TINY_PNG_BASE64 as PNG_BASE64,
  TINY_PNG_BYTES as PNG_BYTES,
} from '../test-utils/image.js';

const mockRequest = vi.hoisted(() => vi.fn());

vi.mock('./fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fetch.js')>()),
  unmanagedRequest: mockRequest,
}));

const {
  MAX_GENERATED_IMAGE_BYTES,
  decodeGeneratedImageBase64,
  downloadGeneratedImage,
  saveGeneratedImage,
} = await import('./generated-image.js');

describe('generated image boundaries', () => {
  let tempDir: string;

  beforeEach(async () => {
    mockRequest.mockReset();
    tempDir = await mkdtemp(join(tmpdir(), 'generated-image-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('decodes a valid image data URL and rejects non-images', () => {
    expect(
      decodeGeneratedImageBase64(`data:image/png;base64,${PNG_BASE64}`),
    ).toEqual(PNG_BYTES);
    expect(() =>
      decodeGeneratedImageBase64(
        Buffer.from('not-an-image').toString('base64'),
      ),
    ).toThrow('unsupported or invalid format');
  });

  it('downloads a public image with manual redirect handling', async () => {
    mockRequest
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://8.8.8.8/final.png' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );

    await expect(
      downloadGeneratedImage('https://8.8.8.8/start'),
    ).resolves.toEqual(PNG_BYTES);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      new URL('https://8.8.8.8/final.png'),
      expect.objectContaining({ redirect: 'manual' }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('rejects private destinations and oversized responses', async () => {
    await expect(
      downloadGeneratedImage('http://127.0.0.1/image.png'),
    ).rejects.toThrow('private network');
    expect(mockRequest).not.toHaveBeenCalled();

    mockRequest.mockResolvedValueOnce(
      new Response(PNG_BYTES, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(MAX_GENERATED_IMAGE_BYTES + 1),
        },
      }),
    );
    await expect(
      downloadGeneratedImage('https://8.8.8.8/image.png'),
    ).rejects.toThrow(`too large: ${MAX_GENERATED_IMAGE_BYTES + 1} bytes`);
  });

  it('sanitizes traversal names and never overwrites a same-name image', async () => {
    const first = await saveGeneratedImage(
      tempDir,
      'vibe_images',
      '../../../unsafe name',
      PNG_BYTES,
    );
    const second = await saveGeneratedImage(
      tempDir,
      'vibe_images',
      '../../../unsafe name',
      PNG_BYTES,
    );
    const outputDir = join(tempDir, 'vibe_images');

    expect(relative(outputDir, first)).toMatch(/^unsafe-name_.*\.png$/);
    expect(relative(outputDir, first)).not.toContain('..');
    expect(dirname(first)).toBe(outputDir);
    expect(second).not.toBe(first);
    await expect(readFile(first)).resolves.toEqual(PNG_BYTES);
    await expect(readFile(second)).resolves.toEqual(PNG_BYTES);
  });
});
