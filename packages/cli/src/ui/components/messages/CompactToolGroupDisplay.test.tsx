/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import {
  CompactToolGroupDisplay,
  buildToolSummary,
  isCollapsibleTool,
} from './CompactToolGroupDisplay.js';
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
  it('renders semantic summary for collapsible tools', () => {
    const tools = [
      toolCall({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      toolCall({ callId: 'c2', name: 'ReadFile', description: 'b.ts' }),
      toolCall({ callId: 'c3', name: 'Grep', description: 'search pattern' }),
    ];
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={tools} contentWidth={80} />,
    );
    const frame = lastFrame()!;
    // CATEGORY_ORDER: search → read → list → ...
    expect(frame).toContain('Searched 1 pattern');
    expect(frame).toContain('read 2 files');
  });

  it('renders nothing for empty tool calls', () => {
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={[]} contentWidth={80} />,
    );
    expect(lastFrame()).toBe('');
  });

  it('renders semantic summary for shell commands without label', () => {
    const tools = [
      toolCall({
        callId: 'c1',
        name: 'Shell',
        description: 'ls -la',
      }),
    ];
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={tools} contentWidth={80} />,
    );
    expect(lastFrame()).toContain('Ran 1 command');
  });
});

describe('buildToolSummary', () => {
  const make = (
    overrides: Partial<IndividualToolCallDisplay>,
  ): IndividualToolCallDisplay => ({
    callId: 'c1',
    name: 'ReadFile',
    description: 'a.ts',
    status: ToolCallStatus.Success,
    resultDisplay: '',
    confirmationDetails: undefined,
    ...overrides,
  });

  it('returns empty string for empty array', () => {
    expect(buildToolSummary([], false)).toBe('');
  });

  it('single tool uses count format', () => {
    expect(buildToolSummary([make({})], false)).toBe('Read 1 file');
  });

  it('single tool uses progressive verb when active', () => {
    expect(buildToolSummary([make({})], true)).toBe('Reading 1 file');
  });

  it('multiple same-type tools use count', () => {
    const tools = [
      make({ callId: 'c1', description: 'a.ts' }),
      make({ callId: 'c2', description: 'b.ts' }),
      make({ callId: 'c3', description: 'c.ts' }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Read 3 files');
  });

  it('mixed types joined with comma and lowercase verbs', () => {
    const tools = [
      make({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      make({ callId: 'c2', name: 'Edit', description: 'b.ts' }),
      make({ callId: 'c3', name: 'Shell', description: 'npm test' }),
    ];
    // CATEGORY_ORDER: search → read → list → command → edit
    expect(buildToolSummary(tools, false)).toBe(
      'Read 1 file, ran 1 command, edited 1 file',
    );
  });

  it('respects CATEGORY_ORDER (read before command)', () => {
    const tools = [
      make({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      make({ callId: 'c2', name: 'Shell', description: 'ls' }),
    ];
    const result = buildToolSummary(tools, false);
    expect(result).toBe('Read 1 file, ran 1 command');
  });

  it('unknown tool names fall to other category', () => {
    const tools = [
      make({ callId: 'c1', name: 'UnknownTool', description: 'something' }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Used 1 tool');
  });

  it('mixed group with count per category', () => {
    const tools = [
      make({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      make({ callId: 'c2', name: 'ReadFile', description: 'b.ts' }),
      make({ callId: 'c3', name: 'Shell', description: 'npm test' }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Read 2 files, ran 1 command');
  });
});

describe('isCollapsibleTool', () => {
  it('returns true for read/search/list tools', () => {
    expect(isCollapsibleTool('ReadFile')).toBe(true);
    expect(isCollapsibleTool('Grep')).toBe(true);
    expect(isCollapsibleTool('Glob')).toBe(true);
    expect(isCollapsibleTool('ListFiles')).toBe(true);
    expect(isCollapsibleTool('Read File')).toBe(true);
    expect(isCollapsibleTool('Read File(s)')).toBe(true);
    expect(isCollapsibleTool('Read Directory')).toBe(true);
  });

  it('returns false for mutation/command/agent tools', () => {
    expect(isCollapsibleTool('Shell')).toBe(false);
    expect(isCollapsibleTool('Edit')).toBe(false);
    expect(isCollapsibleTool('WriteFile')).toBe(false);
    expect(isCollapsibleTool('Agent')).toBe(false);
    expect(isCollapsibleTool('Workflow')).toBe(false);
    expect(isCollapsibleTool('NotebookEdit')).toBe(false);
  });

  it('returns false for unknown tool names', () => {
    expect(isCollapsibleTool('CustomMcpTool')).toBe(false);
    expect(isCollapsibleTool('unknown')).toBe(false);
  });
});
