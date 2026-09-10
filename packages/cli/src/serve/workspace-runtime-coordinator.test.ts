/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ServeWorkspaceExtensionsRefreshResult,
  ServeWorkspaceExtensionsStatus,
  ServeWorkspaceSkillsStatus,
} from '@qwen-code/acp-bridge/status';
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
  const invokeWorkspaceCommand = vi.fn(
    async (): Promise<ServeWorkspaceExtensionsRefreshResult> => ({
      sessionsRefreshed: 0,
      sessionsFailed: 0,
      configsRefreshed: 1,
      configsFailed: 0,
    }),
  );
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
  const getWorkspaceExtensionsStatus = vi.fn(
    async (): Promise<ServeWorkspaceExtensionsStatus> => ({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      runtimeEpoch: snapshot.runtimeEpoch,
      extensions: [],
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
      getWorkspaceExtensionsStatus,
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
    getWorkspaceExtensionsStatus,
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
        extensions: {
          state: 'ready',
          revision: 0,
          runtimeEpoch: 1,
          desiredGeneration: 0,
          appliedGeneration: 0,
        },
        skills: { state: 'ready', revision: 0, runtimeEpoch: 1 },
        mcp: { state: 'ready', revision: 0, runtimeEpoch: 1 },
      },
    });
    expect(harness.preheat).toHaveBeenCalledWith({
      keepAliveMs: 600_000,
    });
    expect(harness.bridge.sessionCount).toBe(0);
    expect(harness.getWorkspaceExtensionsStatus).toHaveBeenCalledOnce();
    expect(harness.invalidateWorkspaceSkillsStatus).toHaveBeenCalledOnce();
  });

  it('certifies a slow Extension refresh after the ensure observation expires', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeRuntime();
      harness.setSnapshot({
        state: 'idle',
        runtimeLive: true,
        runtimeEpoch: 3,
      });
      const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
      harness.invokeWorkspaceCommand.mockImplementationOnce(
        (
          _method?: string,
          _params?: Record<string, unknown>,
          options?: { timeoutMs?: number },
        ) =>
          new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('command timeout')),
              options?.timeoutMs,
            );
            setTimeout(() => {
              clearTimeout(timeout);
              resolve({
                configsRefreshed: 1,
                configsFailed: 0,
                sessionsRefreshed: 0,
                sessionsFailed: 0,
              });
            }, 61_000);
          }),
      );

      const reconciliation = coordinator.reconcileExtensionGeneration(1);
      const ensured = coordinator.ensure();
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await ensured).capabilities?.extensions).toMatchObject({
        state: 'starting',
        desiredGeneration: 1,
        appliedGeneration: 0,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(reconciliation).resolves.toMatchObject({
        state: 'reconciled',
      });
      expect(coordinator.status().capabilities?.extensions).toMatchObject({
        state: 'ready',
        runtimeEpoch: 3,
        appliedGeneration: 1,
      });
      expect(
        harness.invokeWorkspaceCommand.mock.calls.filter(
          (call) =>
            (call as unknown[])[0] ===
            'qwen/control/workspace/extensions/reconcile',
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles an Extension generation without a session', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    await expect(coordinator.reconcileExtensionGeneration(7)).resolves.toEqual({
      state: 'reconciled',
      refreshed: 0,
      failed: 0,
    });

    expect(coordinator.status().capabilities?.extensions).toEqual({
      state: 'ready',
      revision: 1,
      runtimeEpoch: 3,
      desiredGeneration: 7,
      appliedGeneration: 7,
    });
    expect(harness.invokeWorkspaceCommand).toHaveBeenCalledWith(
      'qwen/control/workspace/extensions/reconcile',
      { cwd: '/workspace' },
      { timeoutMs: 300_000 },
    );

    await coordinator.reconcileExtensionGeneration(7);
    await expect(
      coordinator.reconcileExtensionGeneration(6),
    ).resolves.toMatchObject({ state: 'superseded' });
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      desiredGeneration: 7,
      appliedGeneration: 7,
    });
    expect(harness.getWorkspaceExtensionsStatus).toHaveBeenCalledOnce();
    expect(
      harness.invokeWorkspaceCommand.mock.calls.filter(
        (call) =>
          (call as unknown[])[0] ===
          'qwen/control/workspace/extensions/reconcile',
      ),
    ).toHaveLength(1);
  });

  it.each([6, 0])(
    'adopts fresh backup recovery to generation %i',
    async (generation) => {
      const harness = makeRuntime();
      harness.setSnapshot({
        state: 'idle',
        runtimeLive: true,
        runtimeEpoch: 3,
      });
      const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
      await coordinator.reconcileExtensionGeneration(7);
      await coordinator.ensure();
      const skillsRevision =
        coordinator.status().capabilities!.skills!.revision;
      const mcpRevision = coordinator.status().capabilities!.mcp!.revision;
      const readRevision =
        coordinator.status().capabilities!.extensions!.revision;
      coordinator.observeExtensionGeneration(8);
      coordinator.observeExtensionGeneration(generation, readRevision);
      expect(
        coordinator.status().capabilities?.extensions?.desiredGeneration,
      ).toBe(8);

      coordinator.observeExtensionGeneration(
        generation,
        coordinator.status().capabilities!.extensions!.revision,
      );
      expect(coordinator.status().capabilities?.extensions).toMatchObject({
        state: 'stale',
        desiredGeneration: generation,
        appliedGeneration: 0,
      });
      if (generation === 0) {
        await coordinator.ensure();
      } else {
        await expect(
          coordinator.reconcileExtensionGeneration(generation),
        ).resolves.toMatchObject({ state: 'reconciled' });
      }
      expect(coordinator.status().capabilities?.extensions).toMatchObject({
        state: 'ready',
        desiredGeneration: generation,
        appliedGeneration: generation,
      });
      expect(coordinator.status().capabilities!.skills!.revision).toBe(
        skillsRevision + 1,
      );
      expect(coordinator.status().capabilities!.mcp!.revision).toBe(
        mcpRevision + 1,
      );
    },
  );

  it('preserves the narrow refresh for Extension Skill-state changes', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.ensure();
    // Certify the previous generation so the skills-only reconcile reaches
    // the success exit (applied === generation - 1).
    await coordinator.reconcileExtensionGeneration(6);
    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.mcp?.state).toBe('ready'),
    );
    harness.reloadWorkspaceMcp.mockClear();

    await expect(
      coordinator.reconcileExtensionGeneration(7, { skillsOnly: true }),
    ).resolves.toMatchObject({ state: 'reconciled' });

    expect(harness.invokeWorkspaceCommand).toHaveBeenCalledWith(
      'qwen/control/workspace/extensions/reconcile',
      { cwd: '/workspace', skillsOnly: true },
      { timeoutMs: 300_000 },
    );
    // A skills-only reconcile cannot change MCP config: the ready MCP
    // capability must not be invalidated or reloaded for it.
    expect(coordinator.status().capabilities?.mcp).toMatchObject({
      state: 'ready',
      runtimeEpoch: 3,
    });
    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.skills?.state).toBe('ready'),
    );
    expect(harness.reloadWorkspaceMcp).not.toHaveBeenCalled();
  });

  it('does not let a skills-only reconcile certify an unapplied generation', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    await expect(
      coordinator.reconcileExtensionGeneration(8),
    ).resolves.toMatchObject({ state: 'reconciled' });
    expect(
      coordinator.status().capabilities?.extensions?.appliedGeneration,
    ).toBe(8);

    harness.invokeWorkspaceCommand.mockResolvedValueOnce({
      sessionsRefreshed: 0,
      sessionsFailed: 0,
      configsRefreshed: 0,
      configsFailed: 1,
      configErrors: ['broken extension'],
    });
    await expect(
      coordinator.reconcileExtensionGeneration(9),
    ).resolves.toMatchObject({ state: 'failed' });
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'error',
      appliedGeneration: 8,
    });

    await expect(
      coordinator.reconcileExtensionGeneration(10, { skillsOnly: true }),
    ).resolves.toMatchObject({ state: 'deferred' });

    // The generation-10 skill refresh succeeded, but the generation-9 full
    // refresh never applied: the capability must stay non-ready so the next
    // ensure runs the full refresh.
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      desiredGeneration: 10,
      appliedGeneration: 8,
    });
    expect(coordinator.status().capabilities?.extensions?.state).not.toBe(
      'ready',
    );

    await coordinator.ensure();
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'ready',
      desiredGeneration: 10,
      appliedGeneration: 10,
    });
  });

  it('defers an Extension generation until the runtime is ensured', async () => {
    const harness = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    await expect(coordinator.reconcileExtensionGeneration(4)).resolves.toEqual({
      state: 'deferred',
      refreshed: 0,
      failed: 0,
    });
    await expect(coordinator.ensure()).resolves.toMatchObject({
      capabilities: {
        extensions: {
          state: 'ready',
          desiredGeneration: 4,
          appliedGeneration: 4,
          runtimeEpoch: 1,
        },
      },
    });
  });

  it('does not certify a skills-only apply across runtime epochs', async () => {
    const h = makeRuntime();
    h.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    const coordinator = getWorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.reconcileExtensionGeneration(6);
    h.setSnapshot({ runtimeEpoch: 4 });
    await expect(
      coordinator.reconcileExtensionGeneration(7, { skillsOnly: true }),
    ).resolves.toMatchObject({ state: 'deferred' });
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'stale',
      appliedGeneration: 0,
    });
    await coordinator.ensure();
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'ready',
      runtimeEpoch: 4,
      appliedGeneration: 7,
    });
  });

  it('does not certify generation zero when the runtime changes during apply', async () => {
    const h = makeRuntime();
    h.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    const coordinator = getWorkspaceRuntimeCoordinator(h.runtime);
    h.getWorkspaceExtensionsStatus.mockImplementationOnce(async () => {
      h.setSnapshot({ runtimeEpoch: 4 });
      return {
        v: 1,
        workspaceCwd: '/workspace',
        initialized: true,
        runtimeEpoch: 3,
        extensions: [],
      };
    });
    await expect(
      coordinator.reconcileExtensionGeneration(0),
    ).resolves.toMatchObject({ state: 'deferred' });
    expect(coordinator.status().capabilities?.extensions?.state).toBe('stale');
    expect(h.reloadWorkspaceMcp).not.toHaveBeenCalled();
  });

  it('does not start a runtime that goes cold before queued reconciliation', async () => {
    const h = makeRuntime();
    h.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    const coordinator = getWorkspaceRuntimeCoordinator(h.runtime);
    const result = coordinator.reconcileExtensionGeneration(7);
    h.setSnapshot({ state: 'cold', runtimeLive: false });
    await expect(result).resolves.toMatchObject({ state: 'deferred' });
    expect(h.preheat).not.toHaveBeenCalled();
    expect(h.invokeWorkspaceCommand).not.toHaveBeenCalled();
  });

  it('invalidates retained Skills when a cold runtime observes a new generation', () => {
    const h = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(h.runtime);
    coordinator.observeExtensionGeneration(7);
    coordinator.observeExtensionGeneration(7);
    expect(h.invalidateWorkspaceSkillsStatus).toHaveBeenCalledOnce();
    expect(h.preheat).not.toHaveBeenCalled();
  });

  it('defers an Extension generation when the runtime epoch changes', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    harness.getWorkspaceExtensionsStatus.mockImplementationOnce(async () => {
      harness.setSnapshot({
        state: 'cold',
        runtimeLive: false,
        runtimeEpoch: 4,
      });
      return {
        v: 1,
        workspaceCwd: '/workspace',
        initialized: true,
        runtimeEpoch: 3,
        extensions: [],
      };
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    await expect(coordinator.reconcileExtensionGeneration(7)).resolves.toEqual({
      state: 'deferred',
      refreshed: 0,
      failed: 0,
    });
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'stale',
      desiredGeneration: 7,
      appliedGeneration: 0,
    });
  });

  it('fails reconciliation when the live Extension catalog is uninitialized', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    harness.getWorkspaceExtensionsStatus.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: false,
      runtimeEpoch: 3,
      extensions: [],
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    await expect(coordinator.reconcileExtensionGeneration(7)).resolves.toEqual({
      state: 'failed',
      refreshed: 0,
      failed: 1,
      error: 'Extension runtime returned a stale or uninitialized catalog',
    });
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'error',
      desiredGeneration: 7,
      appliedGeneration: 0,
    });
  });

  it('surfaces the runtime Extension diagnostic over the uninitialized gate', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    harness.getWorkspaceExtensionsStatus.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: false,
      runtimeEpoch: 3,
      extensions: [],
      errors: [
        {
          kind: 'extensions',
          status: 'error',
          error: 'extension manifest parse failed',
        },
      ],
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    await expect(
      coordinator.reconcileExtensionGeneration(7),
    ).resolves.toMatchObject({
      state: 'failed',
      error: 'extension manifest parse failed',
    });
    expect(coordinator.status().capabilities?.extensions?.error?.message).toBe(
      'extension manifest parse failed',
    );
  });

  it('sanitizes Extension reconcile failures before broadcasting and persisting them', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    harness.invokeWorkspaceCommand.mockResolvedValueOnce({
      sessionsRefreshed: 2,
      sessionsFailed: 1,
      sessionsSkipped: 1,
      configsRefreshed: 0,
      configsFailed: 1,
      configErrors: [
        `fatal: unable to access 'https://user:tok3n@github.com/org/ext.git/'${'x'.repeat(600)}\x1b[31m`,
      ],
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    const reconciliation = await coordinator.reconcileExtensionGeneration(7);

    // The ExtensionRuntimeRefreshError result payload must survive into the
    // returned counters, not just the error message.
    expect(reconciliation).toMatchObject({
      state: 'failed',
      refreshed: 2,
      failed: 3,
    });
    // The extensions_changed broadcast reads reconciliation.error verbatim.
    expect(reconciliation.error).not.toContain('tok3n');
    expect(reconciliation.error).not.toContain('\x1b');
    expect(reconciliation.error!.length).toBeLessThanOrEqual(500);
    // The persisted capabilities status is the second sink.
    const extensions = coordinator.status().capabilities?.extensions;
    expect(extensions?.state).toBe('error');
    expect(extensions?.error?.message).not.toContain('tok3n');
    expect(extensions?.error?.message).not.toContain('\x1b');
    expect(extensions?.error?.message!.length).toBeLessThanOrEqual(500);
  });

  it.each([false, true])(
    'replays interrupted Extension reconciliation with skillsOnly=%s',
    async (skillsOnly) => {
      const harness = makeRuntime();
      harness.setSnapshot({
        state: 'idle',
        runtimeLive: true,
        runtimeEpoch: 3,
      });
      const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
      await coordinator.reconcileExtensionGeneration(6);
      harness.getWorkspaceExtensionsStatus.mockClear();
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
      const reconciliation = coordinator.reconcileExtensionGeneration(7, {
        skillsOnly,
      });
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));

      coordinator.beginDrain();
      release();
      await expect(reconciliation).resolves.toMatchObject({
        state: 'deferred',
      });
      harness.invokeWorkspaceCommand.mockClear();
      coordinator.cancelDrain();

      await vi.waitFor(() =>
        expect(coordinator.status().capabilities?.extensions).toMatchObject({
          state: 'ready',
          desiredGeneration: 7,
          appliedGeneration: 7,
        }),
      );
      expect(harness.getWorkspaceExtensionsStatus).toHaveBeenCalledTimes(2);
      expect(harness.invokeWorkspaceCommand).toHaveBeenCalledWith(
        'qwen/control/workspace/extensions/reconcile',
        { cwd: '/workspace', ...(skillsOnly ? { skillsOnly: true } : {}) },
        { timeoutMs: 300_000 },
      );
    },
  );

  it('continues preparing Skills and MCP after an Extension refresh fails', async () => {
    const harness = makeRuntime();
    harness.invokeWorkspaceCommand.mockResolvedValueOnce({
      sessionsRefreshed: 0,
      sessionsFailed: 0,
      sessionsSkipped: 1,
      configsRefreshed: 0,
      configsFailed: 1,
      configErrors: ['broken extension'],
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    coordinator.observeExtensionGeneration(2);

    await expect(coordinator.ensure()).resolves.toMatchObject({
      capabilities: {
        extensions: {
          state: 'error',
          desiredGeneration: 2,
          appliedGeneration: 0,
          error: { message: expect.stringContaining('broken extension') },
        },
        skills: { state: 'ready' },
        mcp: { state: 'ready' },
      },
    });
    expect(harness.getWorkspaceSkillsRuntimeStatus).toHaveBeenCalled();
    expect(harness.getWorkspaceMcpStatus).toHaveBeenCalled();
  });

  it('restores derived capabilities after an explicit Extension reconcile fails', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.ensure();
    harness.invokeWorkspaceCommand.mockResolvedValueOnce({
      sessionsRefreshed: 0,
      sessionsFailed: 0,
      configsRefreshed: 0,
      configsFailed: 1,
      configErrors: ['broken extension'],
    });

    await expect(coordinator.reconcileExtensionGeneration(7)).resolves.toEqual({
      state: 'failed',
      refreshed: 0,
      failed: 1,
      error: 'Extension runtime refresh failed: broken extension',
    });
    await vi.waitFor(() =>
      expect(coordinator.status().capabilities).toMatchObject({
        extensions: { state: 'error' },
        skills: { state: 'ready', runtimeEpoch: 3 },
        mcp: { state: 'ready', runtimeEpoch: 3 },
      }),
    );
  });

  it('does not re-run a failed Extension revision from the ensure path', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    harness.invokeWorkspaceCommand.mockResolvedValue({
      sessionsRefreshed: 0,
      sessionsFailed: 0,
      configsRefreshed: 0,
      configsFailed: 1,
      configErrors: ['broken extension'],
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    coordinator.observeExtensionGeneration(2);
    const reconcileCalls = () =>
      (harness.invokeWorkspaceCommand.mock.calls as unknown[][]).filter(
        (call) => call[0] === 'qwen/control/workspace/extensions/reconcile',
      ).length;

    await coordinator.ensure();
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'error',
    });
    expect(reconcileCalls()).toBe(1);

    // The failure arms one retry, consumed by the next ensure; the retry
    // fails too, and only then is the revision terminal for the ensure path.
    await coordinator.ensure();
    expect(reconcileCalls()).toBe(2);
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'error',
    });
    await coordinator.ensure();
    expect(reconcileCalls()).toBe(2);

    // A newly observed generation (or an explicit reconcile) retries.
    coordinator.observeExtensionGeneration(3);
    await coordinator.ensure();
    expect(reconcileCalls()).toBe(3);
  });

  it.each(['success', 'partial failure', 'uninitialized catalog'])(
    'invalidates derived capabilities after ensure Extension apply: %s',
    async (outcome) => {
      const harness = makeRuntime();
      harness.setSnapshot({
        state: 'idle',
        runtimeLive: true,
        runtimeEpoch: 3,
      });
      const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

      await coordinator.ensure();
      expect(coordinator.status().capabilities).toMatchObject({
        extensions: { state: 'ready' },
        skills: { state: 'ready', revision: 0 },
        mcp: { state: 'ready', revision: 0 },
      });
      const skillsReads =
        harness.getWorkspaceSkillsRuntimeStatus.mock.calls.length;

      coordinator.observeExtensionGeneration(5);
      if (outcome === 'partial failure') {
        harness.invokeWorkspaceCommand.mockResolvedValue({
          sessionsRefreshed: 0,
          sessionsFailed: 1,
          configsRefreshed: 1,
          configsFailed: 0,
        });
      } else if (outcome === 'uninitialized catalog') {
        harness.getWorkspaceExtensionsStatus.mockResolvedValue({
          v: 1,
          workspaceCwd: '/workspace',
          runtimeEpoch: 3,
          initialized: false,
          extensions: [],
        });
      }
      await coordinator.ensure();

      expect(coordinator.status().capabilities?.extensions).toMatchObject({
        state: outcome === 'success' ? 'ready' : 'error',
        desiredGeneration: 5,
        appliedGeneration: outcome === 'success' ? 5 : 0,
      });
      // Applying the generation on the ensure path must re-verify the derived
      // capabilities: a ready status that predates the applied generation must
      // not be certified for it.
      expect(harness.reloadWorkspaceMcp).toHaveBeenCalled();
      expect(
        harness.getWorkspaceSkillsRuntimeStatus.mock.calls.length,
      ).toBeGreaterThan(skillsReads);
      expect(coordinator.status().capabilities).toMatchObject({
        skills: { state: 'ready', runtimeEpoch: 3 },
        mcp: { state: 'ready', runtimeEpoch: 3 },
      });
    },
  );

  it('recovers a latched Extension failure at the initial generation after the cooldown', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    harness.invokeWorkspaceCommand.mockResolvedValue({
      sessionsRefreshed: 0,
      sessionsFailed: 0,
      configsRefreshed: 0,
      configsFailed: 1,
      configErrors: ['broken extension'],
    });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    // The store was never mutated: the desired generation stays 0, so no
    // observed generation move can clear the failed-revision latch.
    await coordinator.ensure();
    await coordinator.ensure();
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'error',
      desiredGeneration: 0,
      appliedGeneration: 0,
    });

    // Within the cooldown the latch stays terminal for the ensure path.
    await coordinator.ensure();
    expect(coordinator.status().capabilities?.extensions?.state).toBe('error');
    const callsBefore = harness.invokeWorkspaceCommand.mock.calls.length;
    await expect(
      coordinator.reconcileExtensionGeneration(0),
    ).resolves.toMatchObject({
      state: 'deferred',
      error: 'Extension runtime refresh failed: broken extension',
    });
    expect(harness.invokeWorkspaceCommand).toHaveBeenCalledTimes(callsBefore);

    // The underlying fault heals without any store write; once the cooldown
    // elapses the ensure path must retry instead of certifying the failure
    // until the runtime restarts.
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 2 * 60_000 + 1_000);
    try {
      await coordinator.ensure();
      const retryCalls = harness.invokeWorkspaceCommand.mock.calls.length;
      await coordinator.ensure();
      expect(harness.invokeWorkspaceCommand).toHaveBeenCalledTimes(retryCalls);
      harness.invokeWorkspaceCommand.mockResolvedValue({
        sessionsRefreshed: 0,
        sessionsFailed: 0,
        configsRefreshed: 1,
        configsFailed: 0,
      });
      nowSpy.mockReturnValue(Date.now() + 2 * 60_000 + 1_000);
      await coordinator.ensure();
    } finally {
      nowSpy.mockRestore();
    }
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'ready',
      desiredGeneration: 0,
      appliedGeneration: 0,
    });
  });

  it('retries a failed Extension refresh once and reaches ready', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    harness.getWorkspaceExtensionsStatus.mockRejectedValueOnce(
      new Error('catalog read failed'),
    );
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    coordinator.observeExtensionGeneration(2);
    const reconcileCalls = () =>
      (harness.invokeWorkspaceCommand.mock.calls as unknown[][]).filter(
        (call) => call[0] === 'qwen/control/workspace/extensions/reconcile',
      ).length;

    await coordinator.ensure();
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'error',
      error: { message: 'catalog read failed' },
    });

    await coordinator.ensure();
    expect(coordinator.status().capabilities?.extensions).toMatchObject({
      state: 'ready',
      desiredGeneration: 2,
      appliedGeneration: 2,
    });
    expect(reconcileCalls()).toBe(2);
  });

  it('keeps a queued MCP reload alive across a read-side Extension observation', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 3 });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    // Hold the MCP queue so the configuration reconcile stays queued behind
    // an in-flight mutation, the same way a committed config change waits.
    let releaseMutation!: () => void;
    const mutation = coordinator.runMcpRuntimeMutation(
      () =>
        new Promise<void>((resolve) => {
          releaseMutation = resolve;
        }),
    );
    await vi.waitFor(() => expect(releaseMutation).toBeTypeOf('function'));
    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');

    // A read-only observation (GET routes, poller pre-pass) must not discard
    // the queued reload: observation is not mutation.
    coordinator.observeExtensionGeneration(5);
    releaseMutation();
    await mutation;

    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.mcp).toMatchObject({
        state: 'ready',
        runtimeEpoch: 3,
      }),
    );
    expect(harness.reloadWorkspaceMcp).toHaveBeenCalledTimes(1);
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
    expect(harness.invokeWorkspaceCommand).not.toHaveBeenCalledWith(
      'qwen/control/workspace/skills/refresh',
      expect.anything(),
    );
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
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.reconcileExtensionGeneration(0);
    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.skills?.state).toBe('ready'),
    );
    harness.invokeWorkspaceCommand.mockClear();
    harness.invokeWorkspaceCommand.mockResolvedValueOnce({
      sessionsRefreshed: 0,
      sessionsFailed: 0,
      configsRefreshed: 0,
      configsFailed: 1,
    });
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
    expect(
      harness.invokeWorkspaceCommand.mock.calls.filter(
        (call) =>
          (call as unknown[])[0] === 'qwen/control/workspace/skills/refresh',
      ),
    ).toHaveLength(2);
  });

  it('applies a Skills mutation deferred while the runtime is starting', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'starting', runtimeLive: false });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);

    expect(coordinator.reconcileSkillsConfiguration()).toBe('deferred');
    await expect(coordinator.ensure()).resolves.toMatchObject({
      capabilities: { skills: { state: 'ready', revision: 1 } },
    });
    expect(
      harness.invokeWorkspaceCommand.mock.calls.filter(
        (call) =>
          (call as unknown[])[0] === 'qwen/control/workspace/skills/refresh',
      ),
    ).toHaveLength(1);
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
    expect(
      harness.invokeWorkspaceCommand.mock.calls.filter(
        (call) =>
          (call as unknown[])[0] === 'qwen/control/workspace/skills/refresh',
      ),
    ).toHaveLength(2);
  });

  it('does not certify a revision that changed while preparation was queued', async () => {
    const harness = makeRuntime();
    harness.setSnapshot({ state: 'idle', runtimeLive: true, runtimeEpoch: 1 });
    const coordinator = getWorkspaceRuntimeCoordinator(harness.runtime);
    await coordinator.reconcileExtensionGeneration(0);
    await vi.waitFor(() =>
      expect(coordinator.status().capabilities?.skills?.state).toBe('ready'),
    );
    harness.invokeWorkspaceCommand.mockClear();
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
    coordinator.reconcileSkillsConfiguration();
    await vi.waitFor(() =>
      expect(harness.invokeWorkspaceCommand).toHaveBeenCalledOnce(),
    );
    const ensure = coordinator.ensure();
    await new Promise((resolve) => setTimeout(resolve, 0));
    coordinator.reconcileSkillsConfiguration();
    releaseFirst();

    await expect(ensure).resolves.toMatchObject({
      capabilities: { skills: { state: 'starting', revision: 3 } },
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
