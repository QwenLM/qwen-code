/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TextTokenizer } from './textTokenizer.js';

// Mock tiktoken at the top level with hoisted functions
const mockEncode = vi.hoisted(() => vi.fn());
const mockFree = vi.hoisted(() => vi.fn());
const mockGetEncoding = vi.hoisted(() => vi.fn());

vi.mock('tiktoken', () => ({
  get_encoding: mockGetEncoding,
}));

describe('TextTokenizer', () => {
  let tokenizer: TextTokenizer;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Default mock implementation
    mockGetEncoding.mockReturnValue({
      encode: mockEncode,
      free: mockFree,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tokenizer?.dispose();
  });

  describe('constructor', () => {
    it('should create tokenizer with default encoding', () => {
      tokenizer = new TextTokenizer();
      expect(tokenizer).toBeInstanceOf(TextTokenizer);
    });

    it('should create tokenizer with custom encoding', () => {
      tokenizer = new TextTokenizer('gpt2');
      expect(tokenizer).toBeInstanceOf(TextTokenizer);
    });
  });

  describe('calculateTokens', () => {
    beforeEach(() => {
      tokenizer = new TextTokenizer();
    });

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

    it('should calculate tokens using tiktoken when available', async () => {
      const testText = 'Hello, world!';
      const mockTokens = [1, 2, 3, 4, 5]; // 5 tokens
      mockEncode.mockReturnValue(mockTokens);

      const result = await tokenizer.calculateTokens(testText);

      expect(mockGetEncoding).toHaveBeenCalledWith('cl100k_base');
      expect(mockEncode).toHaveBeenCalledWith(testText);
      expect(result).toBe(5);
    });

    it('should use fallback calculation when tiktoken fails to load', async () => {
      mockGetEncoding.mockImplementation(() => {
        throw new Error('Failed to load tiktoken');
      });

      const testText = 'Hello, world!'; // 13 characters
      const result = await tokenizer.calculateTokens(testText);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Failed to load tiktoken with encoding cl100k_base:',
        expect.any(Error),
      );
      // Fallback: Math.ceil(13 / 4) = 4
      expect(result).toBe(4);
    });

    it('should use fallback calculation when encoding fails', async () => {
      mockEncode.mockImplementation(() => {
        throw new Error('Encoding failed');
      });

      const testText = 'Hello, world!'; // 13 characters
      const result = await tokenizer.calculateTokens(testText);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Error encoding text with tiktoken:',
        expect.any(Error),
      );
      // Fallback: Math.ceil(13 / 4) = 4
      expect(result).toBe(4);
    });

    it('should handle very long text', async () => {
      const longText = 'a'.repeat(10000);
      const mockTokens = new Array(2500); // 2500 tokens
      mockEncode.mockReturnValue(mockTokens);

      const result = await tokenizer.calculateTokens(longText);

      expect(result).toBe(2500);
    });

    it('should handle unicode characters', async () => {
      const unicodeText = '你好世界 🌍';
      const mockTokens = [1, 2, 3, 4, 5, 6];
      mockEncode.mockReturnValue(mockTokens);

      const result = await tokenizer.calculateTokens(unicodeText);

      expect(result).toBe(6);
    });

    it('should use custom encoding when specified', async () => {
      tokenizer = new TextTokenizer('gpt2');
      const testText = 'Hello, world!';
      const mockTokens = [1, 2, 3];
      mockEncode.mockReturnValue(mockTokens);

      const result = await tokenizer.calculateTokens(testText);

      expect(mockGetEncoding).toHaveBeenCalledWith('gpt2');
      expect(result).toBe(3);
    });
  });

  describe('calculateTokensBatch', () => {
    beforeEach(() => {
      tokenizer = new TextTokenizer();
    });

    it('should process multiple texts and return token counts', async () => {
      const texts = ['Hello', 'world', 'test'];
      mockEncode
        .mockReturnValueOnce([1, 2]) // 2 tokens for 'Hello'
        .mockReturnValueOnce([3, 4, 5]) // 3 tokens for 'world'
        .mockReturnValueOnce([6]); // 1 token for 'test'

      const result = await tokenizer.calculateTokensBatch(texts);

      expect(result).toEqual([2, 3, 1]);
      expect(mockEncode).toHaveBeenCalledTimes(3);
    });

    it('should handle empty array', async () => {
      const result = await tokenizer.calculateTokensBatch([]);
      expect(result).toEqual([]);
    });

    it('should handle array with empty strings', async () => {
      const texts = ['', 'hello', ''];
      mockEncode.mockReturnValue([1, 2, 3]); // Only called for 'hello'

      const result = await tokenizer.calculateTokensBatch(texts);

      expect(result).toEqual([0, 3, 0]);
      expect(mockEncode).toHaveBeenCalledTimes(1);
      expect(mockEncode).toHaveBeenCalledWith('hello');
    });

    it('should use fallback calculation when tiktoken fails to load', async () => {
      mockGetEncoding.mockImplementation(() => {
        throw new Error('Failed to load tiktoken');
      });

      const texts = ['Hello', 'world']; // 5 and 5 characters
      const result = await tokenizer.calculateTokensBatch(texts);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Failed to load tiktoken with encoding cl100k_base:',
        expect.any(Error),
      );
      // Fallback: Math.ceil(5/4) = 2 for both
      expect(result).toEqual([2, 2]);
    });

    it('should use fallback calculation when encoding fails during batch processing', async () => {
      mockEncode.mockImplementation(() => {
        throw new Error('Encoding failed');
      });

      const texts = ['Hello', 'world']; // 5 and 5 characters
      const result = await tokenizer.calculateTokensBatch(texts);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Error encoding texts with tiktoken:',
        expect.any(Error),
      );
      // Fallback: Math.ceil(5/4) = 2 for both
      expect(result).toEqual([2, 2]);
    });

    it('should handle null and undefined values in batch', async () => {
      const texts = [null, 'hello', undefined, 'world'] as unknown as string[];
      mockEncode
        .mockReturnValueOnce([1, 2, 3]) // 3 tokens for 'hello'
        .mockReturnValueOnce([4, 5]); // 2 tokens for 'world'

      const result = await tokenizer.calculateTokensBatch(texts);

      expect(result).toEqual([0, 3, 0, 2]);
    });
  });

  describe('dispose', () => {
    beforeEach(() => {
      tokenizer = new TextTokenizer();
    });

    it('should free tiktoken encoding when disposing', async () => {
      // Initialize the encoding by calling calculateTokens
      await tokenizer.calculateTokens('test');

      tokenizer.dispose();

      expect(mockFree).toHaveBeenCalled();
    });

    it('should handle disposal when encoding is not initialized', () => {
      expect(() => tokenizer.dispose()).not.toThrow();
      expect(mockFree).not.toHaveBeenCalled();
    });

    it('should handle disposal when encoding is null', async () => {
      // Force encoding to be null by making tiktoken fail
      mockGetEncoding.mockImplementation(() => {
        throw new Error('Failed to load');
      });

      await tokenizer.calculateTokens('test');

      expect(() => tokenizer.dispose()).not.toThrow();
      expect(mockFree).not.toHaveBeenCalled();
    });

    it('should handle errors during disposal gracefully', async () => {
      await tokenizer.calculateTokens('test');

      mockFree.mockImplementation(() => {
        throw new Error('Free failed');
      });

      tokenizer.dispose();

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Error freeing tiktoken encoding:',
        expect.any(Error),
      );
    });

    it('should allow multiple calls to dispose', async () => {
      await tokenizer.calculateTokens('test');

      tokenizer.dispose();
      tokenizer.dispose(); // Second call should not throw

      expect(mockFree).toHaveBeenCalledTimes(1);
    });
  });

  describe('lazy initialization', () => {
    beforeEach(() => {
      tokenizer = new TextTokenizer();
    });

    it('should not initialize tiktoken until first use', () => {
      expect(mockGetEncoding).not.toHaveBeenCalled();
    });

    it('should initialize tiktoken on first calculateTokens call', async () => {
      await tokenizer.calculateTokens('test');
      expect(mockGetEncoding).toHaveBeenCalledTimes(1);
    });

    it('should not reinitialize tiktoken on subsequent calls', async () => {
      await tokenizer.calculateTokens('test1');
      await tokenizer.calculateTokens('test2');

      expect(mockGetEncoding).toHaveBeenCalledTimes(1);
    });

    it('should initialize tiktoken on first calculateTokensBatch call', async () => {
      await tokenizer.calculateTokensBatch(['test']);
      expect(mockGetEncoding).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      tokenizer = new TextTokenizer();
    });

    it('should handle very short text', async () => {
      const result = await tokenizer.calculateTokens('a');

      if (mockGetEncoding.mock.calls.length > 0) {
        // If tiktoken was called, use its result
        expect(mockEncode).toHaveBeenCalledWith('a');
      } else {
        // If tiktoken failed, should use fallback: Math.ceil(1/4) = 1
        expect(result).toBe(1);
      }
    });

    it('should handle text with only whitespace', async () => {
      const whitespaceText = '   \n\t  ';
      const mockTokens = [1];
      mockEncode.mockReturnValue(mockTokens);

      const result = await tokenizer.calculateTokens(whitespaceText);

      expect(result).toBe(1);
    });

    it('should handle special characters and symbols', async () => {
      const specialText = '!@#$%^&*()_+-=[]{}|;:,.<>?';
      const mockTokens = new Array(10);
      mockEncode.mockReturnValue(mockTokens);

      const result = await tokenizer.calculateTokens(specialText);

      expect(result).toBe(10);
    });
  });
});
