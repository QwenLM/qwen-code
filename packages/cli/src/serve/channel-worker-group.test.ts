/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ChannelWebhookTask } from '@qwen-code/channel-base';
import { createChannelWorkerGroup } from './channel-worker-group.js';
import type {
  ChannelWorkerSnapshot,
  ChannelWorkerSupervisor,
  CreateChannelWorkerSupervisorOptions,
} from './channel-worker-supervisor.js';
import { ChannelWorkerStopError } from './channel-worker-supervisor.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';

const PRIMARY = '/ws/primary';
const SECONDARY = '/ws/secondary';

function fakeRuntime(
  cwd: string,
  primary: boolean,
  effectiveEnv?: Record<string, string | undefined>,
): WorkspaceRuntime {
  return {
    workspaceId: `id:${cwd}`,
    workspaceCwd: cwd,
    primary,
    trusted: true,
    env: effectiveEnv
      ? {
          mode: 'runtime-overlay',
          overlayKeys: Object.keys(effectiveEnv),
          effectiveEnv,
        }
      : { mode: 'parent-process', overlayKeys: [] },
  } as unknown as WorkspaceRuntime;
}

function fakeRegistry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
  return {
    primary: runtimes.find((runtime) => runtime.primary)!,
    list: () => runtimes,
    listManaged: () => runtimes,
    add: vi.fn(),
    getByWorkspaceCwd: (cwd) =>
      runtimes.find((runtime) => runtime.workspaceCwd === cwd),
    getByWorkspaceId: (id) =>
      runtimes.find((runtime) => runtime.workspaceId === id),
    getManagedByWorkspaceCwd: (cwd) =>
      runtimes.find((runtime) => runtime.workspaceCwd === cwd),
    getManagedByWorkspaceId: (id) =>
      runtimes.find((runtime) => runtime.workspaceId === id),
    resolveWorkspaceCwd: (cwd) =>
      cwd === undefined
        ? runtimes.find((runtime) => runtime.primary)
        : runtimes.find((runtime) => runtime.workspaceCwd === cwd),
    resolveLiveSessionOwner: () => ({ kind: 'not_found' }),
    beginDrain: vi.fn(() => true),
    cancelDrain: vi.fn(),
    completeDrain: vi.fn(),
  };
}

function snapshot(
  overrides: Partial<ChannelWorkerSnapshot>,
): ChannelWorkerSnapshot {
  return {
    enabled: true,
    state: 'running',
    channels: [],
    ...overrides,
  };
}

interface RecordedSupervisor {
  opts: CreateChannelWorkerSupervisorOptions;
  supervisor: ChannelWorkerSupervisor & {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
    killAllSync: ReturnType<typeof vi.fn>;
    enqueueWebhookTask: ReturnType<typeof vi.fn>;
  };
}

function makeCreateSupervisor(
  snapshotFor: (workspace: string) => ChannelWorkerSnapshot,
) {
  const recorded: RecordedSupervisor[] = [];
  const createSupervisor = (opts: CreateChannelWorkerSupervisorOptions) => {
    const supervisor = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      restart: vi.fn(async () => snapshotFor(opts.workspace)),
      killAllSync: vi.fn(),
      snapshot: () => snapshotFor(opts.workspace),
      enqueueWebhookTask: vi.fn().mockRejectedValue(new Error('unused')),
    };
    recorded.push({ opts, supervisor });
    return supervisor;
  };
  return { createSupervisor, recorded };
}

const shared = {
  cliEntryPath: '/cli.js',
  daemonUrl: 'http://127.0.0.1:1234',
  daemonToken: 'tok',
};

const webhookTask: ChannelWebhookTask = {
  channelName: 'b',
  source: 'github-ci',
  eventType: 'check_failed',
  targetRef: 'default',
  title: 'CI failed',
  payload: { runId: 123 },
};

describe('createChannelWorkerGroup', () => {
  it('routes webhook tasks to the supervisor that owns the channel', async () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    recorded[1]!.supervisor.enqueueWebhookTask.mockResolvedValueOnce({
      accepted: true,
    });

    await expect(group.enqueueWebhookTask(webhookTask)).resolves.toEqual({
      accepted: true,
    });
    expect(recorded[0]!.supervisor.enqueueWebhookTask).not.toHaveBeenCalled();
    expect(recorded[1]!.supervisor.enqueueWebhookTask).toHaveBeenCalledWith(
      webhookTask,
    );
  });

  it('drains and removes only the target workspace worker', async () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });

    expect(group.workspaceActivity(SECONDARY)).toBe(1);
    group.beginWorkspaceDrain(SECONDARY);
    await expect(group.enqueueWebhookTask(webhookTask)).rejects.toMatchObject({
      code: 'channel_worker_unavailable',
    });
    await group.restart();
    expect(recorded[0]!.supervisor.restart).toHaveBeenCalledOnce();
    expect(recorded[1]!.supervisor.restart).not.toHaveBeenCalled();

    group.cancelWorkspaceDrain(SECONDARY);
    recorded[1]!.supervisor.enqueueWebhookTask.mockResolvedValueOnce({
      accepted: true,
    });
    await expect(group.enqueueWebhookTask(webhookTask)).resolves.toEqual({
      accepted: true,
    });

    group.beginWorkspaceDrain(SECONDARY);
    const firstRemoval = group.removeWorkspace(SECONDARY);
    const secondRemoval = group.removeWorkspace(SECONDARY);
    expect(firstRemoval).toBe(secondRemoval);
    await firstRemoval;

    expect(recorded[1]!.supervisor.stop).toHaveBeenCalledOnce();
    expect(recorded[0]!.supervisor.stop).not.toHaveBeenCalled();
    expect(group.workspaceActivity(SECONDARY)).toBe(0);
    expect(group.snapshots()).toEqual([
      expect.objectContaining({ workspaceCwd: PRIMARY }),
    ]);
    await expect(group.enqueueWebhookTask(webhookTask)).rejects.toMatchObject({
      code: 'channel_worker_unavailable',
    });

    await group.stop();
    expect(recorded[0]!.supervisor.stop).toHaveBeenCalledOnce();
    expect(recorded[1]!.supervisor.stop).toHaveBeenCalledOnce();
  });

  it('falls back to synchronous kill when target worker stop fails', async () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    recorded[1]!.supervisor.stop.mockRejectedValueOnce(
      new Error('stop failed'),
    );

    await expect(group.removeWorkspace(SECONDARY)).resolves.toBeUndefined();

    expect(recorded[1]!.supervisor.killAllSync).toHaveBeenCalledOnce();
    expect(group.snapshots()).toEqual([
      expect.objectContaining({ workspaceCwd: PRIMARY }),
    ]);
  });

  it('routes --channel all webhook tasks to the primary supervisor', async () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [{ workspaceCwd: PRIMARY, selection: { mode: 'all' } }],
      registry,
      createSupervisor,
      shared,
    });
    recorded[0]!.supervisor.enqueueWebhookTask.mockResolvedValueOnce({
      accepted: true,
    });

    await expect(group.enqueueWebhookTask(webhookTask)).resolves.toEqual({
      accepted: true,
    });
    expect(recorded[0]!.supervisor.enqueueWebhookTask).toHaveBeenCalledWith(
      webhookTask,
    );
  });

  it('rejects webhook tasks that have no owning worker', async () => {
    const registry = fakeRegistry([fakeRuntime(PRIMARY, true)]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });

    await expect(group.enqueueWebhookTask(webhookTask)).rejects.toMatchObject({
      code: 'channel_worker_unavailable',
    });
    expect(recorded[0]!.supervisor.enqueueWebhookTask).not.toHaveBeenCalled();
  });

  it('builds one supervisor per group with the runtime env overlay', () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true, { A: 'primary' }),
      fakeRuntime(SECONDARY, false, { A: 'secondary' }),
    ]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );

    createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.opts.workspace).toBe(PRIMARY);
    expect(recorded[0]!.opts.workerBaseEnv).toEqual({ A: 'primary' });
    expect(recorded[1]!.opts.workspace).toBe(SECONDARY);
    expect(recorded[1]!.opts.workerBaseEnv).toEqual({ A: 'secondary' });
  });

  it('omits workerBaseEnv for a parent-process runtime', () => {
    const registry = fakeRegistry([fakeRuntime(PRIMARY, true)]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );

    createChannelWorkerGroup({
      groups: [{ workspaceCwd: PRIMARY, selection: { mode: 'all' } }],
      registry,
      createSupervisor,
      shared,
    });

    expect(recorded[0]!.opts.workerBaseEnv).toBeUndefined();
  });

  it('throws when a group references an unregistered workspace', () => {
    const registry = fakeRegistry([fakeRuntime(PRIMARY, true)]);
    const { createSupervisor } = makeCreateSupervisor(() => snapshot({}));

    expect(() =>
      createChannelWorkerGroup({
        groups: [
          {
            workspaceCwd: SECONDARY,
            selection: { mode: 'names', names: ['b'] },
          },
        ],
        registry,
        createSupervisor,
        shared,
      }),
    ).toThrow(/unregistered workspace/);
  });

  it('throws when a planned workspace is no longer trusted', () => {
    const runtime = { ...fakeRuntime(PRIMARY, true), trusted: false };
    const registry = fakeRegistry([runtime]);
    const { createSupervisor } = makeCreateSupervisor(() => snapshot({}));

    expect(() =>
      createChannelWorkerGroup({
        groups: [{ workspaceCwd: PRIMARY, selection: { mode: 'all' } }],
        registry,
        createSupervisor,
        shared,
      }),
    ).toThrow(/not trusted/);
  });

  it('fans out start / stop / killAllSync to every supervisor', async () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const onStateChange = vi.fn();

    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
      onStateChange,
    });

    await group.start();
    await group.stop();
    group.killAllSync();

    for (const entry of recorded) {
      expect(entry.supervisor.start).toHaveBeenCalledTimes(1);
      expect(entry.supervisor.stop).toHaveBeenCalledTimes(1);
      expect(entry.supervisor.killAllSync).toHaveBeenCalledTimes(1);
    }
    expect(onStateChange).toHaveBeenCalledTimes(2);
  });

  it('stops supervisors again after the group is restarted', async () => {
    const registry = fakeRegistry([fakeRuntime(PRIMARY, true)]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [{ workspaceCwd: PRIMARY, selection: { mode: 'all' } }],
      registry,
      createSupervisor,
      shared,
    });

    await group.start();
    await group.stop();
    await group.start();
    await group.stop();

    expect(recorded[0]!.supervisor.start).toHaveBeenCalledTimes(2);
    expect(recorded[0]!.supervisor.stop).toHaveBeenCalledTimes(2);
  });

  it('creates a fresh worker and restores webhook routing after re-add', async () => {
    const runtimes = [
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false, { VERSION: 'old' }),
    ];
    const registry = fakeRegistry(runtimes);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    await group.start();
    await group.removeWorkspace(SECONDARY);
    runtimes.splice(1, 1, fakeRuntime(SECONDARY, false, { VERSION: 'new' }));

    await group.restoreWorkspace(SECONDARY);
    recorded[2]!.supervisor.enqueueWebhookTask.mockResolvedValueOnce({
      accepted: true,
    });

    expect(recorded).toHaveLength(3);
    expect(recorded[2]!.opts.workerBaseEnv).toEqual({ VERSION: 'new' });
    expect(recorded[2]!.supervisor.start).toHaveBeenCalledOnce();
    await expect(group.enqueueWebhookTask(webhookTask)).resolves.toEqual({
      accepted: true,
    });
    await group.removeWorkspace(SECONDARY);
    expect(recorded[2]!.supervisor.stop).toHaveBeenCalledOnce();
  });

  it('removes a restored worker from routing when startup fails', async () => {
    const runtimes = [
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ];
    const registry = fakeRegistry(runtimes);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const createSupervisorWithRestoreFailure = (
      opts: CreateChannelWorkerSupervisorOptions,
    ) => {
      const supervisor = createSupervisor(opts);
      if (recorded.length === 3) {
        supervisor.start.mockRejectedValueOnce(new Error('restore failed'));
      }
      return supervisor;
    };
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor: createSupervisorWithRestoreFailure,
      shared,
    });
    await group.start();
    await group.removeWorkspace(SECONDARY);

    await expect(group.restoreWorkspace(SECONDARY)).rejects.toThrow(
      'restore failed',
    );

    expect(group.workspaceActivity(SECONDARY)).toBe(0);
    await expect(group.enqueueWebhookTask(webhookTask)).rejects.toMatchObject({
      code: 'channel_worker_unavailable',
    });

    await group.restoreWorkspace(SECONDARY);
    expect(recorded).toHaveLength(4);
    expect(recorded[3]!.supervisor.start).toHaveBeenCalledOnce();
  });

  it('does not start later supervisors when the first start fails', async () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    recorded[0]!.supervisor.start.mockRejectedValueOnce(
      new Error('primary failed'),
    );

    await expect(group.start()).rejects.toThrow('primary failed');

    expect(recorded[1]!.supervisor.start).not.toHaveBeenCalled();
  });

  it('does not start later supervisors when stopped during startup', async () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    let releaseStart!: () => void;
    recorded[0]!.supervisor.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );

    const startPromise = group.start();
    await vi.waitFor(() => {
      expect(recorded[0]!.supervisor.start).toHaveBeenCalledTimes(1);
    });
    await group.stop();
    releaseStart();
    await expect(startPromise).rejects.toThrow(
      'Channel worker group stopped during startup.',
    );

    expect(recorded[1]!.supervisor.start).not.toHaveBeenCalled();
  });

  it('rolls back already-started supervisors when a later start fails', async () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    recorded[1]!.supervisor.start.mockRejectedValueOnce(
      new Error('secondary failed'),
    );

    await expect(group.start()).rejects.toThrow('secondary failed');

    expect(recorded[0]!.supervisor.stop).toHaveBeenCalledTimes(1);
  });

  it('attempts to stop every supervisor before reporting a stop failure', async () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    recorded[0]!.supervisor.stop.mockRejectedValueOnce(
      new Error('primary stop failed'),
    );

    await expect(group.stop()).rejects.toThrow('primary stop failed');

    for (const entry of recorded) {
      expect(entry.supervisor.stop).toHaveBeenCalledTimes(1);
    }
  });

  it('reports a non-primary-only group while keeping the legacy primary disabled', () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor } = makeCreateSupervisor(() => snapshot({}));
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });

    expect(group.snapshots()).toEqual([
      expect.objectContaining({
        enabled: true,
        workspaceCwd: SECONDARY,
        primary: false,
      }),
    ]);
    expect(group.primarySnapshot()).toEqual({
      enabled: false,
      state: 'disabled',
      channels: [],
    });
  });

  it('annotates snapshots with workspace metadata and exposes the primary', () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor } = makeCreateSupervisor((workspace) =>
      snapshot({
        channels: workspace === PRIMARY ? ['a'] : ['b'],
        pid: workspace === PRIMARY ? 10 : 20,
      }),
    );

    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });

    const snapshots = group.snapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      workspaceId: `id:${PRIMARY}`,
      workspaceCwd: PRIMARY,
      primary: true,
      channels: ['a'],
      pid: 10,
    });
    expect(group.primarySnapshot()).toMatchObject({ pid: 10, channels: ['a'] });
  });

  it('returns a disabled primary snapshot when no primary group exists', () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor } = makeCreateSupervisor(() => snapshot({}));

    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });

    expect(group.primarySnapshot()).toEqual({
      enabled: false,
      state: 'disabled',
      channels: [],
    });
  });

  it('forwards ready/exit/log callbacks with workspace metadata', () => {
    const registry = fakeRegistry([fakeRuntime(SECONDARY, false)]);
    const onReady = vi.fn();
    const onExit = vi.fn();
    const onLog = vi.fn();
    const recorded: CreateChannelWorkerSupervisorOptions[] = [];
    const createSupervisor = (opts: CreateChannelWorkerSupervisorOptions) => {
      recorded.push(opts);
      return {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        restart: vi.fn(async () => snapshot({})),
        killAllSync: vi.fn(),
        snapshot: () => snapshot({}),
        enqueueWebhookTask: vi.fn().mockRejectedValue(new Error('unused')),
      };
    };

    createChannelWorkerGroup({
      groups: [
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
      onReady,
      onExit,
      onLog,
    });

    const opts = recorded[0]!;
    opts.onReady?.(snapshot({ pid: 7 }));
    opts.onExit?.(snapshot({ state: 'exited' }));
    opts.onLog?.({ stream: 'stderr', line: 'boom' });

    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceCwd: SECONDARY,
        primary: false,
        pid: 7,
      }),
    );
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: SECONDARY, state: 'exited' }),
    );
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'boom',
      workspaceCwd: SECONDARY,
    });
  });

  it('restarts only the workspace whose ordered selection changed', async () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });

    await group.reconcile([
      { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['c'] } },
      { workspaceCwd: SECONDARY, selection: { mode: 'names', names: ['b'] } },
    ]);

    expect(recorded).toHaveLength(3);
    expect(recorded[0]!.supervisor.stop).toHaveBeenCalledTimes(1);
    expect(recorded[1]!.supervisor.stop).not.toHaveBeenCalled();
    expect(recorded[1]!.supervisor.start).not.toHaveBeenCalled();
    expect(recorded[2]!.opts.workspace).toBe(PRIMARY);
    expect(recorded[2]!.supervisor.start).toHaveBeenCalledTimes(1);
  });

  it('reports health for running, mixed, and empty worker groups', async () => {
    const states = new Map([
      [PRIMARY, 'running'],
      [SECONDARY, 'running'],
    ]);
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const { createSupervisor } = makeCreateSupervisor((workspace) =>
      snapshot({ state: states.get(workspace) as 'running' | 'failed' }),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        {
          workspaceCwd: SECONDARY,
          selection: { mode: 'names', names: ['b'] },
        },
      ],
      registry,
      createSupervisor,
      shared,
    });

    expect(group.isHealthy()).toBe(true);
    states.set(SECONDARY, 'failed');
    expect(group.isHealthy()).toBe(false);
    await group.reconcile([]);
    expect(group.isHealthy()).toBe(false);
  });

  it('force-reconciles an unchanged healthy selection', async () => {
    const registry = fakeRegistry([fakeRuntime(PRIMARY, true)]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const groups = [
      {
        workspaceCwd: PRIMARY,
        selection: { mode: 'names' as const, names: ['a'] },
      },
    ];
    const group = createChannelWorkerGroup({
      groups,
      registry,
      createSupervisor,
      shared,
    });
    await group.start();

    await expect(
      group.reconcile(groups, { force: true }),
    ).resolves.toMatchObject({
      changed: true,
    });
    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.supervisor.stop).toHaveBeenCalledTimes(1);
    expect(recorded[1]!.supervisor.start).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent reconciles onto the in-flight operation', async () => {
    const registry = fakeRegistry([fakeRuntime(PRIMARY, true)]);
    let releaseReplacement!: () => void;
    const test = makeCreateSupervisor(() => snapshot({}));
    const createSupervisor = (opts: CreateChannelWorkerSupervisorOptions) => {
      const supervisor = test.createSupervisor(opts);
      if (
        opts.selection.mode === 'names' &&
        opts.selection.names.includes('c')
      ) {
        supervisor.start.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              releaseReplacement = resolve;
            }),
        );
      }
      return supervisor;
    };
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    await group.start();

    const first = group.reconcile([
      { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['c'] } },
    ]);
    await vi.waitFor(() => expect(releaseReplacement).toBeTypeOf('function'));
    const second = group.reconcile([
      { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['d'] } },
    ]);
    releaseReplacement();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(test.recorded).toHaveLength(2);
    expect(test.recorded[1]!.opts.selection).toEqual({
      mode: 'names',
      names: ['c'],
    });
  });

  it('stops failed new workers and restores stopped old workers', async () => {
    const registry = fakeRegistry([fakeRuntime(PRIMARY, true)]);
    const recorded: RecordedSupervisor[] = [];
    const createSupervisor = (opts: CreateChannelWorkerSupervisorOptions) => {
      const supervisor = {
        start: vi.fn(async () => {
          if (
            opts.selection.mode === 'names' &&
            opts.selection.names.includes('c')
          ) {
            throw new Error('bad c');
          }
        }),
        stop: vi.fn(async () => {}),
        restart: vi.fn(async () => snapshot({})),
        killAllSync: vi.fn(),
        snapshot: () => snapshot({}),
        enqueueWebhookTask: vi.fn().mockRejectedValue(new Error('unused')),
      };
      recorded.push({ opts, supervisor });
      return supervisor;
    };
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    await group.start();

    await expect(
      group.reconcile([
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['c'] } },
      ]),
    ).rejects.toMatchObject({ rolledBack: true, stopFailed: false });
    expect(recorded[1]!.supervisor.stop).toHaveBeenCalledTimes(1);
    expect(recorded[0]!.supervisor.start).toHaveBeenCalledTimes(2);
    expect(group.snapshots()[0]!.workspaceCwd).toBe(PRIMARY);
  });

  it('attempts to restore every stopped worker after a rollback failure', async () => {
    const registry = fakeRegistry([
      fakeRuntime(PRIMARY, true),
      fakeRuntime(SECONDARY, false),
    ]);
    const test = makeCreateSupervisor(() => snapshot({}));
    const createSupervisor = (opts: CreateChannelWorkerSupervisorOptions) => {
      const supervisor = test.createSupervisor(opts);
      if (
        opts.selection.mode === 'names' &&
        opts.selection.names.includes('c')
      ) {
        supervisor.start.mockRejectedValueOnce(new Error('replacement failed'));
      }
      return supervisor;
    };
    const { recorded } = test;
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
        {
          workspaceCwd: SECONDARY,
          selection: { mode: 'names', names: ['b'] },
        },
      ],
      registry,
      createSupervisor,
      shared,
    });
    await group.start();
    recorded[0]!.supervisor.start.mockRejectedValueOnce(
      new Error('primary restore failed'),
    );
    await expect(
      group.reconcile([
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['c'] } },
        {
          workspaceCwd: SECONDARY,
          selection: { mode: 'names', names: ['d'] },
        },
      ]),
    ).rejects.toMatchObject({
      rolledBack: false,
      rollbackError: 'primary restore failed',
    });
    expect(recorded[0]!.supervisor.start).toHaveBeenCalledTimes(2);
    expect(recorded[1]!.supervisor.start).toHaveBeenCalledTimes(2);
  });

  it('does not start replacements after an unconfirmed old-worker stop', async () => {
    const registry = fakeRegistry([fakeRuntime(PRIMARY, true)]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    recorded[0]!.supervisor.stop.mockRejectedValueOnce(
      new ChannelWorkerStopError('still alive'),
    );

    await expect(
      group.reconcile([
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['c'] } },
      ]),
    ).rejects.toMatchObject({
      stopFailed: true,
      rolledBack: true,
    });
    expect(recorded[1]!.supervisor.start).not.toHaveBeenCalled();
  });

  it('force-kills a replacement that is still starting', async () => {
    const registry = fakeRegistry([fakeRuntime(PRIMARY, true)]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    await group.start();

    const replacement = group.reconcile([
      { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['c'] } },
    ]);
    let releaseStart!: () => void;
    recorded[1]!.supervisor.start.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );
    await vi.waitFor(() =>
      expect(recorded[1]!.supervisor.start).toHaveBeenCalledTimes(1),
    );

    group.killAllSync();
    expect(recorded[0]!.supervisor.killAllSync).toHaveBeenCalledTimes(1);
    expect(recorded[1]!.supervisor.killAllSync).toHaveBeenCalledTimes(1);
    releaseStart();
    await expect(replacement).rejects.toMatchObject({ rolledBack: false });
  });

  it('retains an unconfirmed replacement so a later stop can retry it', async () => {
    const registry = fakeRegistry([fakeRuntime(PRIMARY, true)]);
    const { createSupervisor, recorded } = makeCreateSupervisor(() =>
      snapshot({}),
    );
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
      ],
      registry,
      createSupervisor,
      shared,
    });
    const replacement = group.reconcile([
      { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['c'] } },
    ]);
    recorded[1]!.supervisor.start.mockRejectedValueOnce(
      new Error('replacement failed'),
    );
    recorded[1]!.supervisor.stop.mockRejectedValueOnce(
      new ChannelWorkerStopError('still alive'),
    );

    await expect(replacement).rejects.toMatchObject({
      stopFailed: false,
      rolledBack: false,
      rollbackError: 'still alive',
    });
    recorded[1]!.supervisor.stop.mockResolvedValueOnce(undefined);
    await group.stop();
    expect(recorded[1]!.supervisor.stop).toHaveBeenCalledTimes(2);
  });

  it('suppresses stale lifecycle callbacks after committing a replacement', async () => {
    const registry = fakeRegistry([fakeRuntime(PRIMARY, true)]);
    const onReady = vi.fn();
    const onExit = vi.fn();
    const onLog = vi.fn();
    const recorded: CreateChannelWorkerSupervisorOptions[] = [];
    const createSupervisor = (opts: CreateChannelWorkerSupervisorOptions) => {
      recorded.push(opts);
      return {
        start: vi.fn(async () => {
          opts.onReady?.(snapshot({ state: 'running' }));
          opts.onExit?.(snapshot({ state: 'exited' }));
        }),
        stop: vi.fn(async () => {}),
        restart: vi.fn(async () => snapshot({})),
        killAllSync: vi.fn(),
        snapshot: () => snapshot({}),
        enqueueWebhookTask: vi.fn().mockRejectedValue(new Error('unused')),
      };
    };
    const group = createChannelWorkerGroup({
      groups: [
        { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['a'] } },
      ],
      registry,
      createSupervisor,
      shared,
      onReady,
      onExit,
      onLog,
    });

    await group.reconcile([
      { workspaceCwd: PRIMARY, selection: { mode: 'names', names: ['c'] } },
    ]);
    expect(onLog).not.toHaveBeenCalled();
    recorded[0]!.onReady?.(snapshot({ state: 'running' }));
    recorded[0]!.onExit?.(snapshot({ state: 'exited' }));

    expect(onReady).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceCwd: PRIMARY,
        line: expect.stringContaining('stale'),
      }),
    );
  });
});
