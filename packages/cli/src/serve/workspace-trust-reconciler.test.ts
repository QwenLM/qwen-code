/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { DaemonTrustPolicySnapshot } from '../config/daemon-trust-policy.js';
import { TrustLevel } from '../config/trustedFolders.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';
import {
  createWorkspaceTrustReconciler,
  type WorkspaceTrustReconcilerOptions,
} from './workspace-trust-reconciler.js';

function makeRuntime(
  workspaceCwd: string,
  overrides: Partial<WorkspaceRuntime> = {},
): WorkspaceRuntime {
  return {
    workspaceId: `id:${workspaceCwd}`,
    workspaceCwd,
    primary: false,
    trusted: true,
    trustMaterialization: 'true',
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: {},
    workspaceService: {},
    routeFileSystemFactory: {},
    clientMcpSenderRegistry: {},
    ...overrides,
  } as WorkspaceRuntime;
}

function policy(
  revision: string,
  rules: Record<string, TrustLevel>,
): DaemonTrustPolicySnapshot {
  return {
    revision,
    folderTrustEnabled: true,
    ideTrust: undefined,
    trustedFolders: rules,
  };
}

describe('workspace trust reconciler', () => {
  it('closes and starts draining every trust decrease before disposing any runtime', async () => {
    const primary = makeRuntime('/primary', { primary: true });
    const secondary = makeRuntime('/secondary');
    const registry = createWorkspaceRegistry([primary, secondary]);
    const nextPolicy = policy('two', {
      '/primary': TrustLevel.DO_NOT_TRUST,
      '/secondary': TrustLevel.DO_NOT_TRUST,
    });
    const drained: string[] = [];
    const drainRuntime = vi.fn(async (runtime: WorkspaceRuntime) => {
      expect(registry.list()).toEqual([]);
      expect(
        registry.listEntries().every((entry) => entry.current?.guard.closed),
      ).toBe(true);
      drained.push(runtime.workspaceCwd);
    });
    const disposeRuntime = vi.fn(async () => {
      expect(drained.sort()).toEqual(['/primary', '/secondary']);
    });
    const reconciler = createWorkspaceTrustReconciler({
      registry,
      readLatestSnapshot: async () => nextPolicy,
      buildRuntime: async ({ entry, trusted, generationGuard }) =>
        makeRuntime(entry.workspaceCwd, {
          workspaceId: entry.workspaceId,
          primary: entry.primary,
          trusted,
          trustMaterialization: String(trusted),
          generationGuard,
        }),
      drainRuntime,
      disposeRuntime,
    });

    await reconciler.reconcile(nextPolicy);

    expect(drainRuntime).toHaveBeenCalledTimes(2);
    expect(disposeRuntime).toHaveBeenCalledTimes(2);
    expect(registry.list().map((runtime) => runtime.trusted)).toEqual([
      false,
      false,
    ]);
  });

  it('disposes a stale candidate and activates only the latest revision', async () => {
    const primary = makeRuntime('/primary', { primary: true });
    const registry = createWorkspaceRegistry([primary]);
    const stalePolicy = policy('two', {
      '/primary': TrustLevel.DO_NOT_TRUST,
    });
    const latestPolicy = policy('three', {
      '/primary': TrustLevel.TRUST_FOLDER,
    });
    const disposeRuntime = vi.fn(async () => undefined);
    let reads = 0;
    const reconciler = createWorkspaceTrustReconciler({
      registry,
      readLatestSnapshot: async () =>
        reads++ === 0 ? latestPolicy : latestPolicy,
      buildRuntime: async ({ entry, trusted, generationGuard }) =>
        makeRuntime(entry.workspaceCwd, {
          workspaceId: entry.workspaceId,
          primary: entry.primary,
          trusted,
          trustMaterialization: String(trusted),
          generationGuard,
        }),
      drainRuntime: async () => undefined,
      disposeRuntime,
    });

    await reconciler.reconcile(stalePolicy);

    expect(disposeRuntime).toHaveBeenCalledTimes(2);
    expect(registry.primary.trusted).toBe(true);
    expect(registry.primaryEntry.appliedRevision).toBe('three');
  });

  it('applies a newly observed revision to every workspace before returning', async () => {
    const primary = makeRuntime('/primary', { primary: true });
    const secondary = makeRuntime('/secondary');
    const registry = createWorkspaceRegistry([primary, secondary]);
    const stalePolicy = policy('two', {
      '/primary': TrustLevel.DO_NOT_TRUST,
      '/secondary': TrustLevel.TRUST_FOLDER,
    });
    const latestPolicy = policy('three', {
      '/primary': TrustLevel.DO_NOT_TRUST,
      '/secondary': TrustLevel.DO_NOT_TRUST,
    });
    const reconciler = createWorkspaceTrustReconciler({
      registry,
      readLatestSnapshot: async () => latestPolicy,
      buildRuntime: async ({ entry, trusted, generationGuard }) =>
        makeRuntime(entry.workspaceCwd, {
          workspaceId: entry.workspaceId,
          primary: entry.primary,
          trusted,
          trustMaterialization: String(trusted),
          generationGuard,
        }),
      drainRuntime: async () => undefined,
      disposeRuntime: async () => undefined,
    });

    await reconciler.reconcile(stalePolicy);

    expect(registry.list().map((runtime) => runtime.trusted)).toEqual([
      false,
      false,
    ]);
    expect(
      registry.listEntries().map((entry) => entry.appliedRevision),
    ).toEqual(['three', 'three']);
  });

  it('keeps an untrusted fallback active when a grant build fails', async () => {
    const primary = makeRuntime('/primary', {
      primary: true,
      trusted: false,
      trustMaterialization: 'false',
    });
    const registry = createWorkspaceRegistry([primary]);
    const nextPolicy = policy('two', {
      '/primary': TrustLevel.TRUST_FOLDER,
    });
    const reconciler = createWorkspaceTrustReconciler({
      registry,
      readLatestSnapshot: async () => nextPolicy,
      buildRuntime: async ({ entry, trusted, generationGuard }) => {
        if (trusted) throw new Error('trusted build failed');
        return makeRuntime(entry.workspaceCwd, {
          workspaceId: entry.workspaceId,
          primary: entry.primary,
          trusted,
          trustMaterialization: String(trusted),
          generationGuard,
        });
      },
      drainRuntime: async () => undefined,
      disposeRuntime: async () => undefined,
    });

    await reconciler.reconcile(nextPolicy);

    expect(registry.primary.trusted).toBe(false);
    expect(registry.primaryEntry.state).toBe('active');
    expect(registry.primaryEntry.appliedRevision).toBeNull();
    expect(registry.primaryEntry.applyError).toContain('trusted build failed');
  });

  it('closes both candidate guards when a grant and its fallback fail', async () => {
    const primary = makeRuntime('/primary', {
      primary: true,
      trusted: false,
      trustMaterialization: 'false',
    });
    const registry = createWorkspaceRegistry([primary]);
    const nextPolicy = policy('two', {
      '/primary': TrustLevel.TRUST_FOLDER,
    });
    const candidateGuards: Array<{ readonly closed: boolean }> = [];
    const reconciler = createWorkspaceTrustReconciler({
      registry,
      readLatestSnapshot: async () => nextPolicy,
      buildRuntime: async ({ generationGuard }) => {
        candidateGuards.push(generationGuard);
        throw new Error('build failed');
      },
      drainRuntime: async () => undefined,
      disposeRuntime: async () => undefined,
    });

    await reconciler.reconcile(nextPolicy);

    expect(candidateGuards).toHaveLength(2);
    expect(candidateGuards.every((guard) => guard.closed)).toBe(true);
    expect(registry.primaryEntry.state).toBe('blocked');
  });

  it('disposes a candidate when the latest policy cannot be read', async () => {
    const primary = makeRuntime('/primary', { primary: true });
    const registry = createWorkspaceRegistry([primary]);
    const nextPolicy = policy('two', {
      '/primary': TrustLevel.DO_NOT_TRUST,
    });
    const disposeRuntime = vi.fn(async () => undefined);
    const reconciler = createWorkspaceTrustReconciler({
      registry,
      readLatestSnapshot: async () => {
        throw new Error('policy read failed');
      },
      buildRuntime: async ({ entry, trusted, generationGuard }) =>
        makeRuntime(entry.workspaceCwd, {
          workspaceId: entry.workspaceId,
          primary: entry.primary,
          trusted,
          trustMaterialization: String(trusted),
          generationGuard,
        }),
      drainRuntime: async () => undefined,
      disposeRuntime,
    });

    await reconciler.reconcile(nextPolicy);

    expect(disposeRuntime).toHaveBeenCalledTimes(2);
    expect(registry.primaryEntry).toMatchObject({
      state: 'blocked',
      applyError: 'policy read failed',
    });
  });

  it('disposes an untrusted fallback when the latest policy cannot be read', async () => {
    const primary = makeRuntime('/primary', {
      primary: true,
      trusted: false,
      trustMaterialization: 'false',
    });
    const registry = createWorkspaceRegistry([primary]);
    const nextPolicy = policy('two', {
      '/primary': TrustLevel.TRUST_FOLDER,
    });
    const disposeRuntime = vi.fn(async () => undefined);
    const reconciler = createWorkspaceTrustReconciler({
      registry,
      readLatestSnapshot: async () => {
        throw new Error('policy read failed');
      },
      buildRuntime: async ({ entry, trusted, generationGuard }) => {
        if (trusted) throw new Error('trusted build failed');
        return makeRuntime(entry.workspaceCwd, {
          workspaceId: entry.workspaceId,
          primary: entry.primary,
          trusted,
          trustMaterialization: String(trusted),
          generationGuard,
        });
      },
      drainRuntime: async () => undefined,
      disposeRuntime,
    });

    await reconciler.reconcile(nextPolicy);

    expect(disposeRuntime).toHaveBeenCalledTimes(2);
    expect(registry.primaryEntry.state).toBe('blocked');
    expect(registry.primaryEntry.applyError).toContain(
      'Trusted runtime and untrusted fallback both failed to build.',
    );
  });

  it('blocks only the affected entry when containment fails', async () => {
    const primary = makeRuntime('/primary', { primary: true });
    const secondary = makeRuntime('/secondary');
    const registry = createWorkspaceRegistry([primary, secondary]);
    const nextPolicy = policy('two', {
      '/primary': TrustLevel.TRUST_FOLDER,
      '/secondary': TrustLevel.DO_NOT_TRUST,
    });
    const reconciler = createWorkspaceTrustReconciler({
      registry,
      readLatestSnapshot: async () => nextPolicy,
      buildRuntime: async () => {
        throw new Error('should not build');
      },
      drainRuntime: async () => undefined,
      disposeRuntime: async (runtime) => {
        if (runtime.workspaceCwd === '/secondary') throw new Error('stuck');
      },
    });

    await reconciler.reconcile(nextPolicy);

    expect(registry.primary).toBe(primary);
    expect(registry.getEntryByWorkspaceCwd('/secondary')).toMatchObject({
      state: 'blocked',
      applyError: expect.stringContaining('containment failed'),
    });
  });

  it('retries containment before recovering a blocked entry', async () => {
    const primary = makeRuntime('/primary', { primary: true });
    const registry = createWorkspaceRegistry([primary]);
    const nextPolicy = policy('two', {
      '/primary': TrustLevel.DO_NOT_TRUST,
    });
    let disposeAttempts = 0;
    const buildRuntime = vi.fn(
      async ({
        entry,
        trusted,
        generationGuard,
      }: Parameters<WorkspaceTrustReconcilerOptions['buildRuntime']>[0]) =>
        makeRuntime(entry.workspaceCwd, {
          workspaceId: entry.workspaceId,
          primary: entry.primary,
          trusted,
          trustMaterialization: String(trusted),
          generationGuard,
        }),
    );
    const disposeRuntime = vi.fn(async () => {
      disposeAttempts += 1;
      if (disposeAttempts === 1) throw new Error('still active');
    });
    const reconciler = createWorkspaceTrustReconciler({
      registry,
      readLatestSnapshot: async () => nextPolicy,
      buildRuntime,
      drainRuntime: async () => undefined,
      disposeRuntime,
    });

    await reconciler.reconcile(nextPolicy);
    expect(registry.primaryEntry.state).toBe('blocked');
    expect(buildRuntime).not.toHaveBeenCalled();

    await reconciler.reconcile(nextPolicy);

    expect(disposeRuntime).toHaveBeenCalledTimes(2);
    expect(buildRuntime).toHaveBeenCalledOnce();
    expect(registry.primary.trusted).toBe(false);
  });

  it('does not repeat containment after the previous runtime was disposed', async () => {
    const primary = makeRuntime('/primary', { primary: true });
    const registry = createWorkspaceRegistry([primary]);
    const nextPolicy = policy('two', {
      '/primary': TrustLevel.DO_NOT_TRUST,
    });
    const buildRuntime = vi
      .fn<WorkspaceTrustReconcilerOptions['buildRuntime']>()
      .mockRejectedValueOnce(new Error('build failed'))
      .mockImplementation(async ({ entry, trusted, generationGuard }) =>
        makeRuntime(entry.workspaceCwd, {
          workspaceId: entry.workspaceId,
          primary: entry.primary,
          trusted,
          trustMaterialization: String(trusted),
          generationGuard,
        }),
      );
    const drainRuntime = vi.fn(async () => undefined);
    const disposeRuntime = vi.fn(async () => undefined);
    const reconciler = createWorkspaceTrustReconciler({
      registry,
      readLatestSnapshot: async () => nextPolicy,
      buildRuntime,
      drainRuntime,
      disposeRuntime,
    });

    await reconciler.reconcile(nextPolicy);
    expect(registry.primaryEntry.state).toBe('blocked');
    expect(registry.primaryEntry.current).toBeUndefined();

    await reconciler.reconcile(nextPolicy);

    expect(drainRuntime).toHaveBeenCalledOnce();
    expect(disposeRuntime).toHaveBeenCalledOnce();
    expect(buildRuntime).toHaveBeenCalledTimes(2);
    expect(registry.primary.trusted).toBe(false);
  });
});
