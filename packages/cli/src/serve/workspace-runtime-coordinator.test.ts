/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ServeWorkspaceSkillsStatus } from '@qwen-code/acp-bridge/status';
import {
  WorkspaceDrainingError,
  type AcpSessionBridge,
  type BridgeWorkspaceRuntimeLifecycleSnapshot,
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
  const initializeWorkspaceMcp = vi.fn(async () => ({ accepted: true }));
  const reloadWorkspaceMcp = vi.fn(async () => ({ accepted: true }));
  const getWorkspaceSkillsRuntimeStatus = vi.fn(
    async (): Promise<ServeWorkspaceSkillsStatus> => ({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      runtimeEpoch: snapshot.runtimeEpoch,
      skills: [],
    }),
  );
  const getWorkspaceMcpStatus = vi.fn(
    async (): Promise<{
      v: 1;
      workspaceCwd: string;
      initialized: boolean;
      runtimeEpoch: number;
      source: 'live' | 'cache';
      discoveryState: 'not_started' | 'in_progress' | 'completed';
      servers: [];
    }> => ({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      runtimeEpoch: snapshot.runtimeEpoch,
      source: 'live',
      discoveryState: 'completed',
      servers: [],
    }),
  );
  const invalidateWorkspaceSkillsStatus = vi.fn();
  const bridge = {
    sessionCount: 0,
    preheat,
    invokeWorkspaceCommand,
    initializeWorkspaceMcp,
    reloadWorkspaceMcp,
    getWorkspaceRuntimeLifecycleSnapshot: () => snapshot,
  } as unknown as AcpSessionBridge;
  const runtime = {
    workspaceCwd: '/workspace',
    bridge,
    workspaceService: {
      getWorkspaceSkillsRuntimeStatus,
      invalidateWorkspaceSkillsStatus,
      getWorkspaceMcpStatus,
    },
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    bridge,
    preheat,
    invokeWorkspaceCommand,
    getWorkspaceSkillsRuntimeStatus,
    invalidateWorkspaceSkillsStatus,
    getWorkspaceMcpStatus,
    initializeWorkspaceMcp,
    reloadWorkspaceMcp,
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
        mcp: { state: 'ready', revision: 0, runtimeEpoch: 1 },
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

  it('reports a hard retry failure without failing runtime ensure', async () => {
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
    await vi.waitFor(() => {
      expect(coordinator.status().capabilities?.skills?.state).toBe('error');
    });
    harness.invokeWorkspaceCommand.mockRejectedValueOnce(
      new Error('refresh failed'),
    );

    await expect(coordinator.ensure()).resolves.toMatchObject({
      runtimeLive: true,
      capabilities: {
        skills: {
          state: 'error',
          error: { message: 'refresh failed' },
        },
      },
    });
    await expect(coordinator.ensure()).resolves.toMatchObject({
      capabilities: { skills: { state: 'error' } },
    });
    expect(harness.invokeWorkspaceCommand).toHaveBeenCalledTimes(2);
  });

  it('applies a Skills mutation deferred while the runtime is starting', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'starting', runtimeLive: false });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    expect(coordinator.reconcileSkillsConfiguration()).toBe('deferred');
    await expect(coordinator.ensure()).resolves.toMatchObject({
      capabilities: { skills: { state: 'ready', revision: 1 } },
    });
    expect(harness.invokeWorkspaceCommand).toHaveBeenCalledOnce();
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

  it('marks MCP stale when its runtime stops without changing epoch', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.ensure();

    harness.setSnapshot({ state: 'cold', runtimeLive: false });

    expect(coordinator.status()).toMatchObject({
      state: 'cold',
      runtimeLive: false,
      runtimeEpoch: 1,
      capabilities: {
        mcp: { state: 'stale', revision: 0, runtimeEpoch: 1 },
      },
    });
  });

  it('does not project queued MCP work into the runtime lifecycle', async () => {
    const harness = makeRuntime();
    let resolveStatus!: (value: {
      v: 1;
      workspaceCwd: string;
      initialized: boolean;
      runtimeEpoch: number;
      source: 'live';
      discoveryState: 'completed';
      servers: [];
    }) => void;
    harness.getWorkspaceMcpStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    const ensure = coordinator.ensure();
    await vi.waitFor(() => {
      expect(harness.getWorkspaceMcpStatus).toHaveBeenCalledOnce();
    });

    expect(coordinator.status()).toMatchObject({
      state: 'idle',
      capabilities: { mcp: { state: 'starting' } },
    });

    resolveStatus({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      runtimeEpoch: 1,
      source: 'live',
      discoveryState: 'completed',
      servers: [],
    });
    await ensure;
  });

  it('defers MCP configuration reconciliation while cold', () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    expect(coordinator.reconcileMcpConfiguration()).toBe('deferred');
    expect(coordinator.status().capabilities?.mcp?.state).toBe('not_started');
    expect(harness.reloadWorkspaceMcp).not.toHaveBeenCalled();
  });

  it('reconciles MCP configuration on the live workspace runtime', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.ensure();

    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');
    await vi.waitFor(() => {
      expect(harness.reloadWorkspaceMcp).toHaveBeenCalledOnce();
      expect(coordinator.status().capabilities?.mcp).toMatchObject({
        state: 'ready',
        revision: 1,
        runtimeEpoch: 1,
      });
    });
  });

  it('observes an MCP reload already in progress', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.ensure();
    harness.reloadWorkspaceMcp.mockResolvedValueOnce({ accepted: false });

    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');

    await vi.waitFor(() => {
      expect(coordinator.status().capabilities?.mcp).toMatchObject({
        state: 'ready',
        revision: 1,
      });
    });
  });

  it('skips superseded queued MCP reloads', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.ensure();

    coordinator.reconcileMcpConfiguration();
    coordinator.reconcileMcpConfiguration();

    await vi.waitFor(() => {
      expect(coordinator.status().capabilities?.mcp).toMatchObject({
        state: 'ready',
        revision: 2,
      });
    });
    expect(harness.reloadWorkspaceMcp).toHaveBeenCalledOnce();
  });

  it('keeps a queued config reload when a runtime mutation bumps the revision', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.ensure();
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const firstMutation = coordinator.runMcpRuntimeMutation(async () => {
      await mutationGate;
      return { accepted: true };
    });
    await vi.waitFor(() => expect(coordinator.hasActiveWork()).toBe(true));

    coordinator.reconcileMcpConfiguration();
    const secondMutation = coordinator.runMcpRuntimeMutation(async () => ({
      accepted: true,
    }));
    releaseMutation();

    await Promise.all([firstMutation, secondMutation]);
    expect(harness.reloadWorkspaceMcp).toHaveBeenCalledOnce();
    expect(coordinator.status().capabilities?.mcp).toMatchObject({
      state: 'ready',
      revision: 3,
    });
  });

  it('records a background MCP reconciliation failure', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.ensure();
    harness.reloadWorkspaceMcp.mockRejectedValueOnce(
      new Error('reload failed'),
    );

    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');

    await vi.waitFor(() => {
      expect(coordinator.status().capabilities?.mcp).toMatchObject({
        state: 'error',
        revision: 1,
        error: { message: 'reload failed' },
      });
    });
  });

  it('preheats a cold runtime before an MCP mutation', async () => {
    const harness = makeRuntime();
    const mutation = vi.fn(async () => {
      expect(harness.preheat).toHaveBeenCalledOnce();
      return { accepted: true };
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    await expect(coordinator.runMcpRuntimeMutation(mutation)).resolves.toEqual({
      accepted: true,
    });

    expect(harness.preheat).toHaveBeenCalledOnce();
    expect(mutation).toHaveBeenCalledOnce();
    expect(coordinator.status().capabilities?.mcp).toMatchObject({
      state: 'ready',
      revision: 1,
      runtimeEpoch: 1,
    });
  });

  it('wraps a failed MCP mutation preheat as an initialization failure', async () => {
    const harness = makeRuntime();
    harness.preheat.mockRejectedValueOnce(new Error('child failed'));

    await expect(
      getWorkspaceRuntimeCoordinator(harness.runtime).runMcpRuntimeMutation(
        async () => ({ accepted: true }),
      ),
    ).rejects.toBeInstanceOf(WorkspaceRuntimeInitializationError);
  });

  it('rechecks MCP readiness after a rejected runtime mutation', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    const error = new Error('restart failed');

    await expect(
      coordinator.runMcpRuntimeMutation(async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    await vi.waitFor(() => {
      expect(coordinator.status().capabilities?.mcp).toMatchObject({
        state: 'ready',
        revision: 1,
        runtimeEpoch: 1,
      });
    });
    expect(harness.getWorkspaceMcpStatus).toHaveBeenCalledOnce();
  });

  it.each([
    { runtimeEpoch: 1, source: 'cache' as const },
    { runtimeEpoch: 0, source: 'live' as const },
  ])(
    'waits for live MCP status after $source epoch $runtimeEpoch',
    async (stale) => {
      const harness = makeRuntime();
      harness.getWorkspaceMcpStatus.mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/workspace',
        initialized: true,
        ...stale,
        discoveryState: 'completed',
        servers: [],
      });

      const result = await getWorkspaceRuntimeCoordinator(
        harness.runtime,
      ).ensure();

      expect(harness.getWorkspaceMcpStatus).toHaveBeenCalledTimes(2);
      expect(result.capabilities?.mcp).toMatchObject({
        state: 'ready',
        runtimeEpoch: 1,
      });
    },
  );

  it('waits for the latest MCP revision when ensure overlaps a config change', async () => {
    const harness = makeRuntime();
    let releaseFirstStatus: (() => void) | undefined;
    const firstStatus = new Promise<void>((resolve) => {
      releaseFirstStatus = resolve;
    });
    harness.getWorkspaceMcpStatus.mockImplementationOnce(async () => {
      await firstStatus;
      return {
        v: 1,
        workspaceCwd: '/workspace',
        initialized: true,
        runtimeEpoch: 1,
        source: 'live',
        discoveryState: 'completed',
        servers: [],
      };
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    const firstEnsure = coordinator.ensure();
    await vi.waitFor(() => {
      expect(harness.getWorkspaceMcpStatus).toHaveBeenCalledOnce();
    });
    harness.preheat.mockImplementation(async () => {});

    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');
    const latestEnsure = coordinator.ensure();
    releaseFirstStatus?.();

    await firstEnsure;
    await expect(latestEnsure).resolves.toMatchObject({
      capabilities: { mcp: { state: 'ready', revision: 1 } },
    });
  });

  it('abandons stale MCP preparation before running the next revision', async () => {
    const harness = makeRuntime();
    let releaseFirstStatus: (() => void) | undefined;
    const firstStatus = new Promise<void>((resolve) => {
      releaseFirstStatus = resolve;
    });
    harness.getWorkspaceMcpStatus.mockImplementationOnce(async () => {
      await firstStatus;
      return {
        v: 1,
        workspaceCwd: '/workspace',
        initialized: true,
        runtimeEpoch: 1,
        source: 'live',
        discoveryState: 'in_progress',
        servers: [],
      };
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    const firstEnsure = coordinator.ensure();
    await vi.waitFor(() => {
      expect(harness.getWorkspaceMcpStatus).toHaveBeenCalledOnce();
    });

    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');
    releaseFirstStatus?.();

    await firstEnsure;
    await vi.waitFor(() => {
      expect(harness.reloadWorkspaceMcp).toHaveBeenCalledOnce();
      expect(coordinator.status().capabilities?.mcp).toMatchObject({
        state: 'ready',
        revision: 1,
      });
    });
  });

  it('replays a live MCP reconciliation after drain rollback', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.ensure();
    coordinator.beginDrain();

    expect(coordinator.reconcileMcpConfiguration()).toBe('deferred');
    coordinator.cancelDrain();

    await vi.waitFor(() => {
      expect(harness.reloadWorkspaceMcp).toHaveBeenCalledOnce();
      expect(coordinator.status().capabilities?.mcp).toMatchObject({
        state: 'ready',
        revision: 1,
      });
    });
  });

  it('repairs a queued MCP mutation rejected by a drain race', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 1 });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutationStarted = vi.fn();
    const first = coordinator.runMcpRuntimeMutation(async () => {
      mutationStarted();
      await mutationGate;
      return { accepted: true };
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mutationStarted).toHaveBeenCalledOnce();
    const queued = coordinator.runMcpRuntimeMutation(async () => ({
      accepted: true,
    }));
    let queuedError: unknown;
    const queuedHandled = queued.catch((error: unknown) => {
      queuedError = error;
    });

    coordinator.beginDrain();
    releaseMutation();
    await queuedHandled;
    expect(queuedError).toBeInstanceOf(WorkspaceDrainingError);
    expect(coordinator.status().capabilities?.mcp?.state).toBe('stale');
    coordinator.cancelDrain();
    await first;

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.reloadWorkspaceMcp).toHaveBeenCalledOnce();
    expect(coordinator.status().capabilities?.mcp?.state).toBe('ready');
  });

  it('replays MCP reconciliation interrupted while draining', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.ensure();
    harness.getWorkspaceMcpStatus.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      runtimeEpoch: 1,
      source: 'live',
      discoveryState: 'in_progress',
      servers: [],
    });

    coordinator.reconcileMcpConfiguration();
    await vi.waitFor(() => {
      expect(harness.getWorkspaceMcpStatus).toHaveBeenCalledTimes(2);
    });
    coordinator.beginDrain();
    await vi.waitFor(() => {
      expect(coordinator.status().capabilities?.mcp?.state).toBe('stale');
    });
    coordinator.cancelDrain();

    await vi.waitFor(() => {
      expect(harness.reloadWorkspaceMcp).toHaveBeenCalledTimes(2);
      expect(coordinator.status().capabilities?.mcp?.state).toBe('ready');
    });
  });

  it('handles a queued MCP preparation rejection after ensure returns', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.ensure();
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutation = coordinator.runMcpRuntimeMutation(async () => {
      await mutationGate;
      return { accepted: true };
    });
    await vi.waitFor(() => expect(coordinator.hasActiveWork()).toBe(true));

    await coordinator.ensure(0);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      coordinator.beginDrain();
      releaseMutation();
      await mutation;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
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
