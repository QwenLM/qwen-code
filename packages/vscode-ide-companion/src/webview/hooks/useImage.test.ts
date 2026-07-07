/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { escapePath } from '../../utils/imageSupport.js';
import { splitMessageContentForImages } from './useImage.js';

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
