/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  extractInlineContentRuns,
  extractInlineImages,
} from './inline-image-parts.js';

describe('extractInlineImages', () => {
  it('extracts an image from a top-level tool response part', () => {
    const image = {
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
      displayName: 'chart.png',
    };

    expect(extractInlineImages([{ inlineData: image }])).toEqual([image]);
  });

  it('extracts an image from nested function response parts', () => {
    const image = {
      data: 'bmVzdGVkLWltYWdl',
      mimeType: 'image/webp',
    };

    expect(
      extractInlineImages([
        {
          functionResponse: {
            id: 'call-1',
            name: 'generate_image',
            response: { output: 'done' },
            parts: [{ inlineData: image }],
          },
        },
      ]),
    ).toEqual([image]);
  });

  it('ignores non-image inline data', () => {
    expect(
      extractInlineImages([
        {
          inlineData: {
            data: 'bm90LWFuLWltYWdl',
            mimeType: 'text/plain',
          },
        },
      ]),
    ).toEqual([]);
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
});
