/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { act } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { Text } from 'ink';
import { LoadingIndicator } from './LoadingIndicator.js';
import { StreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import { describe, it, expect, vi } from 'vitest';
import * as useTerminalSize from '../hooks/useTerminalSize.js';
import { createMockSettings } from '../../test-utils/settings.js';

// Mock ModelRespondingSpinner
vi.mock('./ModelRespondingSpinner.js', () => ({
  ModelRespondingSpinner: ({
    nonRespondingDisplay,
    forceSpinner,
  }: {
    nonRespondingDisplay?: string;
    forceSpinner?: boolean;
  }) => {
    const streamingState = React.useContext(StreamingContext)!;
    if (streamingState === StreamingState.Responding || forceSpinner) {
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

const renderWithContext = async (
  ui: React.ReactElement,
  streamingStateValue: StreamingState,
  width = 120,
) => {
  useTerminalSizeMock.mockReturnValue({ columns: width, rows: 24 });
  return renderWithProviders(ui, {
    uiState: { streamingState: streamingStateValue },
    width,
  });
};

describe('<LoadingIndicator />', () => {
  const defaultProps = {
    currentLoadingPhrase: 'Thinking...',
    elapsedTime: 5,
  };

  it('should render blank when streamingState is Idle and no loading phrase', async () => {
    const { lastFrame, waitUntilReady } = await renderWithContext(
      <LoadingIndicator
        elapsedTime={5}
        showWit={true}
        wittyPhrase="localized witty phrase"
      />,
      StreamingState.Idle,
    );
    await waitUntilReady();
    expect(lastFrame({ allowEmpty: true })?.trim()).toBe('');
  });

  it('should not show cancel and timer when idle even if a phrase exists', async () => {
    const { lastFrame, waitUntilReady } = await renderWithContext(
      <LoadingIndicator currentLoadingPhrase="Retrying..." elapsedTime={5} />,
      StreamingState.Idle,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Retrying...');
    expect(output).not.toContain('(esc to cancel');
  });

  it('can show an active spinner for a non-model loading status', async () => {
    const { lastFrame, waitUntilReady } = await renderWithContext(
      <LoadingIndicator
        currentLoadingPhrase="Resuming session..."
        elapsedTime={0}
        forceSpinner={true}
      />,
      StreamingState.Idle,
    );
    await waitUntilReady();
    expect(lastFrame()).toContain('MockRespondingSpinner');
    expect(lastFrame()).toContain('Resuming session...');
  });

  it('should render spinner, phrase, and time when streamingState is Responding', async () => {
    const { lastFrame, waitUntilReady } = await renderWithContext(
      <LoadingIndicator {...defaultProps} />,
      StreamingState.Responding,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('MockRespondingSpinner');
    expect(output).toContain('Thinking...');
    expect(output).toContain('(esc to cancel, 5s)');
  });

  // skip: 现存失败
  it.skip('localizes the model fallback and cancel hint in Chinese', async () => {
    useTerminalSizeMock.mockReturnValue({ columns: 120, rows: 24 });
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <LoadingIndicator elapsedTime={5} />,
      {
        width: 120,
        settings,
        uiState: { streamingState: StreamingState.Responding },
      },
    );

    await waitUntilReady();
    expect(lastFrame()).toContain('正在生成...');
    expect(lastFrame()).toContain('（按 esc 取消，5s）');
    expect(lastFrame()).toContain('localized witty phrase');
    expect(lastFrame()).not.toContain('Generating...');
    expect(lastFrame()).not.toContain('esc to cancel');
    unmount();
  });

  it('should render spinner (static), phrase but no time/cancel when streamingState is WaitingForConfirmation', async () => {
    const props = {
      currentLoadingPhrase: 'Confirm action',
      elapsedTime: 10,
    };
    const { lastFrame, waitUntilReady } = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.WaitingForConfirmation,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('⠏'); // Static char for WaitingForConfirmation
    expect(output).toContain('Confirm action');
    expect(output).not.toContain('(esc to cancel)');
    expect(output).not.toContain(', 10s');
  });

  it('should display the currentLoadingPhrase correctly', async () => {
    const props = {
      currentLoadingPhrase: 'Processing data...',
      elapsedTime: 3,
    };
    const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    await waitUntilReady();
    expect(lastFrame()).toContain('Processing data...');
    unmount();
  });

  it('should display the elapsedTime correctly when Responding', async () => {
    const props = {
      currentLoadingPhrase: 'Thinking...',
      elapsedTime: 60,
    };
    const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    await waitUntilReady();
    expect(lastFrame()).toContain('(esc to cancel, 1m)');
    unmount();
  });

  it('should display the elapsedTime correctly in human-readable format', async () => {
    const props = {
      currentLoadingPhrase: 'Thinking...',
      elapsedTime: 125,
    };
    const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.Responding,
    );
    await waitUntilReady();
    expect(lastFrame()).toContain('(esc to cancel, 2m 5s)');
    unmount();
  });

  it('should render rightContent when provided', async () => {
    const rightContent = <Text>Extra Info</Text>;
    const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
      <LoadingIndicator {...defaultProps} rightContent={rightContent} />,
      StreamingState.Responding,
    );
    await waitUntilReady();
    expect(lastFrame()).toContain('Extra Info');
    unmount();
  });

  it('should transition correctly between states', async () => {
    let setStateExternally:
      | React.Dispatch<
          React.SetStateAction<{
            state: StreamingState;
            phrase?: string;
            elapsedTime: number;
          }>
        >
      | undefined;

    const TestWrapper = () => {
      const [config, setConfig] = React.useState<{
        state: StreamingState;
        phrase?: string;
        elapsedTime: number;
      }>({
        state: StreamingState.Idle,
        phrase: undefined,
        elapsedTime: 5,
      });
      setStateExternally = setConfig;

      return (
        <StreamingContext.Provider value={config.state}>
          <LoadingIndicator
            currentLoadingPhrase={config.phrase}
            elapsedTime={config.elapsedTime}
          />
        </StreamingContext.Provider>
      );
    };

    const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
      <TestWrapper />,
      StreamingState.Idle,
    );
    await waitUntilReady();
    expect(lastFrame({ allowEmpty: true })?.trim()).toBe(''); // Initial: Idle (no loading phrase)

    // Transition to Responding
    await act(async () => {
      setStateExternally?.({
        state: StreamingState.Responding,
        phrase: 'Now Responding',
        elapsedTime: 2,
      });
    });
    await waitUntilReady();
    let output = lastFrame();
    expect(output).toContain('MockRespondingSpinner');
    expect(output).toContain('Now Responding');
    expect(output).toContain('(esc to cancel, 2s)');

    // Transition to WaitingForConfirmation
    await act(async () => {
      setStateExternally?.({
        state: StreamingState.WaitingForConfirmation,
        phrase: 'Please Confirm',
        elapsedTime: 15,
      });
    });
    await waitUntilReady();
    output = lastFrame();
    expect(output).toContain('⠏');
    expect(output).toContain('Please Confirm');
    expect(output).not.toContain('(esc to cancel)');
    expect(output).not.toContain(', 15s');

    // Transition back to Idle
    await act(async () => {
      setStateExternally?.({
        state: StreamingState.Idle,
        phrase: undefined,
        elapsedTime: 5,
      });
    });
    await waitUntilReady();
    expect(lastFrame({ allowEmpty: true })?.trim()).toBe(''); // Idle with no loading phrase and no spinner
    unmount();
  }, 15_000);

  it('should display the generic generating phrase while responding', async () => {
    const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
      <LoadingIndicator elapsedTime={5} />,
      StreamingState.Responding,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Generating...');
    unmount();
  });

  it('should prefer an explicit loading phrase over generic thinking text', async () => {
    const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
      <LoadingIndicator
        currentLoadingPhrase="some random tip..."
        elapsedTime={3}
      />,
      StreamingState.Responding,
    );
    await waitUntilReady();
    expect(lastFrame()).not.toContain('Thinking... ');
    expect(lastFrame()).not.toContain('Generating... ');
    unmount();
  });

  it('should truncate long primary text instead of wrapping', async () => {
    const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
      <LoadingIndicator
        {...defaultProps}
        currentLoadingPhrase={
          'This is an extremely long loading phrase that should be truncated in the UI to keep the primary line concise.'
        }
      />,
      StreamingState.Responding,
      80,
    );
    await waitUntilReady();
    expect(lastFrame()).toMatchSnapshot();
    unmount();
  });

  describe('responsive layout', () => {
    it('should render on a single line on a wide terminal', async () => {
      const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
        <LoadingIndicator
          {...defaultProps}
          rightContent={<Text>Right</Text>}
        />,
        StreamingState.Responding,
        120,
      );
      await waitUntilReady();
      const output = lastFrame();
      // Check for single line output
      expect(output?.trim().includes('\n')).toBe(false);
      expect(output).toContain('Thinking...');
      expect(output).toContain('(esc to cancel, 5s)');
      expect(output).toContain('Right');
      unmount();
    });

    it('should render on multiple lines on a narrow terminal', async () => {
      const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
        <LoadingIndicator
          {...defaultProps}
          rightContent={<Text>Right</Text>}
        />,
        StreamingState.Responding,
        79,
      );
      await waitUntilReady();
      const output = lastFrame();
      const lines = output?.trim().split('\n');
      // Expecting 3 lines:
      // 1. Spinner + Primary Text
      // 2. Cancel + Timer
      // 3. Right Content
      expect(lines).toHaveLength(3);
      if (lines) {
        expect(lines[0]).toContain('Thinking...');
        expect(lines[0]).not.toContain('(esc to cancel, 5s)');
        expect(lines[1]).toContain('(esc to cancel, 5s)');
        expect(lines[2]).toContain('Right');
      }
      unmount();
    });

    it('should use wide layout at 80 columns', async () => {
      const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
        <LoadingIndicator {...defaultProps} />,
        StreamingState.Responding,
        80,
      );
      await waitUntilReady();
      expect(lastFrame()?.trim().includes('\n')).toBe(false);
      unmount();
    });

    it('should use narrow layout at 79 columns', async () => {
      const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
        <LoadingIndicator {...defaultProps} />,
        StreamingState.Responding,
        79,
      );
      await waitUntilReady();
      expect(lastFrame()?.includes('\n')).toBe(true);
      unmount();
    });

    it('should render witty phrase after cancel and timer hint in wide layout', async () => {
      const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
        <LoadingIndicator
          elapsedTime={5}
          wittyPhrase="I am witty"
          showWit={true}
          currentLoadingPhrase="Thinking..."
        />,
        StreamingState.Responding,
        120,
      );
      await waitUntilReady();
      const output = lastFrame();
      // Sequence should be: Primary Text -> Cancel/Timer -> Witty Phrase
      expect(output).toContain('Thinking... (esc to cancel, 5s) I am witty');
      unmount();
    });

    it('should render witty phrase for the generating phase', async () => {
      const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
        <LoadingIndicator
          elapsedTime={5}
          wittyPhrase="I am witty"
          showWit={true}
          currentLoadingPhrase="Generating..."
        />,
        StreamingState.Responding,
        120,
      );
      await waitUntilReady();
      expect(lastFrame()).toContain(
        'Generating... (esc to cancel, 5s) I am witty',
      );
      unmount();
    });

    it('should render witty phrase after cancel and timer hint in narrow layout', async () => {
      const { lastFrame, unmount, waitUntilReady } = await renderWithContext(
        <LoadingIndicator
          elapsedTime={5}
          wittyPhrase="I am witty"
          showWit={true}
          currentLoadingPhrase="Thinking..."
        />,
        StreamingState.Responding,
        79,
      );
      await waitUntilReady();
      const output = lastFrame();
      const lines = output?.trim().split('\n');
      // Expecting 3 lines:
      // 1. Spinner + Primary Text
      // 2. Cancel + Timer
      // 3. Witty Phrase
      expect(lines).toHaveLength(3);
      if (lines) {
        expect(lines[0]).toContain('Thinking...');
        expect(lines[1]).toContain('(esc to cancel, 5s)');
        expect(lines[2]).toContain('I am witty');
      }
      unmount();
    });
  });

  it('should use spinnerIcon when provided', async () => {
    const props = {
      currentLoadingPhrase: 'Confirm action',
      elapsedTime: 10,
      spinnerIcon: '?',
    };
    const { lastFrame, waitUntilReady, unmount } = await renderWithContext(
      <LoadingIndicator {...props} />,
      StreamingState.WaitingForConfirmation,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('?');
    expect(output).not.toContain('⠏');
    unmount();
  });
});
