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
} from '@qwen-code/sdk/daemon';
import { useBackgroundTasks } from './useBackgroundTasks';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const sdkMock = vi.hoisted(() => ({
  actions: {
    getTasks: vi.fn(),
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useActions: () => sdkMock.actions,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let sessionId: string | undefined = 'session-a';
let taskActivityKey = 'monitor:running';
let refreshTrigger = 0;
let latestTasks: DaemonSessionTaskStatus[] = [];

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
    true,
    refreshTrigger,
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
  refreshTrigger = 0;
  latestTasks = [];
  sdkMock.actions.getTasks.mockReset();
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
});
