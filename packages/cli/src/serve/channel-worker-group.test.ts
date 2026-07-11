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
    add: vi.fn(),
    getByWorkspaceCwd: (cwd) =>
      runtimes.find((runtime) => runtime.workspaceCwd === cwd),
    getByWorkspaceId: (id) =>
      runtimes.find((runtime) => runtime.workspaceId === id),
    resolveWorkspaceCwd: (cwd) =>
      cwd === undefined
        ? runtimes.find((runtime) => runtime.primary)
        : runtimes.find((runtime) => runtime.workspaceCwd === cwd),
    resolveLiveSessionOwner: () => ({ kind: 'not_found' }),
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
    await group.stop();
    group.killAllSync();

    for (const entry of recorded) {
      expect(entry.supervisor.start).toHaveBeenCalledTimes(1);
      expect(entry.supervisor.stop).toHaveBeenCalledTimes(1);
      expect(entry.supervisor.killAllSync).toHaveBeenCalledTimes(1);
    }
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

  it('coalesces concurrent group restarts', async () => {
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
    let release!: () => void;
    recorded[0]!.supervisor.restart.mockImplementationOnce(
      () =>
        new Promise<ChannelWorkerSnapshot>((resolve) => {
          release = () => resolve(snapshot({ channels: ['a'] }));
        }),
    );

    const first = group.restart();
    const second = group.restart();
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(secondResult);

    for (const entry of recorded) {
      expect(entry.supervisor.restart).toHaveBeenCalledTimes(1);
    }
  });

  it('waits for an in-flight restart before stopping supervisors', async () => {
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
    let release!: () => void;
    recorded[0]!.supervisor.restart.mockImplementationOnce(
      () =>
        new Promise<ChannelWorkerSnapshot>((resolve) => {
          release = () => resolve(snapshot({ channels: ['a'] }));
        }),
    );

    const restart = group.restart();
    const stop = group.stop();
    await Promise.resolve();
    expect(recorded[0]!.supervisor.stop).not.toHaveBeenCalled();

    release();
    await Promise.all([restart, stop]);
    expect(recorded[0]!.supervisor.stop).toHaveBeenCalledTimes(1);
  });

  it('stops every supervisor on partial restart failure and later recovers', async () => {
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
    recorded[1]!.supervisor.restart.mockRejectedValueOnce(
      new Error('secondary reload failed'),
    );

    await expect(group.restart()).rejects.toThrow('secondary reload failed');

    for (const entry of recorded) {
      expect(entry.supervisor.stop).toHaveBeenCalledTimes(1);
    }

    await expect(group.restart()).resolves.toHaveLength(2);
    for (const entry of recorded) {
      expect(entry.supervisor.restart).toHaveBeenCalledTimes(2);
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
});
