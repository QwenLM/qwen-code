/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { CODE_FENCE_RE } from './pending-rendered-height.js';
import {
  findLastSafeSplitPoint,
  splitFencedMarkdown,
  parseCodeFenceInfo,
  getEnclosingFenceInfo,
} from './markdown-utilities.js';

describe('markdown-utilities', () => {
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

    it.each([200, 2000])(
      'scans fences once when rejecting %s internal blank lines',
      (records) => {
        const fenced = `\`\`\`csv\n${'x\n\n'.repeat(records)}\`\`\`\n`;
        const content = fenced + 'a'.repeat(16500 - fenced.length);
        const scan = vi.spyOn(CODE_FENCE_RE, 'exec');
        try {
          expect(findLastSafeSplitPoint(content, 16384)).toBe(fenced.length);
          expect(scan.mock.calls.length).toBeLessThanOrEqual(4);
        } finally {
          scan.mockRestore();
        }
      },
    );

    it('visits each fence once across many closed blocks', () => {
      const blocks = 1000;
      const fenced = '```csv\nx\n\n```\n'.repeat(blocks);
      const content = fenced + 'a'.repeat(100);
      const scan = vi.spyOn(CODE_FENCE_RE, 'exec');
      try {
        expect(findLastSafeSplitPoint(content, fenced.length + 10)).toBe(
          fenced.length,
        );
        expect(scan.mock.calls.length).toBeLessThanOrEqual(blocks * 2);
      } finally {
        scan.mockRestore();
      }
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
      // The block holds a single content line and the split lands inside it,
      // so the tail is the remainder of line 1 and its gutter must still say
      // 1. This previously read `start-line=2`, counting the unfinished line
      // as though it had been completed in the head.
      expect(after).toBe('```ts qwen-code:start-line=1\n' + content.slice(40));
    });

    it('keeps the tail on the same source line when split mid-line', () => {
      const content = '```js\naaa\nbbb\nccc\n```';
      // Lands inside `bbb`: the head ends `bb`, the tail begins `b`.
      const { before, after } = splitFencedMarkdown(content, 12);

      expect(before).toBe('```js\naaa\nbb\n```\n');
      expect(after).toBe('```js qwen-code:start-line=2\nb\nccc\n```');
    });

    // Guards against over-correcting. Splits that land on a line boundary were
    // already right and must stay put; these pass before and after.
    it.each([
      [6, 1],
      [10, 2],
      [14, 3],
      [18, 4],
    ])(
      'splitting at %d (a line boundary) starts the tail at line %d',
      (splitPoint, expectedStartLine) => {
        const content = '```js\naaa\nbbb\nccc\n```';
        const { after } = splitFencedMarkdown(content, splitPoint);
        expect(
          after.startsWith(
            `\`\`\`js qwen-code:start-line=${expectedStartLine}\n`,
          ),
        ).toBe(true);
      },
    );

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

    it('handles a language-less fence without a stray leading space', () => {
      const content = '```\nline1\nline2\nline3\n';
      const splitPoint = content.indexOf('line3');
      const { before, after } = splitFencedMarkdown(content, splitPoint);
      // Head closes with a bare fence; tail re-opens with the directive only,
      // no language and no leading space.
      expect(before).toBe('```\nline1\nline2\n```\n');
      expect(after).toBe('```qwen-code:start-line=3\nline3\n');
      expect(after).toMatch(/^```qwen-code:start-line=\d+\n/);
      // The directive still parses back to no language and the right start line.
      expect(parseCodeFenceInfo('qwen-code:start-line=3')).toEqual({
        lang: null,
        startLine: 3,
      });
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

  describe('getEnclosingFenceInfo', () => {
    it('returns null when the index is not inside a fence', () => {
      const content = 'plain intro\n\n```ts\ncode\n```\n\nafter';
      expect(getEnclosingFenceInfo(content, 3)).toBeNull(); // in the intro
      expect(getEnclosingFenceInfo(content, content.length - 2)).toBeNull(); // after the closed block
    });

    it('reports the language and start line of the enclosing code block', () => {
      const content = '```python\nline1\nline2\n';
      const idx = content.indexOf('line2');
      expect(getEnclosingFenceInfo(content, idx)).toEqual({
        lang: 'python',
        startLine: 1,
      });
    });

    it('surfaces the mermaid language so the caller can keep the block whole', () => {
      const content = '```mermaid\ngraph TD\nA-->B\n';
      const idx = content.indexOf('A-->B');
      expect(getEnclosingFenceInfo(content, idx)?.lang).toBe('mermaid');
    });

    it('carries the accumulated start-line directive from a re-opened fence', () => {
      const content = '```ts qwen-code:start-line=7\nline7\nline8\n';
      const idx = content.indexOf('line8');
      expect(getEnclosingFenceInfo(content, idx)).toEqual({
        lang: 'ts',
        startLine: 7,
      });
    });
  });

  describe('fence recognition', () => {
    it.each([
      ['~~~', '```'],
      ['```', '~~~'],
    ])('keeps %s open across an inner %s line', (outer, inner) => {
      const opening = `${outer}md\nHere:\n${inner}\n`;
      const pending = `${opening}still inside\n`;
      const content = `${pending}${outer}\nAfter.\n`;
      const splitPoint = content.indexOf('still');

      for (const text of [pending, content]) {
        expect(getEnclosingFenceInfo(text, splitPoint)).toEqual({
          lang: 'md',
          startLine: 1,
        });
        expect(findLastSafeSplitPoint(text, splitPoint)).toBe(splitPoint);
        expect(splitFencedMarkdown(text, splitPoint)).toEqual({
          before: `${opening}${outer}\n`,
          after: `${outer}md qwen-code:start-line=3\n${text.slice(splitPoint)}`,
        });
      }
      expect(
        getEnclosingFenceInfo(content, content.indexOf('After')),
      ).toBeNull();
    });

    it('advances past a fence info string containing the other fence marker', () => {
      const content = '``` ~~~\ncode\n```\nAfter';
      expect(getEnclosingFenceInfo(content, content.indexOf('code'))).toEqual({
        lang: '~~~',
        startLine: 1,
      });
      expect(
        getEnclosingFenceInfo(content, content.indexOf('After')),
      ).toBeNull();
    });

    it.each([
      ['~~~', 'Use `~~~` as the fence marker.'],
      ['```', 'Use ``` as the fence marker.'],
    ])('keeps an inline %s marker in ordinary prose', (_marker, intro) => {
      const content = `${intro}\nMore ordinary prose follows.`;
      const splitPoint = content.indexOf('More');

      expect(getEnclosingFenceInfo(content, splitPoint)).toBeNull();
      expect(findLastSafeSplitPoint(content, splitPoint + 8)).toBe(splitPoint);
      expect(splitFencedMarkdown(content, splitPoint)).toEqual({
        before: `${intro}\n`,
        after: 'More ordinary prose follows.',
      });
    });

    it.each(['```ts`invalid', '~~~ts`invalid'])(
      'rejects an opening fence with a backtick in its info string: %s',
      (opening) => {
        const content = `${opening}\nMore ordinary prose follows.`;
        const splitPoint = content.indexOf('More');

        expect(getEnclosingFenceInfo(content, splitPoint)).toBeNull();
        expect(findLastSafeSplitPoint(content, splitPoint + 8)).toBe(
          splitPoint,
        );
        expect(splitFencedMarkdown(content, splitPoint)).toEqual({
          before: `${opening}\n`,
          after: 'More ordinary prose follows.',
        });
      },
    );

    it.each(['````', '~~~~'])(
      'recognizes an indented %s fence after ordinary prose',
      (delimiter) => {
        const intro = 'Use `~~~` as the fence marker.\n';
        const content = `${intro}  ${delimiter}ts\nline1\nline2\n  ${delimiter}\n\nAfter prose.`;
        const splitPoint = content.indexOf('line2');
        const afterBlock = content.indexOf('After');

        expect(getEnclosingFenceInfo(content, splitPoint)).toEqual({
          lang: 'ts',
          startLine: 1,
        });
        expect(findLastSafeSplitPoint(content, splitPoint)).toBe(
          intro.length + 2,
        );
        expect(splitFencedMarkdown(content, splitPoint)).toEqual({
          before: `${intro}  ${delimiter}ts\nline1\n${delimiter}\n`,
          after: `${delimiter}ts qwen-code:start-line=2\nline2\n  ${delimiter}\n\nAfter prose.`,
        });
        expect(getEnclosingFenceInfo(content, afterBlock)).toBeNull();
        expect(findLastSafeSplitPoint(content, afterBlock + 3)).toBe(
          afterBlock,
        );
      },
    );
  });
});
