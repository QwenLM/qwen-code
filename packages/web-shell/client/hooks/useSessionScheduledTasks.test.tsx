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
  runtimeClient: {},
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
    assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
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
  useWorkspace: () => ({ client: sdkMock.runtimeClient }),
  useWorkspaceActions: () => sdkMock.workspaceActions,
  useDaemonSessionOwnerGuard: () => sdkMock.ownerGuard,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: SessionScheduledTasksResult | null = null;

interface HarnessProps {
  sessionId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
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
    workspaceCwd: props.workspaceCwd,
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
    expect(latest?.taskStatusById.get('["session","wakeup","wakeup-1"]')).toBe(
      'active',
    );
  });

  it('keeps durable discovery and explicit refresh silent when durable reads are disabled', async () => {
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([]);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
      durableSeeded: true,
      durableEnabled: false,
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      latest!.refresh();
      await Promise.resolve();
    });
    expect(sdkMock.workspaceActions.listScheduledTasks).not.toHaveBeenCalled();
    expect(latest?.hasLiveDurableSnapshot).toBe(false);
  });

  it('revokes an in-flight durable discovery across disable and re-enable', async () => {
    let resolveStaleRead: ((tasks: DaemonScheduledTask[]) => void) | undefined;
    sdkMock.workspaceActions.listScheduledTasks
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStaleRead = resolve;
        }),
      )
      .mockResolvedValue([]);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
      durableSeeded: true,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledOnce();
    expect(resolveStaleRead).toBeDefined();

    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
      durableSeeded: true,
      durableEnabled: false,
    });
    expect(latest?.tasks).toEqual([]);
    expect(latest?.hasLiveDurableSnapshot).toBe(false);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
      durableSeeded: true,
      durableEnabled: true,
    });
    await act(async () => {
      resolveStaleRead?.([durableTask()]);
      await Promise.resolve();
    });

    expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledTimes(
      2,
    );
    expect(latest?.tasks).toEqual([]);
    expect(latest?.hasLiveDurableSnapshot).toBe(true);
  });

  it('does not apply a list response captured before an explicit refresh', async () => {
    const oldRead = Promise.withResolvers<DaemonScheduledTask[]>();
    const freshRead = Promise.withResolvers<DaemonScheduledTask[]>();
    sdkMock.workspaceActions.listScheduledTasks
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(freshRead.promise);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledOnce();

    await act(async () => {
      latest!.refresh();
      oldRead.resolve([durableTask({ prompt: 'stale value' })]);
      await oldRead.promise;
      expect(latest?.tasks).toEqual([]);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          sdkMock.workspaceActions.listScheduledTasks,
        ).toHaveBeenCalledTimes(2),
      );
      freshRead.resolve([durableTask({ prompt: 'fresh value' })]);
      await freshRead.promise;
    });
    expect(latest?.tasks).toHaveLength(1);
    expect(latest?.tasks[0]?.prompt).toBe('fresh value');
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
      'session-1',
    );
    expect(latest?.taskStatusById.get('d-1')).toBe('paused');

    await act(async () => {
      await latest!.cancelSessionTask(sessionEntry!);
    });
    expect(sdkMock.sessionActions.cancelTask).toHaveBeenCalledWith(
      'c-1',
      'cron',
      'cron',
    );
    expect(latest?.activeSessionCount).toBe(0);
    expect(
      latest?.confirmedCancelledSessionTaskIds.has('["session","cron","c-1"]'),
    ).toBe(true);

    await act(async () => {
      await latest!.deleteDurableTask(durableEntry!);
    });
    expect(sdkMock.workspaceActions.deleteScheduledTask).toHaveBeenCalledWith(
      'd-1',
      'ws-1',
      'session-1',
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
      expect.any(Function),
      expect.any(Function),
    );
    expect(sdkMock.workspaceActions.runScheduledTask).toHaveBeenCalledWith(
      'd-run',
      'ws-1',
      'session-1',
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

    const sessionTask = sessionCronTask({ id: 'wakeup-reject' });
    await act(async () => latest!.syncSessionTasks([sessionTask]));
    const sessionEntry = latest!.tasks.find(
      (task): task is SessionScopedScheduledTask => task.id === 'wakeup-reject',
    )!;
    let cancelled = true;
    await act(async () => {
      cancelled = await latest!.cancelSessionTask(sessionEntry);
    });
    expect(cancelled).toBe(false);
    expect(onError).toHaveBeenLastCalledWith(
      expect.any(Error),
      'Failed to stop the scheduled task',
    );
    expect(latest?.busyIds.size).toBe(0);
    expect(latest?.activeSessionCount).toBe(1);

    sdkMock.sessionActions.cancelTask.mockResolvedValueOnce({
      cancelled: false,
    });
    await act(async () => {
      cancelled = await latest!.cancelSessionTask(sessionEntry);
    });
    expect(cancelled).toBe(false);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(latest?.busyIds.size).toBe(0);
    expect(latest?.activeSessionCount).toBe(1);
  });

  it('uses the resolved secondary workspace for both the fresh read and manual run', async () => {
    const durable = durableTask({
      id: 'durable-secondary',
      sessionId: 'session-1',
    });
    // A plain list response may omit the workspace id, so the explicit
    // caller's registration must reach both downstream operations.
    delete durable.workspaceId;
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([durable]);
    sdkMock.workspaceActions.runScheduledTask.mockResolvedValue(undefined);
    onRunPrompt.mockResolvedValue(undefined);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-secondary',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => {
      await Promise.resolve();
    });
    const entry = latest?.tasks.find(
      (item): item is SessionDurableScheduledTask =>
        item.id === 'durable-secondary',
    );
    await act(async () => {
      await latest!.runDurableTask(entry!);
    });
    expect(
      sdkMock.workspaceActions.listScheduledTasks.mock.calls.every(
        ([workspaceId]) => workspaceId === 'ws-secondary',
      ),
    ).toBe(true);
    expect(sdkMock.workspaceActions.runScheduledTask).toHaveBeenCalledWith(
      'durable-secondary',
      'ws-secondary',
      'session-1',
    );
  });

  it('does not carry an explicit refresh into a different session', async () => {
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([]);
    renderHarness({ sessionId: 'session-1', workspaceId: 'ws-1' });
    act(() => {
      latest!.refresh();
    });
    await act(async () => {
      await Promise.resolve();
    });
    sdkMock.workspaceActions.listScheduledTasks.mockClear();

    renderHarness({ sessionId: 'session-2', workspaceId: 'ws-2' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sdkMock.workspaceActions.listScheduledTasks).not.toHaveBeenCalled();

    act(() => {
      latest!.refresh();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledWith(
      'ws-2',
    );
  });

  it('keeps disabled in-memory schedules paused, not active', () => {
    renderHarness({ sessionId: 'session-1' });
    act(() => {
      latest!.syncSessionTasks([
        sessionCronTask({
          id: 'stopped-loop',
          source: 'wakeup',
          recurring: false,
          enabled: false,
        }),
      ]);
    });
    expect(latest?.activeSessionCount).toBe(0);
    expect(
      latest?.taskStatusById.get('["session","wakeup","stopped-loop"]'),
    ).toBe('paused');
    expect(latest?.tasks[0]?.enabled).toBe(false);
  });

  it('truncates a task title by Unicode code points, not raw code units', () => {
    renderHarness({ sessionId: 'session-1' });
    const title = 'a'.repeat(76) + '😀' + 'b'.repeat(20);
    act(() => {
      latest!.syncSessionTasks([sessionCronTask({ prompt: title })]);
    });
    expect(latest?.tasks[0]?.title).toBe('a'.repeat(76) + '😀' + '…');
    expect(latest?.tasks[0]?.title).not.toContain('\uFFFD');
  });

  it('keeps a same-scope manual run single-flight across SDK owner replacement', async () => {
    const task = durableTask({ id: 'held-run', sessionId: 'session-1' });
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([task]);
    sdkMock.workspaceActions.runScheduledTask.mockResolvedValue(undefined);
    const admission = new Promise<void>(() => {});
    onRunPrompt.mockReturnValue(admission);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    const entry = latest!.tasks[0] as SessionDurableScheduledTask;

    await act(async () => {
      void latest!.runDurableTask(entry);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRunPrompt).toHaveBeenCalledOnce();
    expect(latest?.manualRunActive).toBe(true);
    sdkMock.ownerVersion += 1;
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    });

    expect(latest?.manualRunActive).toBe(true);
    await act(async () => {
      await latest!.runDurableTask(entry);
    });
    expect(onRunPrompt).toHaveBeenCalledOnce();
  });

  it('continues recurring preflight before an SDK owner re-render', async () => {
    const task = durableTask({ id: 'owner-before-render' });
    let releaseRead!: (tasks: DaemonScheduledTask[]) => void;
    const firstRead = new Promise<DaemonScheduledTask[]>((resolve) => {
      releaseRead = resolve;
    });
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([task]);
    sdkMock.workspaceActions.runScheduledTask.mockResolvedValue(task);
    onRunPrompt.mockResolvedValue(undefined);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    const entry = latest!.tasks[0] as SessionDurableScheduledTask;
    sdkMock.workspaceActions.listScheduledTasks
      .mockReturnValueOnce(firstRead)
      .mockResolvedValue([task]);
    let run!: Promise<void>;
    await act(async () => {
      run = latest!.runDurableTask(entry);
      await Promise.resolve();
    });
    expect(sdkMock.workspaceActions.runScheduledTask).not.toHaveBeenCalled();

    sdkMock.ownerVersion += 1;
    await act(async () => {
      releaseRead([task]);
      await run;
    });
    expect(onRunPrompt).toHaveBeenCalledOnce();
    expect(sdkMock.workspaceActions.runScheduledTask).toHaveBeenCalledOnce();
    expect(latest?.manualRunActive).toBe(false);
  });

  it('cancels a per-run when its client changes during preflight', async () => {
    const task = durableTask({
      id: 'different-runtime',
      sessionMode: 'per-run',
    });
    let releaseRead!: (tasks: DaemonScheduledTask[]) => void;
    const firstRead = new Promise<DaemonScheduledTask[]>((resolve) => {
      releaseRead = resolve;
    });
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([task]);
    sdkMock.workspaceActions.runScheduledTask.mockResolvedValue(task);
    onRunPrompt.mockResolvedValue(undefined);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    const entry = latest!.tasks[0] as SessionDurableScheduledTask;
    sdkMock.workspaceActions.listScheduledTasks
      .mockReturnValueOnce(firstRead)
      .mockResolvedValue([task]);
    let run!: Promise<void>;
    await act(async () => {
      run = latest!.runDurableTask(entry);
      await Promise.resolve();
    });

    sdkMock.runtimeClient = {};
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => {
      releaseRead([task]);
      await run;
    });

    expect(onRunPrompt).not.toHaveBeenCalled();
    expect(sdkMock.workspaceActions.runScheduledTask).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(latest?.manualRunActive).toBe(false);
  });

  it('reports admission failure after a same-scope owner replacement', async () => {
    const task = durableTask({ id: 'admission-error', sessionId: 'session-1' });
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([task]);
    const admissionError = new Error('admission failed');
    let rejectAdmission!: (error: Error) => void;
    const admission = new Promise<void>((_, reject) => {
      rejectAdmission = reject;
    });
    onRunPrompt.mockReturnValue(admission);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    const entry = latest!.tasks[0] as SessionDurableScheduledTask;
    let run!: Promise<void>;
    await act(async () => {
      run = latest!.runDurableTask(entry);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRunPrompt).toHaveBeenCalledOnce();

    sdkMock.ownerVersion += 1;
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => {
      rejectAdmission(admissionError);
      await run;
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      admissionError,
      'Failed to record the run',
    );
    expect(latest?.manualRunActive).toBe(false);
    expect(sdkMock.workspaceActions.runScheduledTask).not.toHaveBeenCalled();
  });

  it('settles a manual run before the owner re-render without retaining its lock', async () => {
    const task = durableTask({ id: 'early-settle', sessionId: 'session-1' });
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([task]);
    sdkMock.workspaceActions.runScheduledTask.mockResolvedValue(undefined);
    let admit!: () => void;
    const admission = new Promise<void>((resolve) => {
      admit = resolve;
    });
    onRunPrompt.mockReturnValue(admission);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    const entry = latest!.tasks[0] as SessionDurableScheduledTask;
    let run!: Promise<void>;
    await act(async () => {
      run = latest!.runDurableTask(entry);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRunPrompt).toHaveBeenCalledOnce();

    sdkMock.ownerVersion += 1;
    await act(async () => {
      admit();
      await run;
    });
    expect(latest?.manualRunActive).toBe(false);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    });
    onRunPrompt.mockResolvedValue(undefined);
    await act(async () => {
      await latest!.runDurableTask(entry);
    });
    expect(onRunPrompt).toHaveBeenCalledTimes(2);
    expect(latest?.manualRunActive).toBe(false);
  });

  it.each(['toggle', 'delete', 'cancel'] as const)(
    'settles %s busy state after an SDK owner replacement',
    async (operation) => {
      const task = durableTask({ id: 'busy-operation' });
      const cronTask = sessionCronTask({ id: 'session-busy-operation' });
      let release!: (value?: { cancelled: boolean }) => void;
      const response = new Promise<void | { cancelled: boolean }>((resolve) => {
        release = resolve;
      });
      sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([task]);
      sdkMock.workspaceActions.updateScheduledTask.mockReturnValue(
        operation === 'toggle' ? response : Promise.resolve(task),
      );
      sdkMock.workspaceActions.deleteScheduledTask.mockReturnValue(
        operation === 'delete' ? response : Promise.resolve(),
      );
      sdkMock.sessionActions.cancelTask.mockReturnValue(
        operation === 'cancel'
          ? response
          : Promise.resolve({ cancelled: false }),
      );
      renderHarness({
        sessionId: 'session-1',
        workspaceId: 'ws-a',
        activityKey: ACTIVE_KEY,
      });
      await act(async () => Promise.resolve());
      act(() => {
        latest!.syncSessionTasks([cronTask]);
      });
      const durableEntry = latest!.tasks.find(
        (item) => item.scope === 'durable',
      ) as SessionDurableScheduledTask;
      const sessionEntry = latest!.tasks.find(
        (item) => item.scope === 'session',
      ) as SessionScopedScheduledTask;

      let settling!: Promise<unknown>;
      await act(async () => {
        if (operation === 'toggle') {
          settling = latest!.toggleDurableTask(durableEntry);
        } else if (operation === 'delete') {
          settling = latest!.deleteDurableTask(durableEntry);
        } else {
          settling = latest!.cancelSessionTask(sessionEntry);
        }
        await Promise.resolve();
      });
      expect(latest?.busyIds.size).toBe(1);
      sdkMock.ownerVersion += 1;
      renderHarness({
        sessionId: 'session-1',
        workspaceId: 'ws-a',
        activityKey: ACTIVE_KEY,
      });
      expect(latest?.busyIds.size).toBe(1);

      await act(async () => {
        release();
        await settling;
      });
      expect(latest?.busyIds.size).toBe(0);
    },
  );

  it('blocks queued admission after durable reads are revoked', async () => {
    const task = durableTask({ id: 'revoked-queued-run' });
    let releaseRevalidation!: () => void;
    const revalidation = new Promise<void>((resolve) => {
      releaseRevalidation = resolve;
    });
    sdkMock.workspaceActions.listScheduledTasks
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([task])
      .mockImplementationOnce(async () => {
        await revalidation;
        return [task];
      });
    sdkMock.workspaceActions.runScheduledTask.mockResolvedValue(undefined);
    let admitted = 0;
    onRunPrompt.mockImplementation(async (...args: unknown[]) => {
      const beforeDispatch = args[4] as
        | (() => void | Promise<void>)
        | undefined;
      await beforeDispatch?.();
      admitted += 1;
    });
    const harness = {
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    };
    renderHarness(harness);
    await act(async () => Promise.resolve());
    const entry = latest!.tasks[0] as SessionDurableScheduledTask;
    let running!: Promise<void>;
    await act(async () => {
      running = latest!.runDurableTask(entry);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(onRunPrompt).toHaveBeenCalledOnce());

    renderHarness({ ...harness, durableEnabled: false });
    await act(async () => {
      releaseRevalidation();
      await running;
    });

    expect(admitted).toBe(0);
    expect(sdkMock.workspaceActions.runScheduledTask).not.toHaveBeenCalled();
    expect(latest?.manualRunActive).toBe(false);
    expect(latest?.busyIds.size).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not resume an older session manual run or clear a newer run lock', async () => {
    const taskA = durableTask({ id: 'a-run', sessionId: 'session-1' });
    const taskB = durableTask({ id: 'b-run', sessionId: 'session-2' });
    let deferFreshA = false;
    let releaseFreshA!: () => void;
    const freshA = new Promise<void>((resolve) => {
      releaseFreshA = resolve;
    });
    sdkMock.workspaceActions.listScheduledTasks.mockImplementation(
      (workspaceId?: string) => {
        if (workspaceId === 'ws-a' && deferFreshA) return freshA;
        return Promise.resolve(workspaceId === 'ws-a' ? [taskA] : [taskB]);
      },
    );
    sdkMock.workspaceActions.runScheduledTask.mockResolvedValue(undefined);
    let admitB!: () => void;
    const admissionB = new Promise<void>((resolve) => {
      admitB = resolve;
    });
    onRunPrompt.mockImplementation(
      (_prompt: string, targetSessionId: string | null) =>
        targetSessionId === 'session-2' ? admissionB : Promise.resolve(),
    );
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    const entryA = latest!.tasks[0] as SessionDurableScheduledTask;
    deferFreshA = true;
    let oldRun!: Promise<void>;
    await act(async () => {
      oldRun = latest!.runDurableTask(entryA);
      await Promise.resolve();
    });

    renderHarness({
      sessionId: 'session-2',
      workspaceId: 'ws-b',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    const entryB = latest!.tasks[0] as SessionDurableScheduledTask;
    let newRun!: Promise<void>;
    await act(async () => {
      newRun = latest!.runDurableTask(entryB);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRunPrompt).toHaveBeenCalledWith(
      taskB.prompt,
      'session-2',
      undefined,
      expect.any(Function),
      expect.any(Function),
    );

    await act(async () => {
      releaseFreshA();
      await oldRun;
    });
    expect(onRunPrompt).toHaveBeenCalledTimes(1);
    expect(sdkMock.workspaceActions.runScheduledTask).not.toHaveBeenCalled();
    expect(latest?.manualRunActive).toBe(true);

    await act(async () => {
      admitB();
      await newRun;
    });
    expect(
      sdkMock.workspaceActions.runScheduledTask,
    ).toHaveBeenCalledExactlyOnceWith('b-run', 'ws-b', 'session-2');
    expect(latest?.manualRunActive).toBe(false);
  });

  it.each(['toggle', 'delete'] as const)(
    'does not let an older read overwrite a successful %s',
    async (mutation) => {
      const task = durableTask({ id: 'd-stale', enabled: true });
      sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([task]);
      sdkMock.workspaceActions.updateScheduledTask.mockResolvedValue({
        ...task,
        enabled: false,
      });
      sdkMock.workspaceActions.deleteScheduledTask.mockResolvedValue(undefined);
      renderHarness({
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        activityKey: ACTIVE_KEY,
      });
      await act(async () => Promise.resolve());
      const entry = latest!.tasks[0] as SessionDurableScheduledTask;
      let releaseRead!: (tasks: DaemonScheduledTask[]) => void;
      const staleRead = new Promise<DaemonScheduledTask[]>((resolve) => {
        releaseRead = resolve;
      });
      sdkMock.workspaceActions.listScheduledTasks.mockImplementationOnce(
        () => staleRead,
      );
      await act(async () => {
        latest!.refresh();
        await Promise.resolve();
      });
      await act(async () => {
        if (mutation === 'toggle') await latest!.toggleDurableTask(entry);
        else await latest!.deleteDurableTask(entry);
      });

      await act(async () => {
        releaseRead([task]);
        await staleRead;
        await Promise.resolve();
      });
      if (mutation === 'delete') expect(latest?.tasks).toEqual([]);
      else expect(latest?.taskStatusById.get('d-stale')).toBe('paused');
    },
  );

  it('cancels only the selected source when cron and wakeup share an id', async () => {
    const cron = sessionCronTask({ id: 'shared-source' });
    const wakeup = sessionCronTask({
      id: 'shared-source',
      source: 'wakeup',
      cronExpr: '@wakeup',
      prompt: 'target loop',
    });
    sdkMock.sessionActions.cancelTask.mockResolvedValue({ cancelled: true });
    renderHarness({ sessionId: 'session-1' });
    await act(async () => latest!.syncSessionTasks([cron, wakeup]));
    const entry = latest!.tasks.find(
      (task) => task.scope === 'session' && task.source === 'wakeup',
    ) as SessionScopedScheduledTask;
    const staleSnapshot = latest!.syncSessionTasks;

    await act(async () => {
      expect(await latest!.cancelSessionTask(entry)).toBe(true);
    });
    expect(sdkMock.sessionActions.cancelTask).toHaveBeenCalledExactlyOnceWith(
      'shared-source',
      'cron',
      'wakeup',
    );
    expect(latest?.tasks.map((task) => task.source).sort()).toEqual(['cron']);
    await act(async () => staleSnapshot([cron, wakeup]));
    expect(latest?.tasks.map((task) => task.source).sort()).toEqual(['cron']);
  });

  it('keeps a confirmed cancellation when an older snapshot arrives', async () => {
    const sessionTask = sessionCronTask({ id: 'cron-cancelled' });
    sdkMock.sessionActions.cancelTask.mockResolvedValue({ cancelled: true });
    renderHarness({ sessionId: 'session-1' });
    await act(async () => latest!.syncSessionTasks([sessionTask]));
    const entry = latest!.tasks[0] as SessionScopedScheduledTask;
    await act(async () => {
      expect(await latest!.cancelSessionTask(entry)).toBe(true);
    });
    expect(latest?.activeSessionCount).toBe(0);

    await act(async () => latest!.syncSessionTasks([sessionTask]));
    expect(latest?.activeSessionCount).toBe(0);
    expect(latest?.tasks).toEqual([]);
  });

  it('reports a consumed one-shot when its owner changes before prompt admission', async () => {
    const oneShot = durableTask({
      id: 'one-shot-owner',
      sessionId: 'session-1',
      recurring: false,
    });
    const other = durableTask({ id: 'other-session', sessionId: 'session-2' });
    sdkMock.workspaceActions.listScheduledTasks.mockImplementation(
      (workspaceId?: string) =>
        Promise.resolve(workspaceId === 'ws-a' ? [oneShot] : [other]),
    );
    let releaseConsumption!: () => void;
    const consumed = new Promise<void>((resolve) => {
      releaseConsumption = resolve;
    });
    sdkMock.workspaceActions.runScheduledTask.mockImplementationOnce(
      () => consumed,
    );
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    let run!: Promise<void>;
    const entry = latest!.tasks[0] as SessionDurableScheduledTask;
    await act(async () => {
      run = latest!.runDurableTask(entry);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(sdkMock.workspaceActions.runScheduledTask).toHaveBeenCalledWith(
        'one-shot-owner',
        'ws-a',
        'session-1',
      );
    });

    renderHarness({
      sessionId: 'session-2',
      workspaceId: 'ws-b',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    await act(async () => {
      releaseConsumption();
      await run;
    });
    expect(onRunPrompt).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.any(Error),
      'The task was deleted but the prompt could not be delivered — it never ran. Recreate it to try again.',
    );
    expect(latest?.manualRunActive).toBe(false);
  });

  it('loads a newly bound durable task only on an explicit refresh in this session', async () => {
    const first = durableTask({ id: 'first-bound', sessionId: 'session-1' });
    const second = durableTask({ id: 'second-bound', sessionId: 'session-2' });
    sdkMock.workspaceActions.listScheduledTasks.mockImplementation(
      (workspaceId?: string) =>
        Promise.resolve(workspaceId === 'ws-1' ? [first] : [second]),
    );
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: '',
      refreshTrigger: 0,
    });
    await act(async () => Promise.resolve());
    expect(sdkMock.workspaceActions.listScheduledTasks).not.toHaveBeenCalled();

    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: '',
      refreshTrigger: 1,
    });
    await act(async () => Promise.resolve());
    expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledTimes(
      1,
    );
    expect(latest?.tasks[0]?.id).toBe('first-bound');

    renderHarness({
      sessionId: 'session-2',
      workspaceId: 'ws-2',
      activityKey: '',
      refreshTrigger: 1,
    });
    await act(async () => Promise.resolve());
    expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledTimes(
      1,
    );
    expect(latest?.tasks).toEqual([]);

    renderHarness({
      sessionId: 'session-2',
      workspaceId: 'ws-2',
      activityKey: '',
      refreshTrigger: 2,
    });
    await act(async () => Promise.resolve());
    expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledTimes(
      2,
    );
    expect(latest?.tasks[0]?.id).toBe('second-bound');
  });

  it('refreshes a per-run task after its next fire time has passed', async () => {
    vi.useFakeTimers();
    try {
      const anchor = Date.parse('2026-06-01T08:00:00Z');
      vi.setSystemTime(anchor);
      const dueAt = anchor + 10_000;
      let reads = 0;
      sdkMock.workspaceActions.listScheduledTasks.mockImplementation(() => {
        reads += 1;
        return Promise.resolve([
          durableTask({
            id: 'per-run-next',
            sessionId: 'session-1',
            sessionMode: 'per_run',
            nextRunAt: reads === 1 ? dueAt : dueAt + 60_000,
          }),
        ]);
      });
      renderHarness({
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        activityKey: ACTIVE_KEY,
      });
      await act(async () => Promise.resolve());
      expect(latest?.nextRunAt).toBe(dueAt);

      await act(() => vi.advanceTimersByTimeAsync(29_999));
      expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledTimes(
        1,
      );
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledTimes(
        2,
      );
      expect(latest?.nextRunAt).toBe(dueAt + 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['transient failure', 'unchanged snapshot'] as const)(
    'continues past-due refreshes after %s',
    async (mode) => {
      vi.useFakeTimers();
      try {
        const anchor = Date.parse('2026-06-01T08:00:00Z');
        vi.setSystemTime(anchor);
        const dueAt = anchor + 10_000;
        const task = durableTask({
          id:
            mode === 'transient failure' ? 'past-due-failure' : 'past-due-same',
          sessionId: 'session-1',
          sessionMode: 'per_run',
          nextRunAt: dueAt,
        });
        sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([task]);
        renderHarness({
          sessionId: 'session-1',
          workspaceId: 'ws-1',
          activityKey: ACTIVE_KEY,
        });
        await act(async () => Promise.resolve());
        expect(latest?.nextRunAt).toBe(dueAt);
        if (mode === 'transient failure') {
          sdkMock.workspaceActions.listScheduledTasks.mockRejectedValueOnce(
            new Error('temporary offline state'),
          );
        }

        await act(() => vi.advanceTimersByTimeAsync(30_000));
        expect(
          sdkMock.workspaceActions.listScheduledTasks,
        ).toHaveBeenCalledTimes(2);
        await act(() => vi.advanceTimersByTimeAsync(30_000));
        expect(
          sdkMock.workspaceActions.listScheduledTasks,
        ).toHaveBeenCalledTimes(3);
        expect(latest?.nextRunAt).toBe(dueAt);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not enqueue a fresh-read response after a confirmed delete', async () => {
    const task = durableTask({
      id: 'pending-run-delete',
      sessionId: 'session-1',
      recurring: true,
      enabled: true,
      workspaceId: 'ws-1',
    });
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValueOnce([task]);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
    });
    await vi.waitFor(() => expect(latest?.tasks).toHaveLength(1));
    let releaseRead!: (tasks: DaemonScheduledTask[]) => void;
    const pendingRead = new Promise<DaemonScheduledTask[]>((resolve) => {
      releaseRead = resolve;
    });
    sdkMock.workspaceActions.listScheduledTasks.mockImplementationOnce(
      () => pendingRead,
    );
    const entry = latest!.tasks[0] as SessionDurableScheduledTask;
    const running = latest!.runDurableTask(entry);
    await vi.waitFor(() =>
      expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledTimes(
        2,
      ),
    );

    await act(async () => {
      latest?.confirmDurableDeletion({
        id: task.id,
        sessionId: 'session-1',
        workspaceId: 'ws-1',
      });
      releaseRead([task]);
      await running;
    });

    expect(onRunPrompt).not.toHaveBeenCalled();
    expect(sdkMock.workspaceActions.runScheduledTask).not.toHaveBeenCalled();
    expect(latest?.tasks).toEqual([]);
    expect(latest?.manualRunActive).toBe(false);
  });

  it('rejects a foreign same-id toggle response without changing the owner projection', async () => {
    const owned = durableTask({ id: 'shared-id', sessionId: 'session-1' });
    const foreign = {
      ...owned,
      sessionId: 'session-b',
      prompt: 'PROMPT_B',
      enabled: false,
    };
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([
      foreign,
      owned,
    ]);
    sdkMock.workspaceActions.updateScheduledTask.mockResolvedValue(foreign);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    const entry = latest!.tasks[0] as SessionDurableScheduledTask;

    await act(async () => latest!.toggleDurableTask(entry));

    expect(onError).toHaveBeenCalled();
    expect(latest?.tasks).toHaveLength(1);
    expect(latest?.tasks[0]?.enabled).toBe(true);
    expect(latest?.tasks[0]?.task.prompt).toBe(owned.prompt);
    expect(latest?.taskStatusById.get('shared-id')).toBe('active');
  });

  it('keeps a confirmed owner deletion retired across later list responses', async () => {
    const owned = durableTask({ id: 'shared-id', sessionId: 'session-1' });
    const foreign = {
      ...owned,
      sessionId: 'session-b',
      prompt: 'PROMPT_B',
    };
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([
      foreign,
      owned,
    ]);
    sdkMock.workspaceActions.deleteScheduledTask.mockResolvedValue(undefined);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    const entry = latest!.tasks[0] as SessionDurableScheduledTask;
    await act(async () => latest!.deleteDurableTask(entry));
    expect(latest?.tasks).toEqual([]);

    let releaseRead!: (tasks: DaemonScheduledTask[]) => void;
    const pendingRead = new Promise<DaemonScheduledTask[]>((resolve) => {
      releaseRead = resolve;
    });
    const readCount =
      sdkMock.workspaceActions.listScheduledTasks.mock.calls.length;
    sdkMock.workspaceActions.listScheduledTasks.mockImplementationOnce(
      () => pendingRead,
    );
    await act(async () => latest!.refresh());
    await vi.waitFor(() =>
      expect(sdkMock.workspaceActions.listScheduledTasks).toHaveBeenCalledTimes(
        readCount + 1,
      ),
    );
    await act(async () => {
      releaseRead([foreign, owned]);
      await pendingRead;
      await Promise.resolve();
    });
    expect(latest?.tasks).toEqual([]);
  });

  it.each(['toggle', 'delete'] as const)(
    'does not let a read started during a %s overwrite its mutation result',
    async (mutation) => {
      const task = durableTask({ id: 'd-mutation-read', enabled: true });
      sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([task]);
      let releaseMutation!: () => void;
      const pendingMutation = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
      sdkMock.workspaceActions.updateScheduledTask.mockImplementation(
        async () => {
          await pendingMutation;
          return { ...task, enabled: false };
        },
      );
      sdkMock.workspaceActions.deleteScheduledTask.mockImplementation(
        () => pendingMutation,
      );
      renderHarness({
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        activityKey: ACTIVE_KEY,
      });
      await act(async () => Promise.resolve());
      const entry = latest!.tasks[0] as SessionDurableScheduledTask;
      let operation!: Promise<void>;
      await act(async () => {
        operation =
          mutation === 'toggle'
            ? latest!.toggleDurableTask(entry)
            : latest!.deleteDurableTask(entry);
        await Promise.resolve();
      });

      let releaseRead!: (tasks: DaemonScheduledTask[]) => void;
      const staleRead = new Promise<DaemonScheduledTask[]>((resolve) => {
        releaseRead = resolve;
      });
      sdkMock.workspaceActions.listScheduledTasks.mockImplementationOnce(
        () => staleRead,
      );
      await act(async () => {
        latest!.refresh();
        await Promise.resolve();
      });
      await act(async () => {
        releaseMutation();
        await operation;
      });

      await act(async () => {
        releaseRead([task]);
        await staleRead;
        await Promise.resolve();
      });
      if (mutation === 'delete') expect(latest?.tasks).toEqual([]);
      else expect(latest?.taskStatusById.get('d-mutation-read')).toBe('paused');
    },
  );

  it('surfaces post-admission recording failures even after the UI scope changes', async () => {
    const task = durableTask({ id: 'record-fail-after-switch' });
    let rejectRecord!: (error: Error) => void;
    const pendingRecord = new Promise<void>((_resolve, reject) => {
      rejectRecord = reject;
    });
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([task]);
    sdkMock.workspaceActions.runScheduledTask.mockReturnValueOnce(
      pendingRecord,
    );
    onRunPrompt.mockResolvedValue(undefined);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      workspaceCwd: '/work/secondary',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());
    const entry = latest!.tasks[0] as SessionDurableScheduledTask;

    let running!: Promise<void>;
    await act(async () => {
      running = latest!.runDurableTask(entry);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(sdkMock.workspaceActions.runScheduledTask).toHaveBeenCalledOnce(),
    );
    expect(onRunPrompt).toHaveBeenCalledWith(
      task.prompt,
      task.sessionId,
      '/work/secondary',
      expect.any(Function),
      expect.any(Function),
    );

    renderHarness({
      sessionId: 'session-2',
      workspaceId: 'ws-1',
      workspaceCwd: '/work/secondary',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => {
      rejectRecord(new Error('disk full'));
      await running;
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'disk full' }),
      'Failed to record the run',
    );
  });

  it('does not treat a primary undefined workspaceId deletion as matching a secondary workspace', async () => {
    const task = durableTask({ id: 'shared-id', sessionId: 'session-1' });
    sdkMock.workspaceActions.listScheduledTasks.mockResolvedValue([task]);
    renderHarness({
      sessionId: 'session-1',
      workspaceId: 'ws-secondary',
      activityKey: ACTIVE_KEY,
    });
    await act(async () => Promise.resolve());

    await act(async () => {
      latest?.confirmDurableDeletion({
        id: 'shared-id',
        sessionId: 'session-1',
        workspaceId: undefined,
      });
    });

    expect(latest?.tasks).toHaveLength(1);
    expect(
      latest?.isDurableTaskDeletionConfirmed({
        id: 'shared-id',
        sessionId: 'session-1',
        workspaceId: undefined,
      }),
    ).toBe(false);
    expect(
      latest?.isDurableTaskDeletionConfirmed({
        id: 'shared-id',
        sessionId: 'session-1',
        workspaceId: 'ws-secondary',
      }),
    ).toBe(false);
  });
});
