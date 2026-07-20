/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SessionNotFoundError } from './acp-session-bridge.js';
import {
  createWorkspaceSessionOwnerIndex,
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  createSingleWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';

function bridgeWithSummary(
  getSessionSummary: (sessionId: string) => unknown,
): WorkspaceRuntime['bridge'] {
  return { getSessionSummary } as unknown as WorkspaceRuntime['bridge'];
}

function makeRuntime(
  workspaceCwd: string,
  overrides: Partial<WorkspaceRuntime> = {},
): WorkspaceRuntime {
  const bridge = bridgeWithSummary(() => {
    throw new SessionNotFoundError('missing');
  });
  return {
    workspaceId: `id:${workspaceCwd}`,
    workspaceCwd,
    primary: false,
    trusted: true,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge,
    workspaceService: {},
    routeFileSystemFactory: {},
    clientMcpSenderRegistry: {},
    ...overrides,
  } as WorkspaceRuntime;
}

describe('createSingleWorkspaceRegistry', () => {
  it('exposes the supplied runtime as the primary and only runtime', () => {
    const runtime = makeRuntime('/work/primary', { primary: true });

    const registry = createSingleWorkspaceRegistry(runtime);

    expect(registry.primary).toBe(runtime);
    expect(registry.list()).toEqual([runtime]);
    expect(registry.list()[0]).toBe(runtime);
  });

  it('looks up only the exact canonical workspace string', () => {
    const runtime = makeRuntime('/work/primary', { primary: true });

    const registry = createSingleWorkspaceRegistry(runtime);

    expect(registry.getByWorkspaceCwd('/work/primary')).toBe(runtime);
    expect(registry.getByWorkspaceCwd('/work')).toBeUndefined();
    expect(registry.getByWorkspaceCwd('/work/primary/child')).toBeUndefined();
    expect(registry.getByWorkspaceCwd('/work/primary/')).toBeUndefined();
    expect(registry.getByWorkspaceCwd('/other')).toBeUndefined();
  });

  it('looks up by workspace id and resolves omitted workspace to primary', () => {
    const runtime = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
    });

    const registry = createSingleWorkspaceRegistry(runtime);

    expect(registry.getByWorkspaceId('ws-primary')).toBe(runtime);
    expect(registry.getByWorkspaceId('missing')).toBeUndefined();
    expect(registry.resolveWorkspaceCwd(undefined)).toBe(runtime);
    expect(registry.resolveWorkspaceCwd('/work/primary')).toBe(runtime);
    expect(registry.resolveWorkspaceCwd('/work/primary/')).toBeUndefined();
  });

  it('closes the old generation and atomically activates a replacement', () => {
    const runtime = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
    });
    const replacement = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
      trusted: false,
    });
    const registry = createSingleWorkspaceRegistry(runtime);
    const entry = registry.primaryEntry;
    const oldGeneration = entry.current!;

    expect(registry.beginReplacement(entry, 'policy-2')).toBe(true);
    expect(oldGeneration.guard.closed).toBe(true);
    expect(() => oldGeneration.guard.assertOpen()).toThrow(/no longer active/);
    expect(registry.list()).toEqual([]);

    const next = registry.activateReplacement(entry, replacement, 'policy-2');
    expect(next.generationId).toBe(oldGeneration.generationId + 1);
    expect(registry.primary).toBe(replacement);
    expect(registry.list()).toEqual([replacement]);
    expect(entry.appliedRevision).toBe('policy-2');
  });

  it('keeps a failed replacement as a queryable blocked entry', () => {
    const runtime = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
    });
    const registry = createSingleWorkspaceRegistry(runtime);
    const entry = registry.primaryEntry;

    expect(registry.beginReplacement(entry, 'policy-2')).toBe(true);
    registry.blockReplacement(entry, 'runtime_build_failed');

    expect(registry.list()).toEqual([]);
    expect(registry.listManaged()).toEqual([runtime]);
    expect(registry.listEntries()).toEqual([entry]);
    expect(registry.getEntryByWorkspaceId('ws-primary')).toBe(entry);
    expect(entry.state).toBe('blocked');
    expect(entry.applyError).toBe('runtime_build_failed');
    expect(() => registry.primary).toThrow(/unavailable/);

    const replacement = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
      trusted: false,
    });
    expect(registry.beginReplacement(entry, 'policy-3')).toBe(true);
    const recovered = registry.activateReplacement(
      entry,
      replacement,
      'policy-3',
    );
    expect(recovered.generationId).toBe(2);
  });
});

describe('createWorkspaceRegistry', () => {
  it('keeps runtime order frozen and uses the marked primary runtime', () => {
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
    });
    const secondary = makeRuntime('/work/secondary', {
      workspaceId: 'ws-secondary',
    });

    const registry = createWorkspaceRegistry([primary, secondary], {
      scanUnindexedOwners: false,
    });

    expect(registry.primary).toBe(primary);
    expect(registry.list()).toEqual([primary, secondary]);
    expect(() => (registry.list() as WorkspaceRuntime[]).push(primary)).toThrow(
      TypeError,
    );
    expect(registry.getByWorkspaceCwd('/work/secondary')).toBe(secondary);
    expect(registry.getByWorkspaceId('ws-secondary')).toBe(secondary);
    expect(registry.resolveWorkspaceCwd('/work/missing')).toBeUndefined();
  });

  it('rejects invalid registry construction', () => {
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
    });
    const otherPrimary = makeRuntime('/work/other', {
      workspaceId: 'ws-other',
      primary: true,
    });

    expect(() => createWorkspaceRegistry([])).toThrow(
      /at least one workspace runtime/,
    );
    expect(() =>
      createWorkspaceRegistry([makeRuntime('/work/no-primary')]),
    ).toThrow(/exactly one primary workspace runtime/);
    expect(() => createWorkspaceRegistry([primary, otherPrimary])).toThrow(
      /exactly one primary workspace runtime/,
    );
    expect(() =>
      createWorkspaceRegistry([
        primary,
        makeRuntime('/work/primary', { workspaceId: 'ws-duplicate-cwd' }),
      ]),
    ).toThrow(/Duplicate workspace runtime cwd/);
    expect(() =>
      createWorkspaceRegistry([
        primary,
        makeRuntime('/work/secondary', { workspaceId: 'ws-primary' }),
      ]),
    ).toThrow(/Duplicate workspace runtime id/);
  });

  it('does not scan bridges when the authoritative owner index is empty', () => {
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
      bridge: bridgeWithSummary(() => {
        throw new SessionNotFoundError('sess-secondary');
      }),
    });
    const secondary = makeRuntime('/work/secondary', {
      workspaceId: 'ws-secondary',
      bridge: bridgeWithSummary((sessionId: string) => {
        if (sessionId !== 'sess-secondary') {
          throw new SessionNotFoundError(sessionId);
        }
        return { sessionId, workspaceCwd: '/work/secondary' };
      }),
    });

    const registry = createWorkspaceRegistry([primary, secondary], {
      scanUnindexedOwners: false,
    });

    expect(registry.resolveLiveSessionOwner('sess-secondary')).toEqual({
      kind: 'not_found',
    });
    expect(registry.resolveLiveSessionOwner('missing')).toEqual({
      kind: 'not_found',
    });
  });

  it('scans unindexed injected bridges when compatibility mode is enabled', () => {
    const primarySummary = vi.fn(() => {
      throw new SessionNotFoundError('missing');
    });
    const secondary = makeRuntime('/work/secondary', {
      workspaceId: 'ws-secondary',
      primary: false,
      bridge: bridgeWithSummary((sessionId: string) => ({
        sessionId,
        workspaceCwd: '/work/secondary',
      })),
    });
    const sessionOwnerIndex = createWorkspaceSessionOwnerIndex();
    const registry = createWorkspaceRegistry(
      [
        makeRuntime('/work/primary', {
          workspaceId: 'ws-primary',
          primary: true,
          bridge: bridgeWithSummary(primarySummary),
        }),
        secondary,
      ],
      { sessionOwnerIndex, scanUnindexedOwners: true },
    );

    expect(registry.resolveLiveSessionOwner('legacy-session')).toEqual({
      kind: 'found',
      runtime: secondary,
    });
    expect(sessionOwnerIndex.getWorkspaceCwds('legacy-session')).toEqual([
      secondary.workspaceCwd,
    ]);

    expect(registry.resolveLiveSessionOwner('legacy-session')).toEqual({
      kind: 'found',
      runtime: secondary,
    });
    expect(primarySummary).toHaveBeenCalledTimes(1);
  });

  it('uses the session owner index before scanning runtime bridges', () => {
    const primarySummary = vi.fn(() => {
      throw new SessionNotFoundError('sess-secondary');
    });
    const secondarySummary = vi.fn((sessionId: string) => ({
      sessionId,
      workspaceCwd: '/work/secondary',
    }));
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
      bridge: bridgeWithSummary(primarySummary),
    });
    const secondary = makeRuntime('/work/secondary', {
      workspaceId: 'ws-secondary',
      bridge: bridgeWithSummary(secondarySummary),
    });
    const sessionOwnerIndex = createWorkspaceSessionOwnerIndex();
    sessionOwnerIndex.register('sess-secondary', '/work/secondary');

    const registry = createWorkspaceRegistry([primary, secondary], {
      sessionOwnerIndex,
      scanUnindexedOwners: false,
    });

    expect(registry.resolveLiveSessionOwner('sess-secondary')).toEqual({
      kind: 'found',
      runtime: secondary,
    });
    expect(primarySummary).not.toHaveBeenCalled();
    expect(secondarySummary).toHaveBeenCalledWith('sess-secondary');
  });

  it('drops stale indexed owners without scanning unrelated runtimes', () => {
    const primarySummary = vi.fn((sessionId: string) => ({
      sessionId,
      workspaceCwd: '/work/primary',
    }));
    const secondarySummary = vi.fn(() => {
      throw new SessionNotFoundError('stale');
    });
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
      bridge: bridgeWithSummary(primarySummary),
    });
    const secondary = makeRuntime('/work/secondary', {
      workspaceId: 'ws-secondary',
      bridge: bridgeWithSummary(secondarySummary),
    });
    const sessionOwnerIndex = createWorkspaceSessionOwnerIndex();
    sessionOwnerIndex.register('stale', '/work/secondary');

    const registry = createWorkspaceRegistry([primary, secondary], {
      sessionOwnerIndex,
      scanUnindexedOwners: false,
    });

    expect(registry.resolveLiveSessionOwner('stale')).toEqual({
      kind: 'not_found',
    });
    expect(primarySummary).not.toHaveBeenCalled();
    expect(secondarySummary).toHaveBeenCalledTimes(1);

    expect(registry.resolveLiveSessionOwner('stale')).toEqual({
      kind: 'not_found',
    });
    expect(primarySummary).not.toHaveBeenCalled();
    expect(secondarySummary).toHaveBeenCalledTimes(1);
  });

  it('scans live owners after dropping a stale indexed owner', () => {
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
      bridge: bridgeWithSummary((sessionId: string) => ({
        sessionId,
        workspaceCwd: '/work/primary',
      })),
    });
    const sessionOwnerIndex = createWorkspaceSessionOwnerIndex();
    sessionOwnerIndex.register('stale', '/work/removed');
    const registry = createWorkspaceRegistry([primary], {
      sessionOwnerIndex,
      scanUnindexedOwners: true,
    });

    expect(registry.resolveLiveSessionOwner('stale')).toEqual({
      kind: 'found',
      runtime: primary,
    });
    expect(sessionOwnerIndex.getWorkspaceCwds('stale')).toEqual([
      primary.workspaceCwd,
    ]);
  });

  it('does not infer ambiguous ownership by scanning bridges', () => {
    const first = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
      bridge: bridgeWithSummary((sessionId: string) => ({
        sessionId,
        workspaceCwd: '/work/primary',
      })),
    });
    const second = makeRuntime('/work/secondary', {
      workspaceId: 'ws-secondary',
      bridge: bridgeWithSummary((sessionId: string) => ({
        sessionId,
        workspaceCwd: '/work/secondary',
      })),
    });

    const registry = createWorkspaceRegistry([first, second], {
      scanUnindexedOwners: false,
    });

    expect(registry.resolveLiveSessionOwner('sess-ambiguous')).toEqual({
      kind: 'not_found',
    });
  });

  it('does not consult bridge summaries for an unindexed session', () => {
    const lookupError = new Error('bridge unavailable');
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
      bridge: bridgeWithSummary(() => {
        throw lookupError;
      }),
    });

    const registry = createWorkspaceRegistry([primary], {
      scanUnindexedOwners: false,
    });

    expect(registry.resolveLiveSessionOwner('sess')).toEqual({
      kind: 'not_found',
    });
  });

  it('leaves the index unchanged when an unindexed session is queried', () => {
    const lookupError = new Error('bridge unavailable');
    const primarySummary = vi.fn((sessionId: string) => ({
      sessionId,
      workspaceCwd: '/work/primary',
    }));
    const secondarySummary = vi.fn(() => {
      throw lookupError;
    });
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
      bridge: bridgeWithSummary(primarySummary),
    });
    const secondary = makeRuntime('/work/secondary', {
      workspaceId: 'ws-secondary',
      bridge: bridgeWithSummary(secondarySummary),
    });
    const sessionOwnerIndex = createWorkspaceSessionOwnerIndex();
    const registry = createWorkspaceRegistry([primary, secondary], {
      sessionOwnerIndex,
      scanUnindexedOwners: false,
    });

    expect(registry.resolveLiveSessionOwner('sess')).toEqual({
      kind: 'not_found',
    });
    expect(sessionOwnerIndex.getWorkspaceCwds('sess')).toEqual([]);

    expect(registry.resolveLiveSessionOwner('sess')).toEqual({
      kind: 'not_found',
    });
    expect(primarySummary).not.toHaveBeenCalled();
    expect(secondarySummary).not.toHaveBeenCalled();
  });

  it('hides draining runtimes, rolls back, and releases cwd ownership on completion', () => {
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
    });
    const generationGuard = createWorkspaceGenerationGuard();
    const secondary = makeRuntime('/work/secondary', {
      workspaceId: 'ws-secondary',
      removable: true,
      generationGuard,
    });
    const sessionOwnerIndex = createWorkspaceSessionOwnerIndex();
    sessionOwnerIndex.register('session-secondary', secondary.workspaceCwd);
    const registry = createWorkspaceRegistry([primary, secondary], {
      sessionOwnerIndex,
      scanUnindexedOwners: false,
    });

    expect(registry.beginDrain(primary)).toBe(false);
    expect(registry.beginDrain(secondary)).toBe(true);
    expect(registry.list()).toEqual([primary]);
    expect(registry.listManaged()).toEqual([primary, secondary]);
    expect(registry.getByWorkspaceId(secondary.workspaceId)).toBeUndefined();
    expect(registry.getManagedByWorkspaceId(secondary.workspaceId)).toBe(
      secondary,
    );

    registry.cancelDrain(secondary);
    expect(registry.list()).toEqual([primary, secondary]);
    expect(registry.beginDrain(secondary)).toBe(true);
    registry.completeDrain(secondary);
    expect(registry.listManaged()).toEqual([primary]);
    expect(generationGuard.closed).toBe(true);
    expect(() => generationGuard.assertOpen()).toThrow(/no longer active/);
    expect(sessionOwnerIndex.getWorkspaceCwds('session-secondary')).toEqual([]);

    const replacement = makeRuntime('/work/secondary', {
      workspaceId: 'ws-secondary',
      removable: true,
    });
    registry.add(replacement);
    expect(registry.getByWorkspaceCwd('/work/secondary')).toBe(replacement);
  });

  it('closes the generation when removal commits and cannot reactivate it', () => {
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
    });
    const generationGuard = createWorkspaceGenerationGuard();
    const secondary = makeRuntime('/work/secondary', {
      workspaceId: 'ws-secondary',
      removable: true,
      generationGuard,
    });
    const registry = createWorkspaceRegistry([primary, secondary]);

    expect(registry.beginDrain(secondary)).toBe(true);
    registry.commitDrain(secondary);

    expect(generationGuard.closed).toBe(true);
    expect(() => generationGuard.assertOpen()).toThrow(
      'Workspace runtime generation is no longer active.',
    );
    registry.cancelDrain(secondary);
    expect(registry.getByWorkspaceCwd(secondary.workspaceCwd)).toBeUndefined();
  });

  it('excludes draining owners from indexed and fallback session resolution', () => {
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
      bridge: bridgeWithSummary((sessionId: string) => {
        throw new SessionNotFoundError(sessionId);
      }),
    });
    const secondary = makeRuntime('/work/secondary', {
      workspaceId: 'ws-secondary',
      removable: true,
      bridge: bridgeWithSummary((sessionId: string) => ({
        sessionId,
        workspaceCwd: '/work/secondary',
      })),
    });
    const sessionOwnerIndex = createWorkspaceSessionOwnerIndex();
    sessionOwnerIndex.register('indexed', secondary.workspaceCwd);
    const registry = createWorkspaceRegistry([primary, secondary], {
      sessionOwnerIndex,
      scanUnindexedOwners: false,
    });

    expect(registry.beginDrain(secondary)).toBe(true);
    expect(registry.resolveLiveSessionOwner('indexed')).toEqual({
      kind: 'not_found',
    });
    expect(registry.resolveLiveSessionOwner('fallback')).toEqual({
      kind: 'not_found',
    });
    expect(sessionOwnerIndex.getWorkspaceCwds('indexed')).toEqual([
      secondary.workspaceCwd,
    ]);

    registry.cancelDrain(secondary);
    expect(registry.resolveLiveSessionOwner('indexed')).toEqual({
      kind: 'found',
      runtime: secondary,
    });
    expect(registry.resolveLiveSessionOwner('fallback')).toEqual({
      kind: 'not_found',
    });
    expect(sessionOwnerIndex.getWorkspaceCwds('indexed')).toEqual([
      secondary.workspaceCwd,
    ]);
    expect(sessionOwnerIndex.getWorkspaceCwds('fallback')).toEqual([]);
  });
});
