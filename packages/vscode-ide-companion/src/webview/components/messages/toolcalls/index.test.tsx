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

  const renderLabel = (label: string) =>
    function MockTool({
      toolCall,
    }: {
      toolCall: {
        title?: string;
        rawOutput?: {
          taskDescription?: string;
          terminateReason?: string;
        };
      };
    }) {
      return React.createElement(
        'div',
        undefined,
        `${label}:${toolCall.rawOutput?.taskDescription || toolCall.title || ''}:${toolCall.rawOutput?.terminateReason || ''}`,
      );
    };

  const isAgentExec = (toolCall: { rawOutput?: { type?: string } }) =>
    toolCall.rawOutput?.type === 'task_execution';

  const agentComponent = renderLabel('agent');
  const genericComponent = renderLabel('generic');
  const readComponent = renderLabel('read');
  const shellComponent = renderLabel('shell');

  return {
    shouldShowToolCall: () => true,
    isAgentExecutionToolCall: isAgentExec,
    GenericToolCall: genericComponent,
    ThinkToolCall: renderLabel('think'),
    SaveMemoryToolCall: renderLabel('memory'),
    EditToolCall: renderLabel('edit'),
    WriteToolCall: renderLabel('write'),
    SearchToolCall: renderLabel('search'),
    UpdatedPlanToolCall: renderLabel('plan'),
    ShellToolCall: shellComponent,
    ReadToolCall: readComponent,
    WebFetchToolCall: renderLabel('web'),
    AgentToolCall: agentComponent,
    getToolCallComponent: (toolCall: {
      kind: string;
      rawOutput?: { type?: string };
    }) => {
      if (isAgentExec(toolCall)) return agentComponent;
      const kind = toolCall.kind.toLowerCase();
      if (kind === 'read' || kind === 'read_file') return readComponent;
      if (kind === 'execute' || kind === 'bash') return shellComponent;
      return genericComponent;
    },
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
});
