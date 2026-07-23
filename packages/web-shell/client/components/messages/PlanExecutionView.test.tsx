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

const branchedTodos: TodoItem[] = [
  { id: 'plan', content: 'Plan', status: 'completed' },
  {
    id: 'build-api',
    content: 'Build API',
    status: 'in_progress',
    blockedBy: ['plan'],
  },
  {
    id: 'build-ui',
    content: 'Build UI',
    status: 'in_progress',
    blockedBy: ['plan'],
  },
  {
    id: 'verify',
    content: 'Verify',
    status: 'pending',
    blockedBy: ['build-api', 'build-ui'],
  },
];

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
    const step = container.querySelector<HTMLButtonElement>(
      '[data-plan-node-id="build"]',
    );
    expect(step?.getAttribute('aria-expanded')).toBe('false');
    act(() => step?.click());
    expect(step?.getAttribute('aria-expanded')).toBe('true');
    const details = container.querySelector('[data-plan-step-details]');
    expect(details?.textContent).toContain('Step details');
    expect(details?.textContent).toContain('Build');
    expect(details?.textContent).toContain('Depends on: research');
    expect(details?.textContent).toContain('Subagents');
    const button = Array.from(details?.querySelectorAll('button') ?? []).find(
      (candidate) => candidate.textContent?.includes('Agent build'),
    );
    act(() => button?.click());
    expect(onOpen).toHaveBeenCalledWith(agentTool('build'));

    act(() => root.unmount());
    container.remove();
  });

  it('renders every fork and join dependency as a directed workflow edge', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView todos={branchedTodos} tools={[]} tasks={[]} />
        </I18nProvider>,
      );
    });

    const edges = Array.from(container.querySelectorAll('[data-plan-edge]'))
      .map((edge) =>
        JSON.stringify([
          edge.getAttribute('data-from'),
          edge.getAttribute('data-to'),
        ]),
      )
      .sort();
    expect(edges).toEqual([
      JSON.stringify(['build-api', 'verify']),
      JSON.stringify(['build-ui', 'verify']),
      JSON.stringify(['plan', 'build-api']),
      JSON.stringify(['plan', 'build-ui']),
    ]);
    expect(container.querySelector('[data-plan-workflow]')).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('normalizes measured coordinates when the workflow is CSS-scaled', () => {
    const scaledRect = (
      left: number,
      top: number,
      width: number,
      height: number,
    ) =>
      ({
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({}),
      }) as DOMRect;
    const positions: Record<string, [number, number]> = {
      plan: [10, 10],
      'build-api': [300, 10],
      'build-ui': [300, 120],
      verify: [600, 65],
    };
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        if (this.parentElement?.hasAttribute('data-plan-workflow')) {
          return scaledRect(100, 50, 720, 360);
        }
        if (this.tagName === 'ARTICLE') {
          const [left, top] =
            positions[this.querySelector('span')!.textContent!]!;
          return scaledRect(100 + left * 0.72, 50 + top * 0.72, 144, 57.6);
        }
        return scaledRect(0, 0, 0, 0);
      });
    const widthSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockReturnValue(1000);
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(500);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView todos={branchedTodos} tools={[]} tasks={[]} />
        </I18nProvider>,
      );
    });

    expect(
      container
        .querySelector('[data-from="plan"][data-to="build-api"]')
        ?.getAttribute('d'),
    ).toBe('M 210 50 C 255 50, 255 50, 300 50');

    act(() => root.unmount());
    container.remove();
    rectSpy.mockRestore();
    widthSpy.mockRestore();
    heightSpy.mockRestore();
  });

  it('routes a cross-layer dependency below intervening nodes', () => {
    const crossLayerTodos: TodoItem[] = [
      { id: 'root', content: 'Root', status: 'completed' },
      {
        id: 'docs',
        content: 'Docs',
        status: 'pending',
        blockedBy: ['root'],
      },
      {
        id: 'integration',
        content: 'Integration',
        status: 'pending',
        blockedBy: ['docs'],
      },
      {
        id: 'release',
        content: 'Release',
        status: 'pending',
        blockedBy: ['integration', 'docs'],
      },
    ];
    const positions: Record<string, [number, number]> = {
      root: [10, 10],
      docs: [300, 120],
      integration: [590, 10],
      release: [880, 10],
    };
    const rect = (left: number, top: number, width: number, height: number) =>
      ({
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        if (this.parentElement?.hasAttribute('data-plan-workflow')) {
          return rect(100, 50, 1100, 300);
        }
        if (this.tagName === 'ARTICLE') {
          const [left, top] =
            positions[this.querySelector('span')!.textContent!]!;
          return rect(100 + left, 50 + top, 200, 80);
        }
        return rect(0, 0, 0, 0);
      });
    const widthSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockReturnValue(1100);
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(300);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView todos={crossLayerTodos} tools={[]} tasks={[]} />
        </I18nProvider>,
      );
    });

    expect(
      container
        .querySelector('[data-from="docs"][data-to="release"]')
        ?.getAttribute('d'),
    ).toBe('M 500 160 H 528 V 216 H 852 V 50 H 880');

    act(() => root.unmount());
    container.remove();
    rectSpy.mockRestore();
    widthSpy.mockRestore();
    heightSpy.mockRestore();
  });

  it('does not synchronously remeasure unchanged topology on task polling', () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView todos={branchedTodos} tools={[]} tasks={[]} />
        </I18nProvider>,
      );
    });
    const initialMeasurements = rectSpy.mock.calls.length;
    expect(initialMeasurements).toBeGreaterThan(0);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView
            todos={branchedTodos}
            tools={[]}
            tasks={[task('running')]}
          />
        </I18nProvider>,
      );
    });
    expect(rectSpy).toHaveBeenCalledTimes(initialMeasurements);

    act(() => root.unmount());
    container.remove();
    rectSpy.mockRestore();
  });

  it('can receive a branched plan after mounting without todos', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView todos={[]} tools={[]} tasks={[]} />
        </I18nProvider>,
      );
    });
    expect(container.textContent).toBe('');

    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView todos={branchedTodos} tools={[]} tasks={[]} />
        </I18nProvider>,
      );
    });
    expect(container.querySelector('[data-plan-workflow]')).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('clears the selected step when the active plan is cleared', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderTodos = (nextTodos: readonly TodoItem[]) => {
      act(() => {
        root.render(
          <I18nProvider language="en">
            <PlanExecutionView todos={nextTodos} tools={[]} tasks={[]} />
          </I18nProvider>,
        );
      });
    };

    renderTodos(todos);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-plan-node-id="build"]')
        ?.click(),
    );
    expect(container.querySelector('[data-plan-step-details]')).not.toBeNull();

    renderTodos([]);
    renderTodos([
      { id: 'build', content: 'Unrelated new plan', status: 'pending' },
    ]);
    expect(container.querySelector('[data-plan-step-details]')).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('recomputes edges when a later plan revises the topology', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView todos={branchedTodos} tools={[]} tasks={[]} />
        </I18nProvider>,
      );
    });

    const revisedTodos = branchedTodos.map((todo) =>
      todo.id === 'verify' ? { ...todo, blockedBy: ['build-api'] } : todo,
    );
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView todos={revisedTodos} tools={[]} tasks={[]} />
        </I18nProvider>,
      );
    });

    const revisedEdges = Array.from(
      container.querySelectorAll('[data-plan-edge]'),
    )
      .map((edge) =>
        JSON.stringify([
          edge.getAttribute('data-from'),
          edge.getAttribute('data-to'),
        ]),
      )
      .sort();
    expect(revisedEdges).toEqual([
      JSON.stringify(['build-api', 'verify']),
      JSON.stringify(['plan', 'build-api']),
      JSON.stringify(['plan', 'build-ui']),
    ]);

    act(() => root.unmount());
    container.remove();
  });

  it('skips SVG edge materialization for an excessively dense plan', () => {
    const denseTodos = Array.from(
      { length: 33 },
      (_, index): TodoItem => ({
        id: `dense-${index}`,
        content: `Dense ${index}`,
        status: index === 0 ? 'completed' : 'pending',
        ...(index === 0
          ? {}
          : {
              blockedBy: Array.from(
                { length: index },
                (__, dependencyIndex) => `dense-${dependencyIndex}`,
              ),
            }),
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView todos={denseTodos} tools={[]} tasks={[]} />
        </I18nProvider>,
      );
    });

    expect(container.querySelector('[data-plan-workflow]')).not.toBeNull();
    expect(container.querySelectorAll('[data-plan-edge]')).toHaveLength(0);
    expect(container.textContent).toContain('Dense 32');

    act(() => root.unmount());
    container.remove();
  });
});
