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
  useKeypress: vi.fn(
    (handler: (key: { ctrl?: boolean; name?: string }) => void) => {
      keypressHandler = handler;
    },
  ),
}));

describe('<AgentExecutionDisplay />', () => {
  beforeEach(() => {
    keypressHandler = undefined;
  });

  it('bounds expanded detail by the assigned visual height', () => {
    const data: AgentResultDisplay = {
      type: 'task_execution',
      subagentName: 'reviewer',
      subagentColor: 'blue',
      status: 'running',
      taskDescription: 'Review large output stability',
      taskPrompt: `${'very-long-task-prompt '.repeat(20)}\nsecond\nthird`,
      toolCalls: Array.from({ length: 8 }, (_, index) => ({
        callId: `call-${index}`,
        name: `tool-${index}`,
        status: 'success',
        description: `description-${index} ${'wide '.repeat(20)}`,
        resultDisplay: `result-${index} ${'payload '.repeat(20)}`,
      })),
    };

    const { lastFrame } = render(
      <AgentExecutionDisplay
        data={data}
        availableHeight={8}
        childWidth={40}
        config={makeFakeConfig()}
      />,
    );

    act(() => {
      keypressHandler?.({ ctrl: true, name: 'e' });
    });

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Showing the first 2 visual lines');
    expect(frame).toContain('Showing the last 1 of 8 tools');
    expect(frame).toContain('tool-7');
    expect(frame).not.toContain('tool-0');
  });
});
