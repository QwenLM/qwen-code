/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  decodeBase64ImageData,
  maybeResizeAndDownsampleImageBuffer,
  processImageBufferWithMediaLimits,
  processImageBufferWithTokenBudget,
  readImageWithMediaLimits,
  type ImageReadResult,
} from './imageReader.js';
import { createJpegBuffer, createPngBuffer } from '../test-utils/index.js';

function estimatedImageTokens(result: ImageReadResult): number {
  return Math.ceil(result.base64.length * 0.125);
}

async function createLowColorOversizedPng(): Promise<Buffer> {
  const width = 3024;
  const height = 1542;
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const band = ((x >> 3) + (y >> 3)) % 16;
      raw[offset] = band * 16;
      raw[offset + 1] = (band * 7) % 256;
      raw[offset + 2] = (band * 13) % 256;
    }
  }

  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

describe('imageReader', () => {
  it('measures media processing without counting a pixel decode as compression', async () => {
    const original = await createPngBuffer(100, 100);
    const result = await processImageBufferWithMediaLimits(original);
    expect(result.observation).toMatchObject({ original_bytes: original.length, retained_bytes: original.length, original_width: 100, original_height: 100, compression_attempts: 0 });
    expect(result.observation?.['compression_duration_ms']).toBeGreaterThanOrEqual(0);
  });

  it('counts an actual resize encode and measures resulting bytes', async () => {
    const original = await createPngBuffer(4000, 1000);
    const result = await processImageBufferWithMediaLimits(original);
    expect(result.observation?.['compression_attempts']).toBeGreaterThanOrEqual(1);
    expect(result.observation?.['retained_bytes']).toBe(Buffer.from(result.base64, 'base64').length);
    expect(result.observation?.['original_width']).toBe(4000);
    expect(result.observation?.['retained_width']).toBeLessThan(4000);
  });
  it('rejects SVG data instead of forwarding it as an image', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>',
    );

    await expect(
      maybeResizeAndDownsampleImageBuffer(svg, svg.length, 'svg'),
    ).rejects.toThrow('supported formats are PNG, JPEG, GIF, and WebP');
  });

  describe('PNG container integrity', () => {
    // Synthetic blue pixels and minimal embedded XML; no customer content.
    // The broken export has an invalid metadata CRC and a truncated ending.
    const valid = readFileSync(new URL('./fixtures/embedded-valid.png', import.meta.url));
    const broken = readFileSync(new URL('./fixtures/embedded-broken.png', import.meta.url));

    it('rejects embedded metadata corruption even when Sharp can decode the pixels', async () => {
      await expect(sharp(broken).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
      await expect(processImageBufferWithMediaLimits(broken)).rejects.toThrow(
        'Unable to read image: invalid PNG structure (CRC mismatch in zTXt chunk). Use a valid image file before retrying.',
      );
    });

    it('preserves a valid PNG with embedded metadata byte for byte', async () => {
      const result = await readImageWithMediaLimits(
        fileURLToPath(new URL('./fixtures/embedded-valid.png', import.meta.url)),
      );
      expect(Buffer.from(result.base64, 'base64')).toEqual(valid);
    });

    it.each([
      {
        name: 'missing IEND',
        bytes: valid.subarray(0, valid.length - 12),
        reason: 'missing IEND chunk',
      },
      {
        name: 'invalid chunk CRC with a complete IEND',
        bytes: (() => {
          const bytes = Buffer.from(valid);
          bytes[29] = bytes[29]! ^ 1;
          return bytes;
        })(),
        reason: 'CRC mismatch in IHDR chunk',
      },
      {
        name: 'chunk extending beyond the available bytes',
        bytes: (() => {
          const bytes = Buffer.from(valid);
          bytes.writeUInt32BE(0xffffffff, 8);
          return bytes;
        })(),
        reason: 'incomplete IHDR chunk',
      },
      {
        name: 'trailing data after IEND',
        bytes: Buffer.concat([valid, Buffer.from('trailing')]),
        reason: 'unexpected data after IEND chunk',
      },
    ])('rejects $name before returning image content', async ({ bytes, reason }) => {
      await expect(processImageBufferWithMediaLimits(bytes)).rejects.toThrow(
        `invalid PNG structure (${reason})`,
      );
    });
  });

  it('decodes canonical base64 image input', () => {
    const bytes = Buffer.from('image bytes');
    expect(decodeBase64ImageData(bytes.toString('base64'))).toEqual(bytes);
  });

  it('normalizes whitespace, omitted padding, and base64url image input', () => {
    const textBytes = Buffer.from('image bytes');
    const unpadded = textBytes.toString('base64').replace(/=+$/, '');
    expect(decodeBase64ImageData(` \t${unpadded.slice(0, 4)}\n${unpadded.slice(4)}\r`)).toEqual(
      textBytes,
    );

    const urlSafeBytes = Buffer.from([0xfb, 0xff]);
    expect(
      decodeBase64ImageData(urlSafeBytes.toString('base64url')),
    ).toEqual(urlSafeBytes);
  });

  it.each([
    ['', /must not be empty/],
    [' \n\r\t', /must not be empty/],
    ['not*base64', /outside the base64 alphabet/],
    ['A', /invalid base64 padding/],
    ['Zg=', /invalid base64 padding/],
    ['Zg===', /outside the base64 alphabet/],
    ['Zh==', /non-canonical base64 padding bits/],
  ])('rejects invalid image base64 %j', (data, message) => {
    expect(() => decodeBase64ImageData(data)).toThrow(message);
  });

  it('stops before reading when the caller is already aborted', async () => {
    const controller = new AbortController();
    const abortReason = new Error('cancel image read');
    controller.abort(abortReason);

    await expect(
      readImageWithMediaLimits(
        '/path/that/should/not/be-read.png',
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(abortReason);
  });

  describe('processImageBufferWithMediaLimits', () => {
    it('does not apply token-budget compression to images within media limits', async () => {
      const imageBuffer = await createPngBuffer(900, 900);
      const originalBase64 = imageBuffer.toString('base64');

      const result = await processImageBufferWithMediaLimits(imageBuffer, {
        originalMediaType: 'image/png',
      });

      expect(result.mediaType).toBe('image/png');
      expect(result.originalSize).toBe(imageBuffer.length);
      expect(result.base64).toBe(originalBase64);
      expect(result.dimensions).toMatchObject({
        originalWidth: 900,
        originalHeight: 900,
        displayWidth: 900,
        displayHeight: 900,
      });
    });

    it('pads an extremely wide image after resizing so the short edge remains valid', async () => {
      const imageBuffer = await createPngBuffer(4465, 19);

      const result = await processImageBufferWithMediaLimits(imageBuffer, {
        originalMediaType: 'image/png',
      });
      const outputMetadata = await sharp(
        Buffer.from(result.base64, 'base64'),
      ).metadata();

      expect(outputMetadata.width).toBe(2000);
      expect(outputMetadata.height).toBe(11);
      expect(result.dimensions).toEqual({
        originalWidth: 4465,
        originalHeight: 19,
        displayWidth: 2000,
        displayHeight: 11,
      });
    });

    it('pads an original image whose short edge is below the model minimum', async () => {
      const imageBuffer = await createPngBuffer(2000, 10);

      const result = await processImageBufferWithMediaLimits(imageBuffer, {
        originalMediaType: 'image/png',
      });
      const outputMetadata = await sharp(
        Buffer.from(result.base64, 'base64'),
      ).metadata();

      expect(outputMetadata.width).toBe(2000);
      expect(outputMetadata.height).toBe(11);
    });

    it('rejects an image whose metadata is readable but pixel data is truncated', async () => {
      const completeJpeg = await createJpegBuffer(10, 10);
      const jpegWithoutEndMarker = completeJpeg.subarray(
        0,
        completeJpeg.length - 2,
      );

      await expect(
        processImageBufferWithMediaLimits(jpegWithoutEndMarker, {
          originalMediaType: 'image/jpeg',
        }),
      ).rejects.toThrow('Invalid or unsupported image data');
    });

    it('rejects non-image bytes without an explicit strict-validation option', async () => {
      await expect(
        processImageBufferWithMediaLimits(Buffer.from('not an image'), {
          originalMediaType: 'image/jpeg',
        }),
      ).rejects.toThrow('Invalid or unsupported image data');
    });
  });

  describe('processImageBufferWithTokenBudget', () => {
    it('rejects empty image buffers', async () => {
      await expect(
        processImageBufferWithTokenBudget(Buffer.alloc(0)),
      ).rejects.toThrow('Image data is empty');
    });

    it('resizes images that exceed model dimension limits', async () => {
      const imageBuffer = await createPngBuffer(2200, 120);

      const result = await processImageBufferWithTokenBudget(imageBuffer, {
        maxTokens: 1_000_000,
        originalMediaType: 'image/png',
      });

      expect(result.mediaType).toBe('image/png');
      expect(result.originalSize).toBe(imageBuffer.length);
      expect(result.dimensions).toMatchObject({
        originalWidth: 2200,
        originalHeight: 120,
      });
      expect(result.dimensions?.displayWidth).toBeLessThanOrEqual(2000);
      expect(result.base64.length).toBeGreaterThan(0);
    });

    it('compresses images that exceed the token budget', async () => {
      const imageBuffer = await createPngBuffer(900, 900);
      const originalBase64 = imageBuffer.toString('base64');

      const result = await processImageBufferWithTokenBudget(imageBuffer, {
        maxTokens: 2000,
        originalMediaType: 'image/png',
      });

      expect(result.originalSize).toBe(imageBuffer.length);
      expect(result.base64.length).toBeLessThan(originalBase64.length);
      expect(estimatedImageTokens(result)).toBeLessThanOrEqual(2000);
      expect(result.dimensions).toBeUndefined();
    });

    it('keeps media dimension limits when token-budget compression also runs', async () => {
      const maxTokens = 25000;
      const imageBuffer = await createLowColorOversizedPng();
      const originalMetadata = await sharp(imageBuffer).metadata();
      const mediaLimited = await processImageBufferWithMediaLimits(imageBuffer, {
        originalMediaType: 'image/png',
      });

      expect(originalMetadata.width).toBeGreaterThan(2000);
      expect(estimatedImageTokens(mediaLimited)).toBeGreaterThan(maxTokens);
      expect(
        Math.ceil(imageBuffer.toString('base64').length * 0.125),
      ).toBeLessThanOrEqual(maxTokens);

      const result = await processImageBufferWithTokenBudget(imageBuffer, {
        maxTokens,
        originalMediaType: 'image/png',
      });
      const outputMetadata = await sharp(
        Buffer.from(result.base64, 'base64'),
      ).metadata();

      expect(estimatedImageTokens(result)).toBeLessThanOrEqual(maxTokens);
      expect(outputMetadata.width).toBeLessThanOrEqual(2000);
      expect(outputMetadata.height).toBeLessThanOrEqual(2000);
    });

    it('rejects invalid image bytes before token-budget processing', async () => {
      await expect(
        processImageBufferWithTokenBudget(Buffer.from('not an image'), {
          maxTokens: 25000,
          originalMediaType: 'image/png',
        }),
      ).rejects.toThrow('Invalid or unsupported image data');
    });
  });
});
