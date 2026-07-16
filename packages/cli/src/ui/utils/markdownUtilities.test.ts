/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  findLastSafeSplitPoint,
  splitFencedMarkdown,
  parseCodeFenceInfo,
} from './markdownUtilities.js';

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

    it('should not split at a \n\n inside a tilde (~~~) fenced code block', () => {
      // Same as the backtick case but with ~~~ fences: the internal blank line
      // must not be chosen as a split point.
      const content = '~~~\nignore this\n\nnewline\n~~~KeepThis';
      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });

    it('should not split inside a 4+ backtick fenced block (no phantom fence)', () => {
      // A 6-backtick fence must count as ONE delimiter. Matching only the first
      // three characters would produce a phantom close-then-reopen, mark the
      // internal blank line as outside the block, and split there.
      const content = '``````\nignore this\n\nnewline\n``````KeepThis';
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

  describe('splitFencedMarkdown', () => {
    it('splits plainly when the point is not inside a code block', () => {
      const content = 'Intro paragraph.\n\nSecond paragraph.';
      const splitPoint = 18; // start of "Second paragraph."
      const { before, after } = splitFencedMarkdown(content, splitPoint);
      expect(before).toBe(content.slice(0, splitPoint));
      expect(after).toBe(content.slice(splitPoint));
    });

    it('closes the head fence and re-opens it on the tail when split inside a fence', () => {
      const content = '```python\nline1\nline2\n\nline3\nline4\n';
      const splitPoint = content.indexOf('line3'); // inside the still-open fence
      const { before, after } = splitFencedMarkdown(content, splitPoint);
      // Head shows line1,line2,blank (3 lines), so the tail continues at line 4.
      expect(before).toBe('```python\nline1\nline2\n\n```\n');
      expect(after).toBe('```python qwen-code:start-line=4\nline3\nline4\n');
      // Each half is now a self-contained, valid fenced block.
      expect(before.match(/```/g)).toHaveLength(2);
      expect(after.startsWith('```python ')).toBe(true);
      // The directive parses back to the right language and start line.
      expect(parseCodeFenceInfo('python qwen-code:start-line=4')).toEqual({
        lang: 'python',
        startLine: 4,
      });
    });

    it('preserves the exact delimiter run and info string', () => {
      const content = '~~~~ts extra\naaaa\nbbbb\n';
      const splitPoint = content.indexOf('bbbb');
      const { before, after } = splitFencedMarkdown(content, splitPoint);
      expect(before.endsWith('~~~~\n')).toBe(true); // closing carries no info string
      // Re-open keeps the delimiter run and full info string, plus the directive.
      expect(after.startsWith('~~~~ts extra qwen-code:start-line=2\n')).toBe(
        true,
      );
    });

    it('inserts a newline before the closing fence when the head does not end with one', () => {
      const content = '```ts\n' + 'a'.repeat(100);
      const splitPoint = 40; // mid-line hard split inside the fence
      const { before, after } = splitFencedMarkdown(content, splitPoint);
      expect(before).toBe(content.slice(0, 40) + '\n```\n');
      expect(after).toBe('```ts qwen-code:start-line=2\n' + content.slice(40));
    });

    it('accumulates the start line when a re-opened tail is split again', () => {
      // Simulate the tail produced by a prior split (already carries a directive).
      const tail =
        '```python qwen-code:start-line=4\nline4\nline5\n\nline6\nline7\n';
      const splitPoint = tail.indexOf('line6');
      const { after } = splitFencedMarkdown(tail, splitPoint);
      // Head of this tail shows line4,line5,blank (3 lines) from start 4 → next 7.
      expect(after.startsWith('```python qwen-code:start-line=7\n')).toBe(true);
      // No duplicated directive on the re-opened fence.
      expect(after.match(/qwen-code:start-line=/g)).toHaveLength(1);
    });

    it('does not touch a split that closes exactly at the fence boundary', () => {
      // Point sits right after a fully closed block → not inside a fence.
      const content = '```ts\ncode\n```\n\nprose after';
      const splitPoint = content.indexOf('prose after');
      const { before, after } = splitFencedMarkdown(content, splitPoint);
      expect(before).toBe(content.slice(0, splitPoint));
      expect(after).toBe(content.slice(splitPoint));
    });

    it('returns the whole content unchanged at the string boundaries', () => {
      const content = '```ts\ncode';
      expect(splitFencedMarkdown(content, 0)).toEqual({
        before: '',
        after: content,
      });
      expect(splitFencedMarkdown(content, content.length)).toEqual({
        before: content,
        after: '',
      });
    });
  });

  describe('parseCodeFenceInfo', () => {
    it('parses a plain language with no directive as start line 1', () => {
      expect(parseCodeFenceInfo('python')).toEqual({
        lang: 'python',
        startLine: 1,
      });
    });

    it('extracts the start line and strips the directive from the language', () => {
      expect(parseCodeFenceInfo('ts qwen-code:start-line=17')).toEqual({
        lang: 'ts',
        startLine: 17,
      });
    });

    it('handles a language-less fence that only carries the directive', () => {
      expect(parseCodeFenceInfo('qwen-code:start-line=5')).toEqual({
        lang: null,
        startLine: 5,
      });
    });

    it('returns null language and start line 1 for empty/undefined info', () => {
      expect(parseCodeFenceInfo('')).toEqual({ lang: null, startLine: 1 });
      expect(parseCodeFenceInfo(undefined)).toEqual({
        lang: null,
        startLine: 1,
      });
    });
  });
});
