// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ACPToolCall, Message, TodoItem } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import { PlanExecutionHistoryProvider } from '../../planExecutionHistoryContext';
import {
  hydrateSubagentTree,
  SubagentDetailsProvider,
} from '../../subagentDetailsContext';
import { HistoricalPlanExecution } from './HistoricalPlanExecution';

const todos: TodoItem[] = [
  { id: 'discover', content: 'Discover', status: 'completed' },
  {
    id: 'build',
    content: 'Build',
    status: 'completed',
    blockedBy: ['discover'],
  },
];

const activeTodos: TodoItem[] = [
  { id: 'discover', content: 'Discover', status: 'completed' },
  {
    id: 'build',
    content: 'Build',
    status: 'in_progress',
    blockedBy: ['discover'],
  },
];

const activeTodoTool: ACPToolCall = {
  callId: 'todo-call-start',
  toolName: 'todo_write',
  status: 'completed',
  rawOutput: {
    entries: activeTodos,
    plan: { id: 'plan-1' },
  },
};

const todoTool: ACPToolCall = {
  callId: 'todo-call',
  toolName: 'todo_write',
  status: 'completed',
  rawOutput: {
    entries: todos,
    plan: { id: 'plan-1' },
  },
};

const childAgent: ACPToolCall = {
  callId: 'child-agent',
  toolName: 'Agent',
  title: 'Child agent',
  status: 'completed',
  parentToolCallId: 'build-agent',
};

const buildAgent: ACPToolCall = {
  callId: 'build-agent',
  toolName: 'Agent',
  title: 'Build agent',
  status: 'completed',
  args: { todo_id: 'build' },
  subTools: [childAgent],
};

function completedPlanMessages(...agents: ACPToolCall[]): Message[] {
  return [
    { id: 'plan-start-message', role: 'tool_group', tools: [activeTodoTool] },
    { id: 'agent-message', role: 'tool_group', tools: agents },
    { id: 'plan-message', role: 'tool_group', tools: [todoTool] },
  ];
}

const messages = completedPlanMessages(buildAgent);

function PaginatedHistoryFixture({ onLoad }: { onLoad: () => void }) {
  const [page, setPage] = useState<Message[]>([
    { id: 'plan-message', role: 'tool_group', tools: [todoTool] },
  ]);
  const [hasOlder, setHasOlder] = useState(true);
  return (
    <PlanExecutionHistoryProvider
      messages={page}
      hasOlderHistory={hasOlder}
      onLoadOlderHistory={async () => {
        onLoad();
        setPage(completedPlanMessages(buildAgent));
        setHasOlder(false);
      }}
    >
      <HistoricalPlanExecution todos={todos} sourceTool={todoTool} />
    </PlanExecutionHistoryProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function toggleDetails(details: HTMLDetailsElement, open: boolean) {
  Object.defineProperty(details, 'open', {
    configurable: true,
    value: open,
    writable: true,
  });
  details.dispatchEvent(new Event('toggle'));
}

describe('HistoricalPlanExecution', () => {
  it('loads earlier transcript pages before resolving a completed plan', async () => {
    const onLoad = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PaginatedHistoryFixture onLoad={onLoad} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).not.toContain('Build agent');
    await act(async () => {
      toggleDetails(container.querySelector('details')!, true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onLoad).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Build agent');

    act(() => root.unmount());
    container.remove();
  });

  it('rebuilds a completed workflow and opens persisted subagents', () => {
    const onOpen = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionHistoryProvider messages={messages}>
            <SubagentDetailsProvider onOpen={onOpen}>
              <HistoricalPlanExecution todos={todos} sourceTool={todoTool} />
            </SubagentDetailsProvider>
          </PlanExecutionHistoryProvider>
        </I18nProvider>,
      );
    });

    const details = container.querySelector('details')!;
    act(() => {
      toggleDetails(details, true);
    });
    expect(container.textContent).toContain('Build agent');
    expect(container.textContent).toContain('Child agent');

    const childButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Child agent'),
    );
    act(() => childButton?.click());
    expect(onOpen).toHaveBeenCalledWith(childAgent);

    act(() => root.unmount());
    container.remove();
  });

  it('resolves persisted agents from a plan message id', () => {
    const planMessages: Message[] = [
      { id: 'plan-message', role: 'plan', todos: activeTodos },
      { id: 'agent-message', role: 'tool_group', tools: [buildAgent] },
      { id: 'plan-completed-message', role: 'plan', todos },
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionHistoryProvider messages={planMessages}>
            <HistoricalPlanExecution
              todos={activeTodos}
              sourceMessageId="plan-message"
            />
          </PlanExecutionHistoryProvider>
        </I18nProvider>,
      );
    });

    const details = container.querySelector('details')!;
    act(() => {
      toggleDetails(details, true);
    });
    expect(container.textContent).toContain('Build agent');

    act(() => root.unmount());
    container.remove();
  });

  it('lazily restores a nested Agent tree from persisted lineage', async () => {
    const coldRoot = { ...buildAgent, subTools: undefined };
    const coldMessages = completedPlanMessages(coldRoot);
    const resolveTree = vi.fn(async (tool: ACPToolCall) =>
      hydrateSubagentTree(tool, {
        sessionId: 'virtual-root',
        taskId: 'root-task',
        title: 'Build agent',
        status: 'completed',
        nestedAgents: [
          {
            taskId: 'child-task',
            toolCallId: 'child-call',
            parentTaskId: 'root-task',
            title: 'Persisted child',
            status: 'completed',
          },
          {
            taskId: 'grandchild-task',
            toolCallId: 'grandchild-call',
            parentTaskId: 'child-task',
            title: 'Persisted grandchild',
            status: 'failed',
          },
        ],
      }),
    );
    const onOpen = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionHistoryProvider messages={coldMessages}>
            <SubagentDetailsProvider onOpen={onOpen} resolveTree={resolveTree}>
              <HistoricalPlanExecution todos={todos} sourceTool={todoTool} />
            </SubagentDetailsProvider>
          </PlanExecutionHistoryProvider>
        </I18nProvider>,
      );
    });

    expect(resolveTree).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Persisted child');
    const details = container.querySelector('details')!;
    await act(async () => {
      toggleDetails(details, true);
      await Promise.resolve();
    });
    expect(resolveTree).toHaveBeenCalledWith(coldRoot);
    expect(container.textContent).toContain('Persisted child');
    expect(container.textContent).toContain('Persisted grandchild');

    const persistedButtons = Array.from(
      container.querySelectorAll('button[data-plan-interactive]'),
    ).filter((button) => button.textContent?.includes('Persisted'));
    expect(persistedButtons).toHaveLength(2);
    const grandchildButton = persistedButtons.find((button) =>
      button.textContent?.includes('Persisted grandchild'),
    );
    act(() => grandchildButton?.click());
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'grandchild-call' }),
    );

    act(() => root.unmount());
    container.remove();
  });

  it('keeps root executions visible when lineage resolution fails', async () => {
    const coldRoot = { ...buildAgent, subTools: undefined };
    const coldMessages = completedPlanMessages(coldRoot);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionHistoryProvider messages={coldMessages}>
            <SubagentDetailsProvider
              onOpen={() => undefined}
              resolveTree={() => Promise.reject(new Error('not found'))}
            >
              <HistoricalPlanExecution todos={todos} sourceTool={todoTool} />
            </SubagentDetailsProvider>
          </PlanExecutionHistoryProvider>
        </I18nProvider>,
      );
    });

    const details = container.querySelector('details')!;
    await act(async () => {
      toggleDetails(details, true);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Build agent');

    act(() => root.unmount());
    container.remove();
  });

  it('ignores a stale lineage response after closing and reopening', async () => {
    const coldRoot = { ...buildAgent, subTools: undefined };
    const coldMessages = completedPlanMessages(coldRoot);
    const first = deferred<ACPToolCall>();
    const second = deferred<ACPToolCall>();
    const resolveTree = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionHistoryProvider messages={coldMessages}>
            <SubagentDetailsProvider
              onOpen={() => undefined}
              resolveTree={resolveTree}
            >
              <HistoricalPlanExecution todos={todos} sourceTool={todoTool} />
            </SubagentDetailsProvider>
          </PlanExecutionHistoryProvider>
        </I18nProvider>,
      );
    });

    const details = container.querySelector('details')!;
    await act(async () => {
      toggleDetails(details, true);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      toggleDetails(details, false);
      toggleDetails(details, true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resolveTree).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({
        ...coldRoot,
        subTools: [
          {
            callId: 'fresh-child',
            toolName: 'Agent',
            title: 'Fresh child',
            status: 'completed',
          },
        ],
      });
      await second.promise;
    });
    expect(container.textContent).toContain('Fresh child');

    await act(async () => {
      first.resolve({
        ...coldRoot,
        subTools: [
          {
            callId: 'stale-child',
            toolName: 'Agent',
            title: 'Stale child',
            status: 'completed',
          },
        ],
      });
      await first.promise;
    });
    expect(container.textContent).toContain('Fresh child');
    expect(container.textContent).not.toContain('Stale child');

    act(() => root.unmount());
    container.remove();
  });

  it('keeps successful lineage when another root fails to resolve', async () => {
    const firstRoot = { ...buildAgent, subTools: undefined };
    const secondRoot: ACPToolCall = {
      ...buildAgent,
      callId: 'second-agent',
      title: 'Second agent',
      subTools: undefined,
    };
    const coldMessages = completedPlanMessages(firstRoot, secondRoot);
    const resolveTree = vi.fn((tool: ACPToolCall) =>
      tool.callId === firstRoot.callId
        ? Promise.resolve({
            ...tool,
            subTools: [
              {
                callId: 'restored-child',
                toolName: 'Agent',
                title: 'Restored child',
                status: 'completed' as const,
              },
            ],
          })
        : Promise.reject(new Error('missing sidecar')),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <PlanExecutionHistoryProvider messages={coldMessages}>
            <SubagentDetailsProvider
              onOpen={() => undefined}
              resolveTree={resolveTree}
            >
              <HistoricalPlanExecution todos={todos} sourceTool={todoTool} />
            </SubagentDetailsProvider>
          </PlanExecutionHistoryProvider>
        </I18nProvider>,
      );
    });

    const details = container.querySelector('details')!;
    await act(async () => {
      toggleDetails(details, true);
      await Promise.resolve();
    });

    expect(resolveTree).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Restored child');
    expect(container.textContent).toContain('Second agent');

    act(() => root.unmount());
    container.remove();
  });
});
