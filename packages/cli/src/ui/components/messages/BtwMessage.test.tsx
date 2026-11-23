/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { act } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils/render.js';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import { Colors } from '../../colors.js';
import { BtwMessage } from './BtwMessage.js';

// Ink strips styling when stdout is not a TTY, so render each Text's color as
// a prefix. That keeps the notice's severity choice observable in the frame.
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  const React = await import('react');
  return {
    ...actual,
    Text: ({
      color,
      children,
    }: {
      color?: string;
      children?: React.ReactNode;
    }) =>
      React.createElement(
        actual.Text,
        null,
        color ? `[${color}]` : '',
        children,
      ),
  };
});

const PAGE_DOWN = '\x1b[6~';

const longAnswer = (lines: number) =>
  Array.from({ length: lines }, (_, i) => `line-${i}`).join('\n');

/** Rows between the question line and the `Answering...` status line: the
 *  pending margin blank plus the answer's rendered rows. (The status `+` and
 *  `Answering...` are separate Text nodes, so anchor on `Answering...`.) */
const pendingAnswerRows = (frame: string): number => {
  const lines = frame.split('\n');
  const start = lines.findIndex((line) => line.includes('/btw'));
  const end = lines.findIndex((line) => line.includes('Answering...'));
  return end - start - 1;
};

describe('BtwMessage', () => {
  it('is wrapped in React.memo to avoid unnecessary layout rerenders', () => {
    expect((BtwMessage as unknown as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    );
  });

  it('renders the side question and answer', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'side question',
          answer: 'side answer',
          isPending: false,
        }}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('/btw');
    expect(output).toContain('side question');
    expect(output).toContain('side answer');
  });

  it('renders pending state with cancel hint', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'pending question',
          answer: '',
          isPending: true,
        }}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('/btw');
    expect(output).toContain('pending question');
    expect(output).toContain('Answering...');
    expect(output).toContain('Ctrl+C');
    expect(output).toContain('Ctrl+D');
  });

  it('accepts containerWidth prop for content width calculation', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'q',
          answer: 'some answer text',
          isPending: false,
        }}
        containerWidth={60}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('some answer text');
  });

  it('renders dismiss hint when answer is complete', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'q',
          answer: 'a',
          isPending: false,
        }}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Space');
    expect(output).toContain('Enter');
    expect(output).toContain('Escape');
    expect(output).toContain('dismiss');
    expect(output).not.toContain('c copy');
  });

  it('advertises cancel instead of dismiss while the own request runs', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'older question',
          answer: 'older answer',
          isPending: false,
          ownRequestPending: true,
        }}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Ctrl+C');
    expect(output).toContain('Ctrl+D');
    expect(output).not.toContain('dismiss');
  });

  it('caps a long answer at maxAnswerRows and scrolls the rest into view', async () => {
    const ui = (
      <KeypressProvider kittyProtocolEnabled={false}>
        <BtwMessage
          btw={{
            question: 'long question',
            answer: longAnswer(40),
            isPending: false,
          }}
          containerWidth={60}
          maxAnswerRows={4}
        />
      </KeypressProvider>
    );

    const { stdin, lastFrame, rerender } = render(ui);
    rerender(ui);
    await act(async () => {});

    // The panel shows the top of the answer and clips the rest instead of
    // growing with the content.
    expect(lastFrame()).toContain('line-0');
    expect(lastFrame()).not.toContain('line-39');
    expect(lastFrame()!.split('\n').length).toBeLessThan(40);

    // The clipped rows stay reachable: PageDown moves the viewport.
    await act(async () => {
      for (let i = 0; i < 12; i++) {
        stdin.write(PAGE_DOWN);
      }
    });
    await act(async () => {});

    expect(lastFrame()).not.toContain('line-0');
    expect(lastFrame()).toContain('line-39');
  });

  it('renders the whole answer when no maxAnswerRows is given', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'long question',
          answer: longAnswer(40),
          isPending: false,
        }}
        containerWidth={60}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('line-0');
    expect(output).toContain('line-39');
  });

  it('shows streamed text and retry status while pending', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'q',
          answer: 'partial answer',
          isPending: true,
          retryStatus: 'Rate limited · retrying in 3s · attempt 1/5',
        }}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('partial answer');
    expect(output).toContain('retrying in 3s');
    expect(output).not.toContain('Answering...');
  });

  it('shows browse, copy and clear hints when earlier answers exist', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'older question',
          answer: 'older answer',
          isPending: false,
          historyCount: 2,
          browsePosition: 1,
          browsing: true,
          notice: { text: 'Copied to clipboard' },
        }}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('(1/2)');
    expect(output).toContain('browse earlier answers');
    expect(output).toContain('c copy');
    expect(output).toContain('x clear history');
    expect(output).toContain(`[${Colors.AccentGreen}]Copied to clipboard`);
  });

  it('advertises copy and clear only while browsing earlier answers', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'q',
          answer: 'a',
          isPending: false,
          historyCount: 2,
        }}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('browse earlier answers');
    expect(output).not.toContain('c copy');
    expect(output).not.toContain('x clear history');
  });

  it('paints a failed copy notice as an error', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'q',
          answer: 'a',
          isPending: false,
          notice: { text: 'Copy failed', isError: true },
        }}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain(`[${Colors.AccentRed}]Copy failed`);
    expect(output).not.toContain(`[${Colors.AccentGreen}]Copy failed`);
  });

  it('renders a settled error verbatim inside the scrollable path', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'q',
          answer: '(API error: **429**)',
          isPending: false,
          isError: true,
        }}
        containerWidth={60}
        maxAnswerRows={6}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain(`[${Colors.AccentRed}](API error: **429**)`);
  });

  it('renders an error answer without the copy hint', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{
          question: 'q',
          answer: '(API error: boom)',
          isPending: false,
          isError: true,
        }}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('(API error: boom)');
    expect(output).not.toContain('c copy');
    expect(output).not.toContain('browse earlier answers');
  });

  it('shows only the tail of a long streaming answer', () => {
    const { lastFrame } = renderWithProviders(
      <BtwMessage
        btw={{ question: 'q', answer: longAnswer(30), isPending: true }}
        maxAnswerRows={5}
      />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('line-29');
    expect(output).toContain('line-25');
    expect(output).not.toContain('line-24');
  });

  it('counts wrapped rows when tailing a long streaming answer', () => {
    const wideAnswer = (lines: number) =>
      Array.from(
        { length: lines },
        (_, i) => `line-${i}${'x'.repeat(108)}`,
      ).join('\n');
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer: wideAnswer(30), isPending: true }}
          containerWidth={60}
          maxAnswerRows={5}
        />
      </Box>,
    );

    const output = lastFrame() ?? '';
    // Each line is 115 columns wide and wraps to 3 rows at content width
    // 56 (2 at the 60-column base width), so only the last line fits in the
    // 5-row budget — charging at the base width would wrongly fit two.
    expect(output).toContain('line-29');
    expect(output).not.toContain('line-28');
    expect(pendingAnswerRows(output)).toBe(4);
  });

  it('charges wide characters at their display width when tailing', () => {
    const wideAnswer = (lines: number) =>
      Array.from(
        { length: lines },
        (_, i) => `line-${i}${'汉'.repeat(36)}`,
      ).join('\n');
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer: wideAnswer(30), isPending: true }}
          containerWidth={60}
          maxAnswerRows={5}
        />
      </Box>,
    );

    const output = lastFrame() ?? '';
    // Each line is 79 display columns (7 + 36 wide chars) but only 43
    // characters, so it wraps to 2 rows at content width 56 — measuring by
    // string length would charge 1 row and wrongly fit five lines.
    expect(output).toContain('line-29');
    expect(output).toContain('line-28');
    expect(output).not.toContain('line-27');
    expect(pendingAnswerRows(output)).toBe(5);
  });

  it('keeps a trailing-newline answer visible while streaming', () => {
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{
            question: 'q',
            answer: `${'x'.repeat(300)}\n`,
            isPending: true,
          }}
          containerWidth={60}
          maxAnswerRows={5}
        />
      </Box>,
    );

    const output = lastFrame() ?? '';
    // The trailing newline must not blank the answer: the 300-column line
    // wraps to 6 rows and, as the only unit, is kept whole.
    expect(output).toContain('x'.repeat(50));
    expect(output).toContain('Answering...');
  });

  it('never cuts a streaming answer inside a fenced code block', () => {
    const answer = `Here is the fix:\n\`\`\`ts\n${'x'.repeat(800)}\n\`\`\`\nDone.`;
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer, isPending: true }}
          containerWidth={60}
          maxAnswerRows={15}
        />
      </Box>,
    );

    const output = lastFrame() ?? '';
    // The 800-column code line costs the whole budget on its own, so the cut
    // falls inside the block: the start moves back to the opening fence and
    // the block renders whole instead of orphaning its closing fence (which
    // the renderer would read as an opener and swallow `Done.` as code).
    expect(output).toContain('Done.');
    expect(output).not.toContain('Here is the fix:');
    // `Done.` must render as plain prose after the block, not as the code
    // block's first line carrying a line-number gutter. (The ink Text mock
    // prefixes each Text node with its color in brackets, so strip those
    // before checking the gutter.)
    const doneLine =
      output.split('\n').find((line) => line.includes('Done.')) ?? '';
    expect(doneLine.replace(/\[[^\]]*\]/g, '')).not.toMatch(/\d+ Done\./);
  });

  it('drops a trailing table as one unit instead of keeping raw rows', () => {
    const answer = [
      '| Name | Value |',
      '| --- | --- |',
      '| alpha | 1 |',
      '| beta | 2 |',
      '| gamma | 3 |',
      'Done.',
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

    const output = lastFrame() ?? '';
    // The table renders 11 rows (4 content + 2 separators + 5 chrome), so
    // it cannot fit after `Done.` — the tail keeps only `Done.` instead of
    // the table's last rows as raw pipe text.
    expect(output).toContain('Done.');
    expect(output).not.toContain('alpha');
    expect(output).not.toContain('gamma');
  });

  it('keeps a table that fits the budget whole', () => {
    const answer = [
      '| Name | Value |',
      '| --- | --- |',
      '| alpha | 1 |',
      '| beta | 2 |',
      '| gamma | 3 |',
    ].join('\n');
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer, isPending: true }}
          containerWidth={60}
          maxAnswerRows={12}
        />
      </Box>,
    );

    const output = lastFrame() ?? '';
    // The table costs 11 rows and fits the 12-row budget, so it renders as
    // a table instead of being cut mid-table.
    expect(output).toContain('alpha');
    expect(output).toContain('gamma');
    expect(output).not.toContain('| alpha |');
  });

  it('keeps prose above a header-only table instead of blanking the answer', () => {
    const answer = [
      'alpha',
      'beta',
      'gamma',
      'delta',
      '| Name | Value |',
      '| --- | --- |',
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

    const output = lastFrame() ?? '';
    // A table with no data row renders nothing, so it costs 0 rows and the
    // four prose lines above it stay visible instead of being pushed out by
    // a 6-row charge for a header box that never appears.
    expect(output).toContain('alpha');
    expect(output).toContain('delta');
    expect(pendingAnswerRows(output)).toBe(5);
  });

  it('bounds a 30-data-row trailing table to the row budget', () => {
    const answer = [
      '| Name | Value |',
      '| --- | --- |',
      ...Array.from({ length: 30 }, (_, i) => `| row-${i} | ${i} |`),
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

    const output = lastFrame() ?? '';
    // No data row fits the 5-row budget (one row costs 7), so only the
    // header + separator survive — they render nothing instead of 66 rows.
    expect(output).not.toContain('row-29');
    expect(output).not.toContain('row-0');
    expect(pendingAnswerRows(output)).toBeLessThanOrEqual(6);
  });

  it('does not oscillate when a trailing line follows a tall table', () => {
    const answer = [
      '| Name | Value |',
      '| --- | --- |',
      ...Array.from({ length: 30 }, (_, i) => `| row-${i} | ${i} |`),
      'Done.',
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

    const output = lastFrame() ?? '';
    // The table contributes nothing (no data row fits) and `Done.` stays:
    // 2 rows, not 66 rows before the line arrives and 2 after it.
    expect(output).toContain('Done.');
    expect(output).not.toContain('row-29');
    expect(pendingAnswerRows(output)).toBe(2);
  });

  it('charges a display-math block as one unit, not per source line', () => {
    const answer = [
      ...Array.from({ length: 12 }, (_, i) => `prose-${i}`),
      '$$',
      'x = 1',
      'y = 2',
      '$$',
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

    const output = lastFrame() ?? '';
    // The math block renders 2 rows (title + the joined content on one
    // wrapped line), not 4 — so all twelve prose lines still fit the
    // 14-row budget.
    expect(output).toContain('prose-0');
    expect(output).toContain('LaTeX');
    expect(pendingAnswerRows(output)).toBeLessThanOrEqual(15);
  });

  it('charges a mermaid fence as its pending preview, not per source line', () => {
    const answer = [
      ...Array.from({ length: 12 }, (_, i) => `prose-${i}`),
      '```mermaid',
      ...Array.from({ length: 10 }, (_, i) => `node-${i} --> node-${i + 1}`),
      '```',
    ].join('\n');
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer, isPending: true }}
          containerWidth={60}
          maxAnswerRows={20}
        />
      </Box>,
    );

    const output = lastFrame() ?? '';
    // The pending mermaid preview renders 7 rows (header + six preview
    // lines), not 12 — so all twelve prose lines still fit the 20-row budget.
    expect(output).toContain('prose-0');
    expect(output).toContain('Mermaid diagram is being written...');
    expect(pendingAnswerRows(output)).toBeLessThanOrEqual(21);
  });

  it('recognises a display-math block in CRLF text', () => {
    const answer = [
      'prose-0',
      'prose-1',
      'prose-2',
      'prose-3',
      '$$',
      'x = 1',
      '$$',
      'Done.',
    ].join('\r\n');
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer, isPending: true }}
          containerWidth={60}
          maxAnswerRows={5}
        />
      </Box>,
    );

    const output = lastFrame() ?? '';
    // The $$ fences are recognised (no stray CR on the fence lines), so the
    // math renders as a LaTeX block instead of raw $$ lines.
    expect(output).toContain('prose-2');
    expect(output).not.toContain('prose-1');
    expect(output).not.toContain('$$');
    expect(output).toContain('LaTeX');
    expect(output).toContain('x = 1');
    expect(output.indexOf('LaTeX')).toBeLessThan(output.indexOf('x = 1'));
    expect(output.indexOf('x = 1')).toBeLessThan(output.indexOf('Done.'));
  });

  it('drops an over-budget display-math block whole instead of keeping it', () => {
    const answer = [
      'prose-0',
      'prose-1',
      'prose-2',
      'prose-3',
      '$$',
      ...Array.from({ length: 10 }, () => 'x'.repeat(50)),
      '$$',
      'Done.',
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

    const output = lastFrame() ?? '';
    // The math block renders 11 rows (title + 509 joined columns wrapped
    // at 55), so it cannot fit after `Done.` and is dropped whole.
    expect(output).toContain('Done.');
    expect(output).not.toContain('LaTeX');
    expect(pendingAnswerRows(output)).toBe(2);
  });

  it('keeps a display-math block whole when it fits the budget', () => {
    const answer = [
      'prose-0',
      'prose-1',
      'prose-2',
      'prose-3',
      '$$',
      ...Array.from({ length: 10 }, () => 'x'.repeat(50)),
      '$$',
      'Done.',
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

    const output = lastFrame() ?? '';
    expect(output).toContain('LaTeX');
    expect(output).toContain('Done.');
    expect(output).toContain('prose-0');
  });

  it('charges a run of blank lines as one spacer row', () => {
    const answer = 'para one\n\n\npara two\n\n\npara three';
    const { lastFrame } = renderWithProviders(
      <Box width={60}>
        <BtwMessage
          btw={{ question: 'q', answer, isPending: true }}
          containerWidth={60}
          maxAnswerRows={5}
        />
      </Box>,
    );

    const output = lastFrame() ?? '';
    // Two blank runs collapse to two spacer rows, so all three paragraphs
    // fit the 5-row budget instead of only the last two.
    expect(output).toContain('para one');
    expect(output).toContain('para three');
    expect(pendingAnswerRows(output)).toBe(6);
  });
});
