/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractJsonStringField,
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
  readLastJsonStringFieldSync,
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

  describe('readLastJsonStringFieldSync', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-readlast-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeFile(name: string, content: string): string {
      const p = path.join(tmpDir, name);
      fs.writeFileSync(p, content);
      return p;
    }

    it('returns undefined for a missing file', () => {
      const p = path.join(tmpDir, 'does-not-exist.jsonl');
      expect(
        readLastJsonStringFieldSync(p, 'customTitle', 'custom_title'),
      ).toBeUndefined();
    });

    it('returns undefined for an empty file', () => {
      const p = writeFile('empty.jsonl', '');
      expect(
        readLastJsonStringFieldSync(p, 'customTitle', 'custom_title'),
      ).toBeUndefined();
    });

    it('returns the only match for a small file', () => {
      const p = writeFile(
        'small.jsonl',
        '{"type":"user"}\n{"subtype":"custom_title","customTitle":"only"}\n',
      );
      expect(
        readLastJsonStringFieldSync(p, 'customTitle', 'custom_title'),
      ).toBe('only');
    });

    it('returns the last match when the tail contains the field', () => {
      const p = writeFile(
        'tail-hit.jsonl',
        [
          '{"subtype":"custom_title","customTitle":"old"}',
          '{"subtype":"custom_title","customTitle":"new"}',
          '',
        ].join('\n'),
      );
      expect(
        readLastJsonStringFieldSync(p, 'customTitle', 'custom_title'),
      ).toBe('new');
    });

    it('falls back to full-file scan when tail has no match (Phase 2)', () => {
      // Build a file whose custom_title record is near the start, followed by
      // enough filler bytes (> LITE_READ_BUF_SIZE) that the tail window is
      // entirely filler. The old head+tail reader would have hit this via the
      // head window; this test verifies the new tail-first + full-scan
      // strategy still resolves it.
      const titleLine =
        '{"subtype":"custom_title","customTitle":"buried-in-middle"}';
      const filler = '{"type":"user","message":"' + 'x'.repeat(256) + '"}';
      // ~4x the tail window, guaranteed to push the title line out of tail.
      const fillerCount = Math.ceil((LITE_READ_BUF_SIZE * 4) / filler.length);
      const content =
        titleLine +
        '\n' +
        Array.from({ length: fillerCount }, () => filler).join('\n') +
        '\n';

      const p = writeFile('phase2.jsonl', content);
      expect(fs.statSync(p).size).toBeGreaterThan(LITE_READ_BUF_SIZE * 3);

      expect(
        readLastJsonStringFieldSync(p, 'customTitle', 'custom_title'),
      ).toBe('buried-in-middle');
    });

    it('returns the last occurrence even when multiple land in the full-scan region', () => {
      const early = '{"subtype":"custom_title","customTitle":"first-rename"}';
      const middle = '{"subtype":"custom_title","customTitle":"second-rename"}';
      const filler = '{"type":"user","message":"' + 'x'.repeat(256) + '"}';
      const fillerCount = Math.ceil((LITE_READ_BUF_SIZE * 3) / filler.length);

      const content =
        early +
        '\n' +
        middle +
        '\n' +
        Array.from({ length: fillerCount }, () => filler).join('\n') +
        '\n';

      const p = writeFile('phase2-multi.jsonl', content);
      expect(
        readLastJsonStringFieldSync(p, 'customTitle', 'custom_title'),
      ).toBe('second-rename');
    });

    it('respects the lineContains filter when scanning', () => {
      const p = writeFile(
        'filter.jsonl',
        [
          '{"type":"user","customTitle":"spoofed-in-user-content"}',
          '{"subtype":"custom_title","customTitle":"legit"}',
          '',
        ].join('\n'),
      );
      expect(
        readLastJsonStringFieldSync(p, 'customTitle', 'custom_title'),
      ).toBe('legit');
    });

    it('returns undefined when neither phase finds the field', () => {
      const line = '{"type":"user","message":"' + 'x'.repeat(512) + '"}';
      const lineCount = Math.ceil((LITE_READ_BUF_SIZE * 3) / line.length);
      const content =
        Array.from({ length: lineCount }, () => line).join('\n') + '\n';
      const p = writeFile('no-title.jsonl', content);

      expect(
        readLastJsonStringFieldSync(p, 'customTitle', 'custom_title'),
      ).toBeUndefined();
    });

    it('handles a final line without a trailing newline', () => {
      const p = writeFile(
        'no-trailing-newline.jsonl',
        '{"type":"user"}\n{"subtype":"custom_title","customTitle":"last"}',
      );
      expect(
        readLastJsonStringFieldSync(p, 'customTitle', 'custom_title'),
      ).toBe('last');
    });
  });
});
