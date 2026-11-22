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
  DaemonSessionScheduledTaskStatus,
  DaemonSessionTasksStatus,
} from '@qwen-code/sdk/daemon';
import type { DaemonScheduledTask } from '@qwen-code/web-shell/daemon-react-sdk';
import {
  useSessionScheduledTasks,
  type SessionDurableScheduledTask,
  type SessionScheduledTasksResult,
  type SessionScopedScheduledTask,
} from './useSessionScheduledTasks';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sdkMock = vi.hoisted(() => ({
  ownerVersion: 0,
  availability: 'available',
  ownerGuard: { capture: vi.fn() },
  sessionActions: {
    getTasks: vi.fn(),
    cancelTask: vi.fn(),
  },
  workspaceActions: {
    listScheduledTasks: vi.fn(),
    updateScheduledTask: vi.fn(),
    runScheduledTask: vi.fn(),
    deleteScheduledTask: vi.fn(),
  },
}));

vi.mock('../daemon/availability-context', () => ({
  useDaemonAvailability: () => sdkMock.availability,
  useDaemonAvailabilityController: () => undefined,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useActions: () => sdkMock.sessionActions,
  useWorkspaceActions: () => sdkMock.workspaceActions,
  useDaemonSessionOwnerGuard: () => sdkMock.ownerGuard,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: SessionScheduledTasksResult | null = null;

interface HarnessProps {
  sessionId?: string;
  workspaceId?: string;
  connected?: boolean;
  durableEnabled?: boolean;
  activityKey?: string;
  refreshTrigger?: number;
}

function Harness(props: HarnessProps) {
  latest = useSessionScheduledTasks({
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
    connected: props.connected ?? true,
    durableEnabled: props.durableEnabled ?? true,
    activityKey: props.activityKey ?? '',
    refreshTrigger: props.refreshTrigger ?? 0,
  });
  return null;
}

function renderHarness(props: HarnessProps) {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root!.render(<Harness {...props} />);
  });
}

function durableTask(
  overrides: Partial<DaemonScheduledTask> = {},
): DaemonScheduledTask {
  return {
    id: 'durable-1',
    name: 'Daily standup',
    cron: '0 9 * * *',
    prompt: 'Summarize recent commits',
    recurring: true,
    enabled: true,
    createdAt: 1_000,
    lastFiredAt: null,
    nextRunAt: 50_000,
    sessionId: 'session-1',
    sessionMode: 'persistent',
    ...overrides,
  } as DaemonScheduledTask;
}

function sessionCronTask(
  overrides: Partial<DaemonSessionScheduledTaskStatus> = {},
): DaemonSessionScheduledTaskStatus {
  return {
    id: 'cron-1',
    source: 'cron',
    cronExpr: '*/5 * * * *',
    prompt: 'Check build status',
    recurring: true,
    createdAt: 2_000,
    expiresAt: 900_000,
    lastFiredAt: null,
    nextRunAt: 30_000,
    ...overrides,
  };
}

function tasksSnapshot(
  sessionId: string,
  scheduledTasks?: DaemonSessionScheduledTaskStatus[],
): DaemonSessionTasksStatus {
  return {
    v: 1,
    sessionId,
    now: 10_000,
    tasks: [],
    ...(scheduledTasks ? { scheduledTasks } : {}),
  };
}

beforeEach(() => {
  sdkMock.ownerVersion = 0;
  sdkMock.availability = 'available';
  sdkMock.ownerGuard.capture.mockImplementation(() => {
    const version = sdkMock.ownerVersion;
    return { isCurrent: () => sdkMock.ownerVersion === version };
  });
  sdkMock.sessionActions.getTasks.mockReset();
  sdkMock.sessionActions.cancelTask.mockReset();
  sdkMock.workspaceActions.listScheduledTasks.mockReset();
  sdkMock.workspaceActions.updateScheduledTask.mockReset();
  sdkMock.workspaceActions.runScheduledTask.mockReset();
  sdkMock.workspaceActions.deleteScheduledTask.mockReset();
  latest = null;
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

describe('useSessionScheduledTasks', () => {
  it('merges session-bound durable tasks and in-memory session cron/wakeup tasks sorted by active + nextRunAt', async () => {
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([
      durableTask({ id: 'durable-other', sessionId: 'session-2' }),
      durableTask({
        id: 'durable-paused',
        name: 'Paused check',
        enabled: false,
        nextRunAt: 15_000,
      }),
      durableTask({
        id: 'durable-active',
        name: 'Active check',
        enabled: true,
        nextRunAt: 40_000,
      }),
    ]);
    sdkMock.sessionActions.getTasks.mockResolvedValue(
      tasksSnapshot('session-1', [
        sessionCronTask({
          id: 'wakeup-1',
          source: 'wakeup',
          cronExpr: '@wakeup',
          recurring: false,
          nextRunAt: 20_000,
        }),
      ]),
    );

    renderHarness({ sessionId: 'session-1', workspaceId: 'ws-secondary' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledWith(
      'ws-secondary',
    );
    expect(latest?.tasks.map((task) => task.id)).toEqual([
      'wakeup-1',
      'durable-active',
      'durable-paused',
    ]);
    expect(latest?.activeCount).toBe(2);
    expect(latest?.activeSessionCount).toBe(1);
    expect(latest?.nextRunAt).toBe(20_000);
    expect(latest?.taskStatusById.get('durable-active')).toBe('active');
    expect(latest?.taskStatusById.get('durable-paused')).toBe('paused');
    expect(latest?.taskStatusById.get('wakeup-1')).toBe('active');
  });

  it('toggles and deletes durable tasks and cancels session-scoped tasks', async () => {
    const durable = durableTask({ id: 'd-1', enabled: true });
    const sessionTask = sessionCronTask({ id: 'c-1' });
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([durable]);
    sdkMock.sessionActions.getTasks.mockResolvedValue(
      tasksSnapshot('session-1', [sessionTask]),
    );
    sdkMock.workspaceActions.updateScheduledTask.mockResolvedValue({
      ...durable,
      enabled: false,
    });
    sdkMock.workspaceActions.deleteScheduledTask.mockResolvedValue(undefined);
    sdkMock.sessionActions.cancelTask.mockResolvedValue({ cancelled: true });

    renderHarness({ sessionId: 'session-1', workspaceId: 'ws-1' });
    await act(async () => {
      await Promise.resolve();
    });

    const durableEntry = latest?.tasks.find(
      (item): item is SessionDurableScheduledTask => item.scope === 'durable',
    );
    const sessionEntry = latest?.tasks.find(
      (item): item is SessionScopedScheduledTask => item.scope === 'session',
    );
    expect(durableEntry).toBeDefined();
    expect(sessionEntry).toBeDefined();

    await act(async () => {
      await latest!.toggleDurableTask(durableEntry!);
    });
    expect(sdkMock.workspaceActions.updateScheduledTask).toHaveBeenCalledWith(
      'd-1',
      { enabled: false },
      'ws-1',
    );
    expect(latest?.taskStatusById.get('d-1')).toBe('paused');

    await act(async () => {
      await latest!.cancelSessionTask(sessionEntry!);
    });
    expect(sdkMock.sessionActions.cancelTask).toHaveBeenCalledWith(
      'c-1',
      'cron',
    );
    expect(latest?.activeSessionCount).toBe(0);

    await act(async () => {
      await latest!.deleteDurableTask(durableEntry!);
    });
    expect(sdkMock.workspaceActions.deleteScheduledTask).toHaveBeenCalledWith(
      'd-1',
      'ws-1',
    );
    expect(latest?.tasks).toHaveLength(0);
  });

  it('clears state when switching sessions', async () => {
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([
      durableTask({ id: 'd-1', sessionId: 'session-1' }),
    ]);
    sdkMock.sessionActions.getTasks.mockResolvedValue(
      tasksSnapshot('session-1', [sessionCronTask()]),
    );

    renderHarness({ sessionId: 'session-1' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(latest?.tasks).toHaveLength(2);

    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([]);
    sdkMock.sessionActions.getTasks.mockResolvedValue(
      tasksSnapshot('session-2', []),
    );
    renderHarness({ sessionId: 'session-2' });
    expect(latest?.tasks).toHaveLength(0);
    await act(async () => {
      await Promise.resolve();
    });
    expect(latest?.tasks).toHaveLength(0);
  });
});
