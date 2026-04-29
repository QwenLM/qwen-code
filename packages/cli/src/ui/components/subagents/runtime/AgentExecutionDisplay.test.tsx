/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentResultDisplay } from '@qwen-code/qwen-code-core';
import { makeFakeConfig } from '@qwen-code/qwen-code-core';
import { AgentExecutionDisplay } from './AgentExecutionDisplay.js';

let keypressHandler:
  | ((key: { ctrl?: boolean; name?: string }) => void)
  | undefined;

vi.mock('../../../hooks/useKeypress.js', () => ({
  // The mock honours { isActive } so historical/completed displays don't
  // capture the keypress handler — same scoping the production hook does.
  useKeypress: vi.fn(
    (
      handler: (key: { ctrl?: boolean; name?: string }) => void,
      options?: { isActive?: boolean },
    ) => {
      keypressHandler = options?.isActive === false ? undefined : handler;
    },
  ),
}));

function makeRunningData(toolCount: number): AgentResultDisplay {
  return {
    type: 'task_execution',
    subagentName: 'reviewer',
    subagentColor: 'blue',
    status: 'running',
    taskDescription: 'Review large output stability',
    taskPrompt: `${'very-long-task-prompt '.repeat(20)}\nsecond\nthird`,
    toolCalls: Array.from({ length: toolCount }, (_, index) => ({
      callId: `call-${index}`,
      name: `tool-${index}`,
      status: 'success',
      description: `description-${index} ${'wide '.repeat(20)}`,
      resultDisplay: `result-${index} ${'payload '.repeat(20)}`,
    })),
  };
}

function makeCompletedData(toolCount: number): AgentResultDisplay {
  return {
    ...makeRunningData(toolCount),
    status: 'completed',
    executionSummary: {
      rounds: 3,
      totalDurationMs: 12_345,
      totalToolCalls: toolCount,
      successfulToolCalls: toolCount,
      failedToolCalls: 0,
      successRate: 100,
      inputTokens: 100,
      outputTokens: 200,
      thoughtTokens: 0,
      cachedTokens: 0,
      totalTokens: 4_321,
      toolUsage: [],
    },
  };
}

function visualRowCount(frame: string): number {
  if (!frame) return 0;
  return frame.split('\n').length;
}

describe('<AgentExecutionDisplay />', () => {
  beforeEach(() => {
    keypressHandler = undefined;
  });

  it('bounds expanded detail by the assigned visual height', () => {
    const { lastFrame } = render(
      <AgentExecutionDisplay
        data={makeRunningData(8)}
        availableHeight={8}
        childWidth={40}
        config={makeFakeConfig()}
      />,
    );

    act(() => {
      keypressHandler?.({ ctrl: true, name: 'e' });
    });

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Showing the first 1 visual lines');
    expect(frame).toContain('Showing the last 1 of 8 tools');
    expect(frame).toContain('tool-7');
    expect(frame).not.toContain('tool-0');
  });

  it('keeps the rendered running frame within availableHeight', () => {
    const availableHeight = 26;
    const { lastFrame } = render(
      <AgentExecutionDisplay
        data={makeRunningData(8)}
        availableHeight={availableHeight}
        childWidth={80}
        config={makeFakeConfig()}
      />,
    );

    act(() => {
      keypressHandler?.({ ctrl: true, name: 'e' });
    });

    expect(visualRowCount(lastFrame() ?? '')).toBeLessThanOrEqual(
      availableHeight,
    );
  });

  it('keeps the rendered completed frame within availableHeight', () => {
    const availableHeight = 30;
    const { lastFrame } = render(
      <AgentExecutionDisplay
        data={makeCompletedData(8)}
        availableHeight={availableHeight}
        childWidth={80}
        config={makeFakeConfig()}
      />,
    );

    act(() => {
      keypressHandler?.({ ctrl: true, name: 'e' });
    });

    expect(visualRowCount(lastFrame() ?? '')).toBeLessThanOrEqual(
      availableHeight,
    );
  });

  it('does not respond to ctrl+e once the subagent has completed', () => {
    const { lastFrame } = render(
      <AgentExecutionDisplay
        data={makeCompletedData(2)}
        availableHeight={20}
        childWidth={80}
        config={makeFakeConfig()}
      />,
    );

    const before = lastFrame() ?? '';
    act(() => {
      keypressHandler?.({ ctrl: true, name: 'e' });
    });
    const after = lastFrame() ?? '';

    expect(after).toBe(before);
  });
});
