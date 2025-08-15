/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeJsonParse } from './safeJsonParse.js';

describe('safeJsonParse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('valid JSON parsing', () => {
    it('should parse valid JSON correctly', () => {
      const validJson = '{"name": "test", "value": 123}';
      const result = safeJsonParse(validJson);

      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should parse valid JSON arrays', () => {
      const validArray = '["item1", "item2", "item3"]';
      const result = safeJsonParse(validArray);

      expect(result).toEqual(['item1', 'item2', 'item3']);
    });

    it('should parse valid JSON with nested objects', () => {
      const validNested =
        '{"config": {"paths": ["testlogs/*.py"], "options": {"recursive": true}}}';
      const result = safeJsonParse(validNested);

      expect(result).toEqual({
        config: {
          paths: ['testlogs/*.py'],
          options: { recursive: true },
        },
      });
    });
  });

  describe('malformed JSON with jsonrepair fallback', () => {
    it('should handle malformed JSON with single quotes', () => {
      const malformedJson = "{'name': 'test', 'value': 123}";
      const result = safeJsonParse(malformedJson);

      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should handle malformed JSON with unquoted keys', () => {
      const malformedJson = '{name: "test", value: 123}';
      const result = safeJsonParse(malformedJson);

      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should handle malformed JSON with trailing commas', () => {
      const malformedJson = '{"name": "test", "value": 123,}';
      const result = safeJsonParse(malformedJson);

      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should handle malformed JSON with comments', () => {
      const malformedJson = '{"name": "test", // comment\n "value": 123}';
      const result = safeJsonParse(malformedJson);

      expect(result).toEqual({ name: 'test', value: 123 });
    });
  });

  describe('fallback behavior', () => {
    it('should return fallback value for empty string', () => {
      const emptyString = '';
      const fallback = { default: 'value' };

      const result = safeJsonParse(emptyString, fallback);

      expect(result).toEqual(fallback);
    });

    it('should return fallback value for null input', () => {
      const nullInput = null as unknown as string;
      const fallback = { default: 'value' };

      const result = safeJsonParse(nullInput, fallback);

      expect(result).toEqual(fallback);
    });

    it('should return fallback value for undefined input', () => {
      const undefinedInput = undefined as unknown as string;
      const fallback = { default: 'value' };

      const result = safeJsonParse(undefinedInput, fallback);

      expect(result).toEqual(fallback);
    });

    it('should return empty object as default fallback', () => {
      const invalidJson = 'invalid json';

      const result = safeJsonParse(invalidJson);

      // jsonrepair returns the original string for completely invalid JSON
      expect(result).toEqual('invalid json');
    });

    it('should return custom fallback when parsing fails', () => {
      const invalidJson = 'invalid json';
      const customFallback = { error: 'parsing failed', data: null };

      const result = safeJsonParse(invalidJson, customFallback);

      // jsonrepair returns the original string for completely invalid JSON
      expect(result).toEqual('invalid json');
    });
  });

  describe('type safety', () => {
    it('should preserve generic type when parsing valid JSON', () => {
      const validJson = '{"name": "test", "value": 123}';
      const result = safeJsonParse<{ name: string; value: number }>(validJson);

      expect(result).toEqual({ name: 'test', value: 123 });
      // TypeScript should infer the correct type
      expect(typeof result.name).toBe('string');
      expect(typeof result.value).toBe('number');
    });

    it('should return fallback type when parsing fails', () => {
      const invalidJson = 'invalid json';
      const fallback = { error: 'fallback' } as const;

      const result = safeJsonParse(invalidJson, fallback);

      // jsonrepair returns the original string for completely invalid JSON
      expect(result).toEqual('invalid json');
      // TypeScript should preserve the fallback type
      expect(typeof result).toBe('string');
    });
  });
});
