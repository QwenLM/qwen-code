/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PastedContent } from '@qwen-code/core';
import {
  preparePastedImage,
  readImageWithMediaLimits,
  runLogger,
} from '@qwen-code/core';
import { insertPastedImageFilePaths } from './useClipboardPaste.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';

// Mock image preparation so tests can observe that it starts after the
// placeholder is registered without doing native image work. escapePath is
// stubbed to identity so assertions are platform-independent and focus on
// the routing logic (image → [Image #N] vs path → @path), not escaping.
vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    preparePastedImage: vi.fn(),
    readImageWithMediaLimits: vi.fn(),
    escapePath: (p: string) => p,
  };
});

function makeBuffer(): {
  buffer: TextBuffer;
  inserts: string[];
  images: Array<{ id: number; content: PastedContent }>;
  resolutions: Array<{
    id: number;
    preparationId: string;
    content: PastedContent;
  }>;
} {
  const inserts: string[] = [];
  const images: Array<{ id: number; content: PastedContent }> = [];
  const resolutions: Array<{
    id: number;
    preparationId: string;
    content: PastedContent;
  }> = [];
  let nextImagePasteId = 0;
  const buffer = {
    nextImagePasteId: 0,
    reserveImagePasteIds: (count: number) => {
      const firstId = nextImagePasteId;
      nextImagePasteId += count;
      return Array.from({ length: count }, (_, index) => firstId + index);
    },
    addImagePaste: (id: number, content: PastedContent) => {
      images.push({ id, content });
    },
    resolveImagePaste: (
      id: number,
      preparationId: string,
      content: PastedContent,
    ) => {
      resolutions.push({ id, preparationId, content });
    },
    insert: (t: string) => {
      inserts.push(t);
    },
  } as unknown as TextBuffer;
  return { buffer, inserts, images, resolutions };
}

describe('insertPastedImageFilePaths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(preparePastedImage).mockImplementation(async (image) => ({
      ...image,
      content: Buffer.from('prepared').toString('base64'),
      mediaType: 'image/png',
      isImageContentPrepared: true,
    }));
  });

  it('registers the placeholder before background preparation completes', async () => {
    let finishPreparation:
      | ((content: Awaited<ReturnType<typeof preparePastedImage>>) => void)
      | undefined;
    vi.mocked(preparePastedImage).mockReturnValueOnce(
      new Promise((resolve) => {
        finishPreparation = resolve;
      }),
    );
    const { buffer, inserts, images, resolutions } = makeBuffer();
    insertPastedImageFilePaths(buffer, ['/pics/a.png'], []);

    expect(readImageWithMediaLimits).not.toHaveBeenCalled();
    expect(images).toHaveLength(1);
    expect(images[0].content).toMatchObject({
      id: 0,
      type: 'image',
      content: '',
      sourcePath: '/pics/a.png',
      filename: 'a.png',
      preparationId: expect.any(String),
    });
    // Only the placeholder is inserted — the external path never enters the prompt text.
    expect(inserts).toEqual(['[Image #0] ']);
    expect(preparePastedImage).toHaveBeenCalledWith(images[0].content);
    expect(resolutions).toHaveLength(0);

    finishPreparation?.({
      ...images[0].content,
      type: 'image',
      content: Buffer.from('prepared').toString('base64'),
      mediaType: 'image/png',
      isImageContentPrepared: true,
    });
    await vi.waitFor(() => {
      expect(resolutions).toHaveLength(1);
    });
    expect(resolutions[0]).toMatchObject({
      id: 0,
      preparationId: images[0].content.preparationId,
      content: { isImageContentPrepared: true },
    });
  });

  it('assigns sequential ids for multiple images from one buffer snapshot', async () => {
    const { buffer, inserts, images } = makeBuffer();
    insertPastedImageFilePaths(
      buffer,
      ['/pics/a.png', '/pics/b.jpg', '/pics/c.webp'],
      [],
    );

    expect(
      images.map(({ id, content }) => ({
        id,
        content: content.content,
        filename: content.filename,
      })),
    ).toEqual([
      { id: 0, content: '', filename: 'a.png' },
      { id: 1, content: '', filename: 'b.jpg' },
      { id: 2, content: '', filename: 'c.webp' },
    ]);
    expect(inserts).toEqual([
      '[Image #0] ',
      '[Image #1] ',
      '[Image #2] ',
    ]);
  });

  it('does not reuse an id across paste events before a render', () => {
    const { buffer, inserts, images } = makeBuffer();

    insertPastedImageFilePaths(buffer, ['/pics/first.png'], []);
    insertPastedImageFilePaths(buffer, ['/pics/second.png'], []);

    expect(images.map(({ id }) => id)).toEqual([0, 1]);
    expect(inserts).toEqual(['[Image #0] ', '[Image #1] ']);
  });

  it('keeps the deferred entry when background preparation fails', async () => {
    vi.mocked(preparePastedImage).mockRejectedValueOnce(
      new Error('decode failed'),
    );
    const debugSpy = vi.spyOn(runLogger, 'debug').mockImplementation(() => {});
    const { buffer, images, resolutions } = makeBuffer();

    insertPastedImageFilePaths(buffer, ['/pics/broken.png'], []);

    await vi.waitFor(() => {
      expect(debugSpy).toHaveBeenCalled();
    });
    expect(images[0].content.content).toBe('');
    expect(resolutions).toHaveLength(0);
  });

  it('keeps the @-mention rewrite for non-image paths', async () => {
    const { buffer, inserts, images } = makeBuffer();
    insertPastedImageFilePaths(buffer, [], ['/docs/readme.txt']);

    expect(images).toHaveLength(0);
    expect(inserts).toEqual(['@/docs/readme.txt ']);
  });

  it('handles a mixed image + non-image paste', async () => {
    const { buffer, inserts, images } = makeBuffer();
    insertPastedImageFilePaths(
      buffer,
      ['/pics/a.png'],
      ['/docs/readme.txt'],
    );

    expect(images).toHaveLength(1);
    expect(inserts).toEqual(['[Image #0] ', '@/docs/readme.txt ']);
  });
});
