/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ServeWorkspaceMcpStatus,
  ServeWorkspaceRuntimeCapability,
  ServeWorkspaceSkillsStatus,
} from '@qwen-code/acp-bridge/status';
import { WorkspaceDrainingError } from './acp-session-bridge.js';
import type { WorkspaceRuntime } from './workspace-registry.js';
import {
  getWorkspaceRuntimeCoordinator,
  WorkspaceRuntimeCoordinator,
} from './workspace-runtime-coordinator.js';

function makeRuntime(workspaceCwd = '/workspace') {
  let live = false;
  let runtimeEpoch = 0;
  const preheatAcpChild = vi.fn(async () => {
    if (!live) {
      live = true;
      runtimeEpoch += 1;
    }
    return { ready: true, channelLive: true, durationMs: 1 };
  });
  const getWorkspaceSkillsStatus = vi.fn(
    async (): Promise<ServeWorkspaceSkillsStatus> => ({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source: 'live',
      runtimeEpoch,
      skills: [],
      errors: [] as Array<{
        kind: string;
        status: 'error';
        error: string;
      }>,
    }),
  );
  const getWorkspaceMcpStatus = vi.fn(
    async (): Promise<ServeWorkspaceMcpStatus> => ({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source: 'live',
      runtimeEpoch,
      discoveryState: 'completed',
      servers: [],
    }),
  );
  const initializeWorkspaceMcp = vi.fn(async () => true);
  const reloadWorkspaceMcp = vi.fn(async () => ({ accepted: true }));
  const invokeWorkspaceCommand = vi.fn(async () => ({}));
  const getWorkspaceExtensionsStatus = vi.fn(async () => ({
    v: 1 as const,
    workspaceCwd: '/workspace',
    initialized: true,
    runtimeEpoch,
    extensions: [],
  }));
  const refreshWorkspaceExtensions = vi.fn(async () => ({
    refreshed: 1,
    failed: 0,
    generation: 1,
    runtimeEpoch,
  }));
  const getWorkspaceToolsStatus = vi.fn(async () => ({
    v: 1 as const,
    workspaceCwd: '/workspace',
    initialized: true,
    runtimeEpoch,
    tools: [],
  }));
  const runtime = {
    workspaceCwd,
    bridge: {
      get sessionCount() {
        return 0;
      },
      isChannelLive: () => live,
      getRuntimeEpoch: () => runtimeEpoch,
      initializeWorkspaceMcp,
      reloadWorkspaceMcp,
      invokeWorkspaceCommand,
      getWorkspaceExtensionsStatus,
      refreshWorkspaceExtensions,
      getWorkspaceToolsStatus,
    },
    workspaceService: {
      preheatAcpChild,
      getWorkspaceSkillsStatus,
      getWorkspaceMcpStatus,
    },
  } as unknown as WorkspaceRuntime;
  return {
    runtime,
    preheatAcpChild,
    getWorkspaceSkillsStatus,
    getWorkspaceMcpStatus,
    initializeWorkspaceMcp,
    reloadWorkspaceMcp,
    invokeWorkspaceCommand,
    refreshWorkspaceExtensions,
    getWorkspaceToolsStatus,
    setLive: (value: boolean) => {
      if (value && !live) runtimeEpoch += 1;
      live = value;
    },
  };
}

describe('WorkspaceRuntimeCoordinator', () => {
  it('ensures every standard capability and reuses a ready runtime', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    const first = await coordinator.ensure();
    const second = await coordinator.ensure();

    expect(first.capabilities).toMatchObject({
      extensions: { state: 'ready' },
      mcp: { state: 'ready' },
      skills: { state: 'ready' },
      tools: { state: 'ready' },
    });
    expect(second.runtimeEpoch).toBe(first.runtimeEpoch);
    expect(h.preheatAcpChild).toHaveBeenCalledOnce();
    expect(h.refreshWorkspaceExtensions).toHaveBeenCalledOnce();
    expect(h.getWorkspaceMcpStatus).toHaveBeenCalledOnce();
    expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledOnce();
    expect(h.getWorkspaceToolsStatus).toHaveBeenCalledOnce();
  });

  it('reports runtime state after the outer control lease is released', async () => {
    const h = makeRuntime();
    h.runtime.bridge.withWorkspaceRuntimeControl = vi.fn(async (run) => {
      if (!h.runtime.bridge.isChannelLive()) {
        await h.preheatAcpChild();
      }
      try {
        return await run(h.runtime.bridge.getRuntimeEpoch?.() ?? 0);
      } finally {
        h.setLive(false);
      }
    });
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    const result = await coordinator.ensure();

    expect(result).toMatchObject({
      state: 'cold',
      runtimeLive: false,
      capabilities: {
        extensions: { state: 'stale' },
        mcp: { state: 'stale' },
        skills: { state: 'stale' },
        tools: { state: 'stale' },
      },
    });
  });

  it('rejects ensure while a ready runtime is draining', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.ensure();

    coordinator.beginDrain();

    await expect(coordinator.ensure()).rejects.toMatchObject({
      code: 'workspace_draining',
      workspaceCwd: '/workspace',
    });
  });

  it('preheats once and prepares multiple capabilities without a session', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    const result = await coordinator.prepare(['skills', 'extensions']);

    expect(h.preheatAcpChild).toHaveBeenCalledOnce();
    expect(result.state).toBe('idle');
    expect(result.capabilities.skills?.state).toBe('ready');
    expect(result.capabilities.extensions?.state).toBe('ready');
  });

  it('coalesces concurrent preparation of the same capability', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    await Promise.all([
      coordinator.prepare(['skills']),
      coordinator.prepare(['skills']),
    ]);

    expect(h.preheatAcpChild).toHaveBeenCalledOnce();
    expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledOnce();
  });

  it('reports capability failures without losing runtime status', async () => {
    const h = makeRuntime();
    h.getWorkspaceSkillsStatus.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: false,
      skills: [],
      errors: [{ kind: 'skill', status: 'error', error: 'skills unavailable' }],
    });
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    const result = await coordinator.prepare(['skills']);

    expect(result.runtimeLive).toBe(true);
    expect(result.capabilities.skills).toMatchObject({
      state: 'error',
      error: { code: 'skills_prepare_failed', message: 'skills unavailable' },
    });
  });

  it('does not report daemon-local Skills fallback as runtime ready', async () => {
    const h = makeRuntime();
    h.getWorkspaceSkillsStatus.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source: 'config',
      skills: [],
      errors: [],
    });
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    const result = await coordinator.prepare(['skills']);

    expect(result.capabilities.skills).toMatchObject({
      state: 'error',
      error: {
        code: 'skills_prepare_failed',
        message: 'Skills runtime did not return a live snapshot',
      },
    });
  });

  it('marks prepared capability data stale after the runtime exits', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    expect(coordinator.status().capabilities.skills?.state).toBe('not_started');
    await coordinator.prepare(['skills']);

    h.setLive(false);

    expect(coordinator.status()).toMatchObject({
      state: 'cold',
      runtimeLive: false,
      capabilities: {
        skills: { state: 'stale' },
        mcp: { state: 'not_started' },
      },
    });
  });

  it('does not reuse ready capability state across runtime epochs', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['skills']);

    h.setLive(false);
    h.setLive(true);

    expect(coordinator.status()).toMatchObject({
      runtimeEpoch: 2,
      capabilities: {
        skills: { state: 'stale', runtimeEpoch: 1 },
      },
    });
  });

  it('does not publish a late Catalog response from an old runtime epoch', async () => {
    const h = makeRuntime();
    h.setLive(true);
    let resolveOld!: (value: ServeWorkspaceSkillsStatus) => void;
    let resolveCurrent!: (value: ServeWorkspaceSkillsStatus) => void;
    h.getWorkspaceSkillsStatus
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCurrent = resolve;
          }),
      );
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const preparation = coordinator.prepare(['skills'], 25);
    await vi.waitFor(() =>
      expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledOnce(),
    );

    h.setLive(false);
    h.setLive(true);
    resolveOld({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source: 'live',
      runtimeEpoch: 1,
      skills: [],
    });
    await preparation;
    await vi.waitFor(() =>
      expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledTimes(2),
    );
    expect(coordinator.status().capabilities.skills).toMatchObject({
      state: 'starting',
      runtimeEpoch: 2,
    });

    resolveCurrent({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source: 'live',
      runtimeEpoch: 2,
      skills: [],
    });
    await vi.waitFor(() => {
      expect(coordinator.status().capabilities.skills).toMatchObject({
        state: 'ready',
        runtimeEpoch: 2,
      });
    });
  });

  it('does not project an error from an old runtime epoch as current', async () => {
    const h = makeRuntime();
    h.getWorkspaceSkillsStatus.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: false,
      source: 'live',
      skills: [],
      errors: [{ kind: 'skill', status: 'error', error: 'skills unavailable' }],
    });
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['skills']);
    expect(coordinator.status().capabilities.skills).toMatchObject({
      state: 'error',
      runtimeEpoch: 1,
    });

    h.setLive(false);
    h.setLive(true);

    expect(coordinator.status()).toMatchObject({
      state: 'idle',
      runtimeEpoch: 2,
      capabilities: {
        skills: { state: 'stale', runtimeEpoch: 1 },
      },
    });
  });

  it('prepares tools and reports the applied extension generation', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    const result = await coordinator.prepare(['tools', 'extensions']);

    expect(h.getWorkspaceToolsStatus).toHaveBeenCalledOnce();
    expect(result.capabilities.tools?.state).toBe('ready');
    expect(result.capabilities.extensions).toMatchObject({
      state: 'ready',
      desiredGeneration: 1,
      appliedGeneration: 1,
      appliedEpoch: 1,
    });
  });

  it('advances extension capability state when reconciliation applies the desired generation', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions']);

    coordinator.setExtensionsDesiredGeneration(2);
    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'stale',
      desiredGeneration: 2,
      appliedGeneration: 1,
    });

    const attempt = coordinator.beginExtensionsReconciliation(2);
    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'starting',
      desiredGeneration: 2,
      appliedGeneration: 1,
    });

    coordinator.setExtensionsAppliedGeneration(2, attempt);
    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'ready',
      desiredGeneration: 2,
      appliedGeneration: 2,
    });
  });

  it('invalidates extension-derived capabilities when the generation advances', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions', 'mcp', 'skills', 'tools']);

    coordinator.setExtensionsDesiredGeneration(2);

    expect(coordinator.status().capabilities).toMatchObject({
      extensions: {
        state: 'stale',
        desiredGeneration: 2,
        appliedGeneration: 1,
      },
      mcp: { state: 'stale' },
      skills: { state: 'stale' },
      tools: { state: 'stale' },
    });
  });

  it('reprepares initialized extension-derived capabilities after reconciliation', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions', 'mcp', 'skills', 'tools']);
    h.getWorkspaceMcpStatus.mockClear();
    h.getWorkspaceSkillsStatus.mockClear();
    h.getWorkspaceToolsStatus.mockClear();

    coordinator.setExtensionsDesiredGeneration(2);
    const attempt = coordinator.beginExtensionsReconciliation(2);
    coordinator.setExtensionsAppliedGeneration(2, attempt);

    await vi.waitFor(() => {
      expect(coordinator.status().capabilities).toMatchObject({
        extensions: { state: 'ready', appliedGeneration: 2 },
        mcp: { state: 'ready' },
        skills: { state: 'ready' },
        tools: { state: 'ready' },
      });
    });
    expect(h.getWorkspaceMcpStatus).toHaveBeenCalledOnce();
    expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledOnce();
    expect(h.getWorkspaceToolsStatus).toHaveBeenCalledOnce();
  });

  it('reconciles Extensions before individually requested derived capabilities', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions', 'mcp', 'skills', 'tools']);
    coordinator.setExtensionsDesiredGeneration(2);
    h.refreshWorkspaceExtensions.mockResolvedValueOnce({
      refreshed: 1,
      failed: 0,
      generation: 2,
      runtimeEpoch: 1,
    });
    h.getWorkspaceMcpStatus.mockClear();
    h.getWorkspaceSkillsStatus.mockClear();
    h.getWorkspaceToolsStatus.mockClear();

    const result = await coordinator.prepare(['mcp', 'skills', 'tools']);

    const refreshOrder =
      h.refreshWorkspaceExtensions.mock.invocationCallOrder.at(-1);
    expect(refreshOrder).toBeDefined();
    expect(h.getWorkspaceMcpStatus.mock.invocationCallOrder[0]).toBeGreaterThan(
      refreshOrder!,
    );
    expect(
      h.getWorkspaceSkillsStatus.mock.invocationCallOrder[0],
    ).toBeGreaterThan(refreshOrder!);
    expect(
      h.getWorkspaceToolsStatus.mock.invocationCallOrder[0],
    ).toBeGreaterThan(refreshOrder!);
    expect(result.capabilities).toMatchObject({
      extensions: {
        state: 'ready',
        desiredGeneration: 2,
        appliedGeneration: 2,
      },
      mcp: { state: 'ready' },
      skills: { state: 'ready' },
      tools: { state: 'ready' },
    });
  });

  it('does not publish a derived Catalog when Extensions cannot converge', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions', 'mcp']);
    coordinator.setExtensionsDesiredGeneration(2);
    h.getWorkspaceMcpStatus.mockClear();

    const result = await coordinator.prepare(['mcp']);

    expect(h.getWorkspaceMcpStatus).not.toHaveBeenCalled();
    expect(result.capabilities).toMatchObject({
      extensions: {
        state: 'error',
        desiredGeneration: 2,
        appliedGeneration: 1,
      },
      mcp: {
        state: 'error',
        error: {
          code: 'mcp_prepare_blocked_by_extensions',
          message: expect.stringContaining(
            'mcp runtime preparation was blocked:',
          ),
        },
      },
    });
  });

  it('continues derived preparation after the Extensions observer times out', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions', 'skills']);
    coordinator.setExtensionsDesiredGeneration(2);
    let finishRefresh!: (value: {
      refreshed: number;
      failed: number;
      generation: number;
      runtimeEpoch: number;
    }) => void;
    h.refreshWorkspaceExtensions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    h.getWorkspaceSkillsStatus.mockClear();

    const result = await coordinator.prepare(['skills'], 10);

    expect(result.capabilities.extensions?.state).toBe('starting');
    expect(h.getWorkspaceSkillsStatus).not.toHaveBeenCalled();
    finishRefresh({
      refreshed: 1,
      failed: 0,
      generation: 2,
      runtimeEpoch: 1,
    });
    await vi.waitFor(() => {
      expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledOnce();
      expect(coordinator.status().capabilities.skills).toMatchObject({
        state: 'ready',
      });
    });
  });

  it('invalidates prepared derived capabilities when extension prepare discovers a newer generation', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['mcp', 'skills', 'tools']);
    h.refreshWorkspaceExtensions.mockResolvedValueOnce({
      refreshed: 1,
      failed: 0,
      generation: 2,
      runtimeEpoch: 1,
    });

    await coordinator.prepare(['extensions']);

    expect(coordinator.status().capabilities).toMatchObject({
      extensions: {
        state: 'ready',
        desiredGeneration: 2,
        appliedGeneration: 2,
      },
      mcp: { state: 'stale' },
      skills: { state: 'stale' },
      tools: { state: 'stale' },
    });
  });

  it('converges extension reconciliation failures and ignores stale generations', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions']);

    coordinator.setExtensionsDesiredGeneration(2);
    const failedAttempt = coordinator.beginExtensionsReconciliation(2);
    coordinator.failExtensionsReconciliation(
      failedAttempt,
      new Error('refresh failed'),
    );
    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'error',
      desiredGeneration: 2,
      appliedGeneration: 1,
      error: {
        code: 'extensions_reconcile_failed',
        message: 'refresh failed',
      },
    });

    coordinator.setExtensionsDesiredGeneration(3);
    coordinator.failExtensionsReconciliation(
      failedAttempt,
      new Error('late failure'),
    );
    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'stale',
      desiredGeneration: 3,
      appliedGeneration: 1,
    });

    const recoveredAttempt = coordinator.beginExtensionsReconciliation(3);
    coordinator.setExtensionsAppliedGeneration(3, recoveredAttempt);
    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'ready',
      desiredGeneration: 3,
      appliedGeneration: 3,
    });
  });

  it('projects a failed extension reconciliation as stale after the runtime exits', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions']);

    coordinator.setExtensionsDesiredGeneration(2);
    const attempt = coordinator.beginExtensionsReconciliation(2);
    h.setLive(false);
    coordinator.failExtensionsReconciliation(
      attempt,
      new Error('channel exited'),
    );

    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'stale',
      desiredGeneration: 2,
      appliedGeneration: 1,
    });
  });

  it('ignores extension reconciliation completions from a previous runtime epoch', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions']);
    coordinator.setExtensionsDesiredGeneration(2);
    const oldAttempt = coordinator.beginExtensionsReconciliation(2);

    h.setLive(false);
    h.setLive(true);
    coordinator.failExtensionsReconciliation(oldAttempt, new Error('late'));
    coordinator.setExtensionsAppliedGeneration(2, oldAttempt);

    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'stale',
      desiredGeneration: 2,
      appliedGeneration: 1,
      runtimeEpoch: 1,
      appliedEpoch: 1,
    });
  });

  it('keeps the applied extension epoch while a replacement epoch reconciles', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions']);
    h.setLive(false);
    h.setLive(true);
    coordinator.setExtensionsDesiredGeneration(2);

    const attempt = coordinator.beginExtensionsReconciliation(2);
    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'starting',
      runtimeEpoch: 2,
      desiredGeneration: 2,
      appliedGeneration: 1,
      appliedEpoch: 1,
    });

    coordinator.failExtensionsReconciliation(attempt, new Error('failed'));
    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'error',
      runtimeEpoch: 2,
      appliedGeneration: 1,
      appliedEpoch: 1,
    });
  });

  it('does not let an older same-generation failure overwrite a newer success', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions']);
    coordinator.setExtensionsDesiredGeneration(2);
    const older = coordinator.beginExtensionsReconciliation(2);
    const newer = coordinator.beginExtensionsReconciliation(2);

    coordinator.setExtensionsAppliedGeneration(2, newer);
    coordinator.failExtensionsReconciliation(older, new Error('late failure'));

    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'ready',
      desiredGeneration: 2,
      appliedGeneration: 2,
    });
  });

  it('does not let an older prepare failure overwrite a newer reconciliation', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions']);
    coordinator.setExtensionsDesiredGeneration(2);
    let rejectPrepare!: (error: Error) => void;
    h.refreshWorkspaceExtensions.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPrepare = reject;
        }),
    );

    const preparation = coordinator.prepare(['extensions']);
    await vi.waitFor(() =>
      expect(h.refreshWorkspaceExtensions).toHaveBeenCalledTimes(2),
    );
    const newer = coordinator.beginExtensionsReconciliation(2);
    coordinator.setExtensionsAppliedGeneration(2, newer);
    rejectPrepare(new Error('late prepare failure'));
    await preparation;

    expect(coordinator.status().capabilities.extensions).toMatchObject({
      state: 'ready',
      desiredGeneration: 2,
      appliedGeneration: 2,
      appliedEpoch: 1,
    });
  });

  it('does not call an unprepared derived capability stale', () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    expect(coordinator.reconcileMcpConfiguration()).toBe('deferred');

    coordinator.setExtensionsDesiredGeneration(2);

    expect(coordinator.status().capabilities.mcp).toMatchObject({
      state: 'not_started',
    });
  });

  it('keeps repeated cold configuration changes not started', () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    expect(coordinator.reconcileMcpConfiguration()).toBe('deferred');
    expect(coordinator.reconcileMcpConfiguration()).toBe('deferred');
    expect(coordinator.reconcileSkillsConfiguration()).toBe('deferred');
    expect(coordinator.reconcileSkillsConfiguration()).toBe('deferred');

    expect(coordinator.status().capabilities).toMatchObject({
      mcp: { state: 'not_started' },
      skills: { state: 'not_started' },
    });
  });

  it('queues a new prepare behind an invalidated physical attempt', async () => {
    const h = makeRuntime();
    h.setLive(true);
    let finishOldPrepare!: (value: ServeWorkspaceSkillsStatus) => void;
    h.getWorkspaceSkillsStatus
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldPrepare = resolve;
          }),
      )
      .mockResolvedValue({
        v: 1,
        workspaceCwd: '/workspace',
        initialized: true,
        source: 'live',
        runtimeEpoch: 1,
        skills: [],
      });
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const oldPrepare = coordinator.prepare(['skills']);
    await vi.waitFor(() =>
      expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledOnce(),
    );

    coordinator.setExtensionsDesiredGeneration(2);
    h.refreshWorkspaceExtensions.mockResolvedValueOnce({
      refreshed: 1,
      failed: 0,
      generation: 2,
      runtimeEpoch: 1,
    });
    const newPrepare = coordinator.prepare(['skills']);
    expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledOnce();

    finishOldPrepare({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source: 'live',
      runtimeEpoch: 1,
      skills: [],
    });
    await expect(newPrepare).resolves.toMatchObject({
      capabilities: { skills: { state: 'ready' } },
    });
    expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledTimes(2);

    await oldPrepare;
    expect(coordinator.status().capabilities.skills?.state).toBe('ready');
  });

  it('waits for a detached physical lease before capability work', async () => {
    const h = makeRuntime();
    h.setLive(true);
    let releasePhysical!: () => void;
    const physical = new Promise<void>((resolve) => {
      releasePhysical = resolve;
    });
    const waitForWorkspacePhysicalRequests = vi.fn(async () => {
      await physical;
    });
    Object.assign(h.runtime.bridge, { waitForWorkspacePhysicalRequests });
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const run = vi.fn(async () => 'done');

    const reconciliation = coordinator.runExtensionsPhysicalReconciliation(run);
    await vi.waitFor(() => {
      expect(waitForWorkspacePhysicalRequests).toHaveBeenCalledWith(
        'extensions',
      );
    });
    expect(run).not.toHaveBeenCalled();

    releasePhysical();
    await expect(reconciliation).resolves.toBe('done');
    expect(run).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it('keeps a later MCP mutation behind a timed-out raw physical request', async () => {
    const h = makeRuntime();
    h.setLive(true);
    let detachedPhysicalRequest = false;
    let releasePhysical!: () => void;
    const physical = new Promise<void>((resolve) => {
      releasePhysical = resolve;
    });
    const waitForWorkspacePhysicalRequests = vi.fn(
      async (capability: ServeWorkspaceRuntimeCapability) => {
        if (capability === 'mcp' && detachedPhysicalRequest) {
          await physical;
        }
      },
    );
    Object.assign(h.runtime.bridge, { waitForWorkspacePhysicalRequests });
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    await expect(
      coordinator.runMcpRuntimeMutation(async () => {
        detachedPhysicalRequest = true;
        throw new Error('observer timed out');
      }),
    ).rejects.toThrow('observer timed out');

    const secondRun = vi.fn(async () => 'done');
    const second = coordinator.runMcpRuntimeMutation(secondRun);
    await vi.waitFor(() => {
      expect(waitForWorkspacePhysicalRequests).toHaveBeenLastCalledWith('mcp');
    });
    expect(secondRun).not.toHaveBeenCalled();

    releasePhysical();
    await expect(second).resolves.toBe('done');
    expect(secondRun).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it('does not downgrade the desired extension generation to a stale runtime result', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    await coordinator.prepare(['extensions']);
    coordinator.setExtensionsDesiredGeneration(2);

    const result = await coordinator.prepare(['extensions']);

    expect(result.capabilities.extensions).toMatchObject({
      state: 'error',
      desiredGeneration: 2,
      appliedGeneration: 1,
      error: {
        code: 'extensions_prepare_failed',
        message: 'Extensions runtime applied generation 1, expected at least 2',
      },
    });
  });

  it('retries capability preparation after a timed-out background preheat', async () => {
    const h = makeRuntime();
    h.preheatAcpChild.mockResolvedValueOnce({
      ready: false,
      channelLive: false,
      durationMs: 1,
      reason: 'timeout',
      backgroundInProgress: true,
    } as never);
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    const result = await coordinator.prepare(['skills']);

    expect(result.state).toBe('idle');
    expect(result.capabilities.skills).toMatchObject({ state: 'ready' });
    expect(result.capabilities.skills?.error).toBeUndefined();
    expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledOnce();
  });

  it('stops background preparation at one absolute deadline', async () => {
    vi.useFakeTimers();
    try {
      const h = makeRuntime();
      h.preheatAcpChild.mockResolvedValue({
        ready: false,
        channelLive: false,
        durationMs: 1,
        reason: 'timeout',
        backgroundInProgress: true,
      } as never);
      const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

      const preparation = coordinator.prepare(['skills'], 10);
      await vi.advanceTimersByTimeAsync(10);
      const initial = await preparation;
      expect(initial.capabilities.skills?.state).toBe('starting');

      await vi.advanceTimersByTimeAsync(120_000);

      expect(coordinator.status().capabilities.skills).toMatchObject({
        state: 'error',
        error: {
          code: 'skills_prepare_timed_out',
          message: 'skills runtime preparation timed out',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one end-to-end deadline and completes MCP preparation in the background', async () => {
    vi.useFakeTimers();
    try {
      const h = makeRuntime();
      let discoveryCompleted = false;
      h.preheatAcpChild.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              h.setLive(true);
              resolve({ ready: true, channelLive: true, durationMs: 40 });
            }, 40);
          }),
      );
      h.getWorkspaceMcpStatus.mockImplementation(async () =>
        discoveryCompleted
          ? ({
              v: 1,
              workspaceCwd: '/workspace',
              initialized: true,
              source: 'live',
              runtimeEpoch: 1,
              discoveryState: 'completed',
              servers: [],
            } as never)
          : ({
              v: 1,
              workspaceCwd: '/workspace',
              initialized: true,
              source: 'live',
              runtimeEpoch: 1,
              discoveryState: 'in_progress',
              servers: [],
            } as never),
      );
      let activeRuntimeControls = 0;
      h.runtime.bridge.withWorkspaceRuntimeControl = vi.fn(async (run) => {
        activeRuntimeControls += 1;
        try {
          if (!h.runtime.bridge.isChannelLive()) {
            await h.preheatAcpChild();
          }
          return await run(h.runtime.bridge.getRuntimeEpoch?.() ?? 0);
        } finally {
          activeRuntimeControls -= 1;
        }
      });
      const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
      let settled = false;

      const preparation = coordinator.prepare(['mcp'], 50).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await preparation;

      expect(result.capabilities.mcp).toMatchObject({ state: 'starting' });
      expect(activeRuntimeControls).toBe(1);
      discoveryCompleted = true;
      await vi.advanceTimersByTimeAsync(250);
      expect(coordinator.status().capabilities.mcp).toMatchObject({
        state: 'ready',
      });
      expect(activeRuntimeControls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report cached MCP discovery as ready for the current runtime', async () => {
    const h = makeRuntime();
    let source: 'cache' | 'live' = 'cache';
    h.getWorkspaceMcpStatus.mockImplementation(async () => ({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source,
      runtimeEpoch: 1,
      discoveryState: 'completed',
      servers: [],
    }));
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    const result = await coordinator.prepare(['mcp'], 10);
    expect(result.capabilities.mcp).toMatchObject({ state: 'starting' });

    source = 'live';
    await vi.waitFor(() => {
      expect(coordinator.status().capabilities.mcp).toMatchObject({
        state: 'ready',
      });
    });
  });

  it('reconciles committed MCP configuration in the background only for a live runtime', async () => {
    const cold = makeRuntime();
    const coldCoordinator = new WorkspaceRuntimeCoordinator(cold.runtime);
    expect(coldCoordinator.reconcileMcpConfiguration()).toBe('deferred');
    expect(cold.reloadWorkspaceMcp).not.toHaveBeenCalled();

    const live = makeRuntime();
    live.setLive(true);
    let finishReload!: (value: { accepted: boolean }) => void;
    live.reloadWorkspaceMcp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReload = resolve;
        }),
    );
    const coordinator = new WorkspaceRuntimeCoordinator(live.runtime);

    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');
    expect(coordinator.status().capabilities.mcp).toMatchObject({
      state: 'starting',
    });
    await vi.waitFor(() => expect(live.reloadWorkspaceMcp).toHaveBeenCalled());
    finishReload({ accepted: true });
    await vi.waitFor(() => {
      expect(coordinator.status().capabilities.mcp).toMatchObject({
        state: 'ready',
      });
    });
  });

  it('applies a newer MCP configuration after an older queued runtime mutation', async () => {
    const h = makeRuntime();
    h.setLive(true);
    let finishFirst!: () => void;
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const first = coordinator.runMcpRuntimeMutation(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    const second = coordinator.runMcpRuntimeMutation(async () => undefined);

    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');
    finishFirst();

    await Promise.all([first, second]);
    await vi.waitFor(() => expect(h.reloadWorkspaceMcp).toHaveBeenCalledOnce());
  });

  it('applies queued MCP configuration before a later runtime mutation', async () => {
    const h = makeRuntime();
    h.setLive(true);
    let finishFirst!: () => void;
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const first = coordinator.runMcpRuntimeMutation(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));

    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');
    const later = coordinator.runMcpRuntimeMutation(async () => undefined);
    finishFirst();

    await Promise.all([first, later]);
    await vi.waitFor(() => expect(h.reloadWorkspaceMcp).toHaveBeenCalledOnce());
  });

  it('does not reload MCP after a queued reconciliation loses its runtime epoch', async () => {
    const h = makeRuntime();
    h.setLive(true);
    let finishMutation!: () => void;
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const mutation = coordinator.runMcpRuntimeMutation(
      async () =>
        await new Promise<void>((resolve) => {
          finishMutation = resolve;
        }),
    );
    await vi.waitFor(() => expect(finishMutation).toBeTypeOf('function'));

    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');
    h.setLive(false);
    h.setLive(true);
    finishMutation();

    await expect(mutation).rejects.toBeInstanceOf(Error);
    await coordinator.prepare(['mcp']);
    expect(h.reloadWorkspaceMcp).not.toHaveBeenCalled();
  });

  it('reconciles committed Skills configuration without starting a cold runtime', async () => {
    const cold = makeRuntime();
    const coldCoordinator = new WorkspaceRuntimeCoordinator(cold.runtime);
    expect(coldCoordinator.reconcileSkillsConfiguration()).toBe('deferred');
    expect(cold.invokeWorkspaceCommand).not.toHaveBeenCalled();

    const live = makeRuntime();
    live.setLive(true);
    const coordinator = new WorkspaceRuntimeCoordinator(live.runtime);
    expect(coordinator.reconcileSkillsConfiguration()).toBe('reconciling');

    await vi.waitFor(() => {
      expect(live.invokeWorkspaceCommand).toHaveBeenCalledWith(
        'qwen/control/workspace/skills/refresh',
        { cwd: '/workspace' },
      );
      expect(coordinator.status().capabilities.skills).toMatchObject({
        state: 'ready',
      });
    });
  });

  it('does not refresh Skills after a queued reconciliation loses its runtime epoch', async () => {
    const h = makeRuntime();
    h.setLive(true);
    let finishPreparation!: (value: ServeWorkspaceSkillsStatus) => void;
    h.getWorkspaceSkillsStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const preparation = coordinator.prepare(['skills']);
    await vi.waitFor(() =>
      expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledOnce(),
    );

    expect(coordinator.reconcileSkillsConfiguration()).toBe('reconciling');
    h.setLive(false);
    h.setLive(true);
    finishPreparation({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source: 'live',
      runtimeEpoch: 1,
      skills: [],
    });

    await preparation;
    await coordinator.prepare(['skills']);
    expect(h.invokeWorkspaceCommand).not.toHaveBeenCalled();
  });

  it('preserves a queued Skills refresh across extension generation changes', async () => {
    const h = makeRuntime();
    h.setLive(true);
    let finishPreparation!: (value: ServeWorkspaceSkillsStatus) => void;
    h.getWorkspaceSkillsStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const preparation = coordinator.prepare(['skills']);
    await vi.waitFor(() =>
      expect(h.getWorkspaceSkillsStatus).toHaveBeenCalledOnce(),
    );

    expect(coordinator.reconcileSkillsConfiguration()).toBe('reconciling');
    coordinator.setExtensionsDesiredGeneration(2);
    finishPreparation({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source: 'live',
      runtimeEpoch: 1,
      skills: [],
    });

    await preparation;
    await vi.waitFor(() => {
      expect(h.invokeWorkspaceCommand).toHaveBeenCalledWith(
        'qwen/control/workspace/skills/refresh',
        { cwd: '/workspace' },
      );
    });
  });

  it('serializes MCP runtime mutations through one workspace lane', async () => {
    const h = makeRuntime();
    h.setLive(true);
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const events: string[] = [];
    let activeMutations = 0;
    let maxActiveMutations = 0;
    let finishFirst!: () => void;
    const enter = (name: string) => {
      activeMutations += 1;
      maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
      events.push(`${name}:start`);
    };
    const leave = (name: string) => {
      events.push(`${name}:end`);
      activeMutations -= 1;
    };

    const first = coordinator.runMcpRuntimeMutation(async () => {
      enter('first');
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      leave('first');
      return 'first';
    });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));
    const second = coordinator.runMcpRuntimeMutation(async () => {
      enter('second');
      leave('second');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    finishFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      'first',
      'second',
    ]);
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
    expect(maxActiveMutations).toBe(1);
  });

  it('rejects a queued MCP mutation when drain starts before physical execution', async () => {
    const h = makeRuntime();
    h.setLive(true);
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    let finishFirst!: () => void;
    const first = coordinator.runMcpRuntimeMutation(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));

    const secondRun = vi.fn(async () => undefined);
    const second = coordinator
      .runMcpRuntimeMutation(secondRun)
      .catch((error: unknown) => error);
    coordinator.beginDrain();
    finishFirst();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toMatchObject({ code: 'workspace_draining' });
    expect(secondRun).not.toHaveBeenCalled();
  });

  it('rejects a queued MCP operation when drain starts before physical execution', async () => {
    const h = makeRuntime();
    h.setLive(true);
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    let finishMutation!: () => void;
    const mutation = coordinator.runMcpRuntimeMutation(
      () =>
        new Promise<void>((resolve) => {
          finishMutation = resolve;
        }),
    );
    await vi.waitFor(() => expect(finishMutation).toBeTypeOf('function'));

    const operationRun = vi.fn(async () => ({}));
    const operation = coordinator
      .runMcpOperation('docs', 'approve', operationRun)
      .catch((error: unknown) => error);
    coordinator.beginDrain();
    finishMutation();

    await expect(mutation).resolves.toBeUndefined();
    await expect(operation).resolves.toMatchObject({
      code: 'workspace_draining',
    });
    expect(operationRun).not.toHaveBeenCalled();
  });

  it('keeps a superseding MCP prepare behind the invalidated physical mutation', async () => {
    const h = makeRuntime();
    h.setLive(true);
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    let finishMutation!: () => void;
    const mutation = coordinator.runMcpRuntimeMutation(
      () =>
        new Promise<void>((resolve) => {
          finishMutation = resolve;
        }),
    );
    await vi.waitFor(() => expect(finishMutation).toBeTypeOf('function'));

    coordinator.setExtensionsDesiredGeneration(2);
    h.refreshWorkspaceExtensions.mockResolvedValueOnce({
      refreshed: 1,
      failed: 0,
      generation: 2,
      runtimeEpoch: 1,
    });
    const preparation = coordinator.prepare(['mcp']);
    await Promise.resolve();
    expect(h.getWorkspaceMcpStatus).not.toHaveBeenCalled();

    finishMutation();
    await mutation;
    await preparation;
    expect(h.getWorkspaceMcpStatus).toHaveBeenCalledOnce();
    expect(coordinator.status().capabilities.mcp).toMatchObject({
      state: 'ready',
    });
  });

  it('fails Skills reconciliation when any live session refresh fails', async () => {
    const h = makeRuntime();
    h.setLive(true);
    h.invokeWorkspaceCommand.mockResolvedValueOnce({
      sessionsRefreshed: 1,
      sessionsFailed: 1,
    });
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    expect(coordinator.reconcileSkillsConfiguration()).toBe('reconciling');

    await vi.waitFor(() => {
      expect(coordinator.status().capabilities.skills).toMatchObject({
        state: 'error',
        error: {
          code: 'skills_reconcile_failed',
          message: '1 session skill refresh(es) failed',
        },
      });
    });
    expect(h.getWorkspaceSkillsStatus).not.toHaveBeenCalled();
  });

  it('preserves JSON-RPC messages in capability and operation errors', async () => {
    const h = makeRuntime();
    h.setLive(true);
    h.invokeWorkspaceCommand.mockRejectedValueOnce({
      code: -32603,
      message: 'Skill refresh failed',
    });
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    expect(coordinator.reconcileSkillsConfiguration()).toBe('reconciling');
    await vi.waitFor(() => {
      expect(coordinator.status().capabilities.skills).toMatchObject({
        state: 'error',
        error: {
          code: 'skills_reconcile_failed',
          message: 'Skill refresh failed',
        },
      });
    });

    let operationId: string | undefined;
    await expect(
      coordinator.runMcpOperation('docs', 'enable', async (id) => {
        operationId = id;
        throw { code: -32603, message: 'MCP mutation failed' };
      }),
    ).rejects.toEqual({ code: -32603, message: 'MCP mutation failed' });
    expect(operationId).toBeDefined();
    expect(coordinator.operationStatus(operationId!)).toMatchObject({
      state: 'failed',
      error: {
        code: 'mcp_operation_failed',
        message: 'MCP mutation failed',
      },
    });
  });

  it('bounds retained terminal operation history', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const first = await coordinator.runMcpOperation(
      'docs',
      'enable',
      async () => ({}),
    );

    for (let index = 0; index < 100; index++) {
      await coordinator.runMcpOperation('docs', 'enable', async () => ({}));
    }

    expect(coordinator.operationStatus(first.operationId)).toBeUndefined();
  });

  it('passes operation ids to MCP and rejects overlapping target operations', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    let dispatchedOperationId: string | undefined;

    const first = await coordinator.runMcpOperation(
      'docs',
      'authenticate',
      async (operationId) => {
        dispatchedOperationId = operationId;
        return { pending: true };
      },
    );

    expect(dispatchedOperationId).toBe(first.operationId);
    await expect(
      coordinator.runMcpOperation('docs', 'authenticate', async () => ({})),
    ).rejects.toThrow('already has active operation');
    coordinator.dispose();
  });

  it('exposes only active MCP operations and returns the recorded OAuth deadline', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    let finishOperation!: () => void;
    const running = coordinator.runMcpOperation('docs', 'approve', async () => {
      await new Promise<void>((resolve) => {
        finishOperation = resolve;
      });
      return {};
    });

    await vi.waitFor(() => expect(finishOperation).toBeTypeOf('function'));
    expect(coordinator.activeOperations()).toMatchObject([
      { action: 'approve', target: 'docs', state: 'running' },
    ]);

    finishOperation();
    const completed = await running;
    expect(coordinator.activeOperations()).toEqual([]);
    expect(coordinator.operationStatus(completed.operationId)).toMatchObject({
      state: 'succeeded',
    });

    const authentication = await coordinator.runMcpOperation(
      'docs',
      'authenticate',
      async () => ({ pending: true, authUrl: 'https://auth.example/start' }),
    );
    expect(authentication.deadlineAt).toEqual(expect.any(String));
    expect(coordinator.activeOperations()).toMatchObject([
      {
        operationId: authentication.operationId,
        action: 'authenticate',
        target: 'docs',
        state: 'waiting_for_input',
        deadlineAt: authentication.deadlineAt,
        authUrl: 'https://auth.example/start',
      },
    ]);
    expect(
      coordinator.operationStatus(authentication.operationId),
    ).toMatchObject({
      deadlineAt: authentication.deadlineAt,
      authUrl: 'https://auth.example/start',
    });
    coordinator.dispose();
  });

  it('serializes OAuth authentication across workspace runtimes', async () => {
    const firstRuntime = makeRuntime('/workspace-a');
    firstRuntime.setLive(true);
    const first = new WorkspaceRuntimeCoordinator(firstRuntime.runtime);
    const second = new WorkspaceRuntimeCoordinator(
      makeRuntime('/workspace-b').runtime,
    );
    try {
      await first.runMcpOperation('docs', 'authenticate', async () => ({
        pending: true,
      }));
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({
          pending: true,
        })),
      ).rejects.toMatchObject({
        code: 'mcp_authentication_lane_busy',
        message:
          'Another MCP authentication is already in progress in this daemon',
      });

      first.dispose();
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).rejects.toMatchObject({ code: 'mcp_authentication_lane_busy' });

      firstRuntime.setLive(false);
      first.completeDisposeAfterBridgeShutdown();
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).resolves.toMatchObject({ operationId: expect.any(String) });
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('releases the global OAuth lane after the owning runtime exits', async () => {
    const firstRuntime = makeRuntime('/workspace-a');
    firstRuntime.setLive(true);
    const first = new WorkspaceRuntimeCoordinator(firstRuntime.runtime);
    const second = new WorkspaceRuntimeCoordinator(
      makeRuntime('/workspace-b').runtime,
    );
    try {
      const operation = await first.runMcpOperation(
        'docs',
        'authenticate',
        async () => ({ pending: true }),
      );

      firstRuntime.setLive(false);
      await vi.waitFor(() => {
        expect(first.operationStatus(operation.operationId)).toMatchObject({
          state: 'failed',
          error: { code: 'mcp_authentication_runtime_unavailable' },
        });
      });
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).resolves.toMatchObject({ operationId: expect.any(String) });
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('keeps the OAuth lane when entry fails while ACP still owns authentication', async () => {
    vi.useFakeTimers();
    const firstRuntime = makeRuntime('/workspace-a');
    firstRuntime.setLive(true);
    let physicalPending = true;
    Object.assign(firstRuntime.runtime.bridge, {
      isWorkspaceMcpAuthenticationPending: () => physicalPending,
    });
    const first = new WorkspaceRuntimeCoordinator(firstRuntime.runtime);
    const second = new WorkspaceRuntimeCoordinator(
      makeRuntime('/workspace-b').runtime,
    );
    try {
      await expect(
        first.runMcpOperation('docs', 'authenticate', async () => {
          throw new Error('OAuth URL start timed out');
        }),
      ).rejects.toThrow('OAuth URL start timed out');
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).rejects.toThrow('already in progress');

      physicalPending = false;
      await vi.advanceTimersByTimeAsync(250);
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).resolves.toMatchObject({ operationId: expect.any(String) });
    } finally {
      first.dispose();
      second.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps timed-out OAuth non-terminal until ACP releases the provider', async () => {
    vi.useFakeTimers();
    const firstRuntime = makeRuntime('/workspace-a');
    firstRuntime.setLive(true);
    let pending = true;
    firstRuntime.getWorkspaceMcpStatus.mockImplementation(async () => ({
      v: 1,
      workspaceCwd: '/workspace-a',
      initialized: true,
      source: 'live',
      runtimeEpoch: 1,
      discoveryState: 'completed',
      servers: [
        {
          kind: 'mcp_server',
          name: 'docs',
          status: 'ok',
          mcpStatus: 'connected',
          transport: 'stdio',
          disabled: false,
          authenticationState: pending ? 'pending' : 'succeeded',
        },
      ],
    }));
    const first = new WorkspaceRuntimeCoordinator(firstRuntime.runtime);
    const second = new WorkspaceRuntimeCoordinator(
      makeRuntime('/workspace-b').runtime,
    );
    try {
      const operation = await first.runMcpOperation(
        'docs',
        'authenticate',
        async () => ({ pending: true }),
      );

      await vi.advanceTimersByTimeAsync(10 * 60_000 + 250);
      expect(first.operationStatus(operation.operationId)).toMatchObject({
        state: 'waiting_for_input',
      });
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).rejects.toThrow('already in progress');

      pending = false;
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => {
        expect(first.operationStatus(operation.operationId)).toMatchObject({
          state: 'failed',
          error: { code: 'mcp_authentication_timeout' },
        });
      });
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).resolves.toMatchObject({ operationId: expect.any(String) });
    } finally {
      first.dispose();
      second.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps MCP configuration activation behind the physical OAuth lease', async () => {
    const h = makeRuntime();
    h.setLive(true);
    let physicalPending = true;
    Object.assign(h.runtime.bridge, {
      isWorkspaceMcpAuthenticationPending: () => physicalPending,
    });
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    try {
      const authentication = await coordinator.runMcpOperation(
        'docs',
        'authenticate',
        async () => ({ pending: true, runtimeEpoch: 1 }),
      );

      expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(h.reloadWorkspaceMcp).not.toHaveBeenCalled();

      physicalPending = false;
      await vi.waitFor(
        () => {
          expect(h.reloadWorkspaceMcp).toHaveBeenCalledOnce();
          expect(
            coordinator.operationStatus(authentication.operationId),
          ).toMatchObject({
            state: 'failed',
            error: { code: 'mcp_server_not_found' },
          });
        },
        { timeout: 2000 },
      );
    } finally {
      coordinator.dispose();
    }
  });

  it('runs a queued MCP reconciliation before a later OAuth operation', async () => {
    const h = makeRuntime();
    h.setLive(true);
    const calls: string[] = [];
    h.reloadWorkspaceMcp.mockImplementationOnce(async () => {
      calls.push('reload');
      return { accepted: true };
    });
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    try {
      expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');
      await Promise.resolve();
      await Promise.resolve();
      const authentication = coordinator.runMcpOperation(
        'docs',
        'authenticate',
        async () => {
          calls.push('authenticate');
          return {};
        },
      );

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            authentication,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error('MCP physical lane deadlocked')),
                500,
              );
            }),
          ]),
        ).resolves.toMatchObject({ operationId: expect.any(String) });
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      expect(calls).toEqual(['reload', 'authenticate']);
    } finally {
      coordinator.dispose();
    }
  });

  it('keeps the OAuth lane after the entry deadline until the physical request and provider settle', async () => {
    vi.useFakeTimers();
    const firstRuntime = makeRuntime('/workspace-a');
    firstRuntime.setLive(true);
    let pending = true;
    firstRuntime.getWorkspaceMcpStatus.mockImplementation(async () => ({
      v: 1,
      workspaceCwd: '/workspace-a',
      initialized: true,
      source: 'live',
      runtimeEpoch: 1,
      discoveryState: 'completed',
      servers: [
        {
          kind: 'mcp_server',
          name: 'docs',
          status: 'ok',
          mcpStatus: 'connected',
          transport: 'stdio',
          disabled: false,
          authenticationState: pending ? 'pending' : 'succeeded',
        },
      ],
    }));
    const first = new WorkspaceRuntimeCoordinator(firstRuntime.runtime);
    const second = new WorkspaceRuntimeCoordinator(
      makeRuntime('/workspace-b').runtime,
    );
    try {
      let operationId: string | undefined;
      let finishPhysicalRequest!: (value: {
        pending: boolean;
        runtimeEpoch: number;
      }) => void;
      const authentication = first.runMcpOperation(
        'docs',
        'authenticate',
        async (id) => {
          operationId = id;
          return await new Promise<{
            pending: boolean;
            runtimeEpoch: number;
          }>((resolve) => {
            finishPhysicalRequest = resolve;
          });
        },
      );
      const timedOut = authentication.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await expect(timedOut).resolves.toMatchObject({
        message: 'MCP authentication timed out',
      });
      expect(operationId).toBeDefined();
      expect(first.operationStatus(operationId!)).toMatchObject({
        state: 'waiting_for_input',
      });
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).rejects.toThrow('already in progress');

      finishPhysicalRequest({ pending: true, runtimeEpoch: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(first.operationStatus(operationId!)).toMatchObject({
        state: 'waiting_for_input',
      });
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).rejects.toThrow('already in progress');

      pending = false;
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => {
        expect(first.operationStatus(operationId!)).toMatchObject({
          state: 'failed',
          error: { code: 'mcp_authentication_timeout' },
        });
      });
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).resolves.toMatchObject({ operationId: expect.any(String) });
    } finally {
      first.dispose();
      second.dispose();
      vi.useRealTimers();
    }
  });

  it('does not let a replacement runtime epoch complete an old OAuth operation', async () => {
    vi.useFakeTimers();
    const h = makeRuntime();
    h.setLive(true);
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    try {
      const operation = await coordinator.runMcpOperation(
        'docs',
        'authenticate',
        async () => ({ pending: true }),
      );

      h.setLive(false);
      h.setLive(true);
      await vi.advanceTimersByTimeAsync(250);

      expect(coordinator.operationStatus(operation.operationId)).toMatchObject({
        state: 'failed',
        error: { code: 'mcp_authentication_runtime_unavailable' },
      });
    } finally {
      coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it('rejects new runtime work while draining and resumes after rollback', async () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    coordinator.beginDrain();

    const rejected = coordinator.prepare(['skills']);
    await expect(rejected).rejects.toBeInstanceOf(WorkspaceDrainingError);
    await expect(rejected).rejects.toMatchObject({
      code: 'workspace_draining',
      workspaceCwd: '/workspace',
    });
    await expect(
      coordinator.runMcpOperation('docs', 'approve', async () => ({})),
    ).rejects.toMatchObject({ code: 'workspace_draining' });
    expect(coordinator.reconcileMcpConfiguration()).toBe('deferred');
    expect(h.reloadWorkspaceMcp).not.toHaveBeenCalled();

    coordinator.cancelDrain();
    await expect(coordinator.prepare(['skills'])).resolves.toMatchObject({
      capabilities: { skills: { state: 'ready' } },
    });
  });

  it('counts admitted management operations as runtime work', () => {
    const h = makeRuntime();
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const release = coordinator.acquireManagementOperation();

    expect(coordinator.hasActiveWork()).toBe(true);
    coordinator.beginDrain();
    expect(() => coordinator.acquireManagementOperation()).toThrow(
      WorkspaceDrainingError,
    );

    release();
    release();
    expect(coordinator.hasActiveWork()).toBe(false);
  });

  it('replays deferred MCP configuration after drain rollback', async () => {
    const h = makeRuntime();
    h.setLive(true);
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    coordinator.beginDrain();

    expect(coordinator.reconcileMcpConfiguration()).toBe('deferred');
    expect(h.reloadWorkspaceMcp).not.toHaveBeenCalled();

    coordinator.cancelDrain();
    await expect(coordinator.prepare(['mcp'])).resolves.toMatchObject({
      capabilities: { mcp: { state: 'ready' } },
    });
    expect(h.reloadWorkspaceMcp).toHaveBeenCalledOnce();
  });

  it('defers a queued MCP reconciliation when drain starts before it runs', async () => {
    const h = makeRuntime();
    h.setLive(true);
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    let finishMutation!: () => void;
    const mutation = coordinator.runMcpRuntimeMutation(
      () =>
        new Promise<void>((resolve) => {
          finishMutation = resolve;
        }),
    );
    await vi.waitFor(() => expect(finishMutation).toBeTypeOf('function'));

    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');
    coordinator.beginDrain();
    finishMutation();
    await mutation;
    await vi.waitFor(() => {
      expect(coordinator.status().capabilities.mcp).toMatchObject({
        state: 'stale',
      });
    });
    expect(h.reloadWorkspaceMcp).not.toHaveBeenCalled();

    coordinator.cancelDrain();
    await vi.waitFor(() => expect(h.reloadWorkspaceMcp).toHaveBeenCalledOnce());
  });

  it('retries a failed drain-rollback reconciliation during prepare', async () => {
    const h = makeRuntime();
    h.setLive(true);
    h.reloadWorkspaceMcp.mockRejectedValueOnce(new Error('reload failed'));
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    coordinator.beginDrain();
    expect(coordinator.reconcileMcpConfiguration()).toBe('deferred');

    coordinator.cancelDrain();
    await vi.waitFor(() => {
      expect(coordinator.status().capabilities.mcp).toMatchObject({
        state: 'error',
        error: { message: 'reload failed' },
      });
    });

    await expect(coordinator.prepare(['mcp'])).resolves.toMatchObject({
      capabilities: { mcp: { state: 'ready' } },
    });
    expect(h.reloadWorkspaceMcp).toHaveBeenCalledTimes(2);
  });

  it('releases the local barrier on dispose but holds the OAuth lane until bridge shutdown', async () => {
    const h = makeRuntime();
    h.setLive(true);
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);
    const second = new WorkspaceRuntimeCoordinator(
      makeRuntime('/workspace-b').runtime,
    );
    try {
      await coordinator.runMcpOperation('docs', 'authenticate', async () => ({
        pending: true,
      }));
      expect(coordinator.hasActiveWork()).toBe(true);

      const queued = coordinator.runMcpRuntimeMutation(async () => ({}));
      coordinator.dispose();

      expect(coordinator.hasActiveWork()).toBe(false);
      await expect(queued).rejects.toThrow('Workspace runtime was disposed');
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).rejects.toMatchObject({ code: 'mcp_authentication_lane_busy' });

      h.setLive(false);
      coordinator.completeDisposeAfterBridgeShutdown();
      await expect(
        second.runMcpOperation('calendar', 'authenticate', async () => ({})),
      ).resolves.toMatchObject({ operationId: expect.any(String) });
    } finally {
      coordinator.dispose();
      second.dispose();
    }
  });

  it('does not deadlock when epoch flips during a physical lane reconciliation', async () => {
    const h = makeRuntime();
    h.setLive(true);
    let finishMcpStatus!: (value: ServeWorkspaceMcpStatus) => void;
    h.getWorkspaceMcpStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishMcpStatus = resolve;
        }),
    );
    const coordinator = new WorkspaceRuntimeCoordinator(h.runtime);

    expect(coordinator.reconcileMcpConfiguration()).toBe('reconciling');
    await vi.waitFor(() =>
      expect(h.getWorkspaceMcpStatus).toHaveBeenCalledOnce(),
    );

    // Flip the epoch while the physical lane is blocked in prepareMcp.
    // Before the fix, resumeCapabilityInBackground awaited inside the
    // lane re-acquired the same lane → circular wait → permanent hang.
    h.setLive(false);
    h.setLive(true);
    finishMcpStatus({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: true,
      source: 'live',
      runtimeEpoch: 1,
      discoveryState: 'completed',
      servers: [],
    });

    // The reconciliation must settle (not hang).
    await vi.waitFor(
      () => {
        const state = coordinator.status().capabilities.mcp?.state;
        expect(state).not.toBe('starting');
      },
      { timeout: 5000 },
    );
  });

  it('is owned by the workspace runtime and stops accepting work after dispose', async () => {
    const h = makeRuntime();
    const coordinator = getWorkspaceRuntimeCoordinator(h.runtime);

    expect(h.runtime.runtimeCoordinator).toBe(coordinator);
    expect(getWorkspaceRuntimeCoordinator(h.runtime)).toBe(coordinator);

    coordinator.dispose();
    await expect(coordinator.prepare(['skills'])).rejects.toThrow(
      'Workspace runtime was disposed',
    );
    await expect(
      coordinator.runMcpOperation('docs', 'enable', async () => ({})),
    ).rejects.toThrow('Workspace runtime was disposed');
    expect(coordinator.reconcileMcpConfiguration()).toBe('deferred');
    expect(coordinator.reconcileSkillsConfiguration()).toBe('deferred');
  });
});
