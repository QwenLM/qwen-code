// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionMonitorTaskStatus,
  DaemonSessionTaskWithWorkflowStatus,
  DaemonSessionWorkflowTasksStatus,
  DaemonSessionWorkflowTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { I18nProvider } from '../../i18n';

type DaemonSessionTasksStatus = DaemonSessionWorkflowTasksStatus;

// The panel only needs getTasks/cancelTask from the daemon SDK; mock the
// hook so the unit test doesn't pull the whole connection graph. Hoisted
// so tests can assert on / reprogram the mocks across renders.
const { getTasksMock, cancelTaskMock, controlWorkflowTaskMock } = vi.hoisted(
  () => ({
    getTasksMock: vi.fn(),
    cancelTaskMock: vi.fn(),
    controlWorkflowTaskMock: vi.fn(),
  }),
);
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useActions: () => ({
    getTasks: getTasksMock,
    getWorkflowTasks: getTasksMock,
    cancelTask: cancelTaskMock,
    controlWorkflowTask: controlWorkflowTaskMock,
  }),
}));

const { TasksStatusMessage } = await import('./TasksStatusMessage');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  getTasksMock.mockReset();
  cancelTaskMock.mockReset();
  controlWorkflowTaskMock.mockReset();
  vi.useRealTimers();
});

function agentTask(
  id: string,
  overrides: Partial<DaemonSessionAgentTaskStatus> = {},
): DaemonSessionAgentTaskStatus {
  return {
    kind: 'agent',
    id,
    label: `label-${id}`,
    description: `desc-${id}`,
    status: 'running',
    startTime: 1_000,
    runtimeMs: 5_000,
    isBackgrounded: true,
    subagentType: 'general-purpose',
    ...overrides,
  };
}

function monitorTask(
  overrides: Partial<DaemonSessionMonitorTaskStatus> = {},
): DaemonSessionMonitorTaskStatus {
  return {
    kind: 'monitor',
    id: 'monitor-1',
    label: 'monitor-label',
    description: 'watch server log',
    status: 'running',
    startTime: 1_000,
    runtimeMs: 5_000,
    command: 'tail -f server.log',
    eventCount: 3,
    lastEventTime: 5_000,
    droppedLines: 0,
    ...overrides,
  };
}

function workflowTask(
  overrides: Partial<DaemonSessionWorkflowTaskStatus> = {},
): DaemonSessionWorkflowTaskStatus {
  return {
    kind: 'workflow',
    id: 'workflow-1',
    label: 'review-and-fix',
    description: 'Review and fix',
    status: 'running',
    startTime: 1_000,
    runtimeMs: 5_000,
    isBackgrounded: true,
    currentPhase: 'Review',
    phaseVisits: [
      {
        id: 'phase-1',
        index: 0,
        title: 'Review',
        startedAt: 1_000,
      },
    ],
    dispatches: [
      {
        id: 'dispatch-1',
        phaseVisitId: 'phase-1',
        label: 'Correctness',
        prompt: 'Review behavior regressions',
        status: 'running',
        dependsOn: [],
        queuedAt: 1_010,
        startedAt: 1_020,
      },
    ],
    agentsDispatched: 1,
    agentsCompleted: 0,
    tokensSpent: 120,
    tokenBudgetTotal: null,
    recentLogs: [],
    pendingApprovalCount: 0,
    pendingApprovals: [],
    ...overrides,
  };
}

function renderPanel(
  tasks: DaemonSessionTaskWithWorkflowStatus[],
  options: {
    embedded?: boolean;
    keyboardShortcuts?: boolean;
    syncSnapshot?: boolean;
    taskView?: 'all' | 'workflow-active' | 'workflow-history';
    sessionId?: string;
    onTasksChange?: (snapshot: DaemonSessionWorkflowTasksStatus) => void;
    planTodos?: readonly TodoItem[];
    agentTools?: readonly ACPToolCall[];
    onOpenSubagent?: (tool: ACPToolCall) => void;
    onOpenMonitor?: (task: DaemonSessionMonitorTaskStatus) => void;
  } = {},
): HTMLElement {
  const snapshot: DaemonSessionWorkflowTasksStatus = {
    v: 1,
    sessionId: options.sessionId ?? 'session-1',
    now: 10_000,
    tasks,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      <I18nProvider language="en">
        <TasksStatusMessage
          message={{ snapshot }}
          embedded={options.embedded}
          keyboardShortcuts={options.keyboardShortcuts}
          syncSnapshot={options.syncSnapshot}
          taskView={options.taskView}
          manageActiveEvent={false}
          planTodos={options.planTodos}
          agentTools={options.agentTools}
          onOpenSubagent={options.onOpenSubagent}
          onOpenMonitor={options.onOpenMonitor}
          onTasksChange={options.onTasksChange}
        />
      </I18nProvider>,
    );
  });
  return container;
}

describe('TasksStatusMessage monitor details', () => {
  it('opens an embedded monitor in the right-panel callback', () => {
    const onOpenMonitor = vi.fn();
    const task = monitorTask();
    const container = renderPanel([task], {
      embedded: true,
      onOpenMonitor,
    });
    const label = Array.from(container.querySelectorAll('span')).find(
      (node) => node.textContent === '[monitor] watch server log',
    );
    expect(label?.parentElement).not.toBeNull();

    act(() => {
      label?.parentElement?.click();
    });

    expect(onOpenMonitor).toHaveBeenCalledOnce();
    expect(onOpenMonitor).toHaveBeenCalledWith(task);
    expect(container.textContent).not.toContain('tail -f server.log');
  });

  it('keeps the existing inline detail when no panel callback is provided', () => {
    const container = renderPanel([monitorTask()], { embedded: true });
    const label = Array.from(container.querySelectorAll('span')).find(
      (node) => node.textContent === '[monitor] watch server log',
    );

    act(() => {
      label?.parentElement?.click();
    });

    expect(container.textContent).toContain('tail -f server.log');
  });
});

describe('TasksStatusMessage workflow details', () => {
  it('makes embedded workflow rows keyboard-accessible', () => {
    const container = renderPanel([workflowTask()], {
      embedded: true,
      keyboardShortcuts: false,
      taskView: 'workflow-active',
    });
    const row = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((candidate) => candidate.textContent?.includes('review-and-fix'));

    expect(row).toBeDefined();
    expect(row?.tabIndex).toBe(0);
    expect(row?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      row?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(row?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Review behavior regressions');
    expect(container.textContent).not.toContain('Runtime 5s');
    expect(container.textContent?.match(/120 tokens/gi)).toHaveLength(1);
  });

  it('closes filtered detail instead of selecting a different workflow', () => {
    const taskA = workflowTask({
      id: 'workflow-a',
      label: 'run-a',
      startTime: 2_000,
      dispatches: [
        {
          ...workflowTask().dispatches[0]!,
          id: 'dispatch-a',
          prompt: 'prompt-for-a',
        },
      ],
    });
    const taskB = workflowTask({
      id: 'workflow-b',
      label: 'run-b',
      startTime: 1_000,
      dispatches: [
        {
          ...workflowTask().dispatches[0]!,
          id: 'dispatch-b',
          prompt: 'prompt-for-b',
        },
      ],
    });
    const container = renderPanel([taskA, taskB], {
      embedded: true,
      keyboardShortcuts: false,
      syncSnapshot: true,
      taskView: 'workflow-active',
    });
    const rowA = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((candidate) => candidate.textContent?.includes('run-a'));
    act(() => rowA?.click());
    expect(container.textContent).toContain('prompt-for-a');

    const nextSnapshot: DaemonSessionTasksStatus = {
      v: 1,
      sessionId: 'session-1',
      now: 11_000,
      tasks: [{ ...taskA, status: 'completed', endTime: 11_000 }, taskB],
    };
    const root = mounted.at(-1)!.root;
    act(() => {
      root.render(
        <I18nProvider language="en">
          <TasksStatusMessage
            message={{ snapshot: nextSnapshot }}
            embedded
            keyboardShortcuts={false}
            manageActiveEvent={false}
            syncSnapshot
            taskView="workflow-active"
          />
        </I18nProvider>,
      );
    });

    const rowB = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((candidate) => candidate.textContent?.includes('run-b'));
    expect(rowB?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('prompt-for-a');
    expect(container.textContent).not.toContain('prompt-for-b');
  });

  it('ignores a stale polling response from the previous session', async () => {
    vi.useFakeTimers();
    const onTasksChange = vi.fn();
    let resolveSessionA!: (snapshot: DaemonSessionTasksStatus) => void;
    const pendingSessionA = new Promise<DaemonSessionTasksStatus>((resolve) => {
      resolveSessionA = resolve;
    });
    getTasksMock.mockReturnValueOnce(pendingSessionA);
    const sessionATask = workflowTask({ id: 'workflow-a', label: 'run-a' });
    const sessionBTask = workflowTask({ id: 'workflow-b', label: 'run-b' });
    const container = renderPanel([sessionATask], {
      embedded: true,
      keyboardShortcuts: false,
      syncSnapshot: true,
      taskView: 'workflow-active',
      sessionId: 'session-a',
      onTasksChange,
    });
    await act(async () => vi.advanceTimersByTime(3_000));

    const sessionBSnapshot: DaemonSessionTasksStatus = {
      v: 1,
      sessionId: 'session-b',
      now: 11_000,
      tasks: [sessionBTask],
    };
    const root = mounted.at(-1)!.root;
    act(() => {
      root.render(
        <I18nProvider language="en">
          <TasksStatusMessage
            message={{ snapshot: sessionBSnapshot }}
            embedded
            keyboardShortcuts={false}
            manageActiveEvent={false}
            syncSnapshot
            taskView="workflow-active"
            onTasksChange={onTasksChange}
          />
        </I18nProvider>,
      );
    });

    await act(async () => {
      resolveSessionA({
        v: 1,
        sessionId: 'session-a',
        now: 12_000,
        tasks: [sessionATask],
      });
      await pendingSessionA;
    });

    expect(container.textContent).toContain('run-b');
    expect(container.textContent).not.toContain('run-a');
    expect(onTasksChange).not.toHaveBeenCalled();
  });

  it('opens the live graph and stops the workflow through the task API', async () => {
    const task = workflowTask();
    cancelTaskMock.mockResolvedValue({ cancelled: true });
    getTasksMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 10_100,
      tasks: [{ ...task, status: 'cancelled' }],
    });
    const container = renderPanel([task]);
    const row = Array.from(container.querySelectorAll('span')).find((node) =>
      node.textContent?.includes('review-and-fix'),
    )?.parentElement;

    act(() => row?.click());

    expect(container.textContent).toContain('Review behavior regressions');
    const stop = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Stop');
    expect(stop).toBeDefined();

    await act(async () => stop!.click());

    expect(cancelTaskMock).toHaveBeenCalledWith('workflow-1', 'workflow');
  });

  it('pauses and resumes a background workflow through the task API', async () => {
    const task = workflowTask();
    controlWorkflowTaskMock.mockResolvedValue({
      changed: true,
      status: 'pausing',
    });
    getTasksMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 10_100,
      tasks: [{ ...task, status: 'pausing' }],
    });
    const container = renderPanel([task]);
    const row = Array.from(container.querySelectorAll('span')).find((node) =>
      node.textContent?.includes('review-and-fix'),
    )?.parentElement;

    act(() => row?.click());
    const pause = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Pause');

    await act(async () => pause!.click());

    expect(controlWorkflowTaskMock).toHaveBeenCalledWith('workflow-1', 'pause');

    controlWorkflowTaskMock.mockResolvedValue({
      changed: true,
      status: 'running',
    });
    getTasksMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 10_200,
      tasks: [{ ...task, status: 'running' }],
    });
    const pausedContainer = renderPanel([workflowTask({ status: 'paused' })]);
    const pausedRow = Array.from(pausedContainer.querySelectorAll('span')).find(
      (node) => node.textContent?.includes('review-and-fix'),
    )?.parentElement;
    act(() => pausedRow?.click());
    const resume = Array.from(
      pausedContainer.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Resume');

    await act(async () => resume!.click());

    expect(controlWorkflowTaskMock).toHaveBeenLastCalledWith(
      'workflow-1',
      'resume',
    );
  });

  it('ignores a workflow action that settles after switching sessions', async () => {
    let resolveControl!: (value: {
      changed: boolean;
      status: 'pausing';
    }) => void;
    controlWorkflowTaskMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveControl = resolve;
      }),
    );
    const sessionATask = workflowTask({ id: 'workflow-a', label: 'run-a' });
    const sessionBTask = workflowTask({ id: 'workflow-b', label: 'run-b' });
    const container = renderPanel([sessionATask], {
      embedded: true,
      keyboardShortcuts: false,
      syncSnapshot: true,
      taskView: 'workflow-active',
      sessionId: 'session-a',
    });
    const rowA = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((candidate) => candidate.textContent?.includes('run-a'));
    act(() => rowA?.click());
    const pause = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Pause');
    act(() => pause?.click());

    const sessionBSnapshot: DaemonSessionTasksStatus = {
      v: 1,
      sessionId: 'session-b',
      now: 11_000,
      tasks: [sessionBTask],
    };
    const root = mounted.at(-1)!.root;
    act(() => {
      root.render(
        <I18nProvider language="en">
          <TasksStatusMessage
            message={{ snapshot: sessionBSnapshot }}
            embedded
            keyboardShortcuts={false}
            manageActiveEvent={false}
            syncSnapshot
            taskView="workflow-active"
          />
        </I18nProvider>,
      );
    });

    await act(async () => {
      resolveControl({ changed: true, status: 'pausing' });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('run-b');
    expect(container.textContent).not.toContain('run-a');
    expect(getTasksMock).not.toHaveBeenCalled();
  });

  it('retries a failed workflow path and refreshes the graph', async () => {
    const failed = workflowTask({
      status: 'failed',
      error: 'Architecture review failed',
      dispatches: [
        {
          ...workflowTask().dispatches[0]!,
          status: 'failed',
          error: 'Architecture review failed',
        },
      ],
    });
    controlWorkflowTaskMock.mockResolvedValue({
      changed: true,
      status: 'running',
    });
    getTasksMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 10_200,
      tasks: [workflowTask()],
    });
    const container = renderPanel([failed]);
    const row = Array.from(container.querySelectorAll('span')).find((node) =>
      node.textContent?.includes('review-and-fix'),
    )?.parentElement;

    act(() => row?.click());
    const retry = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Retry failed path');
    expect(retry).toBeDefined();

    await act(async () => retry!.click());

    expect(controlWorkflowTaskMock).toHaveBeenCalledWith('workflow-1', 'retry');
    expect(getTasksMock).toHaveBeenCalledOnce();
  });

  it('reruns a failed workflow from scratch and opens the new run', async () => {
    const failed = workflowTask({
      status: 'failed',
      error: 'Architecture review failed',
    });
    const rerun = workflowTask({
      id: 'workflow-2',
      sourceRunId: failed.id,
      startMode: 'rerun',
      startTime: 2_000,
      dispatches: [
        {
          ...workflowTask().dispatches[0]!,
          id: 'dispatch-2',
          prompt: 'Fresh run agent',
        },
      ],
    });
    controlWorkflowTaskMock.mockResolvedValue({
      changed: true,
      status: 'running',
      taskId: rerun.id,
    });
    getTasksMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 10_200,
      tasks: [failed, rerun, agentTask('newer-agent', { startTime: 3_000 })],
    });
    const container = renderPanel([failed]);
    const row = Array.from(container.querySelectorAll('span')).find((node) =>
      node.textContent?.includes('review-and-fix'),
    )?.parentElement;

    act(() => row?.click());
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    );
    expect(
      buttons.find((button) => button.textContent === 'Retry failed path'),
    ).toBeDefined();
    const rerunAll = buttons.find(
      (button) => button.textContent === 'Rerun all',
    );
    expect(rerunAll).toBeDefined();

    await act(async () => rerunAll!.click());

    expect(controlWorkflowTaskMock).toHaveBeenCalledWith('workflow-1', 'rerun');
    expect(container.textContent).toContain('Fresh run agent');
    expect(container.textContent).toContain('Compare runs');
  });

  it('offers a full rerun, but not a path retry, after completion', () => {
    const container = renderPanel([
      workflowTask({ status: 'completed', endTime: 9_000 }),
    ]);
    const row = Array.from(container.querySelectorAll('span')).find((node) =>
      node.textContent?.includes('review-and-fix'),
    )?.parentElement;

    act(() => row?.click());

    expect(container.textContent).toContain('Rerun all');
    expect(container.textContent).not.toContain('Retry failed path');
  });

  it('shows saved workflow history while keeping restored runs read-only', () => {
    const current = workflowTask({ id: 'workflow-current' });
    const historical = workflowTask({
      id: 'workflow-saved',
      isHistorical: true,
      status: 'failed',
      startTime: 500,
      endTime: 1_000,
      runtimeMs: 500,
    });
    const container = renderPanel([current, historical]);
    const currentRow = Array.from(container.querySelectorAll('span')).find(
      (node) => node.textContent?.includes('review-and-fix'),
    )?.parentElement;

    act(() => currentRow?.click());
    const history = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Run history (1)');
    expect(history).toBeDefined();
    act(() => history!.click());

    expect(container.textContent).toContain('workflow-saved');

    const savedContainer = renderPanel([historical]);
    const savedRow = Array.from(savedContainer.querySelectorAll('span')).find(
      (node) => node.textContent?.includes('review-and-fix'),
    )?.parentElement;
    act(() => savedRow?.click());

    expect(savedContainer.textContent).toContain('Saved run · read-only');
    expect(savedContainer.textContent).not.toContain('Retry failed path');
    expect(savedContainer.textContent).not.toContain('Rerun all');
  });

  it('deletes a restored run after confirmation and refreshes the task list', async () => {
    const historical = workflowTask({
      id: 'wf-abcd',
      isHistorical: true,
      status: 'failed',
      startTime: 500,
      endTime: 1_000,
      runtimeMs: 500,
    });
    controlWorkflowTaskMock.mockResolvedValue({ changed: true });
    getTasksMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 2_000,
      tasks: [],
    });
    const container = renderPanel([historical]);
    const row = Array.from(container.querySelectorAll('span')).find((node) =>
      node.textContent?.includes('review-and-fix'),
    )?.parentElement;
    act(() => row?.click());

    const remove = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete saved run',
    );
    act(() => remove?.click());
    expect(controlWorkflowTaskMock).not.toHaveBeenCalled();
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Confirm delete',
    );
    await act(async () => confirm?.click());

    expect(controlWorkflowTaskMock).toHaveBeenCalledWith(
      'wf-abcd',
      'delete-history',
    );
    expect(getTasksMock).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('Saved run · read-only');
  });
});

describe('TasksStatusMessage paused agent controls', () => {
  it('keeps the abandon hint distinct from workflow stop', () => {
    const container = renderPanel([
      agentTask('paused-agent', { status: 'paused' }),
    ]);

    expect(container.textContent).toContain('x abandon');
    expect(container.textContent).not.toContain('x stop');
  });
});

describe('TasksStatusMessage nested-agent tree', () => {
  it('leaves workflow and subagent buttons in control of their keyboard input', async () => {
    const onOpenSubagent = vi.fn();
    const tool: ACPToolCall = {
      callId: 'call-build',
      toolName: 'Agent',
      title: 'Build agent',
      status: 'in_progress',
      args: { todo_id: 'build' },
    };
    const container = renderPanel(
      [agentTask('build', { toolUseId: tool.callId })],
      {
        planTodos: [
          { id: 'build', content: 'Build the feature', status: 'in_progress' },
        ],
        agentTools: [tool],
        onOpenSubagent,
      },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    const node = container.querySelector<HTMLButtonElement>(
      '[data-plan-node-id="build"]',
    )!;
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => node.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(false);
    act(() => node.click());

    const details = container.querySelector('[data-plan-step-details]')!;
    const execution = Array.from(
      details.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Build agent'))!;
    const executionEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => execution.dispatchEvent(executionEnter));
    expect(executionEnter.defaultPrevented).toBe(false);
    act(() => execution.click());
    expect(onOpenSubagent).toHaveBeenCalledWith(tool);
    expect(cancelTaskMock).not.toHaveBeenCalled();
  });

  it('groups a child directly beneath its parent across the sort order', () => {
    // Active sort alone renders newest-first: child(3000), other(2000),
    // parent(1000). The tree post-pass must pull the child up under its
    // parent without disturbing the other root's earned position.
    const container = renderPanel([
      agentTask('parent', { startTime: 1_000 }),
      agentTask('other', { startTime: 2_000 }),
      agentTask('child', {
        startTime: 3_000,
        parentAgentId: 'parent',
        parentName: 'general-purpose',
        depth: 1,
      }),
    ]);
    const text = container.textContent ?? '';
    const posOther = text.indexOf('label-other');
    const posParent = text.indexOf('label-parent');
    const posChild = text.indexOf('label-child');
    expect(posOther).toBeGreaterThanOrEqual(0);
    expect(posParent).toBeGreaterThan(posOther);
    expect(posChild).toBeGreaterThan(posParent);
  });

  it('marks nested rows with the ↳ marker and indents by visible depth', () => {
    const container = renderPanel([
      agentTask('parent'),
      agentTask('child', { parentAgentId: 'parent', depth: 1 }),
    ]);
    expect(container.textContent).toContain('↳');
    const indented = container.querySelector(
      'span[style*="padding-left"]',
    ) as HTMLElement | null;
    expect(indented).not.toBeNull();
    expect(indented!.style.paddingLeft).toBe('16px');
    expect(indented!.textContent).toContain('label-child');
  });

  it('annotates an orphaned row with its departed parent instead of indenting', () => {
    const container = renderPanel([
      agentTask('orphan', {
        parentAgentId: 'gone',
        parentName: 'editor',
        depth: 2,
      }),
    ]);
    const text = container.textContent ?? '';
    expect(text).toContain('↳');
    expect(text).toContain('from editor');
    expect(container.querySelector('span[style*="padding-left"]')).toBeNull();
  });

  it('cancels a foreground child of a background parent on the first press', async () => {
    // The two-step confirm exists to warn "cancelling ends your turn".
    // A foreground child awaited by a background parent unblocks that
    // parent, not the user — first press must cancel immediately, same
    // as the TUI dialog's chain-aware gate.
    getTasksMock.mockResolvedValue({ tasks: [] });
    cancelTaskMock.mockResolvedValue({ cancelled: true });
    renderPanel([
      agentTask('bg-parent', { isBackgrounded: true, startTime: 2_000 }),
      agentTask('fg-child', {
        isBackgrounded: false,
        parentAgentId: 'bg-parent',
        depth: 1,
        startTime: 1_000,
      }),
    ]);
    // The global keydown listener attaches after a 50 ms guard delay.
    // Use 200 ms to keep a generous margin on slow CI runners.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const press = (key: string) =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key }));
        // Each state change re-arms the delayed listener (50 ms guard);
        // wait it out so the next press isn't swallowed mid-re-attach.
        await new Promise((r) => setTimeout(r, 200));
      });
    await press('ArrowDown'); // select the child (row 2)
    await press('x');
    expect(cancelTaskMock).toHaveBeenCalledTimes(1);
    expect(cancelTaskMock).toHaveBeenCalledWith('fg-child', 'agent');
  });

  it('requires a second press to cancel a user-blocking agent', async () => {
    getTasksMock.mockResolvedValue({ tasks: [] });
    cancelTaskMock.mockResolvedValue({ cancelled: true });
    renderPanel([
      agentTask('fg-root', { isBackgrounded: false, startTime: 2_000 }),
      agentTask('fg-child', {
        isBackgrounded: false,
        parentAgentId: 'fg-root',
        depth: 1,
        startTime: 1_000,
      }),
    ]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const press = (key: string) =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key }));
        // Each state change re-arms the delayed listener (50 ms guard);
        // wait it out so the next press isn't swallowed mid-re-attach.
        await new Promise((r) => setTimeout(r, 200));
      });
    await press('x'); // fully-foreground chain → arms the confirm instead
    expect(cancelTaskMock).not.toHaveBeenCalled();
    await press('x'); // second press confirms
    expect(cancelTaskMock).toHaveBeenCalledTimes(1);
    expect(cancelTaskMock).toHaveBeenCalledWith('fg-root', 'agent');
  });

  it('tags [blocking] only on a fully-foreground chain', () => {
    const container = renderPanel([
      agentTask('bg-parent', { isBackgrounded: true }),
      agentTask('fg-child', {
        isBackgrounded: false,
        parentAgentId: 'bg-parent',
        depth: 1,
      }),
      agentTask('fg-root', { isBackgrounded: false }),
    ]);
    const text = container.textContent ?? '';
    // fg-root's whole chain (itself) is foreground → tagged.
    expect(text).toContain('[blocking] label-fg-root');
    // fg-child is awaited by a background parent → blocks that parent,
    // not the user; must NOT be tagged.
    expect(text).not.toContain('[blocking] label-fg-child');
    expect(text).not.toContain('[blocking] label-bg-parent');
  });

  it('caps the detail progress list at the newest MAX_DISPLAYED_ACTIVITIES rows', async () => {
    const recentActivities = Array.from({ length: 8 }, (_, i) => ({
      name: 'read_file',
      description: `activity-${i}.ts`,
      at: i,
    }));
    const tasks = [agentTask('solo', { recentActivities })];
    // The 3 s poll would otherwise replace state; return the same task.
    getTasksMock.mockResolvedValue({ tasks });
    const container = renderPanel(tasks);
    // Global keydown listener attaches after a 50 ms guard delay.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    // Enter opens the detail view for the selected (only) task.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await new Promise((r) => setTimeout(r, 200));
    });
    const text = container.textContent ?? '';
    // Only the newest five (activity-3 … activity-7) render; older drop.
    expect(text).not.toContain('activity-2.ts');
    expect(text).toContain('activity-3.ts');
    expect(text).toContain('activity-7.ts');
  });
});
