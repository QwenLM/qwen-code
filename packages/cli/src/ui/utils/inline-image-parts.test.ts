/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { extractInlineImages } from './inline-image-parts.js';

describe('extractInlineImages', () => {
  it('extracts an image from a top-level tool response part', () => {
    const image = {
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
      displayName: 'chart.png',
    };

    expect(extractInlineImages([{ inlineData: image }])).toEqual([image]);
  });
});
