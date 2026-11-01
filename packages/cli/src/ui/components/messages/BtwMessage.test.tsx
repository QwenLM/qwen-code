/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { act } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils/render.js';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import { BtwMessage } from './BtwMessage.js';

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
});
