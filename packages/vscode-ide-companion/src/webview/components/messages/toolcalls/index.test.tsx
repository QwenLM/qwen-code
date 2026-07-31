/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolCallRouter } from './index.js';

vi.mock('@qwen-code/webui', async () => {
  const React = await vi.importActual<typeof import('react')>('react');

  // Use a data attribute to record which component was selected by the
  // *real* routing logic, rather than maintaining a parallel mock router.
  const renderLabel = (label: string) =>
    function MockTool(props: {
      toolCall: {
        title?: string;
        rawOutput?: {
          taskDescription?: string;
          terminateReason?: string;
        };
      };
      isFirst?: boolean;
      isLast?: boolean;
    }) {
      return React.createElement(
        'div',
        {
          'data-label': label,
          'data-is-first': props.isFirst,
          'data-is-last': props.isLast,
        },
        `${label}:${props.toolCall.rawOutput?.taskDescription || props.toolCall.title || ''}:${props.toolCall.rawOutput?.terminateReason || ''}`,
      );
    };

  // Import the real routing function so the test validates actual routing
  // rather than a manually-maintained parallel mock that can silently drift.
  const {
    getToolCallComponent: realGetToolCallComponent,
    isAgentExecutionToolCall,
  } =
    await vi.importActual<typeof import('@qwen-code/webui')>(
      '@qwen-code/webui',
    );

  // Map each real component to its label-based mock.
  const componentMocks: Record<string, ReturnType<typeof renderLabel>> = {
    AgentToolCall: renderLabel('agent'),
    GenericToolCall: renderLabel('generic'),
    ReadToolCall: renderLabel('read'),
    ShellToolCall: renderLabel('shell'),
    ThinkToolCall: renderLabel('think'),
    EditToolCall: renderLabel('edit'),
    WriteToolCall: renderLabel('write'),
    SearchToolCall: renderLabel('search'),
    UpdatedPlanToolCall: renderLabel('plan'),
    WebFetchToolCall: renderLabel('web'),
  };

  // Wrap getToolCallComponent to return the label-mock instead of the real
  // component — the routing logic is real, only the rendering is mocked.
  const getToolCallComponent = (
    toolCall: Parameters<typeof realGetToolCallComponent>[0],
  ) => {
    const realComponent = realGetToolCallComponent(toolCall);
    const componentName = realComponent.displayName || realComponent.name || '';
    return componentMocks[componentName] || componentMocks['GenericToolCall']!;
  };

  return {
    shouldShowToolCall: () => true,
    isAgentExecutionToolCall,
    getToolCallComponent,
    GenericToolCall: componentMocks['GenericToolCall'],
    ThinkToolCall: componentMocks['ThinkToolCall'],
    EditToolCall: componentMocks['EditToolCall'],
    WriteToolCall: componentMocks['WriteToolCall'],
    SearchToolCall: componentMocks['SearchToolCall'],
    UpdatedPlanToolCall: componentMocks['UpdatedPlanToolCall'],
    ShellToolCall: componentMocks['ShellToolCall'],
    ReadToolCall: componentMocks['ReadToolCall'],
    WebFetchToolCall: componentMocks['WebFetchToolCall'],
    AgentToolCall: componentMocks['AgentToolCall'],
  };
});

describe('ToolCallRouter agent execution rendering', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it('renders a dedicated view for structured agent progress and summary', () => {
    act(() => {
      root?.render(
        <ToolCallRouter
          toolCall={
            {
              toolCallId: 'agent-1',
              kind: 'other',
              title: 'Launch agent',
              status: 'completed',
              rawOutput: {
                type: 'task_execution',
                subagentName: 'Explore',
                taskDescription: 'Explore auth logic',
                taskPrompt: 'Inspect auth flow implementation',
                status: 'completed',
                toolCalls: [
                  {
                    callId: 'child-1',
                    name: 'read',
                    status: 'success',
                  },
                  {
                    callId: 'child-2',
                    name: 'grep',
                    status: 'success',
                  },
                ],
                executionSummary: {
                  totalToolCalls: 2,
                  totalTokens: 1234,
                  totalDurationMs: 2200,
                },
              },
            } as never
          }
        />,
      );
    });

    expect(container?.textContent).toContain('agent:Explore auth logic');
  });

  it('renders the agent failure reason from structured rawOutput', () => {
    act(() => {
      root?.render(
        <ToolCallRouter
          toolCall={
            {
              toolCallId: 'agent-2',
              kind: 'other',
              title: 'Launch agent',
              status: 'failed',
              rawOutput: {
                type: 'task_execution',
                subagentName: 'Explore',
                taskDescription: 'Explore auth logic',
                taskPrompt: 'Inspect auth flow implementation',
                status: 'failed',
                terminateReason: 'Subagent crashed',
              },
            } as never
          }
        />,
      );
    });

    expect(container?.textContent).toContain(
      'agent:Explore auth logic:Subagent crashed',
    );
  });

  it('forwards isFirst and isLast props to the underlying component', () => {
    act(() => {
      root?.render(
        <ToolCallRouter
          toolCall={
            {
              toolCallId: 'read-1',
              kind: 'read',
              title: 'Read file',
              status: 'completed',
            } as never
          }
          isFirst
          isLast={false}
        />,
      );
    });

    const renderedDiv = container?.querySelector('div');
    expect(renderedDiv?.getAttribute('data-label')).toBe('read');
    expect(renderedDiv?.getAttribute('data-is-first')).toBe('true');
    expect(renderedDiv?.getAttribute('data-is-last')).toBe('false');
  });
});
