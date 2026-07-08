/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SessionNotFoundError } from './acp-session-bridge.js';
import {
  createWorkspaceSessionOwnerIndex,
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

    const registry = createWorkspaceRegistry([primary, secondary]);

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

  it('resolves live session owners without falling back to primary', () => {
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

    const registry = createWorkspaceRegistry([primary, secondary]);

    expect(registry.resolveLiveSessionOwner('sess-secondary')).toEqual({
      kind: 'found',
      runtime: secondary,
    });
    expect(registry.resolveLiveSessionOwner('missing')).toEqual({
      kind: 'not_found',
    });
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
    });

    expect(registry.resolveLiveSessionOwner('sess-secondary')).toEqual({
      kind: 'found',
      runtime: secondary,
    });
    expect(primarySummary).not.toHaveBeenCalled();
    expect(secondarySummary).toHaveBeenCalledWith('sess-secondary');
  });

  it('drops stale indexed owners and caches the fallback scan result', () => {
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
    });

    expect(registry.resolveLiveSessionOwner('stale')).toEqual({
      kind: 'found',
      runtime: primary,
    });
    expect(primarySummary).toHaveBeenCalledTimes(1);
    expect(secondarySummary).toHaveBeenCalledTimes(2);

    expect(registry.resolveLiveSessionOwner('stale')).toEqual({
      kind: 'found',
      runtime: primary,
    });
    expect(primarySummary).toHaveBeenCalledTimes(2);
    expect(secondarySummary).toHaveBeenCalledTimes(2);
  });

  it('fails closed when live session owner resolution is ambiguous', () => {
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

    const registry = createWorkspaceRegistry([first, second]);

    expect(registry.resolveLiveSessionOwner('sess-ambiguous')).toEqual({
      kind: 'ambiguous',
      runtimes: [first, second],
    });
  });

  it('propagates unexpected live session lookup errors', () => {
    const lookupError = new Error('bridge unavailable');
    const primary = makeRuntime('/work/primary', {
      workspaceId: 'ws-primary',
      primary: true,
      bridge: bridgeWithSummary(() => {
        throw lookupError;
      }),
    });

    const registry = createWorkspaceRegistry([primary]);

    expect(() => registry.resolveLiveSessionOwner('sess')).toThrow(lookupError);
  });
});
