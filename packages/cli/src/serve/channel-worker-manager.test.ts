/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelWorkerGroup,
  ChannelWorkerGroupSnapshot,
} from './channel-worker-group.js';
import { ChannelWorkerReconcileError } from './channel-worker-group.js';
import {
  ChannelWorkerControlError,
  createChannelWorkerManager,
} from './channel-worker-manager.js';
import { ChannelWorkerStartupError } from './channel-worker-supervisor.js';
import type { ChannelWorkspaceGroup } from './channel-workspace-grouping.js';
import type { ServeChannelSelection } from './types.js';

const PRIMARY = '/ws/primary';

function workspaceGroups(
  selection: ServeChannelSelection,
): ChannelWorkspaceGroup[] {
  return [{ workspaceCwd: PRIMARY, selection }];
}

function workerSnapshot(
  overrides: Partial<ChannelWorkerGroupSnapshot> = {},
): ChannelWorkerGroupSnapshot {
  return {
    enabled: true,
    state: 'running',
    channels: ['telegram'],
    requestedChannels: ['telegram'],
    workspaceId: 'primary',
    workspaceCwd: PRIMARY,
    primary: true,
    ...overrides,
  };
}

function fakeGroup(
  overrides: Partial<ChannelWorkerGroup> = {},
): ChannelWorkerGroup {
  const snapshots = [workerSnapshot()];
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    reconcile: vi.fn(async () => ({ changed: true, workers: snapshots })),
    isHealthy: vi.fn(() =>
      snapshots.every((worker) => worker.state === 'running'),
    ),
    killAllSync: vi.fn(),
    snapshots: vi.fn(() => snapshots),
    primarySnapshot: vi.fn(() => snapshots[0]!),
    beginWorkspaceDrain: vi.fn(),
    cancelWorkspaceDrain: vi.fn(),
    workspaceActivity: vi.fn(() => 0),
    removeWorkspace: vi.fn(async () => {}),
    restoreWorkspace: vi.fn(async () => {}),
    enqueueWebhookTask: vi.fn(async () => ({ accepted: true as const })),
    ...overrides,
  };
}

function setup(group = fakeGroup()) {
  const reserveLease = vi.fn();
  const releaseLease = vi.fn();
  const onCommittedSelection = vi.fn();
  const onStateChange = vi.fn();
  const resolveGroups = vi.fn(async (selection: ServeChannelSelection) =>
    workspaceGroups(selection),
  );
  const createGroup = vi.fn(() => group);
  const manager = createChannelWorkerManager({
    resolveGroups,
    createGroup,
    reserveLease,
    releaseLease,
    onCommittedSelection,
    onStateChange,
  });
  return {
    manager,
    group,
    reserveLease,
    releaseLease,
    resolveGroups,
    createGroup,
    onCommittedSelection,
    onStateChange,
  };
}

describe('createChannelWorkerManager', () => {
  it('exposes committed channel names in selection order', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram', 'feishu'],
    };

    expect(test.manager.committedChannelNames()).toEqual([]);
    await test.manager.setSelection(selection);

    const names = test.manager.committedChannelNames();
    expect(names).toEqual(['telegram', 'feishu']);
    names.reverse();
    expect(test.manager.committedChannelNames()).toEqual([
      'telegram',
      'feishu',
    ]);
  });

  it('enables a disabled manager and makes an equal healthy PUT idempotent', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    const enabled = await test.manager.setSelection(selection);
    const unchanged = await test.manager.setSelection(selection);

    expect(enabled).toMatchObject({
      changed: true,
      replaced: false,
      created: true,
    });
    expect(unchanged).toMatchObject({
      changed: false,
      replaced: false,
      created: false,
    });
    expect(test.reserveLease).toHaveBeenCalledTimes(1);
    expect(test.group.start).toHaveBeenCalledTimes(1);
    expect(test.group.reconcile).not.toHaveBeenCalled();
    expect(test.onCommittedSelection).toHaveBeenCalledTimes(1);
    expect(test.onCommittedSelection).toHaveBeenCalledWith(
      selection,
      workspaceGroups(selection),
    );
    expect(test.onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        pendingSelection: selection,
        transition: 'starting',
      }),
    );
    expect(test.onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        selection,
        transition: 'idle',
      }),
    );
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection,
      transition: 'idle',
    });
  });

  it('refreshes workspace topology without forcing unchanged workers', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);

    await test.manager.refreshWorkspaces();

    expect(test.resolveGroups).toHaveBeenLastCalledWith(selection, 'reload');
    expect(test.group.reconcile).toHaveBeenCalledWith(
      workspaceGroups(selection),
    );
    expect(test.onCommittedSelection).toHaveBeenCalledTimes(2);
  });

  it('restores idle and classifies workspace topology reconcile failures', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);
    vi.mocked(test.group.reconcile).mockRejectedValueOnce(
      new ChannelWorkerReconcileError('secondary failed', {
        rolledBack: true,
      }),
    );

    await expect(test.manager.refreshWorkspaces()).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: true,
    });
    expect(test.manager.state()).toMatchObject({
      transition: 'idle',
      selection,
    });
  });

  it('restores idle when workspace topology resolution fails', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);
    test.resolveGroups.mockRejectedValueOnce(new Error('settings invalid'));

    await expect(test.manager.refreshWorkspaces()).rejects.toThrow(
      'settings invalid',
    );
    expect(test.manager.state()).toMatchObject({
      transition: 'idle',
      selection,
    });
  });

  it('does not reconcile after forced shutdown interrupts workspace refresh', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);
    let releaseGroups!: () => void;
    test.resolveGroups.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGroups = () => resolve(workspaceGroups(selection));
        }),
    );

    const refreshing = test.manager.refreshWorkspaces();
    await vi.waitFor(() => expect(test.resolveGroups).toHaveBeenCalledTimes(2));
    test.manager.killAllSync();
    releaseGroups();

    await expect(refreshing).rejects.toMatchObject({ code: 'daemon_draining' });
    expect(test.group.reconcile).not.toHaveBeenCalled();
  });

  it('starts the initial selection through the boot-time path', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    await test.manager.startInitial(selection);

    expect(test.resolveGroups).toHaveBeenCalledWith(selection, 'initial');
    expect(test.reserveLease).toHaveBeenCalledWith(selection);
    expect(test.group.start).toHaveBeenCalledTimes(1);
    expect(test.manager.state()).toMatchObject({ enabled: true, selection });
  });

  it('applies an existing workspace drain before a newly created group starts', async () => {
    const test = setup();

    test.manager.beginWorkspaceDrain(PRIMARY);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram'],
    });

    expect(test.group.beginWorkspaceDrain).toHaveBeenCalledWith(PRIMARY);
    expect(
      vi.mocked(test.group.beginWorkspaceDrain).mock.invocationCallOrder[0]!,
    ).toBeLessThan(vi.mocked(test.group.start).mock.invocationCallOrder[0]!);
  });

  it('keeps the boot-time lease reserved when group construction fails', async () => {
    const test = setup();
    test.createGroup.mockImplementationOnce(() => {
      throw new Error('group construction failed');
    });

    await expect(
      test.manager.startInitial({ mode: 'names', names: ['telegram'] }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: false,
    });

    expect(test.releaseLease).not.toHaveBeenCalled();
    expect(test.manager.state()).toMatchObject({ enabled: true });
  });

  it('marks only the first concurrent enable as created', async () => {
    let releaseStart!: () => void;
    const group = fakeGroup({
      start: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseStart = resolve;
          }),
      ),
    });
    const test = setup(group);
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    const first = test.manager.setSelection(selection);
    const second = test.manager.setSelection(selection);
    await vi.waitFor(() => expect(group.start).toHaveBeenCalledTimes(1));
    releaseStart();

    await expect(first).resolves.toMatchObject({ created: true });
    await expect(second).resolves.toMatchObject({ created: false });
  });

  it('reconciles an unhealthy worker when reapplying the same selection', async () => {
    const group = fakeGroup({ isHealthy: vi.fn(() => false) });
    const test = setup(group);
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    await test.manager.setSelection(selection);
    const recovered = await test.manager.setSelection(selection);

    expect(group.reconcile).toHaveBeenCalledWith(workspaceGroups(selection), {
      onRollingBack: expect.any(Function),
    });
    expect(recovered).toMatchObject({
      changed: true,
      replaced: false,
      created: false,
    });
  });

  it('reports partial readiness without treating it as a failed enable', async () => {
    const group = fakeGroup({
      snapshots: () => [
        workerSnapshot({
          channels: ['telegram'],
          requestedChannels: ['telegram', 'discord'],
        }),
      ],
    });
    const test = setup(group);

    await expect(
      test.manager.setSelection({
        mode: 'names',
        names: ['telegram', 'discord'],
      }),
    ).resolves.toMatchObject({ partial: true, changed: true });
  });

  it('reconciles replacements without reacquiring the existing lease', async () => {
    const test = setup();
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    vi.mocked(test.group.reconcile).mockResolvedValueOnce({
      changed: false,
      workers: test.group.snapshots(),
    });

    const result = await test.manager.setSelection({
      mode: 'names',
      names: ['discord'],
    });

    expect(result).toMatchObject({ changed: true, replaced: true });
    expect(test.reserveLease).toHaveBeenCalledTimes(1);
    expect(test.group.reconcile).toHaveBeenCalledWith(
      workspaceGroups({ mode: 'names', names: ['discord'] }),
      { onRollingBack: expect.any(Function) },
    );
  });

  it('restores an idle transition when reload group resolution fails', async () => {
    const test = setup();
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    test.resolveGroups.mockRejectedValueOnce(new Error('settings invalid'));

    await expect(test.manager.reload()).rejects.toThrow('settings invalid');
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      transition: 'idle',
    });
    expect(test.manager.state()).not.toHaveProperty('pendingSelection');
  });

  it('force-reconciles reload and returns the primary snapshot', async () => {
    const primary = workerSnapshot();
    const secondary = workerSnapshot({
      workspaceId: 'secondary',
      workspaceCwd: '/ws/secondary',
      primary: false,
    });
    const group = fakeGroup({
      snapshots: vi.fn(() => [secondary, primary]),
    });
    const test = setup(group);
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);

    await expect(test.manager.reload()).resolves.toEqual(primary);

    expect(test.resolveGroups).toHaveBeenLastCalledWith(selection, 'reload');
    expect(group.reconcile).toHaveBeenLastCalledWith(
      workspaceGroups(selection),
      { force: true, onRollingBack: expect.any(Function) },
    );
  });

  it('reloads only the requested workspace worker', async () => {
    const primary = workerSnapshot();
    const secondary = workerSnapshot({
      workspaceId: 'secondary',
      workspaceCwd: '/ws/secondary',
      primary: false,
    });
    const initialGroups: ChannelWorkspaceGroup[] = [
      {
        workspaceCwd: PRIMARY,
        selection: { mode: 'names', names: ['telegram'] },
      },
      {
        workspaceCwd: '/ws/secondary',
        selection: { mode: 'names', names: ['feishu'] },
      },
    ];
    const targetGroups: ChannelWorkspaceGroup[] = [
      initialGroups[0]!,
      {
        workspaceCwd: '/ws/secondary',
        selection: { mode: 'names', names: ['changed-elsewhere'] },
      },
    ];
    const group = fakeGroup({ snapshots: vi.fn(() => [primary, secondary]) });
    const test = setup(group);
    test.resolveGroups
      .mockResolvedValueOnce(initialGroups)
      .mockResolvedValueOnce(targetGroups);
    await test.manager.setSelection({
      mode: 'names',
      names: ['telegram', 'feishu'],
    });

    await expect(test.manager.reloadWorkspace(PRIMARY)).resolves.toEqual(
      primary,
    );

    expect(group.reconcile).toHaveBeenLastCalledWith(targetGroups, {
      forceWorkspaceCwd: PRIMARY,
      onRollingBack: expect.any(Function),
    });
    expect(test.onCommittedSelection).toHaveBeenLastCalledWith(
      { mode: 'names', names: ['telegram', 'feishu'] },
      initialGroups,
    );
  });

  it('rejects a required owner mismatch before reconciling selection', async () => {
    const test = setup();
    test.resolveGroups.mockResolvedValueOnce([
      {
        workspaceCwd: '/ws/secondary',
        selection: { mode: 'names', names: ['bot'] },
      },
    ]);

    await expect(
      test.manager.setSelection(
        { mode: 'names', names: ['bot'] },
        { name: 'bot', workspaceCwd: PRIMARY },
      ),
    ).rejects.toMatchObject({ code: 'channel_runtime_owner_mismatch' });

    expect(test.createGroup).not.toHaveBeenCalled();
    expect(test.group.reconcile).not.toHaveBeenCalled();
    expect(test.reserveLease).not.toHaveBeenCalled();
    expect(test.onStateChange).not.toHaveBeenCalled();
  });

  it('preserves workspace-attributed startup failures from reload', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);
    vi.mocked(test.group.reconcile).mockRejectedValueOnce(
      new ChannelWorkerReconcileError('reload failed', {
        rolledBack: true,
        startupFailures: [
          {
            workspaceCwd: '/ws/secondary',
            channel: 'telegram',
            phase: 'connect',
            code: 'ECONNREFUSED',
            message: 'connection refused',
          },
        ],
      }),
    );

    await expect(test.manager.reload()).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: true,
      startupFailures: [
        {
          workspaceCwd: '/ws/secondary',
          channel: 'telegram',
          phase: 'connect',
          code: 'ECONNREFUSED',
          message: 'connection refused',
        },
      ],
    });
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection,
      transition: 'idle',
    });
  });

  it('does not reconcile after forced shutdown interrupts reload resolution', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(selection);
    let releaseGroups!: () => void;
    test.resolveGroups.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGroups = () => resolve(workspaceGroups(selection));
        }),
    );

    const reloading = test.manager.reload();
    await vi.waitFor(() =>
      expect(test.resolveGroups).toHaveBeenLastCalledWith(selection, 'reload'),
    );
    test.manager.killAllSync();
    releaseGroups();

    await expect(reloading).rejects.toMatchObject({ code: 'daemon_draining' });
    expect(test.group.reconcile).not.toHaveBeenCalled();
  });

  it('keeps the old committed selection when reconcile rolls back', async () => {
    const group = fakeGroup();
    const test = setup(group);
    const oldSelection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };
    await test.manager.setSelection(oldSelection);
    vi.mocked(group.reconcile).mockRejectedValueOnce(
      new ChannelWorkerReconcileError('discord failed', {
        rolledBack: true,
      }),
    );

    await expect(
      test.manager.setSelection({ mode: 'names', names: ['discord'] }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: true,
    });
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection: oldSelection,
      transition: 'idle',
    });
    expect(test.releaseLease).not.toHaveBeenCalled();
  });

  it('publishes rolling_back while a failed replacement restores old workers', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    let releaseRollback!: () => void;
    vi.mocked(group.reconcile).mockImplementationOnce(
      async (_groups, options) => {
        options?.onRollingBack?.();
        await new Promise<void>((resolve) => {
          releaseRollback = resolve;
        });
        throw new ChannelWorkerReconcileError('replacement failed', {
          rolledBack: true,
        });
      },
    );

    const replacing = test.manager.setSelection({
      mode: 'names',
      names: ['discord'],
    });
    await vi.waitFor(() => {
      expect(test.manager.state()).toMatchObject({
        transition: 'rolling_back',
        pendingSelection: { mode: 'names', names: ['discord'] },
      });
    });
    releaseRollback();
    await expect(replacing).rejects.toMatchObject({ rolledBack: true });
    expect(test.manager.state().transition).toBe('idle');
  });

  it('retains a failed first-start group and lease until DELETE confirms stop', async () => {
    const group = fakeGroup();
    vi.mocked(group.start).mockRejectedValueOnce(
      new ChannelWorkerStartupError('spawn failed', {
        workspaceCwd: PRIMARY,
        startupFailures: [
          {
            channel: 'telegram',
            phase: 'connect',
            message: 'provider failed',
          },
        ],
      }),
    );
    vi.mocked(group.stop)
      .mockRejectedValueOnce(new Error('exit not observed'))
      .mockResolvedValueOnce(undefined);
    const test = setup(group);

    await expect(
      test.manager.setSelection({ mode: 'names', names: ['telegram'] }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: false,
      rollbackError: 'exit not observed',
      startupFailures: [
        expect.objectContaining({
          workspaceCwd: PRIMARY,
          message: 'provider failed',
        }),
      ],
    });
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection: null,
    });
    expect(test.releaseLease).not.toHaveBeenCalled();

    await expect(test.manager.stopSelection()).resolves.toMatchObject({
      changed: true,
      state: { enabled: false },
    });
    expect(group.stop).toHaveBeenCalledTimes(2);
    expect(test.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('returns attempted startup failures while current state reflects successful rollback', async () => {
    const group = fakeGroup();
    const startupError = new ChannelWorkerStartupError('worker failed', {
      workspaceCwd: PRIMARY,
      startupFailures: [
        {
          channel: 'telegram',
          phase: 'connect',
          code: 'ECONNREFUSED',
          message: 'connection refused',
        },
      ],
      startupFailuresTruncated: true,
    });
    vi.mocked(group.start).mockRejectedValueOnce(startupError);
    const test = setup(group);

    const error = await test.manager
      .setSelection({ mode: 'names', names: ['telegram'] })
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: true,
      startupFailuresTruncated: true,
      startupFailures: [
        {
          workspaceCwd: PRIMARY,
          channel: 'telegram',
          phase: 'connect',
          code: 'ECONNREFUSED',
          message: 'connection refused',
        },
      ],
    });
    expect(test.manager.state()).toEqual({
      enabled: false,
      selection: null,
      transition: 'idle',
      workers: [],
    });
    (error as ChannelWorkerControlError).startupFailures![0]!.message =
      'mutated';
    expect(startupError.startupFailures![0]!.message).toBe(
      'connection refused',
    );
  });

  it('does not replace attempted failures with a reconcile rollback error', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    vi.mocked(group.reconcile).mockRejectedValueOnce(
      new ChannelWorkerReconcileError('replacement failed', {
        rolledBack: false,
        rollbackError: 'restore failed',
        startupFailures: [
          {
            workspaceCwd: PRIMARY,
            channel: 'discord',
            phase: 'connect',
            message: 'invalid token',
          },
        ],
      }),
    );

    await expect(
      test.manager.setSelection({ mode: 'names', names: ['discord'] }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: false,
      rollbackError: 'restore failed',
      startupFailures: [
        expect.objectContaining({
          workspaceCwd: PRIMARY,
          channel: 'discord',
          message: 'invalid token',
        }),
      ],
    });
  });

  it('keeps a lease-only failure enabled so DELETE can retry its release', async () => {
    const test = setup();
    test.createGroup.mockImplementationOnce(() => {
      throw new Error('group construction failed');
    });
    test.releaseLease
      .mockImplementationOnce(() => {
        throw new Error('lease release failed');
      })
      .mockImplementationOnce(() => {});

    await expect(
      test.manager.setSelection({ mode: 'names', names: ['telegram'] }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: false,
      rollbackError: 'lease release failed',
    });
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection: null,
      transition: 'idle',
      workers: [],
    });

    await expect(test.manager.stopSelection()).resolves.toMatchObject({
      changed: true,
      state: { enabled: false },
    });
    expect(test.releaseLease).toHaveBeenCalledTimes(2);
  });

  it('does not release the lease when stop cannot confirm child exit', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    vi.mocked(group.stop).mockRejectedValueOnce(new Error('still alive'));

    await expect(test.manager.stopSelection()).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
    });
    expect(test.manager.state()).toMatchObject({ enabled: true });
    expect(test.releaseLease).not.toHaveBeenCalled();
  });

  it('clears a confirmed-stopped group when lease release fails and retries', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    test.releaseLease.mockImplementationOnce(() => {
      throw new Error('lease owner changed');
    });

    await expect(test.manager.stopSelection()).rejects.toMatchObject({
      code: 'channel_worker_stop_failed',
    });
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection: { mode: 'names', names: ['telegram'] },
      workers: [],
    });

    await expect(test.manager.stopSelection()).resolves.toMatchObject({
      changed: true,
      state: { enabled: false },
    });
    expect(group.stop).toHaveBeenCalledTimes(1);
    expect(test.releaseLease).toHaveBeenCalledTimes(2);
  });

  it('rejects webhook work after shutdown latches', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });

    await test.manager.shutdown();

    await expect(
      test.manager.enqueueWebhookTask({
        channelName: 'telegram',
        source: 'alerts',
        eventType: 'failed',
        targetRef: 'default',
        title: 'Build failed',
        payload: {},
      }),
    ).rejects.toMatchObject({ code: 'channel_worker_unavailable' });
    expect(group.enqueueWebhookTask).not.toHaveBeenCalled();
  });

  it('serializes mutations and rejects queued work once shutdown latches', async () => {
    let releaseStart!: () => void;
    const group = fakeGroup({
      start: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseStart = resolve;
          }),
      ),
    });
    const test = setup(group);
    const enabling = test.manager.setSelection({
      mode: 'names',
      names: ['telegram'],
    });
    await vi.waitFor(() => expect(group.start).toHaveBeenCalled());
    const shutdown = test.manager.shutdown();
    const queuedSet = test.manager.setSelection({
      mode: 'names',
      names: ['discord'],
    });

    releaseStart();
    await enabling;
    await shutdown;
    await expect(queuedSet).rejects.toBeInstanceOf(ChannelWorkerControlError);
    await expect(queuedSet).rejects.toMatchObject({ code: 'daemon_draining' });
    expect(test.releaseLease).toHaveBeenCalledTimes(1);
  });

  it('finishes mutations queued before shutdown in FIFO order', async () => {
    const group = fakeGroup();
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });
    let releaseFirst!: () => void;
    vi.mocked(group.reconcile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({ changed: true, workers: group.snapshots() });
        }),
    );

    const first = test.manager.setSelection({
      mode: 'names',
      names: ['discord'],
    });
    const second = test.manager.setSelection({
      mode: 'names',
      names: ['feishu'],
    });
    const shutdown = test.manager.shutdown();
    await vi.waitFor(() => expect(group.reconcile).toHaveBeenCalledTimes(1));
    releaseFirst();

    await expect(first).resolves.toMatchObject({ changed: true });
    await expect(second).resolves.toMatchObject({ changed: true });
    await shutdown;
    expect(group.reconcile).toHaveBeenCalledTimes(2);
    expect(group.stop).toHaveBeenCalledTimes(1);
  });

  it('publishes stopping while daemon shutdown waits for workers', async () => {
    let releaseStop!: () => void;
    const group = fakeGroup({
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseStop = resolve;
          }),
      ),
    });
    const test = setup(group);
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });

    const shutdown = test.manager.shutdown();
    await vi.waitFor(() => {
      expect(test.manager.state().transition).toBe('stopping');
    });
    releaseStop();
    await shutdown;

    expect(test.manager.state()).toMatchObject({
      enabled: false,
      transition: 'idle',
    });
  });

  it('keeps the lease and worker references during synchronous forced shutdown', async () => {
    const test = setup();
    await test.manager.setSelection({ mode: 'names', names: ['telegram'] });

    test.manager.killAllSync();

    expect(test.group.killAllSync).toHaveBeenCalledTimes(1);
    expect(test.releaseLease).not.toHaveBeenCalled();
    expect(test.manager.state()).toMatchObject({ enabled: true });
  });

  it('does not create a worker after forced shutdown interrupts group resolution', async () => {
    const test = setup();
    let releaseGroups!: () => void;
    test.resolveGroups.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseGroups = () =>
            resolve(workspaceGroups({ mode: 'names', names: ['telegram'] }));
        }),
    );

    const enabling = test.manager.setSelection({
      mode: 'names',
      names: ['telegram'],
    });
    await vi.waitFor(() => expect(test.resolveGroups).toHaveBeenCalledTimes(1));
    test.manager.killAllSync();
    releaseGroups();

    await expect(enabling).rejects.toMatchObject({ code: 'daemon_draining' });
    expect(test.reserveLease).not.toHaveBeenCalled();
    expect(test.createGroup).not.toHaveBeenCalled();
    expect(test.group.start).not.toHaveBeenCalled();
  });
});
