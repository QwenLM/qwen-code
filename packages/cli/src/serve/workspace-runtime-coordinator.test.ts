/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ServeWorkspaceSkillsStatus } from '@qwen-code/acp-bridge/status';
import type {
  AcpSessionBridge,
  BridgeWorkspaceRuntimeLifecycleSnapshot,
} from './acp-session-bridge.js';
import type { WorkspaceRuntime } from './workspace-registry.js';
import {
  getWorkspaceRuntimeCoordinator,
  getWorkspaceRuntimeCoordinatorIfSupported,
  WorkspaceRuntimeCoordinator,
  WorkspaceRuntimeInitializationError,
  WorkspaceRuntimeStillStartingError,
} from './workspace-runtime-coordinator.js';

function makeRuntime() {
  let snapshot: BridgeWorkspaceRuntimeLifecycleSnapshot = {
    state: 'cold',
    runtimeLive: false,
    runtimeEpoch: 0,
    activeWork: false,
  };
  const preheat = vi.fn(async () => {
    if (snapshot.runtimeLive) return;
    snapshot = {
      state: 'idle',
      runtimeLive: true,
      runtimeEpoch: snapshot.runtimeEpoch + 1,
      activeWork: false,
    };
  });
  const invokeWorkspaceCommand = vi.fn(async () => ({
    sessionsRefreshed: 0,
    sessionsFailed: 0,
    configsRefreshed: 1,
    configsFailed: 0,
  }));
  const getWorkspaceSkillsRuntimeStatus = vi.fn(
    async (): Promise<ServeWorkspaceSkillsStatus> => ({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      runtimeEpoch: snapshot.runtimeEpoch,
      skills: [],
    }),
  );
  const invalidateWorkspaceSkillsStatus = vi.fn();
  const bridge = {
    sessionCount: 0,
    preheat,
    invokeWorkspaceCommand,
    getWorkspaceRuntimeLifecycleSnapshot: () => snapshot,
  } as unknown as AcpSessionBridge;
  const runtime = {
    workspaceCwd: '/workspace',
    bridge,
    workspaceService: {
      getWorkspaceSkillsRuntimeStatus,
      invalidateWorkspaceSkillsStatus,
    },
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    bridge,
    preheat,
    invokeWorkspaceCommand,
    getWorkspaceSkillsRuntimeStatus,
    invalidateWorkspaceSkillsStatus,
    setSnapshot(
      update: Partial<BridgeWorkspaceRuntimeLifecycleSnapshot>,
    ): void {
      snapshot = { ...snapshot, ...update };
    },
  };
}

describe('WorkspaceRuntimeCoordinator', () => {
  it('starts one workspace runtime without creating a session', async () => {
    const harness = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(
      harness.runtime,
      harness.bridge as AcpSessionBridge & {
        getWorkspaceRuntimeLifecycleSnapshot(): BridgeWorkspaceRuntimeLifecycleSnapshot;
      },
    );

    const result = await coordinator.ensure();

    expect(result).toMatchObject({
      state: 'idle',
      runtimeLive: true,
      runtimeEpoch: 1,
      capabilities: {
        skills: { state: 'ready', revision: 0, runtimeEpoch: 1 },
      },
    });
    expect(harness.preheat).toHaveBeenCalledWith({
      keepAliveMs: 600_000,
    });
    expect(harness.bridge.sessionCount).toBe(0);
    expect(harness.invalidateWorkspaceSkillsStatus).toHaveBeenCalledOnce();
  });

  it('reconciles a live Skills runtime in revision order', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    expect(coordinator.reconcileSkillsConfiguration()).toBe('reconciling');

    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.skills).toEqual({
        state: 'ready',
        revision: 1,
        runtimeEpoch: 3,
      }),
    );
    expect(harness.invokeWorkspaceCommand).toHaveBeenCalledWith(
      'qwen/control/workspace/skills/refresh',
      { cwd: '/workspace', reason: 'all' },
    );
  });

  it('keeps the Skills capability ready when only a session refresh fails', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    harness.invokeWorkspaceCommand.mockResolvedValueOnce({
      sessionsRefreshed: 1,
      sessionsFailed: 1,
      configsRefreshed: 1,
      configsFailed: 0,
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    coordinator.reconcileSkillsConfiguration();

    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.skills).toEqual({
        state: 'ready',
        revision: 1,
        runtimeEpoch: 3,
      }),
    );
  });

  it('coalesces a superseded Skills reconciliation before refreshing', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    coordinator.reconcileSkillsConfiguration();
    coordinator.reconcileSkillsConfiguration();

    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.skills).toEqual({
        state: 'ready',
        revision: 2,
        runtimeEpoch: 3,
      }),
    );
    expect(harness.invokeWorkspaceCommand).toHaveBeenCalledOnce();
  });

  it('shares an in-flight reconciliation with ensure', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    coordinator.reconcileSkillsConfiguration();

    await expect(coordinator.ensure()).resolves.toMatchObject({
      capabilities: { skills: { state: 'ready', revision: 1 } },
    });
    expect(harness.getWorkspaceSkillsRuntimeStatus).toHaveBeenCalledOnce();
  });

  it('prepares a deferred Skills revision when the runtime is next ensured', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    expect(coordinator.reconcileSkillsConfiguration()).toBe('deferred');
    await expect(coordinator.ensure()).resolves.toMatchObject({
      capabilities: {
        skills: { state: 'ready', revision: 1, runtimeEpoch: 1 },
      },
    });
    expect(harness.invokeWorkspaceCommand).not.toHaveBeenCalled();
  });

  it('surfaces a live Skills preparation error', async () => {
    const harness = makeRuntime();
    harness.getWorkspaceSkillsRuntimeStatus.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: false,
      runtimeEpoch: 1,
      skills: [],
      errors: [{ kind: 'skills', status: 'error', error: 'invalid manifest' }],
    });

    await expect(
      getWorkspaceRuntimeCoordinator(harness.runtime).ensure(),
    ).resolves.toMatchObject({
      capabilities: {
        skills: {
          state: 'error',
          error: { message: 'invalid manifest' },
        },
      },
    });
  });

  it('wraps a hard preheat failure during Skills preparation', async () => {
    const harness = makeRuntime();
    harness.preheat
      .mockImplementationOnce(async () => {
        harness.setSnapshot({
          state: 'idle',
          runtimeLive: true,
          runtimeEpoch: 1,
        });
        queueMicrotask(() =>
          harness.setSnapshot({ state: 'cold', runtimeLive: false }),
        );
      })
      .mockRejectedValueOnce(new Error('spawn failed'));

    await expect(
      getWorkspaceRuntimeCoordinator(harness.runtime).ensure(),
    ).rejects.toBeInstanceOf(WorkspaceRuntimeInitializationError);
  });

  it('retries a failed Skills refresh before certifying its revision', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 1 });
    harness.invokeWorkspaceCommand.mockResolvedValueOnce({
      sessionsRefreshed: 0,
      sessionsFailed: 0,
      configsRefreshed: 0,
      configsFailed: 1,
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    coordinator.reconcileSkillsConfiguration();
    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.skills?.state).toBe('error'),
    );

    await expect(coordinator.ensure()).resolves.toMatchObject({
      capabilities: { skills: { state: 'ready', revision: 1 } },
    });
    expect(harness.invokeWorkspaceCommand).toHaveBeenCalledTimes(2);
  });

  it('does not certify a revision that changed while preparation was queued', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 1 });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    harness.invokeWorkspaceCommand
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () =>
              resolve({
                sessionsRefreshed: 0,
                sessionsFailed: 0,
                configsRefreshed: 1,
                configsFailed: 0,
              });
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = () =>
              resolve({
                sessionsRefreshed: 0,
                sessionsFailed: 0,
                configsRefreshed: 1,
                configsFailed: 0,
              });
          }),
      );
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    coordinator.reconcileSkillsConfiguration();
    await vi.waitFor(() =>
      expect(harness.invokeWorkspaceCommand).toHaveBeenCalledOnce(),
    );
    const ensure = coordinator.ensure();
    await new Promise((resolve) => setTimeout(resolve, 0));
    coordinator.reconcileSkillsConfiguration();
    releaseFirst();

    await expect(ensure).resolves.toMatchObject({
      capabilities: { skills: { state: 'starting', revision: 2 } },
    });
    releaseSecond();
    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.skills?.state).toBe('ready'),
    );
  });

  it('renews the warm window on every ensure call', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({
      state: 'idle',
      runtimeLive: true,
      runtimeEpoch: 1,
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    await coordinator.ensure();
    await coordinator.ensure();

    expect(harness.preheat).toHaveBeenCalledTimes(2);
    expect(harness.preheat).toHaveBeenNthCalledWith(1, {
      keepAliveMs: 600_000,
    });
    expect(harness.preheat).toHaveBeenNthCalledWith(2, {
      keepAliveMs: 600_000,
    });
    expect(harness.getWorkspaceSkillsRuntimeStatus).toHaveBeenCalledOnce();
  });

  it('reports the bridge lifecycle snapshot without synthesizing state', () => {
    const harness = makeRuntime();
    harness.setSnapshot({
      state: 'stopping',
      runtimeLive: false,
      runtimeEpoch: 4,
      activeWork: true,
    });

    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    expect(coordinator.status()).toMatchObject({
      state: 'stopping',
      runtimeLive: false,
      runtimeEpoch: 4,
    });
    expect(coordinator.hasActiveWork()).toBe(true);
  });

  it('does not project queued Skills work into runtime lifecycle', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 1 });
    let release!: () => void;
    harness.invokeWorkspaceCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              sessionsRefreshed: 0,
              sessionsFailed: 0,
              configsRefreshed: 1,
              configsFailed: 0,
            });
        }),
    );
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    coordinator.reconcileSkillsConfiguration();
    await vi.waitFor(() =>
      expect(harness.invokeWorkspaceCommand).toHaveBeenCalledOnce(),
    );
    expect(coordinator.status().state).toBe('idle');
    expect(coordinator.hasActiveWork()).toBe(true);

    release();
    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.skills?.state).toBe('ready'),
    );
  });

  it('releases queued Skills work when runtime restart preheat hangs', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeRuntime();
      harness.setSnapshot({
        state: 'idle',
        runtimeLive: true,
        runtimeEpoch: 1,
      });
      harness.invokeWorkspaceCommand.mockImplementationOnce(async () => {
        harness.setSnapshot({ state: 'cold', runtimeLive: false });
        return {
          sessionsRefreshed: 0,
          sessionsFailed: 0,
          configsRefreshed: 1,
          configsFailed: 0,
        };
      });
      harness.preheat.mockImplementationOnce(() => new Promise(() => {}));
      const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

      coordinator.reconcileSkillsConfiguration();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(coordinator.hasActiveWork()).toBe(false);
      expect(coordinator.status().capabilities?.skills?.state).toBe('stale');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects new work while draining and resumes after rollback', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    coordinator.beginDrain();
    await expect(coordinator.ensure()).rejects.toMatchObject({
      code: 'workspace_draining',
      workspaceCwd: '/workspace',
    });

    coordinator.cancelDrain();
    await expect(coordinator.ensure()).resolves.toMatchObject({
      runtimeLive: true,
    });
  });

  it('replays a deferred reconciliation after drain rollback', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 1 });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    coordinator.beginDrain();
    expect(coordinator.reconcileSkillsConfiguration()).toBe('deferred');
    coordinator.cancelDrain();

    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.skills?.state).toBe('ready'),
    );
    expect(harness.invokeWorkspaceCommand).toHaveBeenCalledOnce();
  });

  it('returns a live runtime when Skills preparation outlasts ensure', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeRuntime();
      let release!: () => void;
      harness.getWorkspaceSkillsRuntimeStatus.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                v: 1,
                workspaceCwd: '/workspace',
                initialized: true,
                runtimeEpoch: 1,
                skills: [],
              });
          }),
      );
      const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

      const ensure = coordinator.ensure(10);
      await vi.advanceTimersByTimeAsync(10);

      await expect(ensure).resolves.toMatchObject({
        runtimeLive: true,
        capabilities: { skills: { state: 'starting' } },
      });
      release();
      await vi.runAllTimersAsync();
      await expect(coordinator.ensure()).resolves.toMatchObject({
        capabilities: { skills: { state: 'ready' } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects ensure when the runtime stops during Skills preparation', async () => {
    const harness = makeRuntime();
    let release!: () => void;
    harness.getWorkspaceSkillsRuntimeStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              v: 1,
              workspaceCwd: '/workspace',
              initialized: true,
              runtimeEpoch: 1,
              skills: [],
            });
        }),
    );
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    const ensure = coordinator.ensure();
    await vi.waitFor(() =>
      expect(harness.getWorkspaceSkillsRuntimeStatus).toHaveBeenCalledOnce(),
    );
    harness.setSnapshot({ state: 'cold', runtimeLive: false });
    release();

    await expect(ensure).rejects.toBeInstanceOf(
      WorkspaceRuntimeInitializationError,
    );
  });

  it('times out one observer without cancelling the shared physical start', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeRuntime();
      let release!: () => void;
      const physicalStart = new Promise<void>((resolve) => {
        release = () => {
          harness.setSnapshot({
            state: 'idle',
            runtimeLive: true,
            runtimeEpoch: 1,
          });
          resolve();
        };
      });
      harness.preheat.mockImplementation(() => physicalStart);
      const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

      const first = coordinator.ensure(10);
      void first.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      await expect(first).rejects.toBeInstanceOf(
        WorkspaceRuntimeStillStartingError,
      );

      const second = coordinator.ensure(10);
      expect(harness.preheat).toHaveBeenCalledTimes(2);
      release();
      await expect(second).resolves.toMatchObject({
        runtimeLive: true,
        runtimeEpoch: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps a failed physical start as an initialization failure', async () => {
    const harness = makeRuntime();
    harness.preheat.mockRejectedValue(new Error('child failed'));

    await expect(
      getWorkspaceRuntimeCoordinator(harness.runtime).ensure(),
    ).rejects.toBeInstanceOf(WorkspaceRuntimeInitializationError);
  });

  it('preserves a preheat failure when draining wins the response race', async () => {
    const harness = makeRuntime();
    let rejectPreheat!: (error: Error) => void;
    harness.preheat.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPreheat = reject;
        }),
    );
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    const failure = new Error('preheat failed');

    const ensure = coordinator.ensure();
    await vi.waitFor(() => expect(harness.preheat).toHaveBeenCalledOnce());
    coordinator.beginDrain();
    rejectPreheat(failure);

    await expect(ensure).rejects.toMatchObject({
      code: 'workspace_draining',
      cause: failure,
    });
  });

  it('rejects when preheat resolves without a live runtime', async () => {
    const harness = makeRuntime();
    harness.preheat.mockResolvedValue(undefined);

    await expect(
      getWorkspaceRuntimeCoordinator(harness.runtime).ensure(),
    ).rejects.toBeInstanceOf(WorkspaceRuntimeInitializationError);
  });

  it('stores one coordinator per supported runtime', () => {
    const harness = makeRuntime();

    expect(getWorkspaceRuntimeCoordinator(harness.runtime)).toBe(
      getWorkspaceRuntimeCoordinator(harness.runtime),
    );
  });

  it('does not create a coordinator for an older injected bridge', () => {
    const harness = makeRuntime();
    delete (harness.bridge as Partial<AcpSessionBridge>)
      .getWorkspaceRuntimeLifecycleSnapshot;

    expect(getWorkspaceRuntimeCoordinatorIfSupported(harness.runtime)).toBe(
      undefined,
    );
  });
});
