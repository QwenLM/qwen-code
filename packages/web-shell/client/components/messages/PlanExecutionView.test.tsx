// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonSessionAgentTaskStatus } from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import {
  getPlanNodeState,
  layerPlanTodos,
  nestedTasksForTool,
  PlanExecutionView,
} from './PlanExecutionView';

const todos: TodoItem[] = [
  { id: 'research', content: 'Research', status: 'completed' },
  {
    id: 'build',
    content: 'Build',
    status: 'in_progress',
    blockedBy: ['research'],
  },
  {
    id: 'verify',
    content: 'Verify',
    status: 'pending',
    blockedBy: ['build'],
  },
];
const todosById = new Map(todos.map((todo) => [todo.id, todo]));

function agentTool(todoId?: string): ACPToolCall {
  return {
    callId: `call-${todoId ?? 'none'}`,
    toolName: 'Agent',
    title: `Agent ${todoId ?? 'none'}`,
    status: 'in_progress',
    args: { ...(todoId ? { todo_id: todoId } : {}) },
  };
}

function task(
  status: DaemonSessionAgentTaskStatus['status'],
  overrides: Partial<DaemonSessionAgentTaskStatus> = {},
): DaemonSessionAgentTaskStatus {
  return {
    kind: 'agent',
    id: 'agent-build',
    label: 'Build agent',
    description: 'Build',
    status,
    startTime: 1,
    runtimeMs: 1,
    isBackgrounded: true,
    toolUseId: 'call-build',
    ...overrides,
  };
}

describe('PlanExecutionView', () => {
  it('layers dependent todos in topological order', () => {
    expect(
      layerPlanTodos(todos).map((layer) => layer.map((todo) => todo.id)),
    ).toEqual([['research'], ['build'], ['verify']]);
  });

  it('layers deep dependency chains without recursive traversal', () => {
    const deepTodos = Array.from(
      { length: 3_000 },
      (_, index): TodoItem => ({
        id: `todo-${index}`,
        content: `Todo ${index}`,
        status: 'pending',
        ...(index === 0 ? {} : { blockedBy: [`todo-${index - 1}`] }),
      }),
    ).reverse();

    const layers = layerPlanTodos(deepTodos);
    const deepTodosById = new Map(deepTodos.map((todo) => [todo.id, todo]));
    const states = deepTodos.map((todo) =>
      getPlanNodeState(todo, deepTodosById, [], []),
    );

    expect(layers).toHaveLength(3_000);
    expect(layers[0][0].id).toBe('todo-0');
    expect(layers[2_999][0].id).toBe('todo-2999');
    expect(states).toHaveLength(3_000);
  });

  it('uses live execution state before todo and dependency state', () => {
    expect(
      getPlanNodeState(todos[1], todosById, [agentTool('build')], []),
    ).toEqual({
      status: 'running',
      attention: false,
    });
    expect(
      getPlanNodeState(
        todos[1],
        todosById,
        [agentTool('build')],
        [task('paused')],
      ),
    ).toEqual({
      status: 'paused',
      attention: false,
    });
    expect(getPlanNodeState(todos[2], todosById, [], [])).toEqual({
      status: 'blocked',
      attention: false,
    });
  });

  it('restores cancellation from replay output after the live task leaves', () => {
    const cancelled = {
      ...agentTool('build'),
      status: 'completed' as const,
      rawOutput: { status: 'cancelled', reason: 'Cancelled by user' },
    };

    expect(getPlanNodeState(todos[1], todosById, [cancelled], [])).toEqual({
      status: 'in_progress',
      attention: true,
    });
  });

  it('keeps nested agents under their linked root execution', () => {
    const root = task('running');
    const child = task('running', {
      id: 'agent-child',
      label: 'Child agent',
      toolUseId: 'call-child',
      parentAgentId: root.id,
      depth: 1,
    });
    const grandchild = task('completed', {
      id: 'agent-grandchild',
      label: 'Grandchild agent',
      toolUseId: 'call-grandchild',
      parentAgentId: child.id,
      depth: 2,
    });

    expect(
      nestedTasksForTool(agentTool('build'), [grandchild, root, child]).map(
        ({ task: nested, depth }) => [nested.id, depth],
      ),
    ).toEqual([
      ['agent-child', 1],
      ['agent-grandchild', 2],
    ]);
  });

  it('groups executions by todo and keeps missing links unassigned', () => {
    const onOpen = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView
            todos={todos}
            tools={[agentTool('build'), agentTool()]}
            tasks={[
              task('running'),
              task('running', {
                id: 'agent-child',
                label: 'Child agent',
                parentAgentId: 'agent-build',
              }),
            ]}
            onOpenSubagent={onOpen}
          />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Depends on: research');
    expect(container.textContent).toContain('Child agent');
    expect(container.textContent).toContain('Unassigned executions');
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Agent build'),
    );
    act(() => button?.click());
    expect(onOpen).toHaveBeenCalledWith(agentTool('build'));

    act(() => root.unmount());
    container.remove();
  });
});
