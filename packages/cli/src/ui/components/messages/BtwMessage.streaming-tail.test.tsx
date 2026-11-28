/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Box } from 'ink';
import stripAnsi from 'strip-ansi';
import { renderWithProviders } from '../../../test-utils/render.js';
import { BtwMessage } from './BtwMessage.js';

// These tests live here instead of BtwMessage.test.tsx because that file
// mocks ink to render each Text color as literal `[#hex]` text, which Ink
// counts as visible width: long or highlighted code lines re-wrap and the
// measured rows no longer match the real renderer. Here the colors stay as
// (zero-width) ANSI escapes, so strip them before asserting on content.

/** Rows between the question line and the `Answering...` status line: the
 *  pending margin blank plus the answer's rendered rows. (The status `+` and
 *  `Answering...` are separate Text nodes, so anchor on `Answering...`.) */
const pendingAnswerRows = (frame: string): number => {
  const lines = frame.split('\n');
  const start = lines.findIndex((line) => line.includes('/btw'));
  const end = lines.findIndex((line) => line.includes('Answering...'));
  return end - start - 1;
};

// The highlighter splits code into colored spans, so ANSI escapes land
// inside words (`code-` + escape + `39`); strip them before matching text.
// Stripping never changes the line count, so row counts use the same frame.

describe('BtwMessage streaming tail', () => {
  it('bounds an open 40-line code fence to the row budget', () => {
    const answer = [
      '```ts',
      ...Array.from({ length: 40 }, (_, i) => `code-${i}`),
    ].join('\n');
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer, isPending: true }}
          containerWidth={60}
          maxAnswerRows={5}
        />
      </Box>,
    );

    const output = stripAnsi(lastFrame() ?? '');
    // The opener plus the last five code lines render 5 rows; the block is
    // never returned whole (41 rows).
    expect(output).toContain('code-39');
    expect(output).not.toContain('code-34');
    expect(pendingAnswerRows(output)).toBe(6);
  });

  it('charges an unclosed code block at the width of the block as it stands', () => {
    const answer = [
      'prose-0',
      'prose-1',
      'prose-2',
      '```ts',
      ...Array.from({ length: 11 }, (_, i) => `c-${i}`),
      'x'.repeat(105),
    ].join('\n');
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer, isPending: true }}
          containerWidth={60}
          maxAnswerRows={16}
        />
      </Box>,
    );

    const output = stripAnsi(lastFrame() ?? '');
    // Twelve content lines take a 3-column gutter, so the code width is 52
    // and the 105-column line wraps to 3 rows (not 2 at the un-narrowed
    // width): the block costs 14 rows, leaving room for two prose lines.
    expect(output).not.toContain('prose-0');
    expect(output).toContain('prose-1');
    expect(pendingAnswerRows(output)).toBeLessThanOrEqual(17);
  });

  it('charges a closed code block with the gutter of its own line count', () => {
    const answer = [
      'prose-0',
      'prose-1',
      'prose-2',
      '```ts',
      ...Array.from({ length: 9 }, (_, i) => `c-${i}`),
      'x'.repeat(105),
      '```',
    ].join('\n');
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer, isPending: true }}
          containerWidth={60}
          maxAnswerRows={14}
        />
      </Box>,
    );

    const output = stripAnsi(lastFrame() ?? '');
    // Ten content lines take a 3-column gutter, so the code width is 52
    // and the 105-column line wraps to 3 rows: the block costs 12 rows,
    // leaving room for two prose lines.
    expect(output).not.toContain('prose-0');
    expect(output).toContain('prose-1');
    expect(output).not.toContain('```');
    expect(pendingAnswerRows(output)).toBeLessThanOrEqual(15);
  });

  it('charges tab-indented code after tab expansion', () => {
    const answer = [
      'prose-0',
      'prose-1',
      'prose-2',
      'prose-3',
      'prose-4',
      '```ts',
      ...Array.from({ length: 10 }, () => `\t\t\t${'x'.repeat(45)}`),
    ].join('\n');
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer, isPending: true }}
          containerWidth={60}
          maxAnswerRows={15}
        />
      </Box>,
    );

    const output = stripAnsi(lastFrame() ?? '');
    // Each tab expands to four spaces, so a 3-tab line is 57 columns and
    // wraps to 2 rows at the 52-column code width — the block costs 20
    // rows, not the 10 rows a pre-expansion measurement gives.
    expect(output).not.toContain('prose-0');
    expect(output).toContain('prose-4');
    expect(pendingAnswerRows(output)).toBeLessThanOrEqual(16);
  });

  it('charges fence delimiters nothing', () => {
    const answer = [
      'prose-0',
      'prose-1',
      'prose-2',
      'prose-3',
      'prose-4',
      '```ts',
      'const a = 1;',
      'const b = 2;',
      '```',
    ].join('\n');
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer, isPending: true }}
          containerWidth={60}
          maxAnswerRows={5}
        />
      </Box>,
    );

    const output = stripAnsi(lastFrame() ?? '');
    // The fences draw no rows, so the block costs its two content lines
    // and three prose lines still fit the 5-row budget.
    expect(output).toContain('prose-2');
    expect(output).not.toContain('prose-1');
    expect(pendingAnswerRows(output)).toBe(6);
  });
});
