/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  collectInlineImages,
  extractInlineContentRuns,
  getInlineImageData,
  MAX_INLINE_IMAGE_ENCODED_LENGTH,
  MAX_INLINE_IMAGES_PER_ITEM,
} from './inline-image-parts.js';

describe('collectInlineImages', () => {
  it('extracts an image from a top-level tool response part', () => {
    const image = {
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
      displayName: 'chart.png',
    };

    expect(collectInlineImages([{ inlineData: image }])).toEqual({
      images: [{ data: image.data, mimeType: image.mimeType }],
      omittedImageCount: 0,
    });
  });

  it('extracts an image from nested function response parts', () => {
    const image = {
      data: 'bmVzdGVkLWltYWdl',
      mimeType: 'image/webp',
    };

    expect(
      collectInlineImages([
        {
          functionResponse: {
            id: 'call-1',
            name: 'generate_image',
            response: { output: 'done' },
            parts: [{ inlineData: image }],
          },
        },
      ]),
    ).toEqual({ images: [image], omittedImageCount: 0 });
  });

  it('ignores non-image inline data', () => {
    expect(
      collectInlineImages([
        {
          inlineData: {
            data: 'bm90LWFuLWltYWdl',
            mimeType: 'text/plain',
          },
        },
      ]),
    ).toEqual({ images: [], omittedImageCount: 0 });
  });

  it('caps images and reports how many were omitted', () => {
    const images = Array.from(
      { length: MAX_INLINE_IMAGES_PER_ITEM + 2 },
      (_, index) => ({
        data: Buffer.from(`image-${index}`).toString('base64'),
        mimeType: 'image/png',
      }),
    );

    expect(
      collectInlineImages(images.map((inlineData) => ({ inlineData }))),
    ).toEqual({
      images: images.slice(0, MAX_INLINE_IMAGES_PER_ITEM),
      omittedImageCount: 2,
    });
  });
});

describe('getInlineImageData', () => {
  it('rejects payloads above the renderer encoded-length limit', () => {
    expect(
      getInlineImageData({
        inlineData: {
          data: 'A'.repeat(MAX_INLINE_IMAGE_ENCODED_LENGTH + 1),
          mimeType: 'image/png',
        },
      }),
    ).toBeNull();
  });
});

describe('extractInlineContentRuns', () => {
  it('preserves text-image-text order and skips thought parts', () => {
    const image = {
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
    };

    expect(
      extractInlineContentRuns([
        { text: 'before' },
        { text: 'hidden reasoning', thought: true },
        { inlineData: image },
        { text: 'after' },
      ]),
    ).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'image', image },
      { kind: 'text', text: 'after' },
    ]);
  });

  it('caps images and preserves an overflow marker at the first omission', () => {
    const images = Array.from(
      { length: MAX_INLINE_IMAGES_PER_ITEM + 2 },
      (_, index) => ({
        data: Buffer.from(`image-${index}`).toString('base64'),
        mimeType: 'image/png',
      }),
    );

    expect(
      extractInlineContentRuns([
        { text: 'before' },
        ...images.map((inlineData) => ({ inlineData })),
        { text: 'after' },
      ]),
    ).toEqual([
      { kind: 'text', text: 'before' },
      ...images
        .slice(0, MAX_INLINE_IMAGES_PER_ITEM)
        .map((image) => ({ kind: 'image' as const, image })),
      { kind: 'omitted_images', count: 2 },
      { kind: 'text', text: 'after' },
    ]);
  });
});
