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
  estimateCompactToolGroupHeight,
  isCollapsibleTool,
} from './CompactToolGroupDisplay.js';
import { ToolCallStatus } from '../../types.js';
import type { IndividualToolCallDisplay } from '../../types.js';

// ToolStatusIndicator pulls in GeminiRespondingSpinner which requires
// StreamingContext; stub the component but keep the real constant so
// height-estimation tests stay in sync with production.
vi.mock('../shared/ToolStatusIndicator.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ToolStatusIndicator: () => <Text>•</Text>,
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
    expect(frame).toContain('Searched search pattern');
    expect(frame).toContain('read a.ts, b.ts');
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
    expect(lastFrame()).toContain('Ran ls -la');
  });

  it('wraps long summaries instead of truncating them', () => {
    const description =
      'packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx';
    const tool = toolCall({ name: 'ReadFile', description });
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={[tool]} contentWidth={30} />,
    );
    const frame = lastFrame()!;

    expect(frame.split('\n').length).toBeGreaterThan(1);
    expect(frame).not.toContain('…');
    expect(frame.replace(/\s/g, '')).toContain(`Read${description}`);
  });

  it('shows all descriptions inline when a batch is active with ≤ 3 tools', () => {
    const tools = [
      toolCall({
        callId: 'c1',
        name: 'ReadFile',
        description: 'completed.ts',
      }),
      toolCall({
        callId: 'c2',
        name: 'ReadFile',
        description: 'current.ts',
        status: ToolCallStatus.Executing,
      }),
      toolCall({
        callId: 'c3',
        name: 'ReadFile',
        description: 'queued.ts',
        status: ToolCallStatus.Pending,
      }),
    ];
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={tools} contentWidth={80} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('Reading completed.ts, current.ts, queued.ts…');
    // No redundant hint line when descriptions are already inline.
    expect(frame).not.toContain('⎿');
  });

  it('hides the description hint when a batch completes', () => {
    const tools = [
      toolCall({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      toolCall({ callId: 'c2', name: 'ReadFile', description: 'b.ts' }),
    ];
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={tools} contentWidth={80} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('Read a.ts, b.ts');
    expect(frame).not.toContain('⎿');
  });

  it('does not expose JSON fallback arguments as an active hint', () => {
    const tools = [
      toolCall({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      toolCall({
        callId: 'c2',
        name: 'ReadFile',
        description: '{"file_path":"b.ts"}',
        status: ToolCallStatus.Executing,
      }),
    ];
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={tools} contentWidth={80} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('Reading 2 files…');
    expect(frame).not.toContain('⎿');
    expect(frame).not.toContain('file_path');
  });

  it('does not repeat a description already shown for a single-tool category', () => {
    const tools = [
      toolCall({
        callId: 'c1',
        name: 'Grep',
        description: 'needle',
        status: ToolCallStatus.Executing,
      }),
      toolCall({
        callId: 'c2',
        name: 'ReadFile',
        description: 'a.ts',
      }),
    ];
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={tools} contentWidth={80} />,
    );
    const frame = lastFrame()!;

    expect(frame).toContain('Searching needle, reading a.ts…');
    expect(frame).not.toContain('⎿');
    expect(estimateCompactToolGroupHeight(tools, 80)).toBe(1);
  });

  it('keeps a 30-file active batch to two rows at 80 columns', () => {
    const tools = Array.from({ length: 30 }, (_, index) =>
      toolCall({
        callId: `c${index + 1}`,
        name: 'ReadFile',
        description: `packages/cli/src/ui/components/example-${String(
          index + 1,
        ).padStart(2, '0')}.tsx`,
        status:
          index === 29 ? ToolCallStatus.Executing : ToolCallStatus.Success,
      }),
    );
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={tools} contentWidth={80} />,
    );
    const frame = lastFrame()!;

    // Summary line wraps + hint line → at least 2 rows at 80 columns.
    expect(frame.split('\n').length).toBeGreaterThanOrEqual(2);
    expect(frame).toContain('... and 28 more');
    expect(frame).toContain('⎿ packages/cli/src/ui/components/example-30.tsx');
    expect(frame).not.toContain('example-03.tsx');
  });

  it('wraps a long inline summary without a redundant hint', () => {
    const currentPath =
      'packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx';
    const tools = [
      toolCall({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      toolCall({
        callId: 'c2',
        name: 'ReadFile',
        description: currentPath,
        status: ToolCallStatus.Executing,
      }),
    ];
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={tools} contentWidth={30} />,
    );
    const frame = lastFrame()!;

    // Summary wraps across multiple lines but no hint row.
    expect(frame).not.toContain('⎿');
    // Both descriptions appear in the wrapped summary (may be split across lines).
    expect(frame).toContain('a.ts');
    expect(frame).toContain('Display.tsx');
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

  it('single tool uses description format', () => {
    expect(buildToolSummary([make({})], false)).toBe('Read a.ts');
  });

  it('single tool uses progressive verb when active', () => {
    expect(buildToolSummary([make({})], true)).toBe('Reading a.ts');
  });

  it('multiple same-type tools show descriptions inline when ≤ 3', () => {
    const tools = [
      make({ callId: 'c1', description: 'a.ts' }),
      make({ callId: 'c2', description: 'b.ts' }),
      make({ callId: 'c3', description: 'c.ts' }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Read a.ts, b.ts, c.ts');
  });

  it('multiple same-type tools use progressive verb when active', () => {
    const tools = [
      make({ callId: 'c1', description: 'a.ts' }),
      make({ callId: 'c2', description: 'b.ts' }),
    ];
    expect(buildToolSummary(tools, true)).toBe('Reading a.ts, b.ts');
  });

  it('multiple same-type tools show first 2 + "...and N more" when > 3', () => {
    const tools = [
      make({ callId: 'c1', description: 'a.ts' }),
      make({ callId: 'c2', description: 'b.ts' }),
      make({ callId: 'c3', description: 'c.ts' }),
      make({ callId: 'c4', description: 'd.ts' }),
    ];
    expect(buildToolSummary(tools, false)).toBe(
      'Read a.ts, b.ts, ... and 2 more',
    );
  });

  it('multiple same-type tools fall back to count when descriptions are missing', () => {
    const tools = [
      make({ callId: 'c1', description: 'a.ts' }),
      make({ callId: 'c2', description: '' }),
      make({ callId: 'c3', description: 'c.ts' }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Read 3 files');
  });

  it('more than 3 tools fall back to count when preview descriptions are missing', () => {
    const tools = [
      make({ callId: 'c1', description: '' }),
      make({ callId: 'c2', description: '' }),
      make({ callId: 'c3', description: 'c.ts' }),
      make({ callId: 'c4', description: 'd.ts' }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Read 4 files');
  });

  it('mixed types joined with comma and lowercase verbs', () => {
    const tools = [
      make({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      make({ callId: 'c2', name: 'Edit', description: 'b.ts' }),
      make({ callId: 'c3', name: 'Shell', description: 'npm test' }),
    ];
    // CATEGORY_ORDER: search → read → list → command → edit
    expect(buildToolSummary(tools, false)).toBe(
      'Read a.ts, ran npm test, edited b.ts',
    );
  });

  it('respects CATEGORY_ORDER (read before command)', () => {
    const tools = [
      make({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      make({ callId: 'c2', name: 'Shell', description: 'ls' }),
    ];
    const result = buildToolSummary(tools, false);
    expect(result).toBe('Read a.ts, ran ls');
  });

  it('unknown tool names fall to other category', () => {
    const tools = [
      make({ callId: 'c1', name: 'UnknownTool', description: 'something' }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Used something');
  });

  it('falls back to count format when description is empty', () => {
    const tools = [make({ callId: 'c1', name: 'ReadFile', description: '' })];
    expect(buildToolSummary(tools, false)).toBe('Read 1 file');
  });

  it('falls back to count format when description is undefined', () => {
    const tools = [
      make({
        callId: 'c1',
        name: 'ReadFile',
        description: undefined as unknown as string,
      }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Read 1 file');
  });

  it('falls back to count format when description is JSON (error args)', () => {
    const tools = [
      make({
        callId: 'c1',
        name: 'ReadFile',
        description: '{"file_path":"/tmp/test.txt"}',
      }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Read 1 file');
  });

  it('falls back to count format when description starts with array bracket', () => {
    const tools = [
      make({ callId: 'c1', name: 'Shell', description: '["ls", "-la"]' }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Ran 1 command');
  });

  it('keeps file names that resemble JSON delimiters', () => {
    expect(buildToolSummary([make({ description: '[id].tsx' })], false)).toBe(
      'Read [id].tsx',
    );
    expect(buildToolSummary([make({ description: '{draft}.md' })], false)).toBe(
      'Read {draft}.md',
    );
  });

  it('strips ANSI CSI escape sequences from description', () => {
    const tools = [
      make({
        callId: 'c1',
        name: 'ReadFile',
        description: '\x1b[32ma.ts\x1b[0m',
      }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Read a.ts');
  });

  it('strips non-CSI ANSI sequences (charset, OSC) from description', () => {
    const tools = [
      make({ callId: 'c1', name: 'Shell', description: '\x1b(Bls -la\x1b[0m' }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Ran ls -la');
  });

  it('replaces embedded newlines with spaces in description', () => {
    const tools = [
      make({
        callId: 'c1',
        name: 'Shell',
        description: 'echo hello\nworld',
      }),
    ];
    expect(buildToolSummary(tools, false)).toBe('Ran echo hello world');
  });

  it('mixed group shows descriptions inline per category', () => {
    const tools = [
      make({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      make({ callId: 'c2', name: 'ReadFile', description: 'b.ts' }),
      make({ callId: 'c3', name: 'Shell', description: 'npm test' }),
    ];
    expect(buildToolSummary(tools, false)).toBe(
      'Read a.ts, b.ts, ran npm test',
    );
  });

  it('legacy display names map to correct categories', () => {
    const tools = [
      make({ callId: 'c1', name: 'SearchFiles', description: 'pattern' }),
      make({ callId: 'c2', name: 'ReadFolder', description: '/src' }),
    ];
    expect(buildToolSummary(tools, false)).toBe(
      'Searched pattern, listed /src',
    );
  });
});

describe('estimateCompactToolGroupHeight', () => {
  it('returns 0 when there are no tool calls', () => {
    expect(estimateCompactToolGroupHeight([], 80)).toBe(0);
  });

  it('returns 1 for summaries that fit on one line', () => {
    expect(estimateCompactToolGroupHeight([toolCall()], 80)).toBe(1);
  });

  it('accounts for wrapped long summaries', () => {
    const description =
      'packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx';
    const tool = toolCall({ name: 'ReadFile', description });

    expect(estimateCompactToolGroupHeight([tool], 30)).toBeGreaterThan(1);
  });

  it('adds one row for an active batch description hint when > 3 tools', () => {
    const tools = [
      toolCall({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      toolCall({ callId: 'c2', name: 'ReadFile', description: 'b.ts' }),
      toolCall({ callId: 'c3', name: 'ReadFile', description: 'c.ts' }),
      toolCall({
        callId: 'c4',
        name: 'ReadFile',
        description: 'd.ts',
        status: ToolCallStatus.Executing,
      }),
    ];

    expect(estimateCompactToolGroupHeight(tools, 80)).toBe(2);
  });

  it('uses one row for an active batch with ≤ 3 tools (descriptions inline)', () => {
    const tools = [
      toolCall({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      toolCall({
        callId: 'c2',
        name: 'ReadFile',
        description: 'b.ts',
        status: ToolCallStatus.Executing,
      }),
    ];

    expect(estimateCompactToolGroupHeight(tools, 80)).toBe(1);
  });

  it('uses one row for a completed batch', () => {
    const tools = [
      toolCall({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      toolCall({ callId: 'c2', name: 'ReadFile', description: 'b.ts' }),
    ];

    expect(estimateCompactToolGroupHeight(tools, 80)).toBe(1);
  });

  it('does not reserve a hint row for unsafe fallback arguments', () => {
    const tools = [
      toolCall({ callId: 'c1', name: 'ReadFile', description: 'a.ts' }),
      toolCall({
        callId: 'c2',
        name: 'ReadFile',
        description: '["b.ts"]',
        status: ToolCallStatus.Executing,
      }),
    ];

    expect(estimateCompactToolGroupHeight(tools, 80)).toBe(1);
  });

  it('reserves additional width for active summary status', () => {
    const description =
      'packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx';
    const completed = toolCall({ name: 'ReadFile', description });
    const active = toolCall({
      name: 'ReadFile',
      description,
      status: ToolCallStatus.Executing,
    });

    expect(estimateCompactToolGroupHeight([active], 30)).toBeGreaterThan(
      estimateCompactToolGroupHeight([completed], 30),
    );
  });

  it('reserves timeout label width for active shell summaries', () => {
    const description =
      'npm test -- --filter packages/cli/src/ui/components/messages';
    const activeShell = shellTool({ description });
    const activeShellWithTimeout = shellTool({
      description,
      resultDisplay: {
        ansiOutput: [],
        totalLines: 0,
        totalBytes: 0,
        timeoutMs: 30_000,
      },
    });

    expect(
      estimateCompactToolGroupHeight([activeShellWithTimeout], 55),
    ).toBeGreaterThan(estimateCompactToolGroupHeight([activeShell], 55));
  });

  it('uses terminal display width for wide characters', () => {
    const tool = toolCall({
      name: 'ReadFile',
      description: '中文中文中文中文',
    });

    expect(estimateCompactToolGroupHeight([tool], 12)).toBe(4);
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

  it('handles legacy display names from ToolDisplayNamesMigration', () => {
    // Legacy search tools → collapsible
    expect(isCollapsibleTool('SearchFiles')).toBe(true);
    expect(isCollapsibleTool('FindFiles')).toBe(true);
    // Legacy list tool → collapsible
    expect(isCollapsibleTool('ReadFolder')).toBe(true);
    // Legacy agent tool → non-collapsible
    expect(isCollapsibleTool('Task')).toBe(false);
    // Legacy todo tool → non-collapsible
    expect(isCollapsibleTool('TodoWrite')).toBe(false);
  });
});
