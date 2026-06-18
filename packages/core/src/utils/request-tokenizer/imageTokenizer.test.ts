/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ImageTokenizer } from './imageTokenizer.js';

describe('ImageTokenizer', () => {
  const tokenizer = new ImageTokenizer();

  describe('token calculation', () => {
    it('should calculate tokens based on image dimensions with reference logic', () => {
      const metadata = {
        width: 28,
        height: 28,
        mimeType: 'image/png',
        dataSize: 1000,
      };

      const tokens = tokenizer.calculateTokens(metadata);

      // 28x28 = 784 pixels = 1 image token + 2 special tokens = 3 total
      // But minimum scaling may apply for small images
      expect(tokens).toBeGreaterThanOrEqual(6); // Minimum after scaling + special tokens
    });

    it('should calculate tokens for larger images', () => {
      const metadata = {
        width: 512,
        height: 512,
        mimeType: 'image/png',
        dataSize: 10000,
      };

      const tokens = tokenizer.calculateTokens(metadata);

      // 512x512 with reference logic: rounded dimensions + scaling + special tokens
      expect(tokens).toBeGreaterThan(300);
      expect(tokens).toBeLessThan(400); // Should be reasonable for 512x512
    });

    it('should enforce minimum tokens per image with scaling', () => {
      const metadata = {
        width: 1,
        height: 1,
        mimeType: 'image/png',
        dataSize: 100,
      };

      const tokens = tokenizer.calculateTokens(metadata);

      // Tiny images get scaled up to minimum pixels + special tokens
      expect(tokens).toBeGreaterThanOrEqual(6); // 4 image tokens + 2 special tokens
    });

    it('should handle very large images with scaling', () => {
      const metadata = {
        width: 8192,
        height: 8192,
        mimeType: 'image/png',
        dataSize: 100000,
      };

      const tokens = tokenizer.calculateTokens(metadata);

      // Very large images should be scaled down to max limit + special tokens
      expect(tokens).toBeLessThanOrEqual(16386); // 16384 max + 2 special tokens
      expect(tokens).toBeGreaterThan(16000); // Should be close to the limit
    });
  });

  describe('PNG dimension extraction', () => {
    it('should extract dimensions from valid PNG', async () => {
      // 1x1 PNG image in base64
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77yQAAAABJRU5ErkJggg==';

      const metadata = await tokenizer.extractImageMetadata(
        pngBase64,
        'image/png',
      );

      expect(metadata.width).toBe(1);
      expect(metadata.height).toBe(1);
      expect(metadata.mimeType).toBe('image/png');
    });

    it('should handle invalid PNG gracefully', async () => {
      const invalidBase64 = 'invalid-png-data';

      const metadata = await tokenizer.extractImageMetadata(
        invalidBase64,
        'image/png',
      );

      // Should return default dimensions
      expect(metadata.width).toBe(512);
      expect(metadata.height).toBe(512);
      expect(metadata.mimeType).toBe('image/png');
    });
  });

  describe('WebP dimension extraction', () => {
    function buildWebp(format: string, totalLength: number): Buffer {
      const buf = Buffer.alloc(totalLength);
      buf.write('RIFF', 0, 'ascii');
      buf.writeUInt32LE(totalLength - 8, 4);
      buf.write('WEBP', 8, 'ascii');
      buf.write(format, 12, 'ascii');
      buf.writeUInt32LE(Math.max(totalLength - 20, 0), 16);
      return buf;
    }

    function buildVp8lWebp(
      width: number,
      height: number,
      signature = 0x2f,
    ): Buffer {
      const buf = buildWebp('VP8L', 26);
      buf.writeUInt32LE(5, 16);
      buf.writeUInt8(signature, 20);
      buf.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
      return buf;
    }

    it('should extract dimensions from a short VP8L lossless WebP', async () => {
      const width = 17;
      const height = 13;

      const buf = buildVp8lWebp(width, height);

      const metadata = await tokenizer.extractImageMetadata(
        buf.toString('base64'),
        'image/webp',
      );

      expect(metadata.width).toBe(width);
      expect(metadata.height).toBe(height);
    });

    it('should fall back for VP8L with an invalid lossless signature', async () => {
      const buf = buildVp8lWebp(17, 13, 0x00);

      const metadata = await tokenizer.extractImageMetadata(
        buf.toString('base64'),
        'image/webp',
      );

      expect(metadata.width).toBe(512);
      expect(metadata.height).toBe(512);
    });

    it('should still reject short VP8 and VP8X WebP files', async () => {
      const formats = ['VP8 ', 'VP8X'];

      for (const format of formats) {
        const metadata = await tokenizer.extractImageMetadata(
          buildWebp(format, 26).toString('base64'),
          'image/webp',
        );

        expect(metadata.width).toBe(512);
        expect(metadata.height).toBe(512);
      }
    });

    it('should extract canvas dimensions from VP8X', async () => {
      const width = 100;
      const height = 80;

      const buf = Buffer.alloc(30);
      buf.write('RIFF', 0, 'ascii');
      buf.writeUInt32LE(22, 4);
      buf.write('WEBP', 8, 'ascii');
      buf.write('VP8X', 12, 'ascii');
      buf.writeUInt32LE(10, 16); // VP8X chunk size
      buf.writeUInt8(0, 20); // flags
      buf.writeUIntLE(width - 1, 24, 3); // canvas width minus one (24-bit LE)
      buf.writeUIntLE(height - 1, 27, 3); // canvas height minus one (24-bit LE)

      const metadata = await tokenizer.extractImageMetadata(
        buf.toString('base64'),
        'image/webp',
      );

      expect(metadata.width).toBe(width);
      expect(metadata.height).toBe(height);
    });
  });

  describe('batch processing', () => {
    it('should process multiple images serially', async () => {
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77yQAAAABJRU5ErkJggg==';

      const images = [
        { data: pngBase64, mimeType: 'image/png' },
        { data: pngBase64, mimeType: 'image/png' },
        { data: pngBase64, mimeType: 'image/png' },
      ];

      const tokens = await tokenizer.calculateTokensBatch(images);

      expect(tokens).toHaveLength(3);
      expect(tokens.every((t) => t >= 4)).toBe(true); // All should have at least 4 tokens
    });

    it('should handle mixed valid and invalid images', async () => {
      const validPng =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77yQAAAABJRU5ErkJggg==';
      const invalidPng = 'invalid-data';

      const images = [
        { data: validPng, mimeType: 'image/png' },
        { data: invalidPng, mimeType: 'image/png' },
      ];

      const tokens = await tokenizer.calculateTokensBatch(images);

      expect(tokens).toHaveLength(2);
      expect(tokens.every((t) => t >= 4)).toBe(true); // All should have at least minimum tokens
    });
  });

  describe('different image formats', () => {
    it('should handle different MIME types', async () => {
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77yQAAAABJRU5ErkJggg==';

      const formats = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

      for (const mimeType of formats) {
        const metadata = await tokenizer.extractImageMetadata(
          pngBase64,
          mimeType,
        );
        expect(metadata.mimeType).toBe(mimeType);
        expect(metadata.width).toBeGreaterThan(0);
        expect(metadata.height).toBeGreaterThan(0);
      }
    });
  });

  describe('TIFF dimension extraction', () => {
    // Build a minimal single-IFD TIFF whose ImageWidth/ImageLength are stored
    // as SHORT (type 3) -- the most common TIFF layout for small dimensions.
    function buildShortTiff(
      byteOrder: 'II' | 'MM',
      width: number,
      height: number,
    ): string {
      const buf = Buffer.alloc(38);
      const le = byteOrder === 'II';
      buf.write(byteOrder, 0, 'ascii');
      const w16 = (off: number, v: number) =>
        le ? buf.writeUInt16LE(v, off) : buf.writeUInt16BE(v, off);
      const w32 = (off: number, v: number) =>
        le ? buf.writeUInt32LE(v, off) : buf.writeUInt32BE(v, off);
      w16(2, 42); // magic
      w32(4, 8); // IFD starts at offset 8
      w16(8, 2); // two directory entries
      // entry 0: ImageWidth (0x0100), SHORT, count 1, value left-justified
      w16(10, 0x0100);
      w16(12, 3);
      w32(14, 1);
      w16(18, width);
      // entry 1: ImageLength (0x0101), SHORT, count 1
      w16(22, 0x0101);
      w16(24, 3);
      w32(26, 1);
      w16(30, height);
      w32(34, 0); // next-IFD offset
      return buf.toString('base64');
    }

    it('reads SHORT dimensions from a big-endian (MM) TIFF', async () => {
      const tiff = buildShortTiff('MM', 800, 600);
      const metadata = await tokenizer.extractImageMetadata(tiff, 'image/tiff');
      expect(metadata.width).toBe(800);
      expect(metadata.height).toBe(600);
    });

    it('reads SHORT dimensions from a little-endian (II) TIFF', async () => {
      const tiff = buildShortTiff('II', 1024, 768);
      const metadata = await tokenizer.extractImageMetadata(tiff, 'image/tiff');
      expect(metadata.width).toBe(1024);
      expect(metadata.height).toBe(768);
    });
  });

  describe('BMP dimension extraction', () => {
    function buildBmp(width: number, height: number): string {
      // A negative height encodes a top-down BMP per the BITMAPINFOHEADER spec.
      const buf = Buffer.alloc(26);
      buf.write('BM', 0, 'ascii');
      buf.writeUInt32LE(26, 2); // file size
      buf.writeUInt32LE(0, 6); // reserved
      buf.writeUInt32LE(26, 10); // pixel data offset
      buf.writeUInt32LE(40, 14); // BITMAPINFOHEADER size
      buf.writeInt32LE(width, 18);
      buf.writeInt32LE(height, 22);
      return buf.toString('base64');
    }

    it('reads a bottom-up (positive height) BMP', async () => {
      const bmp = buildBmp(120, 80);
      const metadata = await tokenizer.extractImageMetadata(bmp, 'image/bmp');
      expect(metadata.width).toBe(120);
      expect(metadata.height).toBe(80);
    });

    it('reads a top-down (negative height) BMP as its absolute height', async () => {
      const bmp = buildBmp(100, -50);
      const metadata = await tokenizer.extractImageMetadata(bmp, 'image/bmp');
      expect(metadata.width).toBe(100);
      expect(metadata.height).toBe(50);
    });
  });
});
