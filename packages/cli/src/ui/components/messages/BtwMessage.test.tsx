/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
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
});
