/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PhotonImage } from '@silvia-odwyer/photon-node';
import { describe, expect, it, vi } from 'vitest';

vi.mock('sharp', () => {
  throw new Error("Cannot open shared library 'sharp-linux-x64.node'");
});

import {
  maybeResizeAndDownsampleImageBuffer,
  processImageBufferWithMediaLimits,
} from './imageReader.js';
import { IMAGE_TARGET_RAW_SIZE } from './constants.js';

const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAsAAAALCAYAAACprHcmAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVR4nGO4oyHyn1jMMKpYY2iHBgB1vfzgoM5voQAAAABJRU5ErkJggg==',
  'base64',
);
const compatibleImages = [
  {
    format: 'png',
    buffer: validPng,
  },
  {
    format: 'jpeg',
    buffer: (() => {
      const image = PhotonImage.new_from_byteslice(createPng(11, 11));
      try {
        return Buffer.from(image.get_bytes_jpeg(80));
      } finally {
        image.free();
      }
    })(),
  },
  {
    format: 'webp',
    buffer: Buffer.from(
      'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoLAAsAAUAmJaACdLoB+AADsAD+7/3D/zBK/INzr/+/aXvtL32l/qEAAAA=',
      'base64',
    ),
  },
] as const;

function createPng(width: number, height: number): Buffer {
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 220;
    pixels[offset + 1] = 40;
    pixels[offset + 2] = 20;
    pixels[offset + 3] = 255;
  }
  const image = new PhotonImage(pixels, width, height);
  try {
    return Buffer.from(image.get_bytes());
  } finally {
    image.free();
  }
}

function createBmp(): Buffer {
  const width = 11;
  const height = 11;
  const pixelBytes = width * height * 4;
  const bmp = Buffer.alloc(54 + pixelBytes);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(32, 28);
  bmp.writeUInt32LE(pixelBytes, 34);
  for (let offset = 54; offset < bmp.length; offset += 4) {
    bmp.set([20, 40, 220, 255], offset);
  }
  return bmp;
}

describe('imageReader portable WebAssembly fallback', () => {
  it('fully decodes a compatible image before preserving original bytes', async () => {
    const result = await maybeResizeAndDownsampleImageBuffer(
      validPng,
      validPng.length,
      'png',
    );

    expect(result.buffer).toEqual(validPng);
    expect(result.mediaType).toBe('png');
    expect(result.dimensions?.originalWidth).toBe(11);
    expect(result.dimensions?.originalHeight).toBe(11);
  });

  it.each(compatibleImages)(
    'fully decodes compatible $format input',
    async ({ format, buffer }) => {
      const result = await maybeResizeAndDownsampleImageBuffer(
        buffer,
        buffer.length,
        format,
      );

      expect(result.buffer).toEqual(buffer);
      expect(result.mediaType).toBe(format);
    },
  );

  it('uses WebAssembly encoding when the original size requires compression', async () => {
    const result = await maybeResizeAndDownsampleImageBuffer(
      validPng,
      IMAGE_TARGET_RAW_SIZE + 1,
      'png',
    );
    const decoded = PhotonImage.new_from_byteslice(result.buffer);
    try {
      expect(decoded.get_width()).toBe(11);
      expect(decoded.get_height()).toBe(11);
      expect(result.buffer.length).toBeLessThanOrEqual(IMAGE_TARGET_RAW_SIZE);
    } finally {
      decoded.free();
    }
  });

  it('resizes dimensions that the raw passthrough cannot accept', async () => {
    const input = createPng(2100, 12);
    const result = await maybeResizeAndDownsampleImageBuffer(
      input,
      input.length,
      'png',
    );

    expect(result.dimensions).toEqual({
      originalWidth: 2100,
      originalHeight: 12,
      displayWidth: 2000,
      displayHeight: 11,
    });
    const decoded = PhotonImage.new_from_byteslice(result.buffer);
    try {
      expect(decoded.get_width()).toBe(2000);
      expect(decoded.get_height()).toBe(11);
    } finally {
      decoded.free();
    }
  });

  it('rejects resizing when the portable processor cannot pad the short edge', async () => {
    const input = createPng(4465, 19);

    await expect(
      maybeResizeAndDownsampleImageBuffer(input, input.length, 'png'),
    ).rejects.toThrow(/cannot add padding/);
  });

  it('converts BMP input to an API-compatible PNG', async () => {
    const result = await processImageBufferWithMediaLimits(createBmp(), {
      originalMediaType: 'image/bmp',
    });

    expect(result.mediaType).toBe('image/png');
    expect(Buffer.from(result.base64, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('fails closed on a truncated container before WebAssembly decoding', async () => {
    await expect(
      maybeResizeAndDownsampleImageBuffer(
        validPng.subarray(0, validPng.length - 12),
        validPng.length - 12,
        'png',
      ),
    ).rejects.toThrow('invalid PNG structure (missing IEND chunk)');
  });
});
