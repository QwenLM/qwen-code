/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImageResizeError } from '../utils/imageReader.js';
import {
  maybeResizeAndDownsampleImageBuffer,
  readImageWithMediaLimits,
} from '../utils/imageReader.js';
import {
  materializePastedContents,
  preparePastedImage,
  processPastedImages,
  storeImages,
} from './image-pipeline.js';

vi.mock('../utils/imageReader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/imageReader.js')>();
  return {
    ...actual,
    maybeResizeAndDownsampleImageBuffer: vi.fn(),
    readImageWithMediaLimits: vi.fn(),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('deferred pasted images', () => {
  it('shares paste-time preparation with an immediate submission', async () => {
    let resolveRead:
      | ((value: Awaited<ReturnType<typeof readImageWithMediaLimits>>) => void)
      | undefined;
    vi.mocked(readImageWithMediaLimits).mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    const image = {
      id: 1,
      type: 'image' as const,
      content: '',
      filename: 'photo.png',
      sourcePath: '/pictures/photo.png',
      preparationId: 'preparation-1',
    };

    const prewarmPromise = preparePastedImage(image);
    const submissionPromise = materializePastedContents({ 1: image });

    await vi.waitFor(() => {
      expect(readImageWithMediaLimits).toHaveBeenCalledOnce();
    });
    resolveRead?.({
      base64: Buffer.from('prepared once').toString('base64'),
      mediaType: 'image/png',
      originalSize: 13,
      dimensions: {
        originalWidth: 1200,
        originalHeight: 800,
        displayWidth: 1200,
        displayHeight: 800,
      },
    });

    const [prewarmed, submitted] = await Promise.all([
      prewarmPromise,
      submissionPromise,
    ]);
    expect(prewarmed.content).toBe(
      Buffer.from('prepared once').toString('base64'),
    );
    expect(submitted[1].content).toBe(prewarmed.content);
    expect(readImageWithMediaLimits).toHaveBeenCalledOnce();
  });

  it('cancels a shared prewarm when submission is aborted', async () => {
    let readSignal: AbortSignal | undefined;
    vi.mocked(readImageWithMediaLimits).mockImplementation(
      (_filePath, _maxBytes, signal) => {
        readSignal = signal;
        return new Promise((_resolve, reject) => {
          const rejectOnAbort = () => reject(signal?.reason);
          if (signal?.aborted) {
            rejectOnAbort();
          } else {
            signal?.addEventListener('abort', rejectOnAbort, { once: true });
          }
        });
      },
    );
    const image = {
      id: 3,
      type: 'image' as const,
      content: '',
      sourcePath: '/pictures/slow.png',
      preparationId: 'preparation-cancelled-on-submit',
    };
    const prewarmResult = preparePastedImage(image).catch((error) => error);

    await vi.waitFor(() => {
      expect(readSignal).toBeDefined();
    });

    const controller = new AbortController();
    const submissionResult = materializePastedContents(
      { 3: image },
      controller.signal,
    ).catch((error) => error);
    const abortReason = new Error('submission cancelled');
    controller.abort(abortReason);

    expect(await submissionResult).toBe(abortReason);
    expect(await prewarmResult).toBe(abortReason);
    expect(readSignal?.aborted).toBe(true);
    expect(readImageWithMediaLimits).toHaveBeenCalledOnce();
  });

  it('reuses a completed prewarm while the prepared buffer state is publishing', async () => {
    vi.mocked(readImageWithMediaLimits).mockResolvedValue({
      base64: Buffer.from('prepared').toString('base64'),
      mediaType: 'image/png',
      originalSize: 8,
    });
    const image = {
      id: 2,
      type: 'image' as const,
      content: '',
      sourcePath: '/pictures/fast.png',
      preparationId: 'preparation-publishing',
    };

    await preparePastedImage(image);
    const submitted = await materializePastedContents({ 2: image });

    expect(submitted[2].isImageContentPrepared).toBe(true);
    expect(readImageWithMediaLimits).toHaveBeenCalledOnce();
  });

  it('materializes a local path only at the submission boundary', async () => {
    vi.mocked(readImageWithMediaLimits).mockResolvedValue({
      base64: Buffer.from('prepared').toString('base64'),
      mediaType: 'image/jpeg',
      originalSize: 123,
      dimensions: {
        originalWidth: 4000,
        originalHeight: 3000,
        displayWidth: 2000,
        displayHeight: 1500,
      },
    });

    const result = await materializePastedContents({
      4: {
        id: 4,
        type: 'image',
        content: '',
        filename: 'photo.jpg',
        sourcePath: '/pictures/photo.jpg',
      },
    });

    expect(readImageWithMediaLimits).toHaveBeenCalledExactlyOnceWith(
      '/pictures/photo.jpg',
      undefined,
      expect.any(AbortSignal),
    );
    expect(result[4]).toMatchObject({
      content: Buffer.from('prepared').toString('base64'),
      mediaType: 'image/jpeg',
      isImageContentPrepared: true,
      sourcePath: '/pictures/photo.jpg',
    });
  });

  it('does not resize a materialized image a second time', async () => {
    const preparedBytes = Buffer.from('prepared image bytes');
    vi.mocked(readImageWithMediaLimits).mockResolvedValue({
      base64: preparedBytes.toString('base64'),
      mediaType: 'image/png',
      originalSize: preparedBytes.length,
      dimensions: {
        originalWidth: 6000,
        originalHeight: 4000,
        displayWidth: 2000,
        displayHeight: 1333,
      },
    });
    const outputDir = await mkdtemp(path.join(tmpdir(), 'test-paste-'));

    try {
      const result = await processPastedImages(
        {
          0: {
            id: 0,
            type: 'image',
            content: '',
            filename: 'clipboard.png',
            sourcePath: '/tmp/clipboard.png',
          },
        },
        outputDir,
        undefined,
        undefined,
        {},
      );

      expect(readImageWithMediaLimits).toHaveBeenCalledOnce();
      expect(maybeResizeAndDownsampleImageBuffer).not.toHaveBeenCalled();
      expect(result.imageContentBlocks).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/png',
            data: preparedBytes.toString('base64'),
          },
        },
      ]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('surfaces a local-file read failure as an image processing error', async () => {
    vi.mocked(readImageWithMediaLimits).mockRejectedValue(
      new Error('ENOENT'),
    );

    await expect(
      materializePastedContents({
        2: {
          id: 2,
          type: 'image',
          content: '',
          sourcePath: '/missing/image.png',
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<ImageResizeError>({
        name: 'ImageResizeError',
        message:
          'Unable to read pasted image /missing/image.png: ENOENT',
      }),
    );
  });

  it('degrades an unreadable pasted path instead of failing the submission', async () => {
    vi.mocked(readImageWithMediaLimits).mockRejectedValue(
      new Error("EUNKNOWN: unknown error, open '\\\\share\\image.png'"),
    );
    const outputDir = await mkdtemp(path.join(tmpdir(), 'test-paste-'));

    try {
      const result = await processPastedImages(
        {
          1: {
            id: 1,
            type: 'image',
            content: '',
            filename: 'image.png',
            sourcePath: '\\\\nonexistent-server\\share\\image.png',
          },
        },
        outputDir,
        [1],
        undefined,
        {},
      );

      expect(result.imageContentBlocks).toEqual([]);
      expect(result.imagePasteIds).toEqual([]);
      expect(result.degradedImages).toEqual([
        {
          id: 1,
          sourcePath: '\\\\nonexistent-server\\share\\image.png',
          reason:
            "Unable to read pasted image \\\\nonexistent-server\\share\\image.png: " +
            "EUNKNOWN: unknown error, open '\\\\share\\image.png'",
        },
      ]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('keeps a readable pasted path when a sibling path degrades', async () => {
    const preparedBytes = Buffer.from('readable image bytes');
    vi.mocked(readImageWithMediaLimits).mockImplementation(
      async (filePath: string) => {
        if (filePath === '/pictures/missing.png') {
          throw new Error('ENOENT: no such file or directory');
        }
        return {
          base64: preparedBytes.toString('base64'),
          mediaType: 'image/png',
          originalSize: preparedBytes.length,
        };
      },
    );
    const outputDir = await mkdtemp(path.join(tmpdir(), 'test-paste-'));

    try {
      const result = await processPastedImages(
        {
          1: {
            id: 1,
            type: 'image',
            content: '',
            filename: 'ok.png',
            sourcePath: '/pictures/ok.png',
          },
          2: {
            id: 2,
            type: 'image',
            content: '',
            filename: 'missing.png',
            sourcePath: '/pictures/missing.png',
          },
        },
        outputDir,
        [1, 2],
        undefined,
        {},
      );

      expect(result.imagePasteIds).toEqual([1]);
      expect(result.imageContentBlocks).toHaveLength(1);
      expect(result.degradedImages).toMatchObject([
        { id: 2, sourcePath: '/pictures/missing.png' },
      ]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('archives without duplicating the extension when the filename already has one', async () => {
    // Regression: clipboard images are staged as "clipboard-<ts>.png"; the
    // archive step used to append the detected extension again, producing
    // "0-clipboard-<ts>.png.png".
    const outputDir = await mkdtemp(path.join(tmpdir(), 'test-paste-'));

    try {
      const stored = await storeImages(
        {
          0: {
            id: 0,
            type: 'image',
            content: Buffer.from('clipboard bytes').toString('base64'),
            mediaType: 'image/png',
            filename: 'clipboard-1793694656310.png',
          },
          1: {
            id: 1,
            type: 'image',
            content: Buffer.from('other bytes').toString('base64'),
            mediaType: 'image/png',
          },
        },
        outputDir,
      );

      expect(path.basename(stored.get(0)!)).toBe(
        '0-clipboard-1793694656310.png',
      );
      // A filename without an extension still gets one appended.
      expect(path.basename(stored.get(1)!)).toBe('1-image.png');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('replaces a misleading filename extension with the detected media type', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'test-paste-'));

    try {
      const stored = await storeImages(
        {
          2: {
            id: 2,
            type: 'image',
            content: Buffer.from('jpeg bytes').toString('base64'),
            mediaType: 'image/jpeg',
            filename: 'photo.png',
          },
        },
        outputDir,
      );

      expect(path.basename(stored.get(2)!)).toBe('2-photo.jpeg');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('keeps validating legacy unprepared base64 content', async () => {
    const input = Buffer.from('legacy input');
    const normalized = Buffer.from('normalized');
    vi.mocked(maybeResizeAndDownsampleImageBuffer).mockResolvedValue({
      buffer: normalized,
      mediaType: 'jpeg',
    });
    const outputDir = await mkdtemp(path.join(tmpdir(), 'test-paste-'));

    try {
      const result = await processPastedImages(
        {
          0: {
            id: 0,
            type: 'image',
            content: input.toString('base64'),
            mediaType: 'image/png',
            filename: 'legacy.png',
          },
        },
        outputDir,
        undefined,
        undefined,
        {},
      );

      expect(readImageWithMediaLimits).not.toHaveBeenCalled();
      expect(maybeResizeAndDownsampleImageBuffer).toHaveBeenCalledOnce();
      expect(result.imageContentBlocks[0]).toMatchObject({
        source: {
          mediaType: 'image/jpeg',
          data: normalized.toString('base64'),
        },
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
