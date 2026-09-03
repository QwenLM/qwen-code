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
import {
  TranscriptRenderModeProvider,
  type TranscriptRenderMode,
} from '../../transcriptRenderMode';

type DaemonSessionTasksStatus = DaemonSessionWorkflowTasksStatus;

// Mock the daemon SDK hook so the unit test doesn't pull the whole connection
// graph. Hoisted so tests can assert on / reprogram the mocks across renders.
const {
  getTasksMock,
  getWorkflowTasksMock,
  cancelTaskMock,
  controlWorkflowTaskMock,
} = vi.hoisted(() => ({
  getTasksMock: vi.fn(),
  getWorkflowTasksMock: vi.fn(),
  cancelTaskMock: vi.fn(),
  controlWorkflowTaskMock: vi.fn(),
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useActions: () => ({
    getTasks: getTasksMock,
    getWorkflowTasks: getWorkflowTasksMock,
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
  getWorkflowTasksMock.mockReset();
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
    workflowName: 'review-and-fix',
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
    includeWorkflows?: boolean;
    taskView?: 'all' | 'workflow-active' | 'workflow-history';
    sessionId?: string;
    onTasksChange?: (snapshot: DaemonSessionWorkflowTasksStatus) => void;
    onWorkflowRunStarted?: () => void;
    planTodos?: readonly TodoItem[];
    agentTools?: readonly ACPToolCall[];
    onOpenSubagent?: (tool: ACPToolCall) => void;
    onOpenMonitor?: (task: DaemonSessionMonitorTaskStatus) => void;
    renderMode?: TranscriptRenderMode;
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
        <TranscriptRenderModeProvider
          value={options.renderMode ?? 'interactive'}
        >
          <TasksStatusMessage
            message={{ snapshot }}
            embedded={options.embedded}
            keyboardShortcuts={options.keyboardShortcuts}
            syncSnapshot={options.syncSnapshot}
            includeWorkflows={options.includeWorkflows}
            taskView={options.taskView}
            manageActiveEvent={false}
            planTodos={options.planTodos}
            agentTools={options.agentTools}
            onOpenSubagent={options.onOpenSubagent}
            onOpenMonitor={options.onOpenMonitor}
            onTasksChange={options.onTasksChange}
            onWorkflowRunStarted={options.onWorkflowRunStarted}
          />
        </TranscriptRenderModeProvider>
      </I18nProvider>,
    );
  });
  return container;
}

it('keeps polling workflow tasks when an enabled panel opens empty', async () => {
  vi.useFakeTimers();
  getWorkflowTasksMock.mockResolvedValue({
    v: 1,
    sessionId: 'session-1',
    now: 13_000,
    tasks: [workflowTask()],
  });
  renderPanel([], { includeWorkflows: true });

  await act(async () => vi.advanceTimersByTimeAsync(3_000));

  expect(getWorkflowTasksMock).toHaveBeenCalledOnce();
  expect(getTasksMock).not.toHaveBeenCalled();
});

describe('TasksStatusMessage monitor details', () => {
  it('renders a complete inert snapshot without polling in document mode', () => {
    vi.useFakeTimers();
    const tasks = Array.from({ length: 10 }, (_, index) =>
      agentTask(`task-${index}`, {
        prompt:
          index === 9
            ? Array.from(
                { length: 6 },
                (_value, line) => `prompt-line-${line}`,
              ).join('\n')
            : undefined,
        recentActivities:
          index === 9
            ? Array.from({ length: 8 }, (_value, activity) => ({
                name: 'read_file',
                description: `activity-${activity}.ts`,
                at: activity,
              }))
            : undefined,
      }),
    );
    const container = renderPanel(tasks, { renderMode: 'document' });

    act(() => vi.advanceTimersByTime(6_000));

    expect(getTasksMock).not.toHaveBeenCalled();
    expect(cancelTaskMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('label-task-0');
    expect(container.textContent).toContain('label-task-9');
    expect(container.textContent).toContain('activity-0.ts');
    expect(container.textContent).toContain('activity-7.ts');
    expect(container.textContent).toContain('prompt-line-0');
    expect(container.textContent).toContain('prompt-line-5');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

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

  it('switches expanded embedded rows with one focus-and-click gesture', () => {
    const taskA = workflowTask({ id: 'workflow-a', label: 'run-a' });
    const taskB = workflowTask({
      id: 'workflow-b',
      label: 'run-b',
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
      taskView: 'workflow-active',
    });
    const findRow = (label: string) =>
      Array.from(
        container.querySelectorAll<HTMLElement>('[role="button"]'),
      ).find((candidate) => candidate.textContent?.includes(label));

    act(() => {
      findRow('run-a')?.focus();
      findRow('run-a')?.click();
    });
    expect(container.textContent).toContain('Review behavior regressions');

    act(() => findRow('run-b')?.focus());
    act(() => findRow('run-b')?.click());

    expect(findRow('run-b')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('prompt-for-b');
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
          <TranscriptRenderModeProvider value="interactive">
            <TasksStatusMessage
              message={{ snapshot: nextSnapshot }}
              embedded
              keyboardShortcuts={false}
              manageActiveEvent={false}
              syncSnapshot
              taskView="workflow-active"
            />
          </TranscriptRenderModeProvider>
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
    getWorkflowTasksMock.mockReturnValueOnce(pendingSessionA);
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
    expect(getWorkflowTasksMock).toHaveBeenCalledOnce();
    expect(getTasksMock).not.toHaveBeenCalled();

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
          <TranscriptRenderModeProvider value="interactive">
            <TasksStatusMessage
              message={{ snapshot: sessionBSnapshot }}
              embedded
              keyboardShortcuts={false}
              manageActiveEvent={false}
              syncSnapshot
              taskView="workflow-active"
              onTasksChange={onTasksChange}
            />
          </TranscriptRenderModeProvider>
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

    // Dropping the stale response is only half of it. The polling effect
    // deliberately keeps sessionId out of its deps and re-reads the ref per
    // tick, so a refactor that "fixes" staleness by tearing the interval
    // down on a session switch — without re-arming it — leaves the mounted
    // panel never refreshing again: running workflows render as running
    // forever and onTasksChange never fires for the new session.
    getWorkflowTasksMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-b',
      now: 13_000,
      tasks: [sessionBTask],
    });
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });

    expect(getWorkflowTasksMock).toHaveBeenCalledTimes(2);
    expect(onTasksChange).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-b' }),
    );
  });

  it('cancels the row the user focused, not the one selection started on', async () => {
    // Rows became focusable in this PR while `x` still routes to the
    // SELECTED task, so without syncing selection on focus the two cursors
    // diverge: Tab to task B, press x, and task A — which the user never
    // pointed at — is the one that stops.
    const taskA = workflowTask({ id: 'workflow-a', label: 'run-a' });
    const taskB = workflowTask({ id: 'workflow-b', label: 'run-b' });
    cancelTaskMock.mockResolvedValue({ cancelled: true });
    const container = renderPanel([taskA, taskB], {
      embedded: true,
      keyboardShortcuts: true,
      taskView: 'workflow-active',
    });
    const findRow = (label: string) =>
      Array.from(
        container.querySelectorAll<HTMLElement>('[role="button"]'),
      ).find((candidate) => candidate.textContent?.includes(label));

    // The global keydown listener attaches after a 50 ms guard delay.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    act(() => findRow('run-b')?.focus());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    });

    expect(cancelTaskMock).toHaveBeenCalledWith('workflow-b', 'workflow');
  });

  it('opens the live graph and stops the workflow through the task API', async () => {
    const task = workflowTask();
    cancelTaskMock.mockResolvedValue({ cancelled: true });
    getWorkflowTasksMock.mockResolvedValue({
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
    getWorkflowTasksMock.mockResolvedValue({
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
    // A second action must still be accepted. `busy` is released only by
    // the session-guarded finally; stuck true, every handler returns early
    // on `if (busy) return` and every control renders disabled until
    // remount — and no other test touches that, so the regression ships
    // green. Asserted through a different control because Pause itself is
    // status-disabled once the run reports 'pausing'.
    cancelTaskMock.mockResolvedValue({ cancelled: true });
    const stop = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Stop');
    expect(stop).toBeDefined();
    expect(stop!.disabled).toBe(false);
    await act(async () => stop!.click());
    expect(cancelTaskMock).toHaveBeenCalledWith('workflow-1', 'workflow');

    controlWorkflowTaskMock.mockResolvedValue({
      changed: true,
      status: 'running',
    });
    getWorkflowTasksMock.mockResolvedValue({
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
          <TranscriptRenderModeProvider value="interactive">
            <TasksStatusMessage
              message={{ snapshot: sessionBSnapshot }}
              embedded
              keyboardShortcuts={false}
              manageActiveEvent={false}
              syncSnapshot
              taskView="workflow-active"
            />
          </TranscriptRenderModeProvider>
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
    expect(getWorkflowTasksMock).not.toHaveBeenCalled();

    // The stale action's finally skips releasing `busy` (its session guard
    // no longer matches), so the [snapshot.sessionId] reset effect is the
    // only thing that frees the new session's panel. Without it every
    // control here renders disabled and every handler no-ops until unmount.
    const rowB = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((candidate) => candidate.textContent?.includes('run-b'));
    expect(rowB).toBeDefined();
    act(() => rowB!.click());
    const pauseB = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Pause');
    expect(pauseB).toBeDefined();
    expect(pauseB!.disabled).toBe(false);

    controlWorkflowTaskMock.mockResolvedValue({
      changed: true,
      status: 'pausing',
    });
    getWorkflowTasksMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-b',
      now: 12_000,
      tasks: [sessionBTask],
    });
    await act(async () => pauseB!.click());

    expect(controlWorkflowTaskMock).toHaveBeenLastCalledWith(
      'workflow-b',
      'pause',
    );
  });

  it('refuses a retry the daemon says is no longer valid', async () => {
    // The daemon answers { changed: false } when the transition is no
    // longer valid — e.g. Retry clicked while a concurrent 3s poll is
    // finalizing the run. No `changed: false` occurs anywhere else in the
    // suite, so dropping the guard would fire onWorkflowRunStarted for a
    // run that never started (App bumps its refresh trigger on it) and the
    // user would never see why the click did nothing.
    const onWorkflowRunStarted = vi.fn();
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
    controlWorkflowTaskMock.mockResolvedValue({ changed: false });
    const container = renderPanel([failed], { onWorkflowRunStarted });
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
    expect(onWorkflowRunStarted).not.toHaveBeenCalled();
    expect(getWorkflowTasksMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Workflow state changed before the action',
    );
  });

  it('retries a failed workflow path and refreshes the graph', async () => {
    const onWorkflowRunStarted = vi.fn();
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
    getWorkflowTasksMock.mockImplementation(() => {
      expect(onWorkflowRunStarted).toHaveBeenCalledOnce();
      return Promise.resolve({
        v: 1,
        sessionId: 'session-1',
        now: 10_200,
        tasks: [workflowTask()],
      });
    });
    const container = renderPanel([failed], { onWorkflowRunStarted });
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
    expect(onWorkflowRunStarted).toHaveBeenCalledOnce();
    expect(getWorkflowTasksMock).toHaveBeenCalledOnce();
    expect(getTasksMock).not.toHaveBeenCalled();
  });

  it('reruns a failed workflow from scratch and opens the new run', async () => {
    const onWorkflowRunStarted = vi.fn();
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
    getWorkflowTasksMock.mockResolvedValue({
      v: 1,
      sessionId: 'session-1',
      now: 10_200,
      tasks: [failed, rerun, agentTask('newer-agent', { startTime: 3_000 })],
    });
    const container = renderPanel([failed], { onWorkflowRunStarted });
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
    expect(onWorkflowRunStarted).toHaveBeenCalledOnce();
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

  it('does not group workflow history by a shared display label', () => {
    const current = workflowTask({
      id: 'workflow-deploy',
      workflowName: 'deploy',
      label: 'Deploy',
    });
    const otherDefinition = workflowTask({
      id: 'workflow-deploy-v2',
      workflowName: 'deploy-v2',
      label: 'Deploy',
      isHistorical: true,
      status: 'failed',
      endTime: 2_000,
    });
    const container = renderPanel([current, otherDefinition]);
    const currentRow = Array.from(
      container.querySelectorAll<HTMLElement>('[role="button"]'),
    ).find((candidate) => candidate.textContent?.includes('Deploy'));

    act(() => currentRow?.click());

    expect(container.textContent).not.toContain('Run history (1)');
    expect(container.textContent).not.toContain('Delete saved run');
  });

  it('refuses a history delete the daemon says is no longer valid', async () => {
    // The sibling !result.changed branch. Without the guard the panel would
    // reload and clear the row as if the delete had happened, and the user
    // would never learn the saved run was already gone.
    const historical = workflowTask({
      id: 'wf-abcd',
      isHistorical: true,
      status: 'failed',
      startTime: 500,
      endTime: 1_000,
      runtimeMs: 500,
    });
    controlWorkflowTaskMock.mockResolvedValue({ changed: false });
    const container = renderPanel([historical]);
    const row = Array.from(container.querySelectorAll('span')).find((node) =>
      node.textContent?.includes('review-and-fix'),
    )?.parentElement;
    act(() => row?.click());

    const remove = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete saved run',
    );
    act(() => remove?.click());
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Confirm delete',
    );
    await act(async () => confirm?.click());

    expect(controlWorkflowTaskMock).toHaveBeenCalledWith(
      'wf-abcd',
      'delete-history',
    );
    expect(getWorkflowTasksMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'The saved run is no longer available',
    );
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
    getWorkflowTasksMock.mockResolvedValue({
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
    expect(getWorkflowTasksMock).toHaveBeenCalledOnce();
    expect(getTasksMock).not.toHaveBeenCalled();
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
