// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonSessionTasksStatus,
  DaemonSessionTaskStatus,
  DaemonSessionTaskWithWorkflowStatus,
  DaemonSessionWorkflowTaskStatus,
  DaemonSessionWorkflowTasksStatus,
} from '@qwen-code/sdk/daemon';
import { TASKS_STATUS_ACTIVE_EVENT } from '../components/messages/TasksStatusMessage';
import { useBackgroundTasks } from './useBackgroundTasks';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const sdkMock = vi.hoisted(() => ({
  ownerVersion: 0,
  ownerGuard: { capture: vi.fn() },
  actions: {
    getTasks: vi.fn(),
    getWorkflowTasks: vi.fn(),
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useActions: () => sdkMock.actions,
  useDaemonSessionOwnerGuard: () => sdkMock.ownerGuard,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let sessionId: string | undefined = 'session-a';
let taskActivityKey = 'monitor:running';
/** The activity fact the transcript walk would report for the key above. */
let taskActivityActive = false;
let refreshTrigger = 0;
let workflowsEnabled = false;
let latestTasks: DaemonSessionTaskWithWorkflowStatus[] = [];

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  if (!resolve) throw new Error('deferred promise did not initialize');
  return { promise, resolve };
}

function snapshot(
  id: string,
  tasks: DaemonSessionTaskStatus[] = [],
): DaemonSessionTasksStatus {
  return {
    v: 1,
    sessionId: id,
    now: Date.now(),
    tasks,
  };
}

function workflowSnapshot(
  id: string,
  tasks: DaemonSessionTaskWithWorkflowStatus[] = [],
): DaemonSessionWorkflowTasksStatus {
  return {
    v: 1,
    sessionId: id,
    now: Date.now(),
    tasks,
  };
}

function monitor(
  id: string,
  status: 'running' | 'completed',
): DaemonSessionTaskStatus {
  return {
    kind: 'monitor',
    id,
    label: id,
    description: id,
    status,
    startTime: Date.now(),
    runtimeMs: 1,
    command: `echo ${id}`,
    eventCount: 0,
    droppedLines: 0,
    lastEventTime: 0,
  };
}

function Harness() {
  latestTasks = useBackgroundTasks(
    sessionId,
    taskActivityKey,
    taskActivityActive,
    true,
    refreshTrigger,
    workflowsEnabled,
  );
  return null;
}

async function renderHarness() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
  });
}

async function rerenderHarness() {
  await act(async () => {
    root?.render(<Harness />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionId = 'session-a';
  taskActivityKey = 'monitor:running';
  taskActivityActive = false;
  refreshTrigger = 0;
  workflowsEnabled = false;
  latestTasks = [];
  sdkMock.actions.getTasks.mockReset();
  sdkMock.actions.getWorkflowTasks.mockReset();
  sdkMock.ownerVersion = 0;
  sdkMock.ownerGuard.capture.mockImplementation(() => {
    const version = sdkMock.ownerVersion;
    return { isCurrent: () => sdkMock.ownerVersion === version };
  });
});

it('uses the opt-in task snapshot when workflows are enabled', async () => {
  const workflow: DaemonSessionWorkflowTaskStatus = {
    kind: 'workflow',
    id: 'workflow-1',
    label: 'review-and-fix',
    description: 'Review and fix',
    status: 'running',
    startTime: Date.now(),
    runtimeMs: 1,
    isBackgrounded: true,
    currentPhase: 'Review',
    phaseVisits: [],
    dispatches: [],
    agentsDispatched: 0,
    agentsCompleted: 0,
    tokensSpent: 0,
    tokenBudgetTotal: null,
    recentLogs: [],
    pendingApprovalCount: 0,
  };
  workflowsEnabled = true;
  sdkMock.actions.getWorkflowTasks.mockResolvedValue({
    v: 1,
    sessionId: 'session-a',
    now: Date.now(),
    tasks: [workflow],
  });

  await renderHarness();

  expect(sdkMock.actions.getWorkflowTasks).toHaveBeenCalledWith({
    silent: true,
  });
  expect(sdkMock.actions.getTasks).not.toHaveBeenCalled();
  expect(latestTasks).toEqual([workflow]);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe('useBackgroundTasks', () => {
  it('keeps polling while an active workflow is waiting to register', async () => {
    taskActivityKey = 'workflow-call:in_progress';
    taskActivityActive = true;
    workflowsEnabled = true;
    const runningWorkflow = {
      kind: 'workflow' as const,
      id: 'wf-live',
      label: 'Live workflow',
      description: 'Live workflow',
      status: 'running' as const,
      startTime: Date.now(),
      runtimeMs: 1,
      isBackgrounded: false,
      currentPhase: null,
      phaseVisits: [],
      dispatches: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      recentLogs: [],
      pendingApprovalCount: 0,
    };
    sdkMock.actions.getWorkflowTasks
      .mockResolvedValueOnce(workflowSnapshot('session-a'))
      .mockResolvedValueOnce(workflowSnapshot('session-a'))
      .mockResolvedValue(workflowSnapshot('session-a', [runningWorkflow]));

    await renderHarness();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(sdkMock.actions.getWorkflowTasks).toHaveBeenCalledTimes(3);
    expect(latestTasks).toEqual([runningWorkflow]);
  });

  it('keeps polling past a terminal snapshot while workflow activity is live', async () => {
    taskActivityKey = 'workflow-call:in_progress';
    taskActivityActive = true;
    workflowsEnabled = true;
    const terminalWorkflow = {
      kind: 'workflow' as const,
      id: 'wf-old',
      label: 'Old workflow',
      description: 'Old workflow',
      status: 'completed' as const,
      startTime: Date.now() - 100,
      endTime: Date.now(),
      runtimeMs: 100,
      isBackgrounded: false,
      currentPhase: null,
      phaseVisits: [],
      dispatches: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      recentLogs: [],
      pendingApprovalCount: 0,
    };
    const runningWorkflow = {
      ...terminalWorkflow,
      id: 'wf-new',
      status: 'running' as const,
      endTime: undefined,
      runtimeMs: 1,
    };
    sdkMock.actions.getWorkflowTasks
      .mockResolvedValueOnce(workflowSnapshot('session-a', [terminalWorkflow]))
      .mockResolvedValueOnce(workflowSnapshot('session-a', [terminalWorkflow]))
      .mockResolvedValue(
        workflowSnapshot('session-a', [terminalWorkflow, runningWorkflow]),
      );

    await renderHarness();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(sdkMock.actions.getWorkflowTasks).toHaveBeenCalledTimes(3);
    expect(latestTasks).toContainEqual(runningWorkflow);
  });

  it('only pauses polling for a task panel in the same session', async () => {
    const runningMonitor = monitor('monitor-a', 'running');
    sdkMock.actions.getTasks.mockResolvedValue(
      snapshot('session-a', [runningMonitor]),
    );
    await renderHarness();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TASKS_STATUS_ACTIVE_EVENT, {
          detail: { active: true, sessionId: 'session-b' },
        }),
      );
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(2);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TASKS_STATUS_ACTIVE_EVENT, {
          detail: { active: true, sessionId: 'session-a' },
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(2);
  });

  it('resumes polling for a new session after a panel left open in the old one', async () => {
    // Split view keeps the previous session's pane mounted, so switching
    // primary fires no `active: false`, and when that pane's panel finally
    // closes its event carries the OLD sessionId and is filtered out. With
    // the latch never reset, the new session's polling stays blocked for
    // good — the guard outranks every refreshTrigger bump.
    sdkMock.actions.getTasks.mockResolvedValue(
      snapshot('session-a', [monitor('monitor-a', 'running')]),
    );
    await renderHarness();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TASKS_STATUS_ACTIVE_EVENT, {
          detail: { active: true, sessionId: 'session-a' },
        }),
      );
    });

    sdkMock.actions.getTasks.mockClear();
    sdkMock.actions.getTasks.mockResolvedValue(
      snapshot('session-b', [monitor('monitor-b', 'running')]),
    );
    sessionId = 'session-b';
    await rerenderHarness();

    // The stale pane's panel closes only now, naming the session it was
    // opened in.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TASKS_STATUS_ACTIVE_EVENT, {
          detail: { active: false, sessionId: 'session-a' },
        }),
      );
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(sdkMock.actions.getTasks.mock.calls.length).toBeGreaterThan(0);
    // `monitor()` stamps startTime from the clock, so compare identity.
    expect(latestTasks.map((task) => task.id)).toEqual(['monitor-b']);
  });

  it('keeps polling after a transient task refresh failure', async () => {
    const runningMonitor = monitor('monitor-a', 'running');
    sdkMock.actions.getTasks
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(snapshot('session-a', [runningMonitor]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await renderHarness();
    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(2);
    expect(latestTasks).toEqual([runningMonitor]);
    warn.mockRestore();
  });

  it('stops polling when the session is disconnected', async () => {
    sdkMock.actions.getTasks.mockRejectedValue(
      new Error('Get tasks failed: Daemon session is not connected'),
    );

    await renderHarness();
    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(1);
  });

  it('starts polling when an out-of-band task triggers a refresh', async () => {
    taskActivityKey = '';
    taskActivityActive = false;
    const runningFork = {
      kind: 'agent' as const,
      id: 'fork-agent-1',
      label: 'Review current changes',
      description: 'Review current changes',
      status: 'running' as const,
      startTime: Date.now(),
      runtimeMs: 1,
      isBackgrounded: true,
    };
    sdkMock.actions.getTasks.mockResolvedValue(
      snapshot('session-a', [runningFork]),
    );

    await renderHarness();
    expect(sdkMock.actions.getTasks).not.toHaveBeenCalled();

    refreshTrigger = 1;
    await rerenderHarness();

    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(1);
    expect(latestTasks).toEqual([runningFork]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(2);
  });

  it('ignores an old response and starts polling the new session immediately', async () => {
    const sessionA = deferred<DaemonSessionTasksStatus>();
    const sessionB = deferred<DaemonSessionTasksStatus>();
    const runningMonitor = monitor('monitor-b', 'running');
    sdkMock.actions.getTasks
      .mockReturnValueOnce(sessionA.promise)
      .mockReturnValueOnce(sessionB.promise)
      .mockResolvedValue(snapshot('session-b', [runningMonitor]));

    await renderHarness();
    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(1);
    expect(sdkMock.actions.getTasks).toHaveBeenLastCalledWith({
      silent: true,
    });

    sessionId = 'session-b';
    sdkMock.ownerVersion += 1;
    await rerenderHarness();
    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(2);
    expect(sdkMock.actions.getTasks).toHaveBeenLastCalledWith({
      silent: true,
    });

    await act(async () => {
      sessionA.resolve(
        snapshot('session-a', [monitor('monitor-a', 'completed')]),
      );
      await sessionA.promise;
    });
    expect(latestTasks).toEqual([]);

    await act(async () => {
      sessionB.resolve(snapshot('session-b', [runningMonitor]));
      await sessionB.promise;
    });

    expect(latestTasks).toEqual([runningMonitor]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(3);
    expect(sdkMock.actions.getTasks).toHaveBeenLastCalledWith({
      silent: true,
    });
  });

  it('ignores an old attachment response when the session id is unchanged', async () => {
    const request = deferred<DaemonSessionTasksStatus>();
    sdkMock.actions.getTasks.mockReturnValueOnce(request.promise);
    await renderHarness();

    sdkMock.ownerVersion += 1;
    await act(async () => {
      request.resolve(
        snapshot('session-a', [monitor('stale-monitor', 'running')]),
      );
      await request.promise;
    });

    expect(latestTasks).toEqual([]);
  });

  it('starts polling a replacement attachment while the old request hangs', async () => {
    const oldRequest = deferred<DaemonSessionTasksStatus>();
    const runningMonitor = monitor('replacement-monitor', 'running');
    sdkMock.actions.getTasks
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce(snapshot('session-a', [runningMonitor]));

    await renderHarness();
    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(1);

    sdkMock.ownerVersion += 1;
    await rerenderHarness();

    expect(sdkMock.actions.getTasks).toHaveBeenCalledTimes(2);
    expect(latestTasks).toEqual([runningMonitor]);

    await act(async () => {
      oldRequest.resolve(
        snapshot('session-a', [monitor('stale-monitor', 'completed')]),
      );
      await oldRequest.promise;
    });
    expect(latestTasks).toEqual([runningMonitor]);
  });
});
