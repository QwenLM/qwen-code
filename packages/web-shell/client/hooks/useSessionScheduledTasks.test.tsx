// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionScheduledTaskStatus } from '@qwen-code/sdk/daemon';
import type { DaemonScheduledTask } from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../i18n';
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

const onRunPrompt = vi.fn();
const onError = vi.fn();

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
  durableSeeded?: boolean;
  refreshTrigger?: number;
}

function Harness(props: HarnessProps) {
  latest = useSessionScheduledTasks({
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
    connected: props.connected ?? true,
    durableEnabled: props.durableEnabled ?? true,
    activityKey: props.activityKey ?? '',
    durableSeeded: props.durableSeeded,
    onRunPrompt,
    onError,
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
    root!.render(
      <I18nProvider language="en">
        <Harness {...props} />
      </I18nProvider>,
    );
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

const ACTIVE_KEY = 'cron-create:completed';

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
  onRunPrompt.mockReset();
  onError.mockReset();
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
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-secondary',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      latest?.syncSessionTasks([
        sessionCronTask({
          id: 'wakeup-1',
          source: 'wakeup',
          cronExpr: '@wakeup',
          recurring: false,
          nextRunAt: 20_000,
        }),
      ]);
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
    sdkMock.workspaceActions.updateScheduledTask.mockResolvedValue({
      ...durable,
      enabled: false,
    });
    sdkMock.workspaceActions.deleteScheduledTask.mockResolvedValue(undefined);
    sdkMock.sessionActions.cancelTask.mockResolvedValue({ cancelled: true });

    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      latest?.syncSessionTasks([sessionTask]);
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

    renderHarness({ sessionId: 'session-1', activityKey: ACTIVE_KEY });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      latest?.syncSessionTasks([sessionCronTask()]);
    });
    expect(latest?.tasks).toHaveLength(2);

    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([]);
    renderHarness({ sessionId: 'session-2', activityKey: ACTIVE_KEY });
    expect(latest?.tasks).toHaveLength(0);
    await act(async () => {
      await Promise.resolve();
    });
    expect(latest?.tasks).toHaveLength(0);
  });

  it('stays silent without scheduling evidence, sharing task snapshots without independent getTasks probes', async () => {
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([]);
    renderHarness({ sessionId: 'session-1', workspaceId: 'ws-1' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sdkMock.workspaceActions.listScheduledTasks).not.toHaveBeenCalled();
    expect(sdkMock.sessionActions.getTasks).not.toHaveBeenCalled();

    act(() => {
      latest?.syncSessionTasks([sessionCronTask({ id: 'shared-snapshot' })]);
    });
    expect(latest?.tasks.map((task) => task.id)).toEqual(['shared-snapshot']);
    expect(sdkMock.sessionActions.getTasks).not.toHaveBeenCalled();

    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledOnce();
    expect(sdkMock.sessionActions.getTasks).not.toHaveBeenCalled();
  });

  it('enqueues a recurring bound-session prompt before recording its manual run', async () => {
    const durable = Object.assign(
      durableTask({
        id: 'd-run',
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        recurring: true,
      }),
      { workspaceCwd: '/workspace/cron-example' },
    );
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([durable]);
    sdkMock.workspaceActions.runScheduledTask.mockResolvedValue(undefined);
    let admitPrompt = (): void => {};
    onRunPrompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          admitPrompt = resolve;
        }),
    );
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => {
      await Promise.resolve();
    });
    const entry = latest?.tasks.find(
      (item): item is SessionDurableScheduledTask => item.id === 'd-run',
    );
    expect(entry).toBeDefined();

    let firstRun: Promise<void> | undefined;
    await act(async () => {
      firstRun = latest!.runDurableTask(entry!);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest?.manualRunActive).toBe(true);
    await act(async () => {
      // A rapid second click must not queue another bound-session prompt or
      // record a concurrent run while the first admission is pending.
      await latest!.runDurableTask(entry!);
    });
    expect(onRunPrompt).toHaveBeenCalledTimes(1);
    expect(sdkMock.workspaceActions.runScheduledTask).not.toHaveBeenCalled();
    await act(async () => {
      admitPrompt();
      await firstRun;
    });
    expect(latest?.manualRunActive).toBe(false);

    expect(onRunPrompt).toHaveBeenCalledWith(
      durable.prompt,
      'session-1',
      '/workspace/cron-example',
    );
    expect(sdkMock.workspaceActions.runScheduledTask).toHaveBeenCalledWith(
      'd-run',
      'ws-1',
    );
    expect(onRunPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      sdkMock.workspaceActions.runScheduledTask.mock.invocationCallOrder[0],
    );
  });

  it('reports failed mutations and always clears the busy state', async () => {
    const durable = durableTask({ id: 'd-reject', enabled: true });
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([durable]);
    sdkMock.workspaceActions.updateScheduledTask.mockRejectedValue(
      new Error('network down'),
    );
    sdkMock.sessionActions.cancelTask.mockRejectedValue(
      new Error('connection lost'),
    );
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => {
      await Promise.resolve();
    });

    const entry = latest?.tasks[0] as SessionDurableScheduledTask;
    await act(async () => {
      await latest!.toggleDurableTask(entry);
    });
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      'Failed to update task',
    );
    expect(latest?.busyIds.size).toBe(0);

    let cancelled = true;
    await act(async () => {
      cancelled = await latest!.cancelSessionTaskById('wakeup-reject');
    });
    expect(cancelled).toBe(false);
    expect(onError).toHaveBeenLastCalledWith(
      expect.any(Error),
      'Failed to update task',
    );
    expect(latest?.busyIds.size).toBe(0);

    sdkMock.sessionActions.cancelTask.mockResolvedValueOnce({
      cancelled: false,
    });
    await act(async () => {
      cancelled = await latest!.cancelSessionTaskById('expired-wakeup');
    });
    expect(cancelled).toBe(false);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(latest?.busyIds.size).toBe(0);
  });
});
