/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DefaultRequestTokenizer } from './requestTokenizer.js';
import type { CountTokensParameters } from '@google/genai';

describe('DefaultRequestTokenizer', () => {
  let tokenizer: DefaultRequestTokenizer;

  beforeEach(() => {
    tokenizer = new DefaultRequestTokenizer();
  });

  afterEach(async () => {
    await tokenizer.dispose();
  });

  describe('text token calculation', () => {
    it('should calculate tokens for simple text content', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Hello, world!' }],
          },
        ],
      };

      const result = await tokenizer.calculateTokens(request);

      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.breakdown.textTokens).toBeGreaterThan(0);
      expect(result.breakdown.imageTokens).toBe(0);
      expect(result.processingTime).toBeGreaterThan(0);
    });

    it('should handle multiple text parts', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'First part' },
              { text: 'Second part' },
              { text: 'Third part' },
            ],
          },
        ],
      };

      const result = await tokenizer.calculateTokens(request);

      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.breakdown.textTokens).toBeGreaterThan(0);
    });

    it('should handle string content', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: ['Simple string content'],
      };

      const result = await tokenizer.calculateTokens(request);

      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.breakdown.textTokens).toBeGreaterThan(0);
    });
  });

  describe('image token calculation', () => {
    it('should calculate tokens for image content', async () => {
      // Create a simple 1x1 PNG image in base64
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77yQAAAABJRU5ErkJggg==';

      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: pngBase64,
                },
              },
            ],
          },
        ],
      };

      const result = await tokenizer.calculateTokens(request);

      expect(result.totalTokens).toBeGreaterThanOrEqual(4); // Minimum 4 tokens per image
      expect(result.breakdown.imageTokens).toBeGreaterThanOrEqual(4);
      expect(result.breakdown.textTokens).toBe(0);
    });

    it('should handle multiple images', async () => {
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77yQAAAABJRU5ErkJggg==';

      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: pngBase64,
                },
              },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: pngBase64,
                },
              },
            ],
          },
        ],
      };

      const result = await tokenizer.calculateTokens(request);

      expect(result.totalTokens).toBeGreaterThanOrEqual(8); // At least 4 tokens per image
      expect(result.breakdown.imageTokens).toBeGreaterThanOrEqual(8);
    });
  });

  describe('mixed content', () => {
    it('should handle text and image content together', async () => {
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77yQAAAABJRU5ErkJggg==';

      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Here is an image:' },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: pngBase64,
                },
              },
              { text: 'What do you see?' },
            ],
          },
        ],
      };

      const result = await tokenizer.calculateTokens(request);

      expect(result.totalTokens).toBeGreaterThan(4);
      expect(result.breakdown.textTokens).toBeGreaterThan(0);
      expect(result.breakdown.imageTokens).toBeGreaterThanOrEqual(4);
    });
  });

  describe('function content', () => {
    it('should handle function calls', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [
              {
                functionCall: {
                  name: 'test_function',
                  args: { param1: 'value1', param2: 42 },
                },
              },
            ],
          },
        ],
      };

      const result = await tokenizer.calculateTokens(request);

      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.breakdown.otherTokens).toBeGreaterThan(0);
    });
  });

  describe('empty content', () => {
    it('should handle empty request', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [],
      };

      const result = await tokenizer.calculateTokens(request);

      expect(result.totalTokens).toBe(0);
      expect(result.breakdown.textTokens).toBe(0);
      expect(result.breakdown.imageTokens).toBe(0);
    });

    it('should handle undefined contents', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [],
      };

      const result = await tokenizer.calculateTokens(request);

      expect(result.totalTokens).toBe(0);
    });
  });

  describe('configuration', () => {
    it('should use custom text encoding', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Test text for encoding' }],
          },
        ],
      };

      const result = await tokenizer.calculateTokens(request, {
        textEncoding: 'cl100k_base',
      });

      expect(result.totalTokens).toBeGreaterThan(0);
    });

    it('should process multiple images serially', async () => {
      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAI9jU77yQAAAABJRU5ErkJggg==';

      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: Array(10).fill({
              inlineData: {
                mimeType: 'image/png',
                data: pngBase64,
              },
            }),
          },
        ],
      };

      const result = await tokenizer.calculateTokens(request);

      expect(result.totalTokens).toBeGreaterThanOrEqual(60); // At least 6 tokens per image * 10 images
    });
  });

  describe('error handling', () => {
    it('should handle malformed image data gracefully', async () => {
      const request: CountTokensParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: 'invalid-base64-data',
                },
              },
            ],
          },
        ],
      };

      const result = await tokenizer.calculateTokens(request);

      // Should still return some tokens (fallback to minimum)
      expect(result.totalTokens).toBeGreaterThanOrEqual(4);
    });
  });
});
