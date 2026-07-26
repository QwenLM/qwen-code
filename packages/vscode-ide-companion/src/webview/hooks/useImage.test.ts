/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { escapePath, MAX_IMAGE_SIZE } from '../../utils/imageSupport.js';
import { formatFileSize, splitMessageContentForImages } from './useImage.js';

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

describe('formatFileSize', () => {
  it('formats small sizes with the right unit', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
  });

  it('describes the image size limit consistently with the constant', () => {
    // The "too large" paste error interpolates this value, so it must read as
    // a real size (and track MAX_IMAGE_SIZE) rather than a hardcoded string.
    expect(formatFileSize(MAX_IMAGE_SIZE)).toBe('10 MB');
  });

  it('handles terabyte-scale sizes without emitting "undefined"', () => {
    // Regression: the previous ['B','KB','MB','GB'] list had no slot for
    // index 4, so a >= 1 TB value rendered "… undefined".
    expect(formatFileSize(2 * 1024 ** 4)).toBe('2 TB');
  });

  it('clamps beyond the largest known unit instead of going out of bounds', () => {
    expect(formatFileSize(1024 ** 5)).toBe('1024 TB');
  });
});

describe('useImage browser bundle', () => {
  it('bundles without resolving node-only qwen-code-core modules', async () => {
    const entryPoint = fileURLToPath(new URL('./useImage.ts', import.meta.url));

    await expect(
      build({
        entryPoints: [entryPoint],
        bundle: true,
        format: 'esm',
        logLevel: 'silent',
        platform: 'browser',
        write: false,
      }),
    ).resolves.toMatchObject({
      outputFiles: expect.any(Array),
    });
  });
});
