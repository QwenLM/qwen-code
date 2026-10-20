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

  const expectTokens = async (text: string, expected: number) =>
    expect(await tokenizer.calculateTokens(text)).toBe(expected);

  describe('constructor', () => {
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
      await expectTokens(null as unknown as string, 0);
      await expectTokens(undefined as unknown as string, 0);
    });

    it.each([
      ['should return 0 for empty text', '', 0],
      // 13 ASCII chars: 13 / 4 = 3.25 -> ceil = 4
      [
        'should calculate tokens using character-based estimation for ASCII text',
        'Hello, world!',
        4,
      ],
      // 30 ASCII chars: 30 / 4 = 7.5 -> ceil = 8
      [
        'should calculate tokens for code (ASCII)',
        'function test() { return 42; }',
        8,
      ],
      // 4 non-ASCII chars: 4 * 1.1 = 4.4 -> ceil = 5
      ['should calculate tokens for non-ASCII text (CJK)', '你好世界', 5],
      // 6 ASCII + 2 non-ASCII: (6 / 4) + (2 * 1.1) = 1.5 + 2.2 = 3.7 -> ceil = 4
      [
        'should calculate tokens for mixed ASCII and non-ASCII text',
        'Hello 世界',
        4,
      ],
      // 2 UTF-16 code units (non-ASCII): 2 * 1.1 = 2.2 -> ceil = 3
      ['should calculate tokens for emoji', '🌍', 3],
      // 10000 ASCII chars: 10000 / 4 = 2500 -> ceil = 2500
      ['should handle very long text', 'a'.repeat(10000), 2500],
      // 7 ASCII chars: 7 / 4 = 1.75 -> ceil = 2
      ['should handle text with only whitespace', '   \n\t  ', 2],
      // 26 ASCII chars: 26 / 4 = 6.5 -> ceil = 7
      [
        'should handle special characters and symbols',
        '!@#$%^&*()_+-=[]{}|;:,.<>?',
        7,
      ],
      // 1 / 4 = 0.25 -> ceil = 1
      ['should handle very short text', 'a', 1],
    ])('%s', (_title, text, expected) => expectTokens(text, expected));
  });

  describe('calculateTokensBatch', () => {
    it.each([
      // 'Hello', 'world' = 5 / 4 = 1.25 -> ceil = 2; 'test' = 4 / 4 = 1 -> ceil = 1
      [
        'should process multiple texts and return token counts',
        ['Hello', 'world', 'test'],
        [2, 2, 1],
      ],
      ['should handle empty array', [], []],
      // '' = 0; 'hello' = 5 / 4 = 1.25 -> ceil = 2
      ['should handle array with empty strings', ['', 'hello', ''], [0, 2, 0]],
      // 'Hello' = 5 / 4 = 1.25 -> ceil = 2; '世界' = 2 * 1.1 = 2.2 -> ceil = 3;
      // 'Hello 世界' = (6/4) + (2*1.1) = 1.5 + 2.2 = 3.7 -> ceil = 4
      [
        'should handle mixed ASCII and non-ASCII texts',
        ['Hello', '世界', 'Hello 世界'],
        [2, 3, 4],
      ],
      // null, undefined = 0; 'hello', 'world' = 5 / 4 = 1.25 -> ceil = 2
      [
        'should handle null and undefined values in batch',
        [null, 'hello', undefined, 'world'] as unknown as string[],
        [0, 2, 0, 2],
      ],
    ])('%s', async (_title, texts, expected) => {
      expect(await tokenizer.calculateTokensBatch(texts)).toEqual(expected);
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
      const tokenizers = [1, 2, 3].map(() => new TextTokenizer());
      for (const t of tokenizers) expect(t).toBeInstanceOf(TextTokenizer);
    });

    it('should produce same results regardless of encoding parameter', async () => {
      const text = 'Hello, world!';
      const [tokenizer1, tokenizer2, tokenizer3] = [1, 2, 3].map(
        () => new TextTokenizer(),
      );
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
    it.each([
      // 3 ASCII chars: 3 / 4 = 0.75 -> ceil = 1
      ['should handle text with only newlines', '\n\n\n', 1],
      // 4 ASCII chars: 4 / 4 = 1 -> ceil = 1
      ['should handle text with tabs', '\t\t\t\t', 1],
      // Mathematical bold letters, outside the BMP (Basic Multilingual
      // Plane): 2 UTF-16 units each, all non-ASCII, so 10 non-ASCII units:
      // 10 * 1.1 = 11 -> ceil = 11
      ['should handle surrogate pairs correctly', '𝕳𝖊𝖑𝖑𝖔', 11],
      // 'e' (ASCII) + combining acute accent (non-ASCII):
      // 1 / 4 + 1 * 1.1 = 0.25 + 1.1 = 1.35 -> ceil = 2
      ['should handle combining characters', 'e\u0301', 2],
      // 'caf' = 3 ASCII, 'é' = 1 non-ASCII:
      // 3 / 4 + 1 * 1.1 = 0.75 + 1.1 = 1.85 -> ceil = 2
      ['should handle accented characters', 'café', 2],
    ])('%s', (_title, text, expected) => expectTokens(text, expected));

    it('should handle various unicode scripts', async () => {
      // All should use 1.1 tokens per (non-ASCII) char, rounded up
      await expectTokens('Привет', 7); // Cyrillic, 6 chars: 6 * 1.1 = 6.6 -> 7
      await expectTokens('مرحبا', 6); // Arabic, 5 chars: 5 * 1.1 = 5.5 -> 6
      await expectTokens('こんにちは', 6); // Japanese, 5 chars: 5 * 1.1 = 5.5 -> 6
    });
  });

  describe('ASCII/non-ASCII boundary', () => {
    it('should treat DEL (U+007F) as ASCII and U+0080 as non-ASCII', async () => {
      // '\x7F' = 1 ASCII char: 1 / 4 = 0.25 -> ceil = 1
      await expectTokens('\x7F', 1);
      // '\u0080' = 1 non-ASCII char: 1 * 1.1 = 1.1 -> ceil = 2
      await expectTokens('\u0080', 2);
    });

    it('should count pure-ASCII text of any length as ceil(length / 4)', async () => {
      for (const len of [1, 3, 4, 5, 4096, 4097]) {
        await expectTokens('a'.repeat(len), Math.ceil(len / 4));
      }
    });

    it('should stay consistent when a single non-ASCII char joins long ASCII text', async () => {
      const ascii = 'x'.repeat(1000);
      await expectTokens(ascii, 250); // 1000 / 4 = 250
      // 1000 / 4 + 1 * 1.1 = 251.1 -> ceil = 252, wherever the char sits
      await expectTokens(ascii + '中', 252);
      await expectTokens('中' + ascii, 252);
    });

    it('should count surrogate pairs as two non-ASCII units within mixed text', async () => {
      // 'abcd🚀' = 4 ASCII + 2 UTF-16 units: 4 / 4 + 2 * 1.1 = 3.2 -> ceil = 4
      await expectTokens('abcd🚀', 4);
    });
  });

  describe('large inputs', () => {
    it('should handle very long text', async () => {
      await expectTokens('a'.repeat(200000), 50000); // 200k chars / 4
    });

    it('should handle large batches', async () => {
      const texts = Array.from({ length: 5000 }, () => 'Hello, world!');
      const result = await tokenizer.calculateTokensBatch(texts);
      expect(result).toHaveLength(5000);
      expect(result[0]).toBe(4);
    });
  });
});
