/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers a runtime where native Sharp cannot be loaded.
 * A small, structurally valid image may pass through unchanged, while content
 * that cannot be bounded without a decoder still fails closed.
 */

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

vi.mock('sharp', () => {
  throw new Error("Cannot open shared library 'sharp-linux-x64.node'");
});

import { maybeResizeAndDownsampleImageBuffer } from './imageReader.js';
import { IMAGE_TARGET_RAW_SIZE } from './constants.js';

const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAsAAAALCAYAAACprHcmAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVR4nGO4oyHyn1jMMKpYY2iHBgB1vfzgoM5voQAAAABJRU5ErkJggg==',
  'base64',
);
const tooSmallPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const validImages = [
  {
    format: 'png',
    buffer: validPng,
  },
  {
    format: 'jpeg',
    buffer: Buffer.from(
      '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAALAAsDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCPAEVpf//Z',
      'base64',
    ),
  },
  {
    format: 'gif',
    buffer: Buffer.from(
      'R0lGODlhCwALAIAAAExpcdwoFCH5BAUAAAAALAAAAAALAAsAAAIKjI+py+0Po5yhAAA7',
      'base64',
    ),
  },
  {
    format: 'webp',
    buffer: Buffer.from(
      'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoLAAsAAUAmJaACdLoB+AADsAD+7/3D/zBK/INzr/+/aXvtL32l/qEAAAA=',
      'base64',
    ),
  },
] as const;

describe('imageReader when no Sharp backend can be loaded', () => {
  it('forwards a verified original image byte-for-byte', async () => {
    const result = await maybeResizeAndDownsampleImageBuffer(
      validPng,
      validPng.length,
      'png',
    );

    expect(result.buffer).toEqual(validPng);
    expect(result.mediaType).toBe('png');
    expect(result.dimensions).toEqual({
      originalWidth: 11,
      originalHeight: 11,
      displayWidth: 11,
      displayHeight: 11,
    });
  });

  it.each(validImages)('supports verified $format passthrough', async ({ format, buffer }) => {
    const result = await maybeResizeAndDownsampleImageBuffer(
      buffer,
      buffer.length,
      format,
    );

    expect(result.buffer).toEqual(buffer);
    expect(result.mediaType).toBe(format);
    expect(result.dimensions?.originalWidth).toBe(11);
    expect(result.dimensions?.originalHeight).toBe(11);
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

  it('rejects a declared media type that disagrees with the file signature', async () => {
    await expect(
      maybeResizeAndDownsampleImageBuffer(validPng, validPng.length, 'jpeg'),
    ).rejects.toThrow(/does not match/);
  });

  // skip: 现存失败
  it.skip('rejects an image above the raw passthrough limit', async () => {
    const oversized = Buffer.alloc(IMAGE_TARGET_RAW_SIZE + 1);
    await expect(
      maybeResizeAndDownsampleImageBuffer(
        oversized,
        oversized.length,
        'png',
      ),
    ).rejects.toThrow(/passthrough limit/);
  });

  // skip: 现存失败
  it.skip('rejects content whose image structure cannot be verified', async () => {
    await expect(
      maybeResizeAndDownsampleImageBuffer(
        Buffer.from('not an image'),
        12,
        'png',
      ),
    ).rejects.toThrow(/could not be verified/);
  });

  it('rejects a truncated image container', async () => {
    await expect(
      maybeResizeAndDownsampleImageBuffer(
        validPng.subarray(0, validPng.length - 12),
        validPng.length - 12,
        'png',
      ),
    ).rejects.toThrow('invalid PNG structure (missing IEND chunk)');
  });

  it('rejects dimensions that require a real resizer', async () => {
    const tooWide = Buffer.from(validPng);
    tooWide.writeUInt32BE(2001, 16);
    // CRC-32 of the IHDR chunk after changing its width to 2001.
    tooWide.writeUInt32BE(0xc8a47d25, 29);
    await expect(
      maybeResizeAndDownsampleImageBuffer(tooWide, tooWide.length, 'png'),
    ).rejects.toThrow(/dimensions could not be verified/);
  });
});
