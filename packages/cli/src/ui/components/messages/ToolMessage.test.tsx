/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from 'ink-testing-library';
import type { ToolMessageProps } from './ToolMessage.js';
import { ToolMessage } from './ToolMessage.js';
import { StreamingState, ToolCallStatus } from '../../types.js';
import { Text } from 'ink';
import { StreamingContext } from '../../contexts/StreamingContext.js';
import type {
  AnsiOutput,
  AnsiOutputDisplay,
  Config,
} from '@qwen-code/qwen-code-core';

vi.mock('../TerminalOutput.js', () => ({
  TerminalOutput: function MockTerminalOutput({
    cursor,
  }: {
    cursor: { x: number; y: number } | null;
  }) {
    return (
      <Text>
        MockCursor:({cursor?.x},{cursor?.y})
      </Text>
    );
  },
}));

vi.mock('../AnsiOutput.js', () => ({
  AnsiOutputText: function MockAnsiOutputText({ data }: { data: AnsiOutput }) {
    // Simple serialization for snapshot stability
    const serialized = data
      .map((line) => line.map((token) => token.text || '').join(''))
      .join('\n');
    return <Text>MockAnsiOutput:{serialized}</Text>;
  },
}));

// Mock child components or utilities if they are complex or have side effects
vi.mock('../GeminiRespondingSpinner.js', () => ({
  GeminiRespondingSpinner: ({
    nonRespondingDisplay,
  }: {
    nonRespondingDisplay?: string;
  }) => {
    const streamingState = React.useContext(StreamingContext)!;
    if (streamingState === StreamingState.Responding) {
      return <Text>MockRespondingSpinner</Text>;
    }
    return nonRespondingDisplay ? <Text>{nonRespondingDisplay}</Text> : null;
  },
}));
vi.mock('./DiffRenderer.js', () => ({
  DiffRenderer: function MockDiffRenderer({
    diffContent,
  }: {
    diffContent: string;
  }) {
    return <Text>MockDiff:{diffContent}</Text>;
  },
}));
vi.mock('../../utils/MarkdownDisplay.js', () => ({
  MarkdownDisplay: function MockMarkdownDisplay({ text }: { text: string }) {
    return <Text>MockMarkdown:{text}</Text>;
  },
}));
vi.mock('../subagents/index.js', () => ({
  AgentExecutionDisplay: function MockAgentExecutionDisplay({
    data,
  }: {
    data: { subagentName: string; taskDescription: string };
  }) {
    return (
      <Text>
        🤖 {data.subagentName} • Task: {data.taskDescription}
      </Text>
    );
  },
}));

// Helper to render with context
const renderWithContext = (
  ui: React.ReactElement,
  streamingState: StreamingState,
) => {
  const contextValue: StreamingState = streamingState;
  return render(
    <StreamingContext.Provider value={contextValue}>
      {ui}
    </StreamingContext.Provider>,
  );
};

describe('<ToolMessage />', () => {
  const mockConfig = {} as Config;

  const baseProps: ToolMessageProps = {
    callId: 'tool-123',
    name: 'test-tool',
    description: 'A tool for testing',
    resultDisplay: 'Test result',
    status: ToolCallStatus.Success,
    terminalWidth: 80,
    confirmationDetails: undefined,
    emphasis: 'medium',
    config: mockConfig,
  };

  it('renders basic tool information', () => {
    const { lastFrame } = renderWithContext(
      <ToolMessage {...baseProps} />,
      StreamingState.Idle,
    );
    const output = lastFrame();
    expect(output).toContain('✓'); // Success indicator
    expect(output).toContain('test-tool');
    expect(output).toContain('A tool for testing');
    expect(output).toContain('MockMarkdown:Test result');
  });

  describe('ToolStatusIndicator rendering', () => {
    it('shows ✓ for Success status', () => {
      const { lastFrame } = renderWithContext(
        <ToolMessage {...baseProps} status={ToolCallStatus.Success} />,
        StreamingState.Idle,
      );
      expect(lastFrame()).toContain('✓');
    });

    it('shows o for Pending status', () => {
      const { lastFrame } = renderWithContext(
        <ToolMessage {...baseProps} status={ToolCallStatus.Pending} />,
        StreamingState.Idle,
      );
      expect(lastFrame()).toContain('o');
    });

    it('shows ? for Confirming status', () => {
      const { lastFrame } = renderWithContext(
        <ToolMessage {...baseProps} status={ToolCallStatus.Confirming} />,
        StreamingState.Idle,
      );
      expect(lastFrame()).toContain('?');
    });

    it('shows - for Canceled status', () => {
      const { lastFrame } = renderWithContext(
        <ToolMessage {...baseProps} status={ToolCallStatus.Canceled} />,
        StreamingState.Idle,
      );
      expect(lastFrame()).toContain('-');
    });

    it('shows x for Error status', () => {
      const { lastFrame } = renderWithContext(
        <ToolMessage {...baseProps} status={ToolCallStatus.Error} />,
        StreamingState.Idle,
      );
      expect(lastFrame()).toContain('x');
    });

    it('shows paused spinner for Executing status when streamingState is Idle', () => {
      const { lastFrame } = renderWithContext(
        <ToolMessage {...baseProps} status={ToolCallStatus.Executing} />,
        StreamingState.Idle,
      );
      expect(lastFrame()).toContain('⊷');
      expect(lastFrame()).not.toContain('MockRespondingSpinner');
      expect(lastFrame()).not.toContain('✓');
    });

    it('shows paused spinner for Executing status when streamingState is WaitingForConfirmation', () => {
      const { lastFrame } = renderWithContext(
        <ToolMessage {...baseProps} status={ToolCallStatus.Executing} />,
        StreamingState.WaitingForConfirmation,
      );
      expect(lastFrame()).toContain('⊷');
      expect(lastFrame()).not.toContain('MockRespondingSpinner');
      expect(lastFrame()).not.toContain('✓');
    });

    it('shows MockRespondingSpinner for Executing status when streamingState is Responding', () => {
      const { lastFrame } = renderWithContext(
        <ToolMessage {...baseProps} status={ToolCallStatus.Executing} />,
        StreamingState.Responding, // Simulate app still responding
      );
      expect(lastFrame()).toContain('MockRespondingSpinner');
      expect(lastFrame()).not.toContain('✓');
    });
  });

  it('renders DiffRenderer for diff results', () => {
    const diffResult = {
      fileDiff: '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new',
      fileName: 'file.txt',
      originalContent: 'old',
      newContent: 'new',
    };
    const { lastFrame } = renderWithContext(
      <ToolMessage {...baseProps} resultDisplay={diffResult} />,
      StreamingState.Idle,
    );
    // Check that the output contains the MockDiff content as part of the whole message
    expect(lastFrame()).toMatch(/MockDiff:--- a\/file\.txt/);
  });

  it('renders emphasis correctly', () => {
    const { lastFrame: highEmphasisFrame } = renderWithContext(
      <ToolMessage {...baseProps} emphasis="high" />,
      StreamingState.Idle,
    );
    // Check for trailing indicator or specific color if applicable (Colors are not easily testable here)
    expect(highEmphasisFrame()).toContain('←'); // Trailing indicator for high emphasis

    const { lastFrame: lowEmphasisFrame } = renderWithContext(
      <ToolMessage {...baseProps} emphasis="low" />,
      StreamingState.Idle,
    );
    // For low emphasis, the name and description might be dimmed (check for dimColor if possible)
    // This is harder to assert directly in text output without color checks.
    // We can at least ensure it doesn't have the high emphasis indicator.
    expect(lowEmphasisFrame()).not.toContain('←');
  });

  it('shows subagent execution display for task tool with proper result display', () => {
    const subagentResultDisplay = {
      type: 'task_execution' as const,
      subagentName: 'file-search',
      taskDescription: 'Search for files matching pattern',
      taskPrompt: 'Search for files matching pattern',
      status: 'running' as const,
    };

    const props: ToolMessageProps = {
      name: 'task',
      description: 'Delegate task to subagent',
      resultDisplay: subagentResultDisplay,
      status: ToolCallStatus.Executing,
      terminalWidth: 80,
      callId: 'test-call-id-2',
      confirmationDetails: undefined,
      config: mockConfig,
    };

    const { lastFrame } = renderWithContext(
      <ToolMessage {...props} />,
      StreamingState.Responding,
    );

    const output = lastFrame();
    expect(output).toContain('🤖'); // Subagent execution display should show
    expect(output).toContain('file-search'); // Actual subagent name
    expect(output).toContain('Search for files matching pattern'); // Actual task description
  });

  it('renders AnsiOutputText for AnsiOutput results', () => {
    const ansiResult: AnsiOutput = [
      [
        {
          text: 'hello',
          fg: '#ffffff',
          bg: '#000000',
          bold: false,
          italic: false,
          underline: false,
          dim: false,
          inverse: false,
        },
      ],
    ];
    const ansiOutputDisplay: AnsiOutputDisplay = { ansiOutput: ansiResult };
    const { lastFrame } = renderWithContext(
      <ToolMessage {...baseProps} resultDisplay={ansiOutputDisplay} />,
      StreamingState.Idle,
    );
    expect(lastFrame()).toContain('MockAnsiOutput:hello');
  });
});
