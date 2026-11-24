/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { ConsentPrompt } from './ConsentPrompt.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { MarkdownDisplay } from '../utils/MarkdownDisplay.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';

vi.mock('../hooks/useKeypress.js', () => ({ useKeypress: vi.fn() }));

vi.mock('./shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: vi.fn(() => null),
}));

vi.mock('../utils/MarkdownDisplay.js', () => ({
  MarkdownDisplay: vi.fn(() => null),
}));

const MockedRadioButtonSelect = vi.mocked(RadioButtonSelect);
const MockedMarkdownDisplay = vi.mocked(MarkdownDisplay);

describe('ConsentPrompt', () => {
  const onConfirm = vi.fn();
  const terminalWidth = 80;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declines on Escape when the owning dialog enables it', () => {
    render(
      <ConsentPrompt
        prompt="Move?"
        onConfirm={onConfirm}
        terminalWidth={terminalWidth}
        dismissOnEscape
      />,
    );

    const [handleKeypress, options] = vi.mocked(useKeypress).mock.lastCall!;
    expect(options.isActive).toBe(true);
    handleKeypress({ name: 'escape' } as Key);
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('renders a string prompt with MarkdownDisplay', () => {
    const prompt = 'Are you sure?';
    render(
      <ConsentPrompt
        prompt={prompt}
        onConfirm={onConfirm}
        terminalWidth={terminalWidth}
      />,
    );

    expect(MockedMarkdownDisplay).toHaveBeenCalledWith(
      {
        isPending: true,
        text: prompt,
        contentWidth: terminalWidth,
      },
      undefined,
    );
  });

  it('passes a constrained height to MarkdownDisplay when terminal height is limited', () => {
    const prompt = 'Are you sure?';
    render(
      <ConsentPrompt
        prompt={prompt}
        onConfirm={onConfirm}
        terminalWidth={terminalWidth}
        availableTerminalHeight={12}
      />,
    );

    expect(MockedMarkdownDisplay).toHaveBeenCalledWith(
      {
        isPending: true,
        text: prompt,
        contentWidth: terminalWidth,
        availableTerminalHeight: 5,
      },
      undefined,
    );
  });

  it('shows a truncation notice when the prompt is reduced to one row', () => {
    const prompt = 'This operation needs careful review.';
    const { lastFrame } = render(
      <ConsentPrompt
        prompt={prompt}
        onConfirm={onConfirm}
        terminalWidth={terminalWidth}
        availableTerminalHeight={8}
      />,
    );

    expect(MockedMarkdownDisplay).toHaveBeenCalledWith(
      {
        isPending: true,
        text: prompt,
        contentWidth: terminalWidth,
        availableTerminalHeight: 1,
      },
      undefined,
    );
    expect(lastFrame()).toContain('Content truncated');
  });

  it('shows a truncation notice at the two-row prompt boundary', () => {
    const prompt = 'This operation needs careful review.';
    const { lastFrame } = render(
      <ConsentPrompt
        prompt={prompt}
        onConfirm={onConfirm}
        terminalWidth={terminalWidth}
        availableTerminalHeight={9}
      />,
    );

    expect(MockedMarkdownDisplay).toHaveBeenCalledWith(
      {
        isPending: true,
        text: prompt,
        contentWidth: terminalWidth,
        availableTerminalHeight: 1,
      },
      undefined,
    );
    expect(lastFrame()).toContain('Content truncated');
  });

  it('does not show a truncation notice at the three-row prompt boundary', () => {
    const prompt = 'This operation needs careful review.';
    const { lastFrame } = render(
      <ConsentPrompt
        prompt={prompt}
        onConfirm={onConfirm}
        terminalWidth={terminalWidth}
        availableTerminalHeight={10}
      />,
    );

    expect(MockedMarkdownDisplay).toHaveBeenCalledWith(
      {
        isPending: true,
        text: prompt,
        contentWidth: terminalWidth,
        availableTerminalHeight: 3,
      },
      undefined,
    );
    expect(lastFrame()).not.toContain('Content truncated');
  });

  it('renders a ReactNode prompt directly', () => {
    const prompt = <Text>Are you sure?</Text>;
    const { lastFrame } = render(
      <ConsentPrompt
        prompt={prompt}
        onConfirm={onConfirm}
        terminalWidth={terminalWidth}
      />,
    );

    expect(MockedMarkdownDisplay).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Are you sure?');
  });

  it('pages through a long review without truncating the final changes', async () => {
    const review = Array.from(
      { length: 28 },
      (_, index) => `Topic ${index + 1}`,
    ).join('\n');
    const { lastFrame } = render(
      <ConsentPrompt
        prompt="Apply these changes?"
        reviewText={review}
        onConfirm={onConfirm}
        terminalWidth={80}
        availableTerminalHeight={19}
      />,
    );
    expect(lastFrame()).toContain('Page 1/3');
    expect(lastFrame()).not.toContain('Topic 28');

    const press = async (name: string) => {
      const [handleKeypress] = vi.mocked(useKeypress).mock.lastCall!;
      await act(async () => handleKeypress({ name } as Key));
    };
    await press('pagedown');
    await press('pagedown');
    expect(lastFrame()).toContain('Topic 28');
    expect(lastFrame()).toContain('Page 3/3');
    expect(onConfirm).not.toHaveBeenCalled();
    await press('pageup');
    expect(lastFrame()).toContain('Page 2/3');
  });

  it('calls onConfirm with true when "Yes" is selected', () => {
    const prompt = 'Are you sure?';
    render(
      <ConsentPrompt
        prompt={prompt}
        onConfirm={onConfirm}
        terminalWidth={terminalWidth}
      />,
    );

    const onSelect = MockedRadioButtonSelect.mock.calls[0][0].onSelect;
    onSelect(true);

    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('calls onConfirm with false when "No" is selected', () => {
    const prompt = 'Are you sure?';
    render(
      <ConsentPrompt
        prompt={prompt}
        onConfirm={onConfirm}
        terminalWidth={terminalWidth}
      />,
    );

    const onSelect = MockedRadioButtonSelect.mock.calls[0][0].onSelect;
    onSelect(false);

    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('passes correct items to RadioButtonSelect', () => {
    const prompt = 'Are you sure?';
    render(
      <ConsentPrompt
        prompt={prompt}
        onConfirm={onConfirm}
        terminalWidth={terminalWidth}
      />,
    );

    expect(MockedRadioButtonSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          { label: 'Yes', value: true, key: 'Yes' },
          { label: 'No', value: false, key: 'No' },
        ],
      }),
      undefined,
    );
  });
});
