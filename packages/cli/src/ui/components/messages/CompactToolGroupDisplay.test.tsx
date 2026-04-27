/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { CompactToolGroupDisplay } from './CompactToolGroupDisplay.js';
import { ToolCallStatus } from '../../types.js';
import type { IndividualToolCallDisplay } from '../../types.js';

// ToolStatusIndicator pulls in GeminiRespondingSpinner which requires
// StreamingContext; stub it out so we can test the elapsed/timeout
// plumbing in isolation.
vi.mock('../shared/ToolStatusIndicator.js', () => ({
  ToolStatusIndicator: () => <Text>•</Text>,
  STATUS_INDICATOR_WIDTH: 2,
}));

const NOW = 1_700_000_000_000;

function shellTool(
  overrides: Partial<IndividualToolCallDisplay> = {},
): IndividualToolCallDisplay {
  return {
    callId: 'c1',
    name: 'Shell',
    description: 'sleep 10',
    status: ToolCallStatus.Executing,
    executionStartTime: NOW,
    resultDisplay: undefined,
    confirmationDetails: undefined,
    ...overrides,
  };
}

function toolCall(
  overrides: Partial<IndividualToolCallDisplay> = {},
): IndividualToolCallDisplay {
  return {
    callId: 'call-1',
    name: 'read_file',
    description: 'Read a.ts',
    resultDisplay: 'file contents',
    status: ToolCallStatus.Success,
    confirmationDetails: undefined,
    renderOutputAsMarkdown: false,
    ...overrides,
  };
}

describe('<CompactToolGroupDisplay /> — shell timeout plumbing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces shell timeoutMs inline via ToolElapsedTime', () => {
    const tool = shellTool({
      resultDisplay: {
        ansiOutput: [],
        totalLines: 0,
        totalBytes: 0,
        timeoutMs: 30_000,
      },
    });
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={[tool]} contentWidth={80} />,
    );
    expect(lastFrame()).toContain('(0s · timeout 30s)');
  });

  it('falls back to quiet elapsed-only when no timeout is surfaced', () => {
    const tool = shellTool({
      resultDisplay: {
        ansiOutput: [],
        totalLines: 0,
        totalBytes: 0,
      },
    });
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={[tool]} contentWidth={80} />,
    );
    // Sub-3s without a timeout budget → indicator is quiet.
    expect(lastFrame()).not.toContain('timeout');
    expect(lastFrame()).not.toContain('0s');
  });

  it('ignores non-ansi resultDisplay shapes', () => {
    const tool = shellTool({
      resultDisplay: 'plain text output',
    });
    const { lastFrame, rerender } = render(
      <CompactToolGroupDisplay toolCalls={[tool]} contentWidth={80} />,
    );
    vi.advanceTimersByTime(5_000);
    rerender(<CompactToolGroupDisplay toolCalls={[tool]} contentWidth={80} />);
    // No timeout in display → legacy 3s-threshold elapsed.
    expect(lastFrame()).toContain('5s');
    expect(lastFrame()).not.toContain('timeout');
  });
});

describe('<CompactToolGroupDisplay /> — summary label', () => {
  it('renders default header (active tool name + count) when no compactLabel is provided', () => {
    const tools = [
      toolCall({ callId: 'c1', name: 'read_file' }),
      toolCall({ callId: 'c2', name: 'read_file' }),
      toolCall({ callId: 'c3', name: 'grep' }),
    ];
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={tools} contentWidth={80} />,
    );
    const frame = lastFrame()!;
    // Active tool = last in array when none are executing/confirming.
    expect(frame).toContain('grep');
    expect(frame).toContain('× 3');
  });

  it('replaces header with compactLabel when provided', () => {
    const tools = [
      toolCall({ callId: 'c1', name: 'read_file' }),
      toolCall({ callId: 'c2', name: 'grep' }),
    ];
    const { lastFrame } = render(
      <CompactToolGroupDisplay
        toolCalls={tools}
        contentWidth={80}
        compactLabel="Searched in auth/"
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Searched in auth/');
    expect(frame).toContain('2 tools');
    // The raw tool name should not appear as the primary header when a
    // summary is shown.
    expect(frame).not.toContain('read_file × 2');
  });

  it('shows tool count suffix only when multiple tools are present', () => {
    const tools = [toolCall({ callId: 'c1', name: 'read_file' })];
    const { lastFrame } = render(
      <CompactToolGroupDisplay
        toolCalls={tools}
        contentWidth={80}
        compactLabel="Read config.json"
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('Read config.json');
    expect(frame).not.toContain('tools');
  });

  it('renders nothing for empty tool calls', () => {
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={[]} contentWidth={80} />,
    );
    expect(lastFrame()).toBe('');
  });

  it('preserves default rendering for shell commands without label', () => {
    const tools = [
      toolCall({
        callId: 'c1',
        name: 'Bash',
        description: 'ls -la',
      }),
    ];
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={tools} contentWidth={80} />,
    );
    expect(lastFrame()).toContain('Bash');
    expect(lastFrame()).toContain('ls -la');
  });
});
