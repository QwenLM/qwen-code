// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import { SessionWorkflowInspector } from './SessionWorkflowInspector';

describe('SessionWorkflowInspector', () => {
  it('keeps routine workflow inspection in a list and escalates the DAG explicitly', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSelectedTodoIdChange = vi.fn();
    const onExpandGraph = vi.fn();
    const onOpenSubagent = vi.fn();
    const todos: TodoItem[] = [
      { id: 'prepare', content: 'Prepare inputs', status: 'completed' },
      {
        id: 'ship',
        content: 'Ship result',
        status: 'in_progress',
        blockedBy: ['prepare'],
      },
    ];
    const shippingAgent: ACPToolCall = {
      callId: 'ship-agent',
      toolName: 'Agent',
      title: 'Shipping Agent',
      status: 'in_progress',
      parentToolCallId: 'ship-step',
    };
    const tools: ACPToolCall[] = [
      {
        callId: 'ship-step',
        toolName: 'workflow_step',
        status: 'in_progress',
        args: { todo_id: 'ship' },
        subTools: [shippingAgent],
      },
    ];
    const tasks = [
      {
        kind: 'agent' as const,
        id: 'ship-task',
        label: 'Shipping Agent',
        description: 'Publishing the result',
        status: 'running' as const,
        startTime: 1,
        runtimeMs: 5_000,
        isBackgrounded: true,
        toolUseId: 'ship-agent',
        stats: { toolUses: 4, totalTokens: 1_200, durationMs: 5_000 },
      },
    ];

    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionWorkflowInspector
            todos={todos}
            tools={tools}
            tasks={tasks}
            artifacts={[]}
            onSelectedTodoIdChange={onSelectedTodoIdChange}
            onExpandGraph={onExpandGraph}
            onOpenSubagent={onOpenSubagent}
          />
        </I18nProvider>,
      );
    });

    expect(container.querySelector('[data-plan-node-id]')).toBeNull();
    expect(container.textContent).toContain('Ship result');
    expect(container.textContent).toContain('Prepare inputs');
    expect(container.textContent).toContain('Shipping Agent');
    expect(container.textContent).toContain('4 tool calls');
    expect(container.textContent).toContain('1,200 tokens');
    expect(onSelectedTodoIdChange).toHaveBeenCalledWith('ship');
    const stepList = container.querySelector(
      '[data-testid="workflow-step-list"]',
    );
    const stepDetail = container.querySelector(
      '[data-testid="workflow-step-detail"]',
    );
    expect(
      stepList?.compareDocumentPosition(stepDetail as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const expand = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Expand dependency graph'),
    );
    act(() => expand?.click());
    expect(onExpandGraph).toHaveBeenCalledOnce();

    const agent = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Shipping Agent'),
    );
    act(() => agent?.click());
    expect(onOpenSubagent).toHaveBeenCalledWith(shippingAgent);

    act(() => root.unmount());
    container.remove();
  });

  // R11-2: same input as the overview strip's transcript-only case — one
  // in_progress Agent tool call, no live daemon tasks. The strip reports
  // "Active agents: 1" via the executionStatus fallback; the summary here
  // must not contradict it with a live-only count of 0.
  it('counts transcript-only agents the same as the overview strip', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const todos: TodoItem[] = [
      { id: 'build', content: 'Build', status: 'in_progress' },
    ];
    const tools: ACPToolCall[] = [
      {
        callId: 'build-agent',
        toolName: 'Agent',
        title: 'Build Agent',
        status: 'in_progress',
        args: { todo_id: 'build' },
      },
    ];

    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionWorkflowInspector
            todos={todos}
            tools={tools}
            tasks={[]}
            artifacts={[]}
            onSelectedTodoIdChange={vi.fn()}
            onExpandGraph={vi.fn()}
            onOpenSubagent={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('1 active Agent');

    act(() => root.unmount());
    container.remove();
  });
});
