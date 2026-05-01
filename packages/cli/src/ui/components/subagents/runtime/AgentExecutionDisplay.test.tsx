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

  it('does not respond to ctrl+e when another running subagent has focus', () => {
    // Two SubAgents running side-by-side share the live viewport. Only the
    // focused one should react to Ctrl+E / Ctrl+F — otherwise both reflow
    // together and the dual height-change reintroduces flicker.
    const { lastFrame } = render(
      <AgentExecutionDisplay
        data={makeRunningData(2)}
        availableHeight={20}
        childWidth={80}
        config={makeFakeConfig()}
        isFocused={false}
      />,
    );

    const before = lastFrame() ?? '';
    act(() => {
      keypressHandler?.({ ctrl: true, name: 'e' });
    });
    expect(lastFrame() ?? '').toBe(before);
  });

  it('survives the running → completed transition while expanded', () => {
    // Real path: subagent is running, the user expands it (ctrl+e) so
    // displayMode becomes 'default', then the same instance rerenders with
    // completed data. The completed-state budget must still hold the
    // expanded layout inside availableHeight, and ctrl+e must become a
    // no-op on the completed instance so it doesn't drag historical
    // displays through mode toggles.
    const availableHeight = 30;
    const { lastFrame, rerender } = render(
      <AgentExecutionDisplay
        data={makeRunningData(8)}
        availableHeight={availableHeight}
        childWidth={80}
        config={makeFakeConfig()}
      />,
    );

    // Expand the running display.
    act(() => {
      keypressHandler?.({ ctrl: true, name: 'e' });
    });
    const expandedRunningFrame = lastFrame() ?? '';
    expect(expandedRunningFrame).toContain('Task Detail:');
    expect(expandedRunningFrame).toContain('Tools:');

    // Re-render the same component instance with completed data, preserving
    // displayMode. Without an overhead-aware completed budget the
    // ExecutionSummary + ToolUsage blocks would push the frame past
    // availableHeight here.
    rerender(
      <AgentExecutionDisplay
        data={makeCompletedData(8)}
        availableHeight={availableHeight}
        childWidth={80}
        config={makeFakeConfig()}
      />,
    );

    const completedFrame = lastFrame() ?? '';
    expect(visualRowCount(completedFrame)).toBeLessThanOrEqual(availableHeight);

    // useKeypress is now `{ isActive: false }`; ctrl+e on the completed
    // instance must not toggle anything. The mock unsets keypressHandler
    // when isActive is false, so the call below is a no-op and the frame
    // is identical.
    const before = lastFrame() ?? '';
    act(() => {
      keypressHandler?.({ ctrl: true, name: 'e' });
    });
    expect(lastFrame() ?? '').toBe(before);
  });
});
