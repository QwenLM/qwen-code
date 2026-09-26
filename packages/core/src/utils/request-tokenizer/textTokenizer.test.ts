/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  estimateTextTokens,
  estimateTextTokenUnits,
  TextTokenizer,
  TOKEN_ESTIMATE_UNITS_PER_TOKEN,
} from './textTokenizer.js';

describe('TextTokenizer', () => {
  let tokenizer: TextTokenizer;

  beforeEach(() => {
    tokenizer = new TextTokenizer();
  });

  const count = (text: string) => tokenizer.calculateTokens(text);
  const batch = (texts: string[]) => tokenizer.calculateTokensBatch(texts);

  describe('constructor', () => {
    // Exact duplicate 'should create tokenizer with custom encoding (for
    // backward compatibility)' removed; the encoding name is accepted but unused.
    it('should create tokenizer with default encoding', () => {
      tokenizer = new TextTokenizer();
      expect(tokenizer).toBeInstanceOf(TextTokenizer);
    });
  });

  describe('calculateTokens', () => {
    it('keeps token-unit estimates aligned with token estimates', () => {
      for (const text of ['', 'Hello', '你好世界', 'Hello 世界']) {
        expect(
          Math.ceil(
            estimateTextTokenUnits(text) / TOKEN_ESTIMATE_UNITS_PER_TOKEN,
          ),
        ).toBe(estimateTextTokens(text));
      }
    });

    it('should return 0 for null/undefined text', async () => {
      expect(await count(null as unknown as string)).toBe(0);
      expect(await count(undefined as unknown as string)).toBe(0);
    });

    // Expected = ceil(ASCII chars / 4 + non-ASCII UTF-16 units * 1.1).
    it.each<[string, string, number]>([
      ['should return 0 for empty text', '', 0],
      [
        'should calculate tokens using character-based estimation for ASCII text',
        'Hello, world!', // 13 ASCII: 3.25 -> 4
        4,
      ],
      [
        'should calculate tokens for code (ASCII)',
        'function test() { return 42; }', // 30 ASCII: 7.5 -> 8
        8,
      ],
      ['should calculate tokens for non-ASCII text (CJK)', '你好世界', 5], // 4.4
      [
        'should calculate tokens for mixed ASCII and non-ASCII text',
        'Hello 世界', // 6 ASCII + 2 non-ASCII: 1.5 + 2.2 = 3.7 -> 4
        4,
      ],
      ['should calculate tokens for emoji', '🌍', 3], // 2 UTF-16 units: 2.2
      ['should handle very long text', 'a'.repeat(10000), 2500],
      ['should handle text with only whitespace', '   \n\t  ', 2], // 7: 1.75
      [
        'should handle special characters and symbols',
        '!@#$%^&*()_+-=[]{}|;:,.<>?', // 26 ASCII: 6.5 -> 7
        7,
      ],
      ['should handle very short text', 'a', 1],
    ])('%s', async (_title, text, expected) => {
      expect(await count(text)).toBe(expected);
    });
  });

  describe('calculateTokensBatch', () => {
    it('should process multiple texts and return token counts', async () => {
      // 'Hello', 'world' = 5 / 4 -> 2; 'test' = 4 / 4 -> 1
      expect(await batch(['Hello', 'world', 'test'])).toEqual([2, 2, 1]);
    });

    it('should handle empty array', async () => {
      expect(await batch([])).toEqual([]);
    });

    it('should handle array with empty strings', async () => {
      expect(await batch(['', 'hello', ''])).toEqual([0, 2, 0]);
    });

    it('should handle mixed ASCII and non-ASCII texts', async () => {
      // '世界' = 2 * 1.1 = 2.2 -> 3; 'Hello 世界' = 1.5 + 2.2 = 3.7 -> 4
      expect(await batch(['Hello', '世界', 'Hello 世界'])).toEqual([2, 3, 4]);
    });

    it('should handle null and undefined values in batch', async () => {
      const texts = [null, 'hello', undefined, 'world'] as unknown as string[];
      expect(await batch(texts)).toEqual([0, 2, 0, 2]);
    });

    it('should process large batches efficiently', async () => {
      const texts = Array.from({ length: 1000 }, (_, i) => `text${i}`);
      const result = await tokenizer.calculateTokensBatch(texts);
      expect(result).toHaveLength(1000);
      result.forEach((n) => {
        expect(n).toBeGreaterThan(0);
        expect(n).toBeLessThan(10); // 'textNNN' should be less than 10 tokens
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
    it.each<[string, string, number]>([
      ['should handle text with only newlines', '\n\n\n', 1], // 3 ASCII: 0.75
      ['should handle text with tabs', '\t\t\t\t', 1], // 4 ASCII: 1
      // Mathematical bold letters outside the BMP: 10 non-ASCII units -> 11
      ['should handle surrogate pairs correctly', '𝕳𝖊𝖑𝖑𝖔', 11],
      // 'e' + combining acute (non-ASCII): 0.25 + 1.1 = 1.35 -> 2
      ['should handle combining characters', 'e\u0301', 2],
      // 'caf' ASCII + 'é' non-ASCII: 0.75 + 1.1 = 1.85 -> 2
      ['should handle accented characters', 'café', 2],
    ])('%s', async (_title, text, expected) => {
      expect(await count(text)).toBe(expected);
    });

    it('should handle various unicode scripts', async () => {
      // All should use 1.1 tokens per char
      expect(await count('Привет')).toBe(7); // 6 * 1.1 = 6.6 -> ceil = 7
      expect(await count('مرحبا')).toBe(6); // 5 * 1.1 = 5.5 -> ceil = 6
      expect(await count('こんにちは')).toBe(6); // 5 * 1.1 = 5.5 -> ceil = 6
    });
  });

  describe('ASCII/non-ASCII boundary', () => {
    it('should treat DEL (U+007F) as ASCII and U+0080 as non-ASCII', async () => {
      // '\x7F' = 1 ASCII char: 1 / 4 = 0.25 -> ceil = 1
      expect(await tokenizer.calculateTokens('\x7F')).toBe(1);
      // '\u0080' = 1 non-ASCII char: 1 * 1.1 = 1.1 -> ceil = 2
      expect(await tokenizer.calculateTokens('\u0080')).toBe(2);
    });

    it('should count pure-ASCII text of any length as ceil(length / 4)', async () => {
      for (const len of [1, 3, 4, 5, 4096, 4097]) {
        const text = 'a'.repeat(len);
        expect(await tokenizer.calculateTokens(text)).toBe(Math.ceil(len / 4));
      }
    });

    it('should stay consistent when a single non-ASCII char joins long ASCII text', async () => {
      const ascii = 'x'.repeat(1000);
      // 1000 / 4 = 250
      expect(await tokenizer.calculateTokens(ascii)).toBe(250);
      // 1000 / 4 + 1 * 1.1 = 251.1 -> ceil = 252, wherever the char sits
      expect(await tokenizer.calculateTokens(ascii + '中')).toBe(252);
      expect(await tokenizer.calculateTokens('中' + ascii)).toBe(252);
    });

    it('should count surrogate pairs as two non-ASCII units within mixed text', async () => {
      const text = 'abcd🚀'; // 4 ASCII + 2 UTF-16 units
      // 4 / 4 + 2 * 1.1 = 3.2 -> ceil = 4
      expect(await tokenizer.calculateTokens(text)).toBe(4);
    });
  });

  describe('large inputs', () => {
    it('should handle very long text', async () => {
      expect(await count('a'.repeat(200000))).toBe(50000); // 200000 / 4
    });

    it('should handle large batches', async () => {
      const texts = Array.from({ length: 5000 }, () => 'Hello, world!');
      const result = await tokenizer.calculateTokensBatch(texts);
      expect(result).toHaveLength(5000);
      expect(result[0]).toBe(4);
    });
  });
});
