/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { type ReactElement, type ReactNode } from 'react';
import { VoiceIndicator } from './VoiceIndicator.js';

describe('<VoiceIndicator />', () => {
  it('sanitizes streaming interim transcript text', () => {
    const { lastFrame } = render(
      <VoiceIndicator
        status="recording"
        interimText={'partial\x1b[8m hidden\x1b[0m'}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('partial\\u001b[8m hidden\\u001b[0m');
    expect(frame).not.toContain('\x1b[8m');
  });

  it('renders the meter when audioLevel is NaN', () => {
    const { lastFrame } = render(
      <VoiceIndicator status="recording" audioLevel={Number.NaN} />,
    );

    expect(lastFrame()).toContain('░'.repeat(16));
  });

  it.each([
    { name: 'absent', level: undefined, expected: '░░░░░░░░░░░░░░░░' },
    { name: 'zero', level: 0, expected: '░░░░░░░░░░░░░░░░' },
    { name: 'negative', level: -1, expected: '░░░░░░░░░░░░░░░░' },
    { name: 'NaN', level: Number.NaN, expected: '░░░░░░░░░░░░░░░░' },
    {
      name: 'positive infinity',
      level: Infinity,
      expected: '░░░░░░░░░░░░░░░░',
    },
    {
      name: 'negative infinity',
      level: -Infinity,
      expected: '░░░░░░░░░░░░░░░░',
    },
    { name: 'half', level: 0.041666666666666664, expected: '████████░░░░░░░░' },
    { name: 'full', level: 1, expected: '████████████████' },
    { name: 'above full', level: 2, expected: '████████████████' },
  ])('shows the independent $name meter expectation', ({ level, expected }) => {
    const { lastFrame } = render(
      <VoiceIndicator status="recording" audioLevel={level} />,
    );
    expect(lastFrame()).toContain(expected);
    expect(lastFrame()).toContain('listening…');
  });

  it('renders nothing when idle', () => {
    const { lastFrame } = render(<VoiceIndicator status="idle" />);
    expect(lastFrame() ?? '').toBe('');
  });

  it.each([
    { status: 'transcribing', expected: '◆ transcribing…' },
    { status: 'refining', expected: '◆ refining…' },
  ] as const)(
    'distinguishes $status from recording',
    ({ status, expected }) => {
      const { lastFrame } = render(<VoiceIndicator status={status} />);
      expect(lastFrame()).toContain(expected);
      expect(lastFrame()).not.toContain('listening…');
    },
  );

  it.each([
    { status: 'transcribing', expected: ' ◆ transcrib\n ing…' },
    { status: 'refining', expected: ' ◆ refining…' },
  ] as const)(
    'keeps the actual $status line boundaries at 12 columns',
    ({ status, expected }) => {
      const { lastFrame } = render(
        <Box width={12} flexDirection="column">
          <VoiceIndicator status={status} />
        </Box>,
      );
      expect(lastFrame()).toBe(expected);
    },
  );

  it('truncates interim text at the real narrow parent width with an ellipsis', () => {
    const { lastFrame } = render(
      <Box width={12} flexDirection="column">
        <VoiceIndicator
          status="transcribing"
          interimText="ABCDEFGHIJKLMNOPQRST"
        />
      </Box>,
    );
    expect(lastFrame()?.split('\n').at(-1)).toBe(' ABCDEFGHIJ…');
  });

  it('dims the interim text without forcing a foreground color', () => {
    const tree = VoiceIndicator({
      status: 'recording',
      interimText: 'OWNED_PARTIAL',
    }) as ReactElement<{ children: ReactNode[] }>;
    const row = tree.props.children[1] as ReactElement<Record<string, unknown>>;
    expect(row.props['children']).toBe('OWNED_PARTIAL');
    expect(row.props['dimColor']).toBe(true);
    expect(row.props['color']).toBeUndefined();
    expect(row.props['wrap']).toBe('truncate-end');
  });
});
