/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
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
    killAllSync: ReturnType<typeof vi.fn>;
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
      killAllSync: vi.fn(),
      snapshot: () => snapshotFor(opts.workspace),
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

describe('createChannelWorkerGroup', () => {
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
        killAllSync: vi.fn(),
        snapshot: () => snapshot({}),
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
