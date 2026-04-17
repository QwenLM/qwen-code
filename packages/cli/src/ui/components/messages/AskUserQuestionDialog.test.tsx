/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { AskUserQuestionDialog } from './AskUserQuestionDialog.js';
import type { ToolAskUserQuestionConfirmationDetails } from '@qwen-code/qwen-code-core';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../../test-utils/render.js';

const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe('<AskUserQuestionDialog />', () => {
  describe('rendering', () => {
    it('renders single question with options', () => {
      const details = createConfirmationDetails();
      const onConfirm = vi.fn();

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
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
          onConfirm={onConfirm}
        />,
      );

      const output = lastFrame();
      expect(output).toContain('Q1');
      expect(output).toContain('Q2');
      expect(output).toContain('Submit');
      expect(output).toContain('Switch tabs');
    });

    it('renders multi-select with checkboxes', () => {
      const details = createConfirmationDetails({
        questions: [createSingleQuestion({ multiSelect: true })],
      });
      const onConfirm = vi.fn();

      const { lastFrame } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
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

    it('does not auto-submit when pressing number key for "Other" custom input', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails();

      const { stdin, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
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
          onConfirm={onConfirm}
        />,
      );
      await wait();

      stdin.write('\u001B'); // Escape
      await wait();

      expect(onConfirm).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
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
  });

  describe('multiple questions', () => {
    it.skipIf(process.platform === 'win32')(
      'shows unanswered questions as (not answered) in Submit tab',
      async () => {
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
      },
    );
  });

  describe('focus behavior', () => {
    it('does not respond to keys when isFocused is false', async () => {
      const onConfirm = vi.fn();
      const details = createConfirmationDetails();

      const { stdin, unmount } = renderWithProviders(
        <AskUserQuestionDialog
          confirmationDetails={details}
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
