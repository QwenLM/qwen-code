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

    describe('preventive single-`\\n` split (narrow terminals)', () => {
      it('should split at the last safe \\n when the terminal is narrow', () => {
        // Narrow terminal (width 40 < 80). Buffer has several lines but no
        // \n\n. The preventive rule should split at the last single \n so
        // only the current partial stays pending.
        const content = 'line1\nline2\nline3\npartial in progress';
        const splitPoint = findLastSafeSplitPoint(content, {
          terminalWidth: 40,
          terminalHeight: 30,
        });
        expect(splitPoint).toBe('line1\nline2\nline3\n'.length);
      });

      it('should split even for a two-line buffer at narrow widths', () => {
        // Even tiny buffers must split so Ink never has to erase more than
        // one logical line in the pending region.
        const content = 'line1\nline2';
        const splitPoint = findLastSafeSplitPoint(content, {
          terminalWidth: 30,
          terminalHeight: 30,
        });
        expect(splitPoint).toBe('line1\n'.length);
      });

      it('should NOT split at narrow widths when buffer has no newline', () => {
        const content = 'a single in-flight partial with no newlines yet';
        const splitPoint = findLastSafeSplitPoint(content, {
          terminalWidth: 30,
          terminalHeight: 30,
        });
        expect(splitPoint).toBe(content.length);
      });

      it('should NOT split in a wide terminal when the pending buffer is still small', () => {
        const content = 'line1\nline2\npartial';
        const splitPoint = findLastSafeSplitPoint(content, {
          terminalWidth: 120,
          terminalHeight: 40,
        });
        expect(splitPoint).toBe(content.length);
      });

      it('should split in wide terminals once the pending buffer approaches half the viewport', () => {
        // 25 short lines at height=40 → 25 rendered rows > 40*0.5=20 budget.
        const content = Array.from({ length: 25 }, (_, i) => `l${i}`).join(
          '\n',
        );
        const splitPoint = findLastSafeSplitPoint(content, {
          terminalWidth: 120,
          terminalHeight: 40,
        });
        expect(splitPoint).toBeGreaterThan(0);
        expect(splitPoint).toBeLessThan(content.length);
        expect(content[splitPoint - 1]).toBe('\n');
      });

      it('should prefer \\n\\n over the preventive \\n fallback when both exist', () => {
        const content = 'para1\n\npara2 line1\npara2 line2\npartial';
        const splitPoint = findLastSafeSplitPoint(content, {
          terminalWidth: 30,
          terminalHeight: 30,
        });
        expect(splitPoint).toBe('para1\n\n'.length);
      });

      it('should skip newlines inside a fenced code block during the preventive fallback', () => {
        const content =
          'intro\n' +
          '```\ncode line 1\ncode line 2\ncode line 3\n```\n' +
          'tail';
        const splitPoint = findLastSafeSplitPoint(content, {
          terminalWidth: 30,
          terminalHeight: 30,
        });
        // The chosen split must not land inside the fences.
        const fenceOpen = content.indexOf('```');
        const fenceClose = content.indexOf('```', fenceOpen + 3);
        expect(splitPoint <= fenceOpen || splitPoint >= fenceClose + 3).toBe(
          true,
        );
      });

      it('should keep the original behaviour when viewport options are not provided', () => {
        const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join(
          '\n',
        );
        // No viewport options → no preventive fallback; still returns content.length
        // because there is no \n\n anywhere in the buffer.
        expect(findLastSafeSplitPoint(content)).toBe(content.length);
      });
    });
  });
});
