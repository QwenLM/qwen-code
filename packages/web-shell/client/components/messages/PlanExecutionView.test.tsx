// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonSessionAgentTaskStatus } from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import {
  getActiveAgents,
  getAttentionAgentTool,
  getPlanNodeState,
  layerPlanTodos,
  nestedAgentToolsForTool,
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

  it('does not block a todo on an unknown dependency', () => {
    const todo: TodoItem = {
      id: 'standalone',
      content: 'Standalone',
      status: 'pending',
      blockedBy: ['missing'],
    };

    expect(getPlanNodeState(todo, new Map([[todo.id, todo]]), [], [])).toEqual({
      status: 'ready',
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

  it('keeps root running precedence while surfacing a failed live descendant', () => {
    const root = task('running');
    const child = task('failed', {
      id: 'agent-child',
      toolUseId: 'call-child',
      parentAgentId: root.id,
    });

    expect(
      getPlanNodeState(
        todos[1],
        todosById,
        [agentTool('build')],
        [root, child],
      ),
    ).toEqual({ status: 'running', attention: true });
    expect(
      getAttentionAgentTool(agentTool('build'), [root, child]),
    ).toMatchObject({ callId: 'call-child', toolName: 'Agent' });
  });

  it('surfaces a failed persisted descendant after live tasks disappear', () => {
    const failedChild: ACPToolCall = {
      ...agentTool('build'),
      callId: 'call-child',
      status: 'failed',
      parentToolCallId: 'call-build',
    };
    const completedRoot: ACPToolCall = {
      ...agentTool('build'),
      status: 'completed',
      subTools: [failedChild],
    };

    expect(getPlanNodeState(todos[1], todosById, [completedRoot], [])).toEqual({
      status: 'in_progress',
      attention: true,
    });
    expect(getAttentionAgentTool(completedRoot, [])).toBe(failedChild);
  });

  it('clears resolved failures when their todo is completed', () => {
    const completedTodo: TodoItem = {
      id: 'build',
      content: 'Build',
      status: 'completed',
    };
    const failedAgent = { ...agentTool('build'), status: 'failed' as const };

    expect(
      getPlanNodeState(
        completedTodo,
        new Map([[completedTodo.id, completedTodo]]),
        [failedAgent],
        [],
      ),
    ).toEqual({ status: 'completed', attention: false });
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

  it('keeps the first task registered for a tool call', () => {
    const firstRoot = task('running', { id: 'agent-first' });
    const firstChild = task('completed', {
      id: 'agent-first-child',
      parentAgentId: firstRoot.id,
    });
    const laterRoot = task('failed', { id: 'agent-later' });
    const laterChild = task('failed', {
      id: 'agent-later-child',
      parentAgentId: laterRoot.id,
    });

    expect(
      nestedTasksForTool(agentTool('build'), [
        firstRoot,
        firstChild,
        laterRoot,
        laterChild,
      ]).map(({ task: nested }) => nested.id),
    ).toEqual(['agent-first-child']);
    expect(
      getPlanNodeState(
        todos[1],
        todosById,
        [agentTool('build')],
        [firstRoot, firstChild, laterRoot, laterChild],
      ),
    ).toEqual({ status: 'running', attention: false });
  });

  it('rebuilds the nested agent tree from transcript tools', () => {
    const grandchild = {
      ...agentTool('verify'),
      callId: 'grandchild',
      parentToolCallId: 'child',
    };
    const child = {
      ...agentTool('build'),
      callId: 'child',
      parentToolCallId: 'root',
      subTools: [grandchild],
    };
    const root = { ...agentTool('build'), callId: 'root', subTools: [child] };

    expect(
      nestedAgentToolsForTool(root).map(({ tool, depth }) => [
        tool.callId,
        depth,
      ]),
    ).toEqual([
      ['child', 1],
      ['grandchild', 2],
    ]);
  });

  it('opens a live nested agent through its transcript tool call', () => {
    const onOpen = vi.fn();
    const childTool = {
      ...agentTool('build'),
      callId: 'call-child',
      title: 'Child agent',
      parentToolCallId: 'call-build',
    };
    const rootTool = { ...agentTool('build'), subTools: [childTool] };
    const rootTask = task('running');
    const childTask = task('running', {
      id: 'agent-child',
      label: 'Child agent',
      toolUseId: childTool.callId,
      parentAgentId: rootTask.id,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView
            todos={todos}
            tools={[rootTool]}
            tasks={[rootTask, childTask]}
            onOpenSubagent={onOpen}
          />
        </I18nProvider>,
      );
    });

    const childButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Child agent'),
    );
    expect(childButton?.hasAttribute('data-plan-interactive')).toBe(true);
    act(() => childButton?.click());
    expect(onOpen).toHaveBeenCalledWith(childTool);

    act(() => root.unmount());
    container.remove();
  });

  it('opens a live nested agent from its task tool call id', () => {
    const onOpen = vi.fn();
    const rootTool = agentTool('build');
    const rootTask = task('running');
    const childTask = task('running', {
      id: 'agent-child',
      label: 'Live nested agent',
      description: 'Inspect live progress',
      toolUseId: 'call-child',
      parentAgentId: rootTask.id,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView
            todos={todos}
            tools={[rootTool]}
            tasks={[rootTask, childTask]}
            onOpenSubagent={onOpen}
          />
        </I18nProvider>,
      );
    });

    const childButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Live nested agent'),
    );
    expect(childButton?.hasAttribute('data-plan-interactive')).toBe(true);
    act(() => childButton?.click());
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-child',
        toolName: 'Agent',
        status: 'in_progress',
      }),
    );

    act(() => root.unmount());
    container.remove();
  });

  it('keeps persisted nested agents beside still-live siblings', () => {
    const completedChild = {
      ...agentTool('build'),
      callId: 'call-completed-child',
      title: 'Completed child',
      status: 'completed' as const,
      parentToolCallId: 'call-build',
    };
    const rootTool = { ...agentTool('build'), subTools: [completedChild] };
    const rootTask = task('running');
    const liveChild = task('running', {
      id: 'agent-live-child',
      label: 'Live child',
      toolUseId: 'call-live-child',
      parentAgentId: rootTask.id,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView
            todos={todos}
            tools={[rootTool]}
            tasks={[rootTask, liveChild]}
          />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Live child');
    expect(container.textContent).toContain('Completed child');

    act(() => root.unmount());
    container.remove();
  });

  it('groups executions by todo and keeps missing links unassigned', () => {
    const onOpen = vi.fn();
    const runningRoot = task('running', {
      runtimeMs: 65_000,
      stats: { totalTokens: 1_200, toolUses: 4, durationMs: 65_000 },
      recentActivities: [
        {
          name: 'read_file',
          description: 'Inspecting the implementation',
          at: 1,
        },
      ],
    });
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
              runningRoot,
              task('running', {
                id: 'agent-child',
                label: 'Child agent',
                parentAgentId: 'agent-build',
              }),
              task('running', {
                id: 'agent-unrelated',
                toolUseId: 'call-unrelated',
              }),
            ]}
            onOpenSubagent={onOpen}
          />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Depends on: research');
    expect(container.textContent).toContain('33%');
    expect(container.textContent).toContain('1 / 3');
    // 3, not 2: the strip now derives from the same source as the node
    // badges (executionStatus), so the unassigned in_progress tool call
    // with no live daemon task counts too — previously the strip silently
    // disagreed with the badge rendered for that same tool.
    expect(container.textContent).toContain('3Active agents');
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
    expect(details?.textContent).toContain('Unblocks: verify');
    expect(details?.textContent).toContain('Subagents');
    expect(details?.textContent).toContain(
      'Current activity:Inspecting the implementation',
    );
    expect(details?.textContent).toContain(
      '1m 5s · 4 tool calls · 1,200 tokens',
    );
    expect(details?.textContent).toContain('Open subagent details →');
    const button = Array.from(details?.querySelectorAll('button') ?? []).find(
      (candidate) => candidate.textContent?.includes('Agent build'),
    );
    act(() => button?.click());
    expect(onOpen).toHaveBeenCalledWith(agentTool('build'));

    act(() => root.unmount());
    container.remove();
  });

  // R7-2: a replayed transcript of an interrupted session carries Agent tool
  // calls still in_progress (or paused) with NO live daemon task. The node
  // badges render Running/Paused off executionStatus's transcript fallback;
  // the overview strip must agree instead of reporting "Active agents: 0".
  it('counts transcript-only running and paused agents in Active agents', () => {
    const nestedAgent = {
      ...agentTool('build'),
      callId: 'call-nested',
      title: 'Nested agent',
      parentToolCallId: 'call-build',
    };
    // Parent + nested are both transcript-only in_progress; the verify tool
    // persisted a paused status. No live tasks exist at all.
    const rootTool = { ...agentTool('build'), subTools: [nestedAgent] };
    const pausedTool: ACPToolCall = {
      ...agentTool('verify'),
      callId: 'call-paused',
      status: 'completed',
      rawOutput: { status: 'paused' },
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView
            todos={todos}
            tools={[rootTool, pausedTool]}
            tasks={[]}
          />
        </I18nProvider>,
      );
    });

    // 3 = in_progress parent + in_progress nested + paused transcript tool.
    // Before the fix every one of these required a live daemon task entry
    // and the strip rendered 0 while the build node badge showed Running.
    expect(container.textContent).toContain('3Active agents');
    // R11-2: the workflow inspector summary counts this same helper output,
    // so it must tally exactly what the strip renders for this input.
    expect(getActiveAgents([rootTool, pausedTool], [])).toHaveLength(3);

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

  it('floors the completion percentage so a nearly-done plan never reads 100%', () => {
    // 2-of-3 completed is where floor and round diverge (66 vs 67); the
    // existing 1-of-3 fixture (33) is identical under both, so it cannot
    // catch a floor→round regression that would report a premature 100%
    // for plans with 200+ steps.
    const twoOfThree: TodoItem[] = [
      { id: 'research', content: 'Research', status: 'completed' },
      { id: 'build', content: 'Build', status: 'completed' },
      { id: 'verify', content: 'Verify', status: 'pending' },
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView todos={twoOfThree} tools={[]} tasks={[]} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('66%');
    expect(container.textContent).not.toContain('67%');
    expect(container.textContent).toContain('2 / 3');
    const progress = container.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute('aria-valuenow')).toBe('66');

    act(() => root.unmount());
    container.remove();
  });

  it('locates the active step once and exposes a manual locate action', () => {
    const rect = (left: number, width: number) =>
      ({
        x: left,
        y: 0,
        left,
        top: 0,
        width,
        height: 80,
        right: left + width,
        bottom: 80,
        toJSON: () => ({}),
      }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function () {
        if (this.hasAttribute('data-plan-workflow')) return rect(0, 300);
        if (this.tagName === 'ARTICLE') {
          const id = this.querySelector('[data-plan-node-id]')?.getAttribute(
            'data-plan-node-id',
          );
          return rect(id === 'build-api' ? 600 : 0, 200);
        }
        return rect(0, 0);
      });
    const widthSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(300);
    // Pin the viewport height too: locate centres the focused step on BOTH
    // axes — a tall graph overflows the fixed-height workflow page downwards,
    // and scrollTo preserves scrollTop when only `left` is passed. With
    // clientHeight 240 and a node of height 80 at top 0:
    // top = 0 + 0 - 0 - (240 - 80) / 2 = -80.
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(240);
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    const animationSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // These patches live on HTMLElement.prototype, so a failing assertion must
    // not leak them into the rest of the file.
    try {
      act(() => {
        root.render(
          <I18nProvider language="en">
            <PlanExecutionView todos={branchedTodos} tools={[]} tasks={[]} />
          </I18nProvider>,
        );
      });
      expect(scrollTo).toHaveBeenCalledWith({
        left: 550,
        top: -80,
        behavior: 'auto',
      });

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
      expect(scrollTo).toHaveBeenCalledTimes(1);

      const locateButton = Array.from(
        container.querySelectorAll('button'),
      ).find((button) => button.textContent === 'Locate current step');
      // Host keyboard handlers (ToolApproval's approval card, the Tasks
      // panel) early-return only for [data-plan-interactive]; without the
      // marker, keypresses on the focused locate button would resolve the
      // surrounding approval request or navigate the task list.
      expect(locateButton?.hasAttribute('data-plan-interactive')).toBe(true);
      act(() => {
        locateButton?.click();
      });
      expect(scrollTo).toHaveBeenLastCalledWith({
        left: 550,
        top: -80,
        behavior: 'smooth',
      });
    } finally {
      act(() => root.unmount());
      container.remove();
      animationSpy.mockRestore();
      rectSpy.mockRestore();
      widthSpy.mockRestore();
      heightSpy.mockRestore();
      if (originalScrollTo) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
          configurable: true,
          value: originalScrollTo,
        });
      } else {
        delete HTMLElement.prototype.scrollTo;
      }
    }
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
    ).toBe('M 214 50 C 255 50, 255 50, 296 50');

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

    // Asserted behaviourally rather than as a golden path string: the guarantee
    // is that the edge leaves the source, drops clear of every node's bottom
    // edge (200 here) and climbs back to the target — not the corner radius
    // used to draw it. (A failure here used to skip the mockRestore calls below
    // and leak the rect spy into the next four tests.)
    const spanningEdge = container
      .querySelector('[data-from="docs"][data-to="release"]')
      ?.getAttribute('d');
    expect(spanningEdge).toBeTruthy();
    expect(spanningEdge).toMatch(/^M 504 160 /);
    expect(spanningEdge?.endsWith('H 876')).toBe(true);
    const routedYs = [...spanningEdge!.matchAll(/[-\d.]+ ([-\d.]+)/g)].map(
      (match) => Number(match[1]),
    );
    expect(Math.max(...routedYs)).toBeGreaterThan(200);

    act(() => root.unmount());
    container.remove();
    rectSpy.mockRestore();
    widthSpy.mockRestore();
    heightSpy.mockRestore();
  });

  it('mutes edges that do not touch the pointed-at step', () => {
    const todos: TodoItem[] = [
      { id: 'root', content: 'Root', status: 'completed' },
      { id: 'left', content: 'Left', status: 'pending', blockedBy: ['root'] },
      { id: 'right', content: 'Right', status: 'pending', blockedBy: ['root'] },
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <I18nProvider language="en">
            <PlanExecutionView todos={todos} tools={[]} tasks={[]} />
          </I18nProvider>,
        );
      });

      const edges = container.querySelector('[data-plan-edge]')?.closest('svg');
      // Nothing pointed at: no focus, so no edge is singled out.
      expect(edges?.getAttribute('data-focused')).toBeNull();

      const leftNode = container
        .querySelector('[data-plan-node-id="left"]')
        ?.closest('article');
      // jsdom has no PointerEvent; React synthesizes onPointerEnter from a
      // bubbling pointerover, which MouseEvent models well enough here.
      act(() => {
        leftNode?.dispatchEvent(
          new MouseEvent('pointerover', { bubbles: true }),
        );
      });

      const focused = container
        .querySelector('[data-plan-edge]')
        ?.closest('svg');
      expect(focused?.getAttribute('data-focused')).toBe('true');
      expect(
        container
          .querySelector('[data-from="root"][data-to="left"]')
          ?.getAttribute('data-active'),
      ).toBe('true');
      // The sibling branch is not part of this step's chain.
      expect(
        container
          .querySelector('[data-from="root"][data-to="right"]')
          ?.getAttribute('data-active'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('gives each layer-spanning edge its own return lane', () => {
    // Two dependencies that both skip a layer. They used to share one routeY
    // and draw on top of each other, which is unreadable as soon as a plan has
    // more than one long edge.
    const todos: TodoItem[] = [
      { id: 'a', content: 'A', status: 'completed' },
      { id: 'b', content: 'B', status: 'pending', blockedBy: ['a'] },
      { id: 'c', content: 'C', status: 'pending', blockedBy: ['b'] },
      { id: 'd', content: 'D', status: 'pending', blockedBy: ['c', 'a', 'b'] },
    ];
    const positions: Record<string, [number, number]> = {
      a: [10, 10],
      b: [300, 10],
      c: [590, 10],
      d: [880, 10],
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
    try {
      act(() => {
        root.render(
          <I18nProvider language="en">
            <PlanExecutionView todos={todos} tools={[]} tasks={[]} />
          </I18nProvider>,
        );
      });

      const laneY = (from: string, to: string) => {
        const d = container
          .querySelector(`[data-from="${from}"][data-to="${to}"]`)
          ?.getAttribute('d');
        expect(d).toBeTruthy();
        const ys = [...d!.matchAll(/[-\d.]+ ([-\d.]+)/g)].map((m) =>
          Number(m[1]),
        );
        return Math.max(...ys);
      };

      // Layers are a=0, b=1, c=2, d=3, so a→d (span 3) and b→d (span 2) both
      // skip a layer and must not share a lane.
      expect(laneY('a', 'd')).not.toBe(laneY('b', 'd'));
      // The longer span routes further out, so the lanes nest instead of
      // crossing each other.
      expect(laneY('a', 'd')).toBeGreaterThan(laneY('b', 'd'));
      // Both still clear the tallest node bottom (90 in normalized space).
      expect(laneY('b', 'd')).toBeGreaterThan(90);
    } finally {
      act(() => root.unmount());
      container.remove();
      rectSpy.mockRestore();
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
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

  it('refreshes edge identities when a revision renumbers steps but preserves geometry', () => {
    // A re-issued plan can rename/rename step ids while keeping every step's
    // content, dependencies, and layer geometry. The topology key changes
    // (so measure re-runs) but the measured path data is identical — the
    // measure-skip signature must still include edge identity, or the
    // stale from/to pairs stay wired to steps that no longer exist.
    const renumberedTodos: TodoItem[] = branchedTodos.map((todo, index) => {
      const renamed = `step-${index + 1}`;
      const renamedDependencies = new Map(
        branchedTodos.map((original, dependencyIndex) => [
          original.id,
          `step-${dependencyIndex + 1}`,
        ]),
      );
      return {
        ...todo,
        id: renamed,
        ...(todo.blockedBy
          ? {
              blockedBy: todo.blockedBy.map(
                (dependencyId) => renamedDependencies.get(dependencyId)!,
              ),
            }
          : {}),
      };
    });

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
      container.querySelector('[data-from="plan"][data-to="build-api"]'),
    ).not.toBeNull();

    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionView todos={renumberedTodos} tools={[]} tasks={[]} />
        </I18nProvider>,
      );
    });

    const renumberedEdges = Array.from(
      container.querySelectorAll('[data-plan-edge]'),
    )
      .map((edge) =>
        JSON.stringify([
          edge.getAttribute('data-from'),
          edge.getAttribute('data-to'),
        ]),
      )
      .sort();
    expect(renumberedEdges).toEqual([
      JSON.stringify(['step-1', 'step-2']),
      JSON.stringify(['step-1', 'step-3']),
      JSON.stringify(['step-2', 'step-4']),
      JSON.stringify(['step-3', 'step-4']),
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
    expect(
      container.querySelectorAll('[data-plan-input], [data-plan-output]'),
    ).toHaveLength(0);
    expect(container.textContent).toContain('Dense 32');
    // Lines disappearing with no explanation reads as a broken render, so the
    // skip is stated rather than silent.
    expect(container.textContent).toContain('Too many dependencies to draw');

    act(() => root.unmount());
    container.remove();
  });
});
