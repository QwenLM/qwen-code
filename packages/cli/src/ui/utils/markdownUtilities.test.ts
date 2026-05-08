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

    it('should split after a closed fenced code block once the trailing prose is still streaming', () => {
      const content =
        'Intro\n```ts\nconst value = 1;\n```\nTail text without paragraph break';
      expect(findLastSafeSplitPoint(content)).toBe(content.indexOf('Tail'));
    });

    it('should return content.length when a closed fenced code block ends the content', () => {
      const content = '```ts\nconst value = 1;\n```\n';
      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });

    it('should split after a completed table run once trailing prose is still streaming', () => {
      const content =
        '| Name | Value |\n| --- | --- |\n| Alpha | 1 |\nTail text without paragraph break';
      expect(findLastSafeSplitPoint(content)).toBe(content.indexOf('Tail'));
    });

    it('should not split a table header and separator while data rows are still streaming', () => {
      const content = '| Syntax | Description | Example |\n| --- | --- |';
      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });

    it('should not split an unterminated table run at streaming EOF', () => {
      const content = [
        '| Syntax | Description | Example |',
        '| --- | --- |',
        '| `sequenceDiagram` | Direction:',
      ].join('\n');

      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });

    it('should keep a table pending when the next row is only partially streamed', () => {
      const content = [
        '| Syntax | Description | Example |',
        '| --- | --- |',
        '| `flowchart TD` | Direction | `flowchart TD` |',
        '| `sequenceDiagram`',
      ].join('\n');

      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });

    it('should not treat pipe text without a separator row as a table boundary', () => {
      const content =
        'Use foo | bar in prose\nTail text without paragraph break';
      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });

    it('should split after a list segment before pending tail text', () => {
      const content =
        '- first item\n- second item\nTail text without paragraph break';
      expect(findLastSafeSplitPoint(content)).toBe(content.indexOf('Tail'));
    });

    it('should return 0 for an open code block that starts at the beginning', () => {
      const content = '```md\n- first item\n- second item\nTail text';
      expect(findLastSafeSplitPoint(content)).toBe(0);
    });

    it('should split before an unfinished fenced block when prose already stabilized', () => {
      const content = 'Intro paragraph.\n\n```mermaid\nflowchart TD\nA-->B';
      expect(findLastSafeSplitPoint(content)).toBe(
        content.indexOf('```mermaid'),
      );
    });

    it('should split before an unfinished table when prose already stabilized', () => {
      const content = [
        'Intro paragraph.',
        '',
        '| Syntax | Description |',
        '| --- | --- |',
        '| `flowchart TD` | Direction',
      ].join('\n');

      expect(findLastSafeSplitPoint(content)).toBe(content.indexOf('| Syntax'));
    });

    it('should not split a leading blank prefix into Static', () => {
      const content = '\n\nUseful text that is still streaming';
      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });

    it('should keep consecutive repeated structural rows out of Static while streaming', () => {
      const content = [
        '### 语法参考',
        '### 语法参考',
        '',
        '| 语法 | 说明 |',
        '| 语法 | 说明 |',
        'Tail text still streaming',
      ].join('\n');

      expect(findLastSafeSplitPoint(content)).toBe(content.length);
    });
  });
});
