/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Covers a poisoned Sharp module cache whose export is not callable. */

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:module', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:module')>();
  return {
    ...original,
    createRequire: (url: string | URL) => {
      const realRequire = original.createRequire(url);
      const wrappedRequire = ((request: string) => {
        if (request === '@silvia-odwyer/photon-node') {
          throw new Error('Photon unavailable in raw-passthrough test');
        }
        return realRequire(request);
      }) as NodeJS.Require;
      Object.assign(wrappedRequire, realRequire);
      return wrappedRequire;
    },
  };
});

vi.mock('sharp', () => ({ default: {} }));

import {
  maybeResizeAndDownsampleImageBuffer,
  processImageBufferWithMediaLimits,
} from './imageReader.js';

const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAsAAAALCAYAAACprHcmAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVR4nGO4oyHyn1jMMKpYY2iHBgB1vfzgoM5voQAAAABJRU5ErkJggg==',
  'base64',
);
const tooSmallPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('imageReader when the Sharp module cache is poisoned', () => {
  it('rejects an incomplete PNG even when neither image processor is available', async () => {
    const incomplete = validPng.subarray(0, validPng.length - 12);
    await expect(
      maybeResizeAndDownsampleImageBuffer(incomplete, incomplete.length, 'png'),
    ).rejects.toThrow('invalid PNG structure (missing IEND chunk)');
  });

  it('passes a verified image through instead of surfacing a callable error', async () => {
    const result = await maybeResizeAndDownsampleImageBuffer(
      validPng,
      validPng.length,
      'png',
    );

    expect(result.buffer).toEqual(validPng);
    expect(result.mediaType).toBe('png');
  });

  it('propagates the verified original through the media-limits pipeline', async () => {
    const result = await processImageBufferWithMediaLimits(validPng, {
      originalMediaType: 'image/png',
    });

    expect(result.base64).toBe(validPng.toString('base64'));
    expect(result.mediaType).toBe('image/png');
  });

  it('rejects an image below the minimum dimensions when no processor can pad it', async () => {
    await expect(
      maybeResizeAndDownsampleImageBuffer(
        tooSmallPng,
        tooSmallPng.length,
        'png',
      ),
    ).rejects.toThrow(/dimensions could not be verified/);
  });
});
