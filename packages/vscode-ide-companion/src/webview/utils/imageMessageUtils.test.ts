/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { escapePath } from '../../utils/pathEscaping.js';
import { splitMessageContentForImages } from './imageMessageUtils.js';

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
