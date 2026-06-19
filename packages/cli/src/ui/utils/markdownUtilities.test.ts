/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { findLastSafeSplitPoint } from './markdownUtilities.js';

describe('markdownUtilities', () => {
  describe('findLastSafeSplitPoint', () => {
    it('should split at the last double newline if not in a code block', () => {
      const content = 'paragraph1\n\nparagraph2\n\nparagraph3';
      expect(findLastSafeSplitPoint(content)).toBe(24); // After the second \n\n
    });

    it('should return content.length if no safe split point is found', () => {
      const content = 'longstringwithoutanysafesplitpoint';
      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });

    it('should prioritize splitting at \n\n over being at the very end of the string if the end is not in a code block', () => {
      const content = 'Some text here.\n\nAnd more text here.';
      expect(findLastSafeSplitPoint(content)).toBe(17); // after the \n\n
    });

    it('should return content.length if the only \n\n is inside a code block and the end of content is not', () => {
      const content = '```\nignore this\n\nnewline\n```KeepThis';
      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });

    it('should correctly identify the last \n\n even if it is followed by text not in a code block', () => {
      const content =
        'First part.\n\nSecond part.\n\nThird part, then some more text.';
      // Split should be after "Second part.\n\n"
      // "First part.\n\n" is 13 chars. "Second part.\n\n" is 14 chars. Total 27.
      expect(findLastSafeSplitPoint(content)).toBe(27);
    });

    it('should return content.length if content is empty', () => {
      const content = '';
      expect(findLastSafeSplitPoint(content)).toBe(0);
    });

    it('should return content.length if content has no newlines and no code blocks', () => {
      const content = 'Single line of text';
      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });

    it('should hard split a long single line when a max length is provided', () => {
      const content = 'a'.repeat(100);
      expect(findLastSafeSplitPoint(content, 40)).toBe(40);
    });

    it('should prefer a safe newline before the max length', () => {
      const content = 'first line\nsecond line\nthird line';
      expect(findLastSafeSplitPoint(content, 18)).toBe(11);
    });

    it('should not split past the max length for a boundary newline', () => {
      const content = `${'a'.repeat(40)}\n\nrest`;
      expect(findLastSafeSplitPoint(content, 40)).toBe(40);
    });

    it('should preserve an opening code block when possible with a max length', () => {
      const content = 'intro\n\n```ts\nconst value = 1;\n';
      expect(findLastSafeSplitPoint(content, 20)).toBe(7);
    });

    it('should hard split an oversized leading code block with a max length', () => {
      const content = '```ts\n' + 'a'.repeat(100);
      expect(findLastSafeSplitPoint(content, 40)).toBe(40);
    });
  });
});
