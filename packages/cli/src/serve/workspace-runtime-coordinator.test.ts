/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
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
    snapshot = {
      state: 'idle',
      runtimeLive: true,
      runtimeEpoch: snapshot.runtimeEpoch + 1,
      activeWork: false,
    };
  });
  const bridge = {
    sessionCount: 0,
    preheat,
    getWorkspaceRuntimeLifecycleSnapshot: () => snapshot,
  } as unknown as AcpSessionBridge;
  const runtime = {
    workspaceCwd: '/workspace',
    bridge,
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    bridge,
    preheat,
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
    });
    expect(harness.preheat).toHaveBeenCalledWith({
      keepAliveMs: 600_000,
    });
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
