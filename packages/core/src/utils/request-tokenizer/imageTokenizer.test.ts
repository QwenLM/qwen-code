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
});
