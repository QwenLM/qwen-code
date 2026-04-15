/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  extractJsonStringField,
  extractLastJsonStringField,
  unescapeJsonString,
} from './sessionStorageUtils.js';

describe('sessionStorageUtils', () => {
  describe('unescapeJsonString', () => {
    it('should return string as-is when no escapes', () => {
      expect(unescapeJsonString('hello world')).toBe('hello world');
    });

    it('should unescape JSON escape sequences', () => {
      expect(unescapeJsonString('hello\\nworld')).toBe('hello\nworld');
      expect(unescapeJsonString('tab\\there')).toBe('tab\there');
      expect(unescapeJsonString('quote\\"here')).toBe('quote"here');
    });

    it('should handle backslash', () => {
      expect(unescapeJsonString('path\\\\to\\\\file')).toBe('path\\to\\file');
    });
  });

  describe('extractJsonStringField', () => {
    it('should extract field without space after colon', () => {
      const text = '{"customTitle":"my-feature"}';
      expect(extractJsonStringField(text, 'customTitle')).toBe('my-feature');
    });

    it('should extract field with space after colon', () => {
      const text = '{"customTitle": "my-feature"}';
      expect(extractJsonStringField(text, 'customTitle')).toBe('my-feature');
    });

    it('should return first match', () => {
      const text = '{"customTitle":"first"}\n{"customTitle":"second"}';
      expect(extractJsonStringField(text, 'customTitle')).toBe('first');
    });

    it('should return undefined when field not found', () => {
      const text = '{"type":"user","message":"hello"}';
      expect(extractJsonStringField(text, 'customTitle')).toBeUndefined();
    });

    it('should handle escaped characters in value', () => {
      const text = '{"customTitle":"hello\\nworld"}';
      expect(extractJsonStringField(text, 'customTitle')).toBe('hello\nworld');
    });

    it('should handle escaped quotes in value', () => {
      const text = '{"customTitle":"say \\"hi\\""}';
      expect(extractJsonStringField(text, 'customTitle')).toBe('say "hi"');
    });

    it('should work on truncated/partial lines', () => {
      // Simulates reading from middle of a file where first line is cut
      const text = 'tle":"partial"}\n{"customTitle":"complete"}';
      expect(extractJsonStringField(text, 'customTitle')).toBe('complete');
    });
  });

  describe('extractLastJsonStringField', () => {
    it('should return last occurrence', () => {
      const text = '{"customTitle":"old-name"}\n{"customTitle":"new-name"}';
      expect(extractLastJsonStringField(text, 'customTitle')).toBe('new-name');
    });

    it('should handle single occurrence', () => {
      const text = '{"customTitle":"only-one"}';
      expect(extractLastJsonStringField(text, 'customTitle')).toBe('only-one');
    });

    it('should return undefined when not found', () => {
      const text = '{"type":"user"}';
      expect(extractLastJsonStringField(text, 'customTitle')).toBeUndefined();
    });

    it('should handle mixed spacing styles', () => {
      const text = '{"customTitle":"no-space"}\n{"customTitle": "with-space"}';
      expect(extractLastJsonStringField(text, 'customTitle')).toBe(
        'with-space',
      );
    });

    it('should return globally last match when mixed patterns interleave', () => {
      // Bug fix: previously returned "middle" because the second pattern
      // ("key": "value") scan overwrote the result from the first pattern.
      const text =
        '{"customTitle":"old"}\n{"customTitle": "middle"}\n{"customTitle":"newest"}';
      expect(extractLastJsonStringField(text, 'customTitle')).toBe('newest');
    });

    it('should filter by lineContains when provided', () => {
      const text = [
        '{"type":"user","content":"I set customTitle to \\"customTitle\\":\\"fake\\""}',
        '{"subtype":"custom_title","customTitle":"real-title"}',
      ].join('\n');
      expect(
        extractLastJsonStringField(text, 'customTitle', 'custom_title'),
      ).toBe('real-title');
    });

    it('should ignore matches on lines without lineContains marker', () => {
      const text =
        '{"role":"assistant","customTitle":"spoofed"}\n{"subtype":"custom_title","customTitle":"legit"}';
      expect(
        extractLastJsonStringField(text, 'customTitle', 'custom_title'),
      ).toBe('legit');
    });

    it('should return undefined when lineContains excludes all matches', () => {
      const text = '{"customTitle":"no-subtype-here"}';
      expect(
        extractLastJsonStringField(text, 'customTitle', 'custom_title'),
      ).toBeUndefined();
    });

    it('should not confuse different field names', () => {
      const text = '{"otherField":"other-value"}\n{"customTitle":"user-name"}';
      expect(extractLastJsonStringField(text, 'customTitle')).toBe('user-name');
      expect(extractLastJsonStringField(text, 'otherField')).toBe(
        'other-value',
      );
    });

    it('should handle many occurrences', () => {
      const lines = Array.from(
        { length: 10 },
        (_, i) => `{"customTitle":"title-${i}"}`,
      ).join('\n');
      expect(extractLastJsonStringField(lines, 'customTitle')).toBe('title-9');
    });
  });

  describe('head+tail priority resolution', () => {
    it('should prefer tail customTitle over head customTitle', () => {
      const head = '{"customTitle":"head-title"}';
      const tail = '{"customTitle":"tail-title"}';

      const resolved =
        extractLastJsonStringField(tail, 'customTitle') ??
        extractLastJsonStringField(head, 'customTitle');

      expect(resolved).toBe('tail-title');
    });

    it('should fall back to head customTitle when not in tail', () => {
      const head = '{"customTitle":"head-title"}';
      const tail = '{"type":"user","message":"hello"}';

      const resolved =
        extractLastJsonStringField(tail, 'customTitle') ??
        extractLastJsonStringField(head, 'customTitle');

      expect(resolved).toBe('head-title');
    });

    it('should return undefined when no customTitle in head or tail', () => {
      const head = '{"type":"user"}';
      const tail = '{"type":"assistant"}';

      const resolved =
        extractLastJsonStringField(tail, 'customTitle') ??
        extractLastJsonStringField(head, 'customTitle');

      expect(resolved).toBeUndefined();
    });
  });
});
