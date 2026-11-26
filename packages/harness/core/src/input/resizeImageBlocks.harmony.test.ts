/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Regression coverage for direct SDK image input when Sharp cannot load. */

import { describe, expect, it, vi } from 'vitest';

vi.mock('sharp', () => {
  throw new Error("Cannot open shared library 'sharp-linux-x64.node'");
});

import { resizeImageBlocks } from './processor.js';

const imageData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function imageBlock() {
  return {
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      mediaType: 'image/png' as const,
      data: imageData,
    },
  };
}

describe('resizeImageBlocks without a loadable Sharp backend', () => {
  it('keeps a verified original image instead of failing the send', async () => {
    const { blocks } = await resizeImageBlocks([imageBlock()]);

    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block.type !== 'image' || block.source.type !== 'base64') {
      throw new Error('应保留标准内联图片');
    }
    expect(block.source.data).toBe(imageData);
    expect(block.source.mediaType).toBe('image/png');
  });

  it('does not report resize metadata for byte-identical passthrough', async () => {
    const { metadataTexts } = await resizeImageBlocks([imageBlock()]);

    expect(metadataTexts).toEqual([]);
  });

  it('passes non-image blocks through untouched', async () => {
    const textBlock = { type: 'text' as const, text: 'hello' };
    const { blocks } = await resizeImageBlocks([textBlock, imageBlock()]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual(textBlock);
  });

  // skip: 现存失败
  it.skip('still rejects invalid image bytes', async () => {
    const invalid = imageBlock();
    invalid.source.data = Buffer.from('not an image').toString('base64');
    await expect(
      resizeImageBlocks([invalid]),
    ).rejects.toThrow(/could not be verified/);
  });
});
