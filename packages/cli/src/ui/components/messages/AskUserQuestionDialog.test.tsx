/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AskUserQuestionDialog,
  computeHeaderCap,
} from './AskUserQuestionDialog.js';
import type { ToolAskUserQuestionConfirmationDetails } from '@qwen-code/qwen-code-core';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../../test-utils/render.js';
import stripAnsi from 'strip-ansi';

const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const writeText = async (
  stdin: { write: (input: string) => unknown },
  text: string,
) => {
  stdin.write(text);
  await wait();
};
const clean = (value: string | undefined) => stripAnsi(value ?? '');
const waitForFrame = async (
  predicate: () => void,
  options: { timeout?: number; interval?: number } = {},
) => {
  const { timeout = 3000, interval = 10 } = options;
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeout) {
    try {
      predicate();
      return;
    } catch (error) {
      lastError = error;
    }
    await wait(interval);
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error('waitForFrame timed out');
};

const createSingleQuestion = (
  overrides: Partial<
    ToolAskUserQuestionConfirmationDetails['questions'][0]
  > = {},
): ToolAskUserQuestionConfirmationDetails['questions'][0] => ({
  question: 'What is your favorite color?',
  header: 'Color',
  options: [
    { label: 'Red', description: 'A warm color' },
    { label: 'Blue', description: 'A cool color' },
    { label: 'Green', description: '' },
  ],
  multiSelect: false,
  ...overrides,
});

const createConfirmationDetails = (
  overrides: Partial<ToolAskUserQuestionConfirmationDetails> = {},
): ToolAskUserQuestionConfirmationDetails => ({
  type: 'ask_user_question',
  title: 'Question',
  questions: [createSingleQuestion()],
  onConfirm: vi.fn(),
  ...overrides,
});

describe('computeHeaderCap', () => {
  const NO_CLIP = Number.MAX_SAFE_INTEGER;

  it('does not clip when every header fits at its natural width', () => {
    expect(computeHeaderCap([5, 8, 3], 100)).toBe(NO_CLIP);
  });

  it("reclaims a short header's slack so a longer one stays full", () => {
    // An equal split of 30 across two headers would cap at 15 and clip the
    // 19-wide header; water-filling gives the short header only 2 and lets the
    // long one keep all 19.
    expect(computeHeaderCap([2, 19], 30)).toBe(NO_CLIP);
  });

  it('clips so that the clipped headers fit the available width', () => {
    const widths = [20, 18, 22];
    const cap = computeHeaderCap(widths, 30);
    const used = widths.reduce((sum, w) => sum + Math.min(w, cap), 0);
    expect(cap).toBeLessThan(Math.max(...widths));
    expect(used).toBeLessThanOrEqual(30);
  });

  it('is maximal — one more cell of cap would overflow the budget', () => {
    const widths = [20, 18, 22];
    const available = 30;
    const cap = computeHeaderCap(widths, available);
    const usedAt = (c: number) =>
      widths.reduce((sum, w) => sum + Math.min(w, c), 0);
    expect(usedAt(cap)).toBeLessThanOrEqual(available);
    expect(usedAt(cap + 1)).toBeGreaterThan(available);
  });

  it('does not clip an empty or all-zero header set', () => {
    expect(computeHeaderCap([], 0)).toBe(NO_CLIP);
    expect(computeHeaderCap([0, 0], 0)).toBe(NO_CLIP);
  });

  it('gives a one-cell budget to the only header that needs clipping', () => {
    expect(computeHeaderCap([0, 100], 1)).toBe(1);
  });

  it('never returns a negative cap when there is no room', () => {
    expect(computeHeaderCap([10, 10], 0)).toBe(0);
    expect(computeHeaderCap([10, 10], -5)).toBe(0);
  });
});

describe('<AskUserQuestionDialog />', () => {
  describe('rendering', () => {
    it('renders single question with options', () => {
      const details = createConfirmationDetails();
      const onConfirm = vi.fn();

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );

      const output = lastFrame();
      expect(output).toContain('What is your favorite color?');
      expect(output).toContain('Red');
      expect(output).toContain('Blue');
      expect(output).toContain('Green');
      expect(output).toContain('A warm color');
      expect(output).toContain('A cool color');
    });

    it('renders header for single question', () => {
      const details = createConfirmationDetails();
      const onConfirm = vi.fn();

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );

      expect(lastFrame()).toContain('Color');
    });

    it('renders "Type something..." custom input option', () => {
      const details = createConfirmationDetails();
      const onConfirm = vi.fn();

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );

      expect(lastFrame()).toContain('Type something...');
    });

    it('renders help text for single select', () => {
      const details = createConfirmationDetails();
      const onConfirm = vi.fn();

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );

      expect(lastFrame()).toContain('Enter: Select');
      expect(lastFrame()).toContain('Esc: Cancel');
      expect(lastFrame()).not.toContain('Switch tabs');
    });

    it('renders tabs for multiple questions', () => {
      const details = createConfirmationDetails({
        questions: [
          createSingleQuestion({ header: 'Q1' }),
          createSingleQuestion({
            header: 'Q2',
            question: 'Second question?',
          }),
        ],
      });
      const onConfirm = vi.fn();

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );

      const output = lastFrame();
      expect(output).toContain('Q1');
      expect(output).toContain('Q2');
      expect(output).toContain('Submit');
      expect(output).toContain('Switch tabs');
    });

    it('renders an over-length header in full for a single question', () => {
      // Regression: a header longer than the old 12-char cap (e.g.
      // "Target config", 13 chars) must render. For a single question the
      // header is on its own line, so it is shown in full — not truncated.
      const details = createConfirmationDetails({
        questions: [createSingleQuestion({ header: 'Target config' })],
      });
      const onConfirm = vi.fn();

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );

      expect(lastFrame()).toContain('Target config');
    });

    it('shows an over-length header in full when the tab row has room', () => {
      // The 12-char limit is only guidance. In a normal-width terminal the tab
      // row has ample space, so an over-length header (e.g. "Target config",
      // 13 chars) is shown in full rather than clipped.
      const details = createConfirmationDetails({
        questions: [
          createSingleQuestion({ header: 'Target config' }),
          createSingleQuestion({
            header: 'Q2',
            question: 'Second question?',
          }),
        ],
      });

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={100}
          onConfirm={vi.fn()}
        />,
      );

      const output = lastFrame();
      expect(output).toContain('Target config');
      expect(output).not.toContain('Target conf…');
    });

    it('clips an over-length header and keeps the row within width when space is tight', () => {
      // In a narrow terminal the headers cannot all fit, so an over-length
      // header is truncated with an ellipsis and the row stays within width.
      const details = createConfirmationDetails({
        questions: [
          createSingleQuestion({ header: 'Target config' }),
          createSingleQuestion({
            header: 'Q2',
            question: 'Second question?',
          }),
        ],
      });

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={28}
          onConfirm={vi.fn()}
        />,
      );

      const output = lastFrame();
      expect(output).not.toContain('Target config'); // clipped
      expect(output).toContain('…');
    });

    it('clips a wide CJK header width-aware when space is tight', () => {
      // CJK characters occupy two cells each; the width-aware clip must bound
      // them correctly rather than by character count.
      const details = createConfirmationDetails({
        questions: [
          createSingleQuestion({ header: '目标配置参数设置' }),
          createSingleQuestion({
            header: 'Q2',
            question: 'Second question?',
          }),
        ],
      });

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={28}
          onConfirm={vi.fn()}
        />,
      );

      const output = lastFrame();
      expect(output).not.toContain('目标配置参数设置'); // clipped
      expect(output).toContain('…');
    });

    it('keeps a long header full when a short neighbor leaves room', () => {
      // Water-filling reclaims a short header's unused width for a longer one:
      // an equal split would clip "Configuration Params" to half the row, but
      // since "Q1" needs almost nothing, the long header stays full.
      const details = createConfirmationDetails({
        questions: [
          createSingleQuestion({ header: 'Q1' }),
          createSingleQuestion({
            header: 'Configuration Params',
            question: 'Second question?',
          }),
        ],
      });

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={50}
          onConfirm={vi.fn()}
        />,
      );

      expect(lastFrame()).toContain('Configuration Params');
    });

    it('clips every header when four long tabs must share a tight row', () => {
      // Overflow protection for the worst case: the maximum number of tabs, each
      // with an over-length header, forces all of them to be clipped so the row
      // still fits.
      const availableWidth = 40;
      const details = createConfirmationDetails({
        questions: [
          createSingleQuestion({ header: 'Target config' }),
          createSingleQuestion({ header: 'Primary metric', question: 'Q2?' }),
          createSingleQuestion({ header: 'Output format', question: 'Q3?' }),
          createSingleQuestion({ header: 'Retry policy', question: 'Q4?' }),
        ],
      });

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={availableWidth}
          onConfirm={vi.fn()}
        />,
      );

      const output = lastFrame();
      expect(output).not.toContain('Target config');
      expect(output).not.toContain('Primary metric');
      expect(output).not.toContain('Output format');
      expect(output).not.toContain('Retry policy');
      expect(output).toContain('…');

      // The rendered tab row must actually fit availableWidth. This pins the
      // dialog's rowOverhead accounting to the JSX it mirrors — if the render
      // structure changes without the accounting, this fails. (All-ASCII
      // headers plus one-cell '▸'/'…', so string length equals display width.)
      const tabRow = clean(output)
        .split('\n')
        .find((line) => line.includes('Submit'));
      expect(tabRow).toBeDefined();
      expect(tabRow!.trimEnd().length).toBeLessThanOrEqual(availableWidth);
    });

    it('renders multi-select with checkboxes', () => {
      const details = createConfirmationDetails({
        questions: [createSingleQuestion({ multiSelect: true })],
      });
      const onConfirm = vi.fn();

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );

      const output = lastFrame();
      expect(output).toContain('[ ]');
      expect(output).toContain('Space: Toggle');
      expect(output).toContain('Enter: Confirm');
    });
  });

  describe('single-select interaction', () => {
    it('selects an option with Enter and submits immediately for single question', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails();

      const { stdin, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      // Press Enter to select the first option (Red)
      stdin.write('\r');
      await wait();

      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { 0: 'Red' } },
      );
      unmount();
    });
    it('auto-submits when pressing a number key for a predefined option', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails();

      const { stdin, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      // Press '2' to select the second option (Blue) — should auto-submit
      stdin.write('2');
      await wait();

      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { 0: 'Blue' } },
      );
      unmount();
    });

    it('does not auto-submit pasted numeric prefixes as option numbers', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails();

      const { stdin, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      stdin.write('\u001B[200~2x\u001B[201~');
      await wait();

      expect(onConfirm).not.toHaveBeenCalled();
      unmount();
    });

    it('does not auto-submit when pressing number key for "Other" custom input', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails();

      const { stdin, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      // Press '4' to select the "Other" option (index 3, after 3 predefined options)
      stdin.write('4');
      await wait();

      // Should NOT auto-submit — just highlight "Other" for text input
      expect(onConfirm).not.toHaveBeenCalled();
      unmount();
    });

    it('cancels with Escape', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails();

      const { stdin, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      stdin.write('\u001B'); // Escape
      await wait();

      expect(onConfirm).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      unmount();
    });

    it('navigates with selection shortcuts when custom input is not focused', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails();

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      expect(clean(lastFrame())).toContain('❯ 1. Red');

      stdin.write('j');
      await wait();
      expect(clean(lastFrame())).toContain('❯ 2. Blue');

      stdin.write('k');
      await wait();
      expect(clean(lastFrame())).toContain('❯ 1. Red');

      unmount();
    });

    it('navigates with Ctrl+N/P when custom input is not focused', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails();

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      expect(clean(lastFrame())).toContain('❯ 1. Red');

      stdin.write('\u000E'); // Ctrl+N
      await wait();
      expect(clean(lastFrame())).toContain('❯ 2. Blue');

      stdin.write('\u0010'); // Ctrl+P
      await wait();
      expect(clean(lastFrame())).toContain('❯ 1. Red');

      unmount();
    });

    it('keeps bare k/j in custom input while Ctrl+P/N still navigates options', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails();

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      stdin.write('4'); // Select "Other" custom input
      await waitForFrame(() => {
        expect(clean(lastFrame())).toContain('❯ 4.');
      });
      await wait();

      stdin.write('j');
      await waitForFrame(() => {
        const frame = clean(lastFrame());
        expect(frame).toContain('❯ 4.');
        expect(frame).toContain('j');
      });

      stdin.write('k');
      await waitForFrame(() => {
        const frame = clean(lastFrame());
        expect(frame).toContain('❯ 4.');
        expect(frame).toContain('jk');
      });

      stdin.write('\u0010'); // Ctrl+P
      await wait();
      await waitForFrame(() => {
        expect(clean(lastFrame())).toContain('❯ 3. Green');
      });

      stdin.write('\u000E'); // Ctrl+N
      await wait();
      await waitForFrame(() => {
        expect(clean(lastFrame())).toContain('❯ 4.');
      });

      unmount();
    });
  });

  describe('multi-select interaction', () => {
    it('does not auto-submit when pressing number key in multi-select mode', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails({
        questions: [createSingleQuestion({ multiSelect: true })],
      });

      const { stdin, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      // Press '2' — should only move highlight, not submit
      stdin.write('2');
      await wait();

      expect(onConfirm).not.toHaveBeenCalled();
      unmount();
    });

    it('toggles options with Space', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails({
        questions: [createSingleQuestion({ multiSelect: true })],
      });

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      // Space to toggle first option
      stdin.write(' ');
      await wait();

      // Should show checked state
      expect(lastFrame()).toContain('[✓]');
      unmount();
    });

    it('auto-selects custom input and submits on Enter after typing', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails({
        questions: [createSingleQuestion({ multiSelect: true })],
      });

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      // Navigate to "Type something..." option (index 3, after 3 predefined options)
      stdin.write('4');
      await waitForFrame(() => {
        expect(clean(lastFrame())).toContain('❯ [ ] 4.');
      });
      await wait();

      // Type custom text
      await writeText(stdin, 'My custom answer');
      await waitForFrame(() => {
        expect(clean(lastFrame())).toContain('My custom answer');
      });

      // Press Enter — should auto-select and submit
      stdin.write('\r');
      await wait();

      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { 0: 'My custom answer' } },
      );
      unmount();
    }, 10000);

    it('does not submit when Enter pressed on empty custom input', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails({
        questions: [createSingleQuestion({ multiSelect: true })],
      });

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      // Navigate to "Type something..." option
      stdin.write('4');
      await waitForFrame(() => {
        expect(clean(lastFrame())).toContain('❯ [ ] 4.');
      });
      await wait();

      // Press Enter without typing anything — should NOT submit
      stdin.write('\r');
      await wait();

      expect(onConfirm).not.toHaveBeenCalled();
      unmount();
    }, 10000);

    it('submits predefined options together with custom input', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails({
        questions: [createSingleQuestion({ multiSelect: true })],
      });

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      // Space to toggle first option (Red)
      stdin.write(' ');
      await waitForFrame(() => {
        expect(clean(lastFrame())).toContain('[✓] 1. Red');
      });

      // Navigate to "Type something..." option
      stdin.write('4');
      await waitForFrame(() => {
        expect(clean(lastFrame())).toContain('❯ [ ] 4.');
      });
      await wait();

      // Type custom text
      await writeText(stdin, 'Purple');
      await waitForFrame(() => {
        expect(clean(lastFrame())).toContain('Purple');
      });

      // Press Enter — should submit both Red and Purple
      stdin.write('\r');
      await wait();

      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { 0: expect.stringContaining('Red') } },
      );
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { 0: expect.stringContaining('Purple') } },
      );
      unmount();
    }, 10000);
  });

  describe('multiple questions', () => {
    it.skipIf(process.platform === 'win32')(
      'does not auto-submit when pressing number key on Submit tab',
      async () => {
        const onConfirm = vi.fn();
        const details = createConfirmationDetails({
          questions: [
            createSingleQuestion({ header: 'Q1' }),
            createSingleQuestion({ header: 'Q2' }),
          ],
        });

        const { stdin, unmount } = renderWithProviders(
          <AskUserQuestionDialog
            confirmationDetails={details}
            availableWidth={80}
            onConfirm={onConfirm}
          />,
        );
        await wait();

        // Navigate to Submit tab
        stdin.write('\u001B[C'); // Right
        await wait();
        stdin.write('\u001B[C'); // Right
        await wait();

        // Press '1' on Submit tab — should only highlight, not submit
        stdin.write('1');
        await wait();

        expect(onConfirm).not.toHaveBeenCalled();
        unmount();
      },
    );

    // TODO(#4036): Ink 7's input throttle merges or drops consecutive arrow
    // keys when run through `ink-testing-library`. The two right-arrow presses
    // below land on Q2 instead of the Submit tab, so the assertion never sees
    // "(not answered)". Re-enable once upstream `ink-testing-library` ships
    // an ink-7-compatible release that flushes input deterministically.
    it.skip('shows unanswered questions as (not answered) in Submit tab', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails({
        questions: [
          createSingleQuestion({ header: 'Q1' }),
          createSingleQuestion({ header: 'Q2' }),
        ],
      });

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      // Navigate directly to submit tab without answering anything
      stdin.write('\u001B[C'); // Right
      await wait();
      stdin.write('\u001B[C'); // Right
      await wait();

      expect(lastFrame()).toContain('(not answered)');
      unmount();
    });
  });

  describe('focus behavior', () => {
    it('does not respond to keys when isFocused is false', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails();

      const { stdin, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
          availableWidth={80}
          isFocused={false}
          onConfirm={onConfirm}
        />,
      );
      await wait();

      stdin.write('\r'); // Enter
      await wait();
      stdin.write('\u001B'); // Escape
      await wait();

      expect(onConfirm).not.toHaveBeenCalled();
      unmount();
    });
  });
});
