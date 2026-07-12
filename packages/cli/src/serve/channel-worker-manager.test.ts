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
    restart: vi.fn(async () => snapshots),
    reconcile: vi.fn(async () => ({ changed: true, workers: snapshots })),
    isHealthy: vi.fn(() =>
      snapshots.every((worker) => worker.state === 'running'),
    ),
    killAllSync: vi.fn(),
    snapshots: vi.fn(() => snapshots),
    primarySnapshot: vi.fn(() => snapshots[0]!),
    enqueueWebhookTask: vi.fn(async () => ({ accepted: true as const })),
    ...overrides,
  };
}

function setup(group = fakeGroup()) {
  const reserveLease = vi.fn();
  const releaseLease = vi.fn();
  const onCommittedSelection = vi.fn();
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
  });
  return {
    manager,
    group,
    reserveLease,
    releaseLease,
    resolveGroups,
    createGroup,
    onCommittedSelection,
  };
}

describe('createChannelWorkerManager', () => {
  it('enables a disabled manager and makes an equal healthy PUT idempotent', async () => {
    const test = setup();
    const selection: ServeChannelSelection = {
      mode: 'names',
      names: ['telegram'],
    };

    const enabled = await test.manager.setSelection(selection);
    const unchanged = await test.manager.setSelection(selection);

    expect(enabled).toMatchObject({ changed: true, replaced: false });
    expect(unchanged).toMatchObject({ changed: false, replaced: false });
    expect(test.reserveLease).toHaveBeenCalledTimes(1);
    expect(test.group.start).toHaveBeenCalledTimes(1);
    expect(test.group.reconcile).not.toHaveBeenCalled();
    expect(test.manager.state()).toMatchObject({
      enabled: true,
      selection,
      transition: 'idle',
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
    vi.mocked(group.start).mockRejectedValueOnce(new Error('spawn failed'));
    vi.mocked(group.stop)
      .mockRejectedValueOnce(new Error('exit not observed'))
      .mockResolvedValueOnce(undefined);
    const test = setup(group);

    await expect(
      test.manager.setSelection({ mode: 'names', names: ['telegram'] }),
    ).rejects.toMatchObject({
      code: 'channel_worker_start_failed',
      rolledBack: false,
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
});
