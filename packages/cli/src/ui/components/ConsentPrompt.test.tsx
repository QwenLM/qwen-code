/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { ConsentPrompt } from './ConsentPrompt.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { MarkdownDisplay } from '../utils/MarkdownDisplay.js';

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
