/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import {
  AgentExecutionDisplay,
  computeContentBudget,
} from './AgentExecutionDisplay.js';
import type { AgentResultDisplay, Config } from '@qwen-code/qwen-code-core';

// Mock useKeypress to avoid stdin issues in tests
vi.mock('../../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

// Mock ToolConfirmationMessage
vi.mock('../../messages/ToolConfirmationMessage.js', () => ({
  ToolConfirmationMessage: () => null,
}));

const mockConfig = {} as Config;

function makeAgentData(
  overrides: Partial<AgentResultDisplay> = {},
): AgentResultDisplay {
  return {
    type: 'task_execution',
    subagentName: 'test-agent',
    taskDescription: 'Test task',
    taskPrompt:
      'Do something\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10',
    status: 'running',
    toolCalls: Array.from({ length: 8 }, (_, i) => ({
      name: `tool-${i + 1}`,
      status: 'success' as const,
      description: `Description ${i + 1}`,
    })),
    ...overrides,
  };
}

describe('computeContentBudget', () => {
  it('returns defaults when availableHeight is undefined', () => {
    const result = computeContentBudget(undefined);
    expect(result.maxTaskPromptLines).toBe(5);
    expect(result.maxToolCalls).toBe(5);
  });

  it('returns defaults when availableHeight is NaN', () => {
    const result = computeContentBudget(NaN);
    expect(result.maxTaskPromptLines).toBe(5);
    expect(result.maxToolCalls).toBe(5);
  });

  it('returns defaults when availableHeight is negative', () => {
    const result = computeContentBudget(-10);
    expect(result.maxTaskPromptLines).toBe(5);
    expect(result.maxToolCalls).toBe(5);
  });

  it('returns defaults when availableHeight is Infinity', () => {
    const result = computeContentBudget(Infinity);
    expect(result.maxTaskPromptLines).toBe(5);
    expect(result.maxToolCalls).toBe(5);
  });

  it('returns max defaults for large terminal (50 lines)', () => {
    const result = computeContentBudget(50);
    // Budget = 50 - 7 = 43, plenty of room
    expect(result.maxTaskPromptLines).toBe(5); // capped at MAX
    expect(result.maxToolCalls).toBe(5); // capped at MAX
  });

  it('constrains content for medium terminal (15 lines)', () => {
    const result = computeContentBudget(15);
    // Budget = 15 - 7 = 8
    // minPrompt = 2, remaining = 6
    // maxToolCalls = min(floor(6/2), 5) = min(3, 5) = 3
    // usedByTools = 3 * 2 = 6
    // maxPromptLines = min(max(1, 2 + max(0, 6-6)), 5) = min(2, 5) = 2
    expect(result.maxToolCalls).toBe(3);
    expect(result.maxTaskPromptLines).toBe(2);
  });

  it('constrains content for small terminal (10 lines)', () => {
    const result = computeContentBudget(10);
    // Budget = 10 - 7 = 3
    // minPrompt = 2, remaining = 1
    // maxToolCalls = min(max(1, floor(1/2)), 5) = min(1, 5) = 1
    // usedByTools = 1 * 2 = 2
    // maxPromptLines = min(max(1, 2 + max(0, 1-2)), 5) = min(2, 5) = 2
    expect(result.maxToolCalls).toBe(1);
    expect(result.maxTaskPromptLines).toBe(2);
  });

  it('handles zero budget (availableHeight = 7, equal to overhead)', () => {
    const result = computeContentBudget(7);
    // Budget = 0, minPrompt = 0, remaining = 0
    // maxToolCalls = max(1, floor(0/2)) = 1
    // maxPromptLines = max(1, 0 + ...) = 1
    expect(result.maxToolCalls).toBe(1);
    expect(result.maxTaskPromptLines).toBe(1);
  });

  it('handles very small height (3 lines)', () => {
    const result = computeContentBudget(3);
    // Budget = 0
    expect(result.maxToolCalls).toBe(1);
    expect(result.maxTaskPromptLines).toBe(1);
  });

  it('always returns at least 1 for both values', () => {
    for (const h of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const result = computeContentBudget(h);
      expect(result.maxTaskPromptLines).toBeGreaterThanOrEqual(1);
      expect(result.maxToolCalls).toBeGreaterThanOrEqual(1);
    }
  });

  it('never exceeds MAX_TOOL_CALLS=5 or MAX_TASK_PROMPT_LINES=5', () => {
    for (const h of [10, 20, 50, 100, 1000]) {
      const result = computeContentBudget(h);
      expect(result.maxTaskPromptLines).toBeLessThanOrEqual(5);
      expect(result.maxToolCalls).toBeLessThanOrEqual(5);
    }
  });
});

describe('AgentExecutionDisplay height constraint', () => {
  it('renders in compact mode by default (minimal lines)', () => {
    const data = makeAgentData();
    const { lastFrame } = render(
      <AgentExecutionDisplay
        data={data}
        availableHeight={30}
        childWidth={80}
        config={mockConfig}
      />,
    );
    const output = lastFrame();
    const lineCount = output.split('\n').length;
    // Compact mode: header + current tool + "+N more" ≈ 3-4 lines
    expect(lineCount).toBeLessThanOrEqual(6);
  });

  it('renders compact mode with small availableHeight (content budget limits output)', () => {
    const data = makeAgentData();
    const { lastFrame } = render(
      <AgentExecutionDisplay
        data={data}
        availableHeight={3}
        childWidth={80}
        config={mockConfig}
      />,
    );
    const output = lastFrame();
    const lineCount = output.split('\n').length;
    // Auto-downgraded to compact, should be very few lines
    expect(lineCount).toBeLessThanOrEqual(6);
  });

  it('shows completed agent summary in compact mode', () => {
    const data = makeAgentData({
      status: 'completed',
      executionSummary: {
        totalToolCalls: 5,
        successfulToolCalls: 5,
        failedToolCalls: 0,
        successRate: 100,
        totalTokens: 1000,
        totalDurationMs: 5000,
        rounds: 3,
      },
    });
    const { lastFrame } = render(
      <AgentExecutionDisplay
        data={data}
        availableHeight={30}
        childWidth={80}
        config={mockConfig}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('test-agent');
    expect(output).toContain('Completed');
  });
});
