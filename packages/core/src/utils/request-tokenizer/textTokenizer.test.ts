/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TextTokenizer } from './textTokenizer.js';

describe('TextTokenizer', () => {
  let tokenizer: TextTokenizer;

  beforeEach(() => {
    tokenizer = new TextTokenizer();
  });

  describe('constructor', () => {
    it('should create tokenizer with default encoding', () => {
      tokenizer = new TextTokenizer();
      expect(tokenizer).toBeInstanceOf(TextTokenizer);
    });

    it('should create tokenizer with custom encoding (for backward compatibility)', () => {
      tokenizer = new TextTokenizer();
      expect(tokenizer).toBeInstanceOf(TextTokenizer);
      // Note: encoding name is accepted but not used
    });
  });

  describe('calculateTokens', () => {
    it('should return 0 for empty text', async () => {
      const result = await tokenizer.calculateTokens('');
      expect(result).toBe(0);
    });

    it('should return 0 for null/undefined text', async () => {
      const result1 = await tokenizer.calculateTokens(
        null as unknown as string,
      );
      const result2 = await tokenizer.calculateTokens(
        undefined as unknown as string,
      );
      expect(result1).toBe(0);
      expect(result2).toBe(0);
    });

    it('should calculate tokens using character-based estimation for ASCII text', async () => {
      const testText = 'Hello, world!'; // 13 ASCII chars
      const result = await tokenizer.calculateTokens(testText);
      // 13 / 4 = 3.25 -> ceil = 4
      expect(result).toBe(4);
    });

    it('should calculate tokens for code (ASCII)', async () => {
      const code = 'function test() { return 42; }'; // 30 ASCII chars
      const result = await tokenizer.calculateTokens(code);
      // 30 / 4 = 7.5 -> ceil = 8
      expect(result).toBe(8);
    });

    it('should calculate tokens for non-ASCII text (CJK)', async () => {
      const unicodeText = '你好世界'; // 4 non-ASCII chars
      const result = await tokenizer.calculateTokens(unicodeText);
      // 4 * 1.1 = 4.4 -> ceil = 5
      expect(result).toBe(5);
    });

    it('should calculate tokens for mixed ASCII and non-ASCII text', async () => {
      const mixedText = 'Hello 世界'; // 6 ASCII + 2 non-ASCII
      const result = await tokenizer.calculateTokens(mixedText);
      // (6 / 4) + (2 * 1.1) = 1.5 + 2.2 = 3.7 -> ceil = 4
      expect(result).toBe(4);
    });

    it('should calculate tokens for emoji', async () => {
      const emojiText = '🌍'; // 2 UTF-16 code units (non-ASCII)
      const result = await tokenizer.calculateTokens(emojiText);
      // 2 * 1.1 = 2.2 -> ceil = 3
      expect(result).toBe(3);
    });

    it('should handle very long text', async () => {
      const longText = 'a'.repeat(10000); // 10000 ASCII chars
      const result = await tokenizer.calculateTokens(longText);
      // 10000 / 4 = 2500 -> ceil = 2500
      expect(result).toBe(2500);
    });

    it('should handle text with only whitespace', async () => {
      const whitespaceText = '   \n\t  '; // 7 ASCII chars
      const result = await tokenizer.calculateTokens(whitespaceText);
      // 7 / 4 = 1.75 -> ceil = 2
      expect(result).toBe(2);
    });

    it('should handle special characters and symbols', async () => {
      const specialText = '!@#$%^&*()_+-=[]{}|;:,.<>?'; // 26 ASCII chars
      const result = await tokenizer.calculateTokens(specialText);
      // 26 / 4 = 6.5 -> ceil = 7
      expect(result).toBe(7);
    });

    it('should handle very short text', async () => {
      const result = await tokenizer.calculateTokens('a');
      // 1 / 4 = 0.25 -> ceil = 1
      expect(result).toBe(1);
    });
  });

  describe('calculateTokensBatch', () => {
    it('should process multiple texts and return token counts', async () => {
      const texts = ['Hello', 'world', 'test'];
      const result = await tokenizer.calculateTokensBatch(texts);
      // 'Hello' = 5 / 4 = 1.25 -> ceil = 2
      // 'world' = 5 / 4 = 1.25 -> ceil = 2
      // 'test' = 4 / 4 = 1 -> ceil = 1
      expect(result).toEqual([2, 2, 1]);
    });

    it('should handle empty array', async () => {
      const result = await tokenizer.calculateTokensBatch([]);
      expect(result).toEqual([]);
    });

    it('should handle array with empty strings', async () => {
      const texts = ['', 'hello', ''];
      const result = await tokenizer.calculateTokensBatch(texts);
      // '' = 0
      // 'hello' = 5 / 4 = 1.25 -> ceil = 2
      // '' = 0
      expect(result).toEqual([0, 2, 0]);
    });

    it('should handle mixed ASCII and non-ASCII texts', async () => {
      const texts = ['Hello', '世界', 'Hello 世界'];
      const result = await tokenizer.calculateTokensBatch(texts);
      // 'Hello' = 5 / 4 = 1.25 -> ceil = 2
      // '世界' = 2 * 1.1 = 2.2 -> ceil = 3
      // 'Hello 世界' = (6/4) + (2*1.1) = 1.5 + 2.2 = 3.7 -> ceil = 4
      expect(result).toEqual([2, 3, 4]);
    });

    it('should handle null and undefined values in batch', async () => {
      const texts = [null, 'hello', undefined, 'world'] as unknown as string[];
      const result = await tokenizer.calculateTokensBatch(texts);
      // null = 0
      // 'hello' = 5 / 4 = 1.25 -> ceil = 2
      // undefined = 0
      // 'world' = 5 / 4 = 1.25 -> ceil = 2
      expect(result).toEqual([0, 2, 0, 2]);
    });

    it('should process large batches efficiently', async () => {
      const texts = Array.from({ length: 1000 }, (_, i) => `text${i}`);
      const result = await tokenizer.calculateTokensBatch(texts);
      expect(result).toHaveLength(1000);
      // Verify results are reasonable
      result.forEach((count) => {
        expect(count).toBeGreaterThan(0);
        expect(count).toBeLessThan(10); // 'textNNN' should be less than 10 tokens
      });
    });
  });

  describe('backward compatibility', () => {
    it('should accept encoding parameter in constructor', () => {
      const tokenizer1 = new TextTokenizer();
      const tokenizer2 = new TextTokenizer();
      const tokenizer3 = new TextTokenizer();

      expect(tokenizer1).toBeInstanceOf(TextTokenizer);
      expect(tokenizer2).toBeInstanceOf(TextTokenizer);
      expect(tokenizer3).toBeInstanceOf(TextTokenizer);
    });

    it('should produce same results regardless of encoding parameter', async () => {
      const text = 'Hello, world!';
      const tokenizer1 = new TextTokenizer();
      const tokenizer2 = new TextTokenizer();
      const tokenizer3 = new TextTokenizer();

      const result1 = await tokenizer1.calculateTokens(text);
      const result2 = await tokenizer2.calculateTokens(text);
      const result3 = await tokenizer3.calculateTokens(text);

      // All should use character-based estimation, ignoring encoding parameter
      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
      expect(result1).toBe(4); // 13 / 4 = 3.25 -> ceil = 4
    });

    it('should maintain async interface for calculateTokens', async () => {
      const result = tokenizer.calculateTokens('test');
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBe(1);
    });

    it('should maintain async interface for calculateTokensBatch', async () => {
      const result = tokenizer.calculateTokensBatch(['test']);
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toEqual([1]);
    });
  });

  describe('edge cases', () => {
    it('should handle text with only newlines', async () => {
      const text = '\n\n\n'; // 3 ASCII chars
      const result = await tokenizer.calculateTokens(text);
      // 3 / 4 = 0.75 -> ceil = 1
      expect(result).toBe(1);
    });

    it('should handle text with tabs', async () => {
      const text = '\t\t\t\t'; // 4 ASCII chars
      const result = await tokenizer.calculateTokens(text);
      // 4 / 4 = 1 -> ceil = 1
      expect(result).toBe(1);
    });

    it('should handle surrogate pairs correctly', async () => {
      // Character outside BMP (Basic Multilingual Plane)
      const text = '𝕳𝖊𝖑𝖑𝖔'; // Mathematical bold letters (2 UTF-16 units each)
      const result = await tokenizer.calculateTokens(text);
      // Each character is 2 UTF-16 units, all non-ASCII
      // Total: 10 non-ASCII units
      // 10 * 1.1 = 11 -> ceil = 11
      expect(result).toBe(11);
    });

    it('should handle combining characters', async () => {
      // e + combining acute accent
      const text = 'e\u0301'; // 2 chars: 'e' (ASCII) + combining acute (non-ASCII)
      const result = await tokenizer.calculateTokens(text);
      // ASCII: 1 / 4 = 0.25
      // Non-ASCII: 1 * 1.1 = 1.1
      // Total: 0.25 + 1.1 = 1.35 -> ceil = 2
      expect(result).toBe(2);
    });

    it('should handle accented characters', async () => {
      const text = 'café'; // 'caf' = 3 ASCII, 'é' = 1 non-ASCII
      const result = await tokenizer.calculateTokens(text);
      // ASCII: 3 / 4 = 0.75
      // Non-ASCII: 1 * 1.1 = 1.1
      // Total: 0.75 + 1.1 = 1.85 -> ceil = 2
      expect(result).toBe(2);
    });

    it('should handle various unicode scripts', async () => {
      const cyrillic = 'Привет'; // 6 non-ASCII chars
      const arabic = 'مرحبا'; // 5 non-ASCII chars
      const japanese = 'こんにちは'; // 5 non-ASCII chars

      const result1 = await tokenizer.calculateTokens(cyrillic);
      const result2 = await tokenizer.calculateTokens(arabic);
      const result3 = await tokenizer.calculateTokens(japanese);

      // All should use 1.1 tokens per char
      expect(result1).toBe(7); // 6 * 1.1 = 6.6 -> ceil = 7
      expect(result2).toBe(6); // 5 * 1.1 = 5.5 -> ceil = 6
      expect(result3).toBe(6); // 5 * 1.1 = 5.5 -> ceil = 6
    });
  });

  describe('large inputs', () => {
    it('should handle very long text', async () => {
      const longText = 'a'.repeat(200000); // 200k characters
      const result = await tokenizer.calculateTokens(longText);
      expect(result).toBe(50000); // 200000 / 4
    });

    it('should handle large batches', async () => {
      const texts = Array.from({ length: 5000 }, () => 'Hello, world!');
      const result = await tokenizer.calculateTokensBatch(texts);
      expect(result).toHaveLength(5000);
      expect(result[0]).toBe(4);
    });
  });
});
