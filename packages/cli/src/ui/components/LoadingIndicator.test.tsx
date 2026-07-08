/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { LoadingIndicator } from './LoadingIndicator.js';
import { StreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import { vi } from 'vitest';
import * as useTerminalSize from '../hooks/useTerminalSize.js';

// Mock GeminiRespondingSpinner
vi.mock('./GeminiRespondingSpinner.js', () => ({
  GeminiRespondingSpinner: ({
    nonRespondingDisplay,
  }: {
    nonRespondingDisplay?: string;
  }) => {
    const streamingState = React.useContext(StreamingContext)!;
    if (streamingState === StreamingState.Responding) {
      return <Text>MockRespondingSpinner</Text>;
    } else if (nonRespondingDisplay) {
      return <Text>{nonRespondingDisplay}</Text>;
    }
    return null;
  },
}));

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(),
}));

const useTerminalSizeMock = vi.mocked(useTerminalSize.useTerminalSize);

const renderWithContext = (
  ui: React.ReactElement,
  streamingStateValue: StreamingState,
  width = 120,
) => {
  useTerminalSizeMock.mockReturnValue({ columns: width, rows: 24 });
  const contextValue: StreamingState = streamingStateValue;
  return render(
    <StreamingContext.Provider value={contextValue}>
      {ui}
    </StreamingContext.Provider>,
  );
};

describe('<LoadingIndicator />', () => {
  const defaultProps = {
    currentLoadingPhrase: 'Loading...',
    elapsedTime: 5,
  };

  it('should not render when streamingState is Idle', () => {
    const { lastFrame } = renderWithContext(
      <LoadingIndicator {...defaultProps} />,
      StreamingState.Idle,
    );
    expect(lastFrame()).toBe('');
  });

  it('should render spinner, phrase, and time when streamingState is Responding', () => {
    const { lastFrame } = renderWithContext(
      <LoadingIndicator {...defaultProps} />,
      StreamingState.Responding,
    );
    const output = lastFrame();
    expect(output).toContain('MockRespondingSpinner');
    expect(output).toContain('Loading...');
    expect(output).toContain('5.0s');
    expect(output).toContain('esc to cancel');
  });

  it('should render spinner (static), phrase but no time/cancel when streamingState is WaitingForConfirmation', () => {
    const props = {
      currentLoadingPhrase: 'Confirm action',
      elapsedTime: 10,
    };
    const { lastFrame } = renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.WaitingForConfirmation,
    );
    const output = lastFrame();
    expect(output).toContain('⠏'); // Static char for WaitingForConfirmation
    expect(output).toContain('Confirm action');
    expect(output).not.toContain('(esc to cancel)');
    expect(output).not.toContain('10.0s');
  });

  it('should display the currentLoadingPhrase correctly', () => {
    const props = {
      currentLoadingPhrase: 'Processing data...',
      elapsedTime: 3,
    };
    const { lastFrame } = renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    expect(lastFrame()).toContain('Processing data...');
  });

  it('should keep a fixed-width time string across 0.5s ticks below one minute (#6402)', () => {
    // The timer ticks at 0.5s resolution; without the fixed decimal the
    // string alternates between "1s" and "1.5s" and the status line jitters.
    const half = renderWithContext(
      <LoadingIndicator currentLoadingPhrase="Working..." elapsedTime={1.5} />,
      StreamingState.Responding,
    );
    expect(half.lastFrame()).toContain('(1.5s · esc to cancel)');

    const whole = renderWithContext(
      <LoadingIndicator currentLoadingPhrase="Working..." elapsedTime={2} />,
      StreamingState.Responding,
    );
    expect(whole.lastFrame()).toContain('(2.0s · esc to cancel)');
  });

  it('should display the elapsedTime correctly when Responding', () => {
    const props = {
      currentLoadingPhrase: 'Working...',
      elapsedTime: 60,
    };
    const { lastFrame } = renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    expect(lastFrame()).toContain('(1m · esc to cancel)');
  });

  it('should display the elapsedTime correctly in human-readable format', () => {
    const props = {
      currentLoadingPhrase: 'Working...',
      elapsedTime: 125,
    };
    const { lastFrame } = renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    expect(lastFrame()).toContain('(2m 5s · esc to cancel)');
  });

  it('should render rightContent when provided', () => {
    const rightContent = <Text>Extra Info</Text>;
    const { lastFrame } = renderWithContext(
      <LoadingIndicator {...defaultProps} rightContent={rightContent} />,
      StreamingState.Responding,
    );
    expect(lastFrame()).toContain('Extra Info');
  });

  it('should transition correctly between states using rerender', () => {
    const { lastFrame, rerender } = renderWithContext(
      <LoadingIndicator {...defaultProps} />,
      StreamingState.Idle,
    );
    expect(lastFrame()).toBe(''); // Initial: Idle

    // Transition to Responding
    rerender(
      <StreamingContext.Provider value={StreamingState.Responding}>
        <LoadingIndicator
          currentLoadingPhrase="Now Responding"
          elapsedTime={2}
        />
      </StreamingContext.Provider>,
    );
    let output = lastFrame();
    expect(output).toContain('MockRespondingSpinner');
    expect(output).toContain('Now Responding');
    expect(output).toContain('(2.0s · esc to cancel)');

    // Transition to WaitingForConfirmation
    rerender(
      <StreamingContext.Provider value={StreamingState.WaitingForConfirmation}>
        <LoadingIndicator
          currentLoadingPhrase="Please Confirm"
          elapsedTime={15}
        />
      </StreamingContext.Provider>,
    );
    output = lastFrame();
    expect(output).toContain('⠏');
    expect(output).toContain('Please Confirm');
    expect(output).not.toContain('(esc to cancel)');
    expect(output).not.toContain('15.0s');

    // Transition back to Idle
    rerender(
      <StreamingContext.Provider value={StreamingState.Idle}>
        <LoadingIndicator {...defaultProps} />
      </StreamingContext.Provider>,
    );
    expect(lastFrame()).toBe('');
  });

  it('should truncate long primary text instead of wrapping', () => {
    const { lastFrame } = renderWithContext(
      <LoadingIndicator
        {...defaultProps}
        currentLoadingPhrase={
          'This is an extremely long loading phrase that should be truncated in the UI to keep the primary line concise.'
        }
      />,
      StreamingState.Responding,
      80,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  describe('responsive layout', () => {
    it('should render on a single line on a wide terminal', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator
          {...defaultProps}
          rightContent={<Text>Right</Text>}
        />,
        StreamingState.Responding,
        120,
      );
      const output = lastFrame();
      // Check for single line output
      expect(output?.includes('\n')).toBe(false);
      expect(output).toContain('Loading...');
      expect(output).toContain('(5.0s · esc to cancel)');
      expect(output).toContain('Right');
    });

    it('should render on multiple lines on a narrow terminal', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator
          {...defaultProps}
          rightContent={<Text>Right</Text>}
        />,
        StreamingState.Responding,
        79,
      );
      const output = lastFrame();
      const lines = output?.split('\n');
      // Expecting 3 lines:
      // 1. Spinner + Primary Text
      // 2. Cancel + Timer
      // 3. Right Content
      expect(lines).toHaveLength(3);
      if (lines) {
        expect(lines[0]).toContain('Loading...');
        expect(lines[0]).not.toContain('5.0s');
        expect(lines[1]).toContain('5.0s');
        expect(lines[2]).toContain('Right');
      }
    });

    it('should use wide layout at 80 columns', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator {...defaultProps} />,
        StreamingState.Responding,
        80,
      );
      expect(lastFrame()?.includes('\n')).toBe(false);
    });

    it('should use narrow layout at 79 columns', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator {...defaultProps} />,
        StreamingState.Responding,
        79,
      );
      expect(lastFrame()?.includes('\n')).toBe(true);
    });
  });

  describe('token display', () => {
    it('should display output tokens inline with arrow notation', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator {...defaultProps} candidatesTokens={847} />,
        StreamingState.Responding,
      );
      const output = lastFrame();
      expect(output).toContain('↓ 847 tokens');
      expect(output).not.toContain('↑');
      expect(output).toContain('5.0s');
      expect(output).toContain('esc to cancel');
    });

    it('should not display tokens when output tokens is 0', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator {...defaultProps} candidatesTokens={0} />,
        StreamingState.Responding,
      );
      const output = lastFrame();
      expect(output).not.toContain('↓');
      expect(output).not.toContain('tokens');
    });

    it('should not display tokens when props are undefined', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator {...defaultProps} />,
        StreamingState.Responding,
      );
      const output = lastFrame();
      expect(output).not.toContain('↓');
      expect(output).not.toContain('tokens');
    });

    it('should hide tokens in narrow terminal', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator {...defaultProps} candidatesTokens={500} />,
        StreamingState.Responding,
        79,
      );
      const output = lastFrame();
      expect(output).not.toContain('↓');
      expect(output).not.toContain('tokens');
      expect(output).toContain('esc to cancel');
    });

    it('should show tokens in wide terminal with inline format', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator {...defaultProps} candidatesTokens={5400} />,
        StreamingState.Responding,
        80,
      );
      const output = lastFrame();
      expect(output).toContain('↓ 5.4k tokens');
    });

    it('should format tokens inline with time and cancel', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator {...defaultProps} candidatesTokens={5400} />,
        StreamingState.Responding,
        120,
      );
      const output = lastFrame();
      expect(output).toContain('(5.0s · ↓ 5.4k tokens · esc to cancel)');
    });

    it('should not show response tokens/sec by default', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator {...defaultProps} candidatesTokens={500} />,
        StreamingState.Responding,
        120,
      );
      const output = lastFrame();
      expect(output).toContain('↓ 500 tokens');
      expect(output).not.toContain('t/s');
    });

    it('should show response tokens/sec when enabled', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator
          {...defaultProps}
          candidatesTokens={500}
          showResponseTokensPerSecond
        />,
        StreamingState.Responding,
        120,
      );
      const output = lastFrame();
      expect(output).toContain('↓ 500 tokens');
      expect(output).toContain('100 t/s');
    });

    it('should calculate response tokens/sec from tokens produced after the timer reset', () => {
      const streamingCharsRef = { current: 400 };
      const { lastFrame } = renderWithContext(
        <LoadingIndicator
          {...defaultProps}
          candidatesTokens={550}
          taskStartTokens={500}
          taskStartStreamingChars={200}
          streamingCharsRef={streamingCharsRef}
          isStreaming
          showResponseTokensPerSecond
        />,
        StreamingState.Responding,
        120,
      );
      const output = lastFrame();
      expect(output).toContain('↓ 650 tokens');
      expect(output).toContain('20 t/s');
      expect(output).not.toContain('130 t/s');
    });

    it('should not count excluded tool tokens toward response tokens/sec', () => {
      const streamingCharsRef = { current: 400 };
      const { lastFrame } = renderWithContext(
        <LoadingIndicator
          {...defaultProps}
          candidatesTokens={8000}
          taskStartTokens={8000}
          streamingCharsRef={streamingCharsRef}
          isStreaming
          showResponseTokensPerSecond
        />,
        StreamingState.Responding,
        120,
      );
      const output = lastFrame();
      expect(output).toContain('↓ 8.1k tokens');
      expect(output).toContain('20 t/s');
      expect(output).not.toContain('1620 t/s');
    });

    it('should format sub-10 response tokens/sec with one decimal place', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator
          currentLoadingPhrase="Working..."
          elapsedTime={8}
          candidatesTokens={25}
          showResponseTokensPerSecond
        />,
        StreamingState.Responding,
        120,
      );
      const output = lastFrame();
      expect(output).toContain('3.1 t/s');
    });

    it('should not show response tokens/sec before content arrives', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator
          {...defaultProps}
          candidatesTokens={500}
          showResponseTokensPerSecond
          isReceivingContent={false}
        />,
        StreamingState.Responding,
        120,
      );
      const output = lastFrame();
      expect(output).toContain('↑ 500 tokens');
      expect(output).not.toContain('t/s');
    });

    it('should show ↑ arrow when waiting for API response', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator
          {...defaultProps}
          candidatesTokens={500}
          isReceivingContent={false}
        />,
        StreamingState.Responding,
      );
      const output = lastFrame();
      expect(output).toContain('↑ 500 tokens');
      expect(output).not.toContain('↓');
    });

    it('should show ↓ arrow when receiving content (default)', () => {
      const { lastFrame } = renderWithContext(
        <LoadingIndicator {...defaultProps} candidatesTokens={500} />,
        StreamingState.Responding,
      );
      const output = lastFrame();
      expect(output).toContain('↓ 500 tokens');
      expect(output).not.toContain('↑');
    });
  });
});
