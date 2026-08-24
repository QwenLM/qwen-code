/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SUPPORTED_IMAGE_MIME_TYPES } from '@qwen-code/qwen-code-core';
import {
  escapePath,
  splitMessageContentForImages,
  SUPPORTED_PASTED_IMAGE_MIME_TYPES,
} from './imageSupport.js';

describe('imageSupport constants', () => {
  it('keeps the browser-safe pasted image list aligned with core-supported formats', () => {
    expect(SUPPORTED_PASTED_IMAGE_MIME_TYPES).toEqual(
      new Set(SUPPORTED_IMAGE_MIME_TYPES),
    );
  });
});

describe('splitMessageContentForImages', () => {
  it('restores escaped image paths with spaces back to their original file path', () => {
    const imagePath = '/tmp/My Images/pasted image.png';
    const escapedImageReference = `@${escapePath(imagePath)}`;

    const result = splitMessageContentForImages(
      `Please inspect this screenshot.\n\n${escapedImageReference}`,
    );

    expect(result.text).toBe('Please inspect this screenshot.');
    expect(result.imagePaths).toEqual([imagePath]);
  });
});
