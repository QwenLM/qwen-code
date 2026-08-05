/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { RenderModeProvider } from '../../contexts/RenderModeContext.js';
import { BtwMessage } from './BtwMessage.js';

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

  it('repairs fences inside $$ regions in raw mode (mathFences off)', () => {
    const { lastFrame } = renderWithProviders(
      <RenderModeProvider
        value={{ renderMode: 'raw', setRenderMode: () => {} }}
      >
        <BtwMessage
          btw={{
            question: 'q',
            answer: 'Intro\n$$\nA```ts\ncode\n```\n$$\nAfter.',
            isPending: false,
          }}
        />
      </RenderModeProvider>,
    );

    const output = lastFrame() ?? '';
    // Raw mode never opens math blocks, so the normalizer must repair the
    // fence inside the $$ region; skipping it would leave 'A```ts' glued.
    expect(output).not.toContain('A```ts');
    expect(output).toContain('code');
  });

  it('leaves $$ regions intact in render mode (mathFences on)', () => {
    const { lastFrame } = renderWithProviders(
      <RenderModeProvider
        value={{ renderMode: 'render', setRenderMode: () => {} }}
      >
        <BtwMessage
          btw={{
            question: 'q',
            answer: '$$\n```\n$$\nLater```ts\nx\n```',
            isPending: false,
          }}
        />
      </RenderModeProvider>,
    );

    const output = lastFrame() ?? '';
    // Render mode honors $$ fences: the region passes through as a math
    // block and only the fence after it gets its newline.
    expect(output).not.toContain('Later```ts');
    expect(output).toContain('Later');
  });
});
