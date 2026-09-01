/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp, realpathSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { hashDaemonWorkspace } from '@qwen-code/qwen-code-core';
import { createServeApp } from './server.js';
import { ClientMcpSenderRegistry } from './acp-http/client-mcp-sender-registry.js';
import type { AcpHttpHandle } from './acp-http/index.js';
import {
  canonicalizeWorkspace,
  createWorkspaceFileSystemFactory,
} from './fs/index.js';
import type { ServeOptions } from './types.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import {
  WorkspaceSkillNotFoundError,
  type DaemonWorkspaceService,
} from './workspace-service/types.js';

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4197,
  mode: 'http-bridge',
};

function host(): string {
  return `127.0.0.1:${baseOpts.port}`;
}

function makeBridge(): AcpSessionBridge {
  return {
    permissionPolicy: 'first-responder',
    knownClientIds: () => new Set<string>(['client-1']),
    publishWorkspaceEvent: vi.fn(),
    isWorkspaceMemoryRememberAvailable: vi.fn(async () => true),
    runWorkspaceMemoryRemember: vi.fn(async () => ({
      summary: 'saved',
      filesTouched: ['/mem/project/secondary.md'],
      touchedScopes: ['project'],
    })),
    runWorkspaceMemoryForget: vi.fn(async () => ({
      summary: 'forgot',
      removedEntries: [],
      touchedTopics: ['project'],
      touchedScopes: ['project'],
    })),
    runWorkspaceMemoryDream: vi.fn(async () => ({
      summary: 'dreamed',
      touchedTopics: ['project'],
      dedupedEntries: 1,
    })),
    manageMcpServer: vi.fn(async (serverName, action, clientId) => ({
      serverName,
      action,
      clientId,
      ok: true,
    })),
    addRuntimeMcpServer: vi.fn(async (name, _config, clientId) => ({
      name,
      replaced: false,
      originatorClientId: clientId,
    })),
    removeRuntimeMcpServer: vi.fn(async (name, clientId) => ({
      name,
      removed: true,
      originatorClientId: clientId,
    })),
    getWorkspaceToolsStatus: vi.fn(async () => ({ v: 1, tools: [] })),
    getWorkspaceMcpToolsStatus: vi.fn(async () => ({ v: 1, tools: [] })),
    getWorkspaceMcpResourcesStatus: vi.fn(async () => ({
      v: 1,
      resources: [],
    })),
    getWorkspaceRuntimeLifecycleSnapshot: vi.fn(() => ({
      state: 'idle',
      runtimeLive: true,
      runtimeEpoch: 1,
      activeWork: false,
    })),
    preheat: vi.fn(async () => {}),
    initializeWorkspaceMcp: vi.fn(async () => ({ accepted: true })),
    reloadWorkspaceMcp: vi.fn(async () => ({ accepted: true })),
    getDaemonStatusSnapshot: vi.fn(() => ({
      limits: {
        maxSessions: 20,
        maxPendingPromptsPerSession: 5,
        eventRingSize: 8000,
        compactedReplayMaxBytes: 4 * 1024 * 1024,
        maxJournalEvents: 10_000,
        maxJournalBytes: 8 * 1024 * 1024,
        journalGrowth: null,
        channelIdleTimeoutMs: 0,
        sessionIdleTimeoutMs: 1_800_000,
      },
      sessionCount: 0,
      pendingPermissionCount: 0,
      channelLive: false,
      permissionPolicy: 'first-responder',
      sessions: [],
    })),
    listWorkspaceSessions: vi.fn(() => []),
    getSessionSummary: vi.fn(() => {
      throw new Error('not found');
    }),
    sessionCount: 0,
    activePromptCount: 0,
    pendingPromptTotal: 0,
    lastActivityAt: null,
  } as unknown as AcpSessionBridge;
}

function makeWorkspaceService(label: string): DaemonWorkspaceService {
  return {
    getWorkspaceTrustStatus: vi.fn(async (ctx) => ({
      v: 1,
      workspaceCwd: ctx.workspaceCwd,
      trusted: true,
      folderTrustEnabled: true,
    })),
    requestWorkspaceTrustChange: vi.fn(async (ctx, request) => ({
      v: 1,
      workspaceCwd: ctx.workspaceCwd,
      requestedState: request.desiredState,
      accepted: true,
    })),
    setWorkspacePermissionRules: vi.fn(async (ctx, request) => ({
      v: 1,
      workspaceCwd: ctx.workspaceCwd,
      user: {
        path: '/user/settings.json',
        rules: { allow: [], ask: [], deny: [] },
      },
      workspace: {
        path: `${ctx.workspaceCwd}/.qwen/settings.json`,
        rules: {
          allow: request.ruleType === 'allow' ? request.rules : [],
          ask: request.ruleType === 'ask' ? request.rules : [],
          deny: request.ruleType === 'deny' ? request.rules : [],
        },
      },
    })),
    setWorkspaceToolEnabled: vi.fn(async (_ctx, toolName, enabled) => ({
      toolName,
      enabled,
    })),
    setWorkspaceSkillEnabled: vi.fn(async (_ctx, skillName, enabled) => ({
      skillName,
      enabled,
      changed: true,
      activation: 'deferred' as const,
      sessionsRefreshed: 0,
      sessionsFailed: 0,
    })),
    setWorkspaceSkillsEnabled: vi.fn(
      async (_ctx, skillNames: readonly string[], enabled) => ({
        enabled,
        activation: 'deferred' as const,
        sessionsRefreshed: 0,
        sessionsFailed: 0,
        results: skillNames.map((skillName) => ({
          skillName,
          enabled,
          changed: true,
        })),
        errors: [],
      }),
    ),
    initWorkspace: vi.fn(async (ctx) => ({
      path: `${ctx.workspaceCwd}/QWEN.md`,
      action: 'created' as const,
    })),
    restartMcpServer: vi.fn(async (_ctx, serverName) => ({
      serverName,
      restarted: true,
    })),
    reload: vi.fn(async (ctx) => ({
      workspaceCwd: ctx.workspaceCwd,
      env: { reloaded: false },
      settings: { reloaded: true },
    })),
    getWorkspaceMcpStatus: vi.fn(async (ctx) => ({
      v: 1,
      workspaceCwd: ctx.workspaceCwd,
      initialized: true,
      runtimeEpoch: 1,
      source: 'live' as const,
      discoveryState: 'completed' as const,
      servers: [{ name: label }],
    })),
    getWorkspaceSkillsStatus: vi.fn(async (ctx) => ({
      v: 1,
      workspaceCwd: ctx.workspaceCwd,
      skills: [],
    })),
    getWorkspaceProvidersStatus: vi.fn(async (ctx) => ({
      v: 1,
      workspaceCwd: ctx.workspaceCwd,
      providers: [],
    })),
    getWorkspaceEnvStatus: vi.fn(async (ctx) => ({
      v: 1,
      workspaceCwd: ctx.workspaceCwd,
      env: {},
    })),
    getWorkspacePreflightStatus: vi.fn(async (ctx) => ({
      v: 1,
      workspaceCwd: ctx.workspaceCwd,
      checks: [],
    })),
    getWorkspaceHooksStatus: vi.fn(async (ctx) => ({
      v: 1,
      workspaceCwd: ctx.workspaceCwd,
      hooks: [],
    })),
  } as unknown as DaemonWorkspaceService;
}

async function makeHarness(opts?: {
  primaryTrusted?: boolean;
  secondaryTrusted?: boolean;
  secondaryDirName?: string;
  token?: string;
  persistSetting?: boolean;
  primaryWriteHold?: { hold: Promise<void>; onWriteStart?: () => void };
}) {
  const scratch = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'qwen-workspace-qualified-rest-'),
  );
  const primaryCwd = canonicalizeWorkspace(path.join(scratch, 'primary'));
  const secondaryCwd = canonicalizeWorkspace(
    path.join(scratch, opts?.secondaryDirName ?? 'secondary'),
  );
  await fsp.mkdir(primaryCwd, { recursive: true });
  await fsp.mkdir(secondaryCwd, { recursive: true });
  await fsp.writeFile(path.join(primaryCwd, 'target.txt'), 'primary');
  await fsp.writeFile(path.join(secondaryCwd, 'target.txt'), 'secondary');

  const primaryFsFactoryBase = createWorkspaceFileSystemFactory({
    boundWorkspaces: [primaryCwd],
    trusted: opts?.primaryTrusted ?? true,
    emit: () => {},
  });
  // A Proxy (not a spread) so prototype methods like resolve/stat are
  // preserved; only writeBytesAtomic is intercepted to hold the gate slot.
  const primaryFsFactory = opts?.primaryWriteHold
    ? {
        assertCanWrite: () => {},
        forRequest: (
          ctx: Parameters<typeof primaryFsFactoryBase.forRequest>[0],
        ) => {
          const realFs = primaryFsFactoryBase.forRequest(ctx);
          return new Proxy(realFs, {
            get(target, prop, receiver) {
              if (prop === 'writeBytesAtomic') {
                return (
                  p: Parameters<typeof realFs.writeBytesAtomic>[0],
                  data: Buffer,
                ) => {
                  opts.primaryWriteHold?.onWriteStart?.();
                  return opts.primaryWriteHold!.hold.then(() =>
                    target.writeBytesAtomic(p, data),
                  );
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      }
    : primaryFsFactoryBase;
  const secondaryFsFactory = createWorkspaceFileSystemFactory({
    boundWorkspaces: [secondaryCwd],
    trusted: true,
    emit: () => {},
  });
  const untrustedFsFactory = createWorkspaceFileSystemFactory({
    boundWorkspaces: [secondaryCwd],
    trusted: false,
    emit: () => {},
  });

  const primaryWorkspaceService = makeWorkspaceService('primary');
  const secondaryWorkspaceService = makeWorkspaceService('secondary');
  const primary: WorkspaceRuntime = {
    workspaceId: 'same-as-path',
    workspaceCwd: primaryCwd,
    sessionRuntimeBaseDir: path.join(primaryCwd, '.runtime'),
    primary: true,
    trusted: opts?.primaryTrusted ?? true,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: makeBridge(),
    workspaceService: primaryWorkspaceService,
    routeFileSystemFactory: primaryFsFactory,
    clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
    generationGuard: createWorkspaceGenerationGuard(),
  };
  const secondary: WorkspaceRuntime = {
    workspaceId: hashDaemonWorkspace(secondaryCwd),
    workspaceCwd: secondaryCwd,
    sessionRuntimeBaseDir: path.join(secondaryCwd, '.runtime'),
    primary: false,
    trusted: opts?.secondaryTrusted ?? true,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: makeBridge(),
    workspaceService: secondaryWorkspaceService,
    routeFileSystemFactory:
      opts?.secondaryTrusted === false
        ? untrustedFsFactory
        : secondaryFsFactory,
    clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
    generationGuard: createWorkspaceGenerationGuard(),
  };

  const persistSetting = vi.fn(async () => {});
  const workspaceRegistry = createWorkspaceRegistry([primary, secondary]);
  const app = createServeApp(
    { ...baseOpts, workspace: primaryCwd, token: opts?.token },
    undefined,
    {
      workspaceRegistry,
      ...(opts?.persistSetting === false ? {} : { persistSetting }),
    },
  );

  return {
    app,
    scratch,
    primaryCwd,
    secondaryCwd,
    secondaryId: secondary.workspaceId,
    primaryBridge: primary.bridge,
    secondaryBridge: secondary.bridge,
    secondaryWorkspaceService,
    persistSetting,
    workspaceRegistry,
  };
}

async function makeWindowsSelectorHarness() {
  const scratch = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'qwen-workspace-qualified-rest-win-'),
  );
  const primaryCwd = canonicalizeWorkspace(path.join(scratch, 'primary'));
  await fsp.mkdir(primaryCwd, { recursive: true });
  const windowsCwd = 'C:\\repo';
  const primaryFsFactory = createWorkspaceFileSystemFactory({
    boundWorkspaces: [primaryCwd],
    trusted: true,
    emit: () => {},
  });
  const windowsFsFactory = createWorkspaceFileSystemFactory({
    boundWorkspaces: [windowsCwd],
    trusted: true,
    emit: () => {},
  });
  const primary: WorkspaceRuntime = {
    workspaceId: 'primary-id',
    workspaceCwd: primaryCwd,
    sessionRuntimeBaseDir: path.join(primaryCwd, '.runtime'),
    primary: true,
    trusted: true,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: makeBridge(),
    workspaceService: makeWorkspaceService('primary'),
    routeFileSystemFactory: primaryFsFactory,
    clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
  };
  const windowsRuntime: WorkspaceRuntime = {
    workspaceId: 'windows-id',
    workspaceCwd: windowsCwd,
    sessionRuntimeBaseDir: '/runtime/windows',
    primary: false,
    trusted: true,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: makeBridge(),
    workspaceService: makeWorkspaceService('windows'),
    routeFileSystemFactory: windowsFsFactory,
    clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
  };
  const persistSetting = vi.fn(async () => {});
  const app = createServeApp(
    { ...baseOpts, workspace: primaryCwd },
    undefined,
    {
      workspaceRegistry: createWorkspaceRegistry([primary, windowsRuntime]),
      persistSetting,
    },
  );
  return { app, scratch, windowsCwd };
}

describe('workspace-qualified core REST', () => {
  it('routes file reads to the workspace selected by id', async () => {
    const h = await makeHarness();
    try {
      const res = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/file`)
        .query({ path: 'target.txt' })
        .set('Host', host());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        kind: 'file',
        path: 'target.txt',
        content: 'secondary',
      });
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('advertises the workspace-qualified core REST capability', async () => {
    const h = await makeHarness();
    try {
      const res = await request(h.app).get('/capabilities').set('Host', host());
      expect(res.status).toBe(200);
      expect(res.body.features).toContain('workspace_qualified_rest_core');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('advertises core workspace-qualified REST without settings persistence', async () => {
    const h = await makeHarness({ persistSetting: false });
    try {
      const res = await request(h.app).get('/capabilities').set('Host', host());
      expect(res.status).toBe(200);
      expect(res.body.features).toContain('workspace_qualified_rest_core');
      expect(res.body.features).not.toContain('workspace_settings');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes file reads to the workspace selected by encoded cwd', async () => {
    const h = await makeHarness();
    try {
      const res = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryCwd)}/file`)
        .query({ path: 'target.txt' })
        .set('Host', host());
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('secondary');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes cwd selectors through local canonical symlink equivalence', async () => {
    const h = await makeHarness();
    try {
      const link = path.join(path.dirname(h.secondaryCwd), 'secondary-link');
      try {
        await fsp.symlink(h.secondaryCwd, link, 'dir');
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          ((err as { code?: unknown }).code === 'EPERM' ||
            (err as { code?: unknown }).code === 'EACCES')
        ) {
          return;
        }
        throw err;
      }
      const res = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(link)}/file`)
        .query({ path: 'target.txt' })
        .set('Host', host());
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('secondary');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('preserves literal percent-encoded text in cwd selectors', async () => {
    const h = await makeHarness({ secondaryDirName: 'secondary%2Fencoded' });
    try {
      const res = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryCwd)}/file`)
        .query({ path: 'target.txt' })
        .set('Host', host());
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('secondary');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('prefers workspace id over an absolute cwd-shaped selector', async () => {
    const h = await makeHarness();
    try {
      const res = await request(h.app)
        .get('/workspaces/same-as-path/file')
        .query({ path: 'target.txt' })
        .set('Host', host());
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('primary');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('rejects unknown workspace selectors with workspace_mismatch', async () => {
    const h = await makeHarness();
    try {
      const res = await request(h.app)
        .get(
          `/workspaces/${encodeURIComponent(path.join(h.scratch, 'nope'))}/file`,
        )
        .query({ path: 'target.txt' })
        .set('Host', host());
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('workspace_mismatch');
      expect(res.body.boundWorkspace).toBeUndefined();
      expect(res.body.requestedWorkspace).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(h.primaryCwd);
      expect(JSON.stringify(res.body)).not.toContain(
        path.join(h.scratch, 'nope'),
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('does not canonicalize unregistered absolute cwd selectors', async () => {
    const h = await makeHarness();
    const realpathSpy = vi.spyOn(realpathSync, 'native');
    try {
      const uncSelector = '\\\\attacker\\share';
      const res = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(uncSelector)}/file`)
        .query({ path: 'target.txt' })
        .set('Host', host());
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('workspace_mismatch');
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('uses portable cwd selector resolution for workspace session routes', async () => {
    const h = await makeWindowsSelectorHarness();
    try {
      const res = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.windowsCwd)}/sessions`)
        .set('Host', host());
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([]);
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('allows untrusted workspace file reads but rejects non-catalog core reads', async () => {
    const h = await makeHarness({ secondaryTrusted: false });
    try {
      const file = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/file`)
        .query({ path: 'target.txt' })
        .set('Host', host());
      expect(file.status).toBe(200);
      expect(file.body.content).toBe('secondary');

      for (const route of [
        'mcp',
        'runtime/mcp',
        'skills',
        'providers',
        'env',
        'preflight',
        'hooks',
        'tools',
        'settings',
        'permissions',
        'memory',
        'agents',
      ]) {
        const res = await request(h.app)
          .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/${route}`)
          .set('Host', host());
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('untrusted_workspace');
        expect(res.body.error).toBe('Workspace is not trusted.');
        expect(res.body).not.toHaveProperty('workspaceCwd');
        expect(res.body).not.toHaveProperty('workspaceId');
      }
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes workspace-qualified status reads to the selected workspace', async () => {
    const h = await makeHarness();
    try {
      for (const route of [
        'mcp',
        'skills',
        'providers',
        'env',
        'preflight',
        'hooks',
      ]) {
        const res = await request(h.app)
          .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/${route}`)
          .set('Host', host());
        expect(res.status).toBe(200);
        expect(res.body.workspaceCwd).toBe(h.secondaryCwd);
      }

      const tools = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/tools`)
        .set('Host', host());
      expect(tools.status).toBe(200);
      expect(tools.body).toEqual({ v: 1, tools: [] });

      const mcpTools = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/mcp/docs/tools`)
        .set('Host', host());
      expect(mcpTools.status).toBe(200);
      expect(mcpTools.body).toEqual({ v: 1, tools: [] });

      const mcpResources = await request(h.app)
        .get(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/mcp/docs/resources`,
        )
        .set('Host', host());
      expect(mcpResources.status).toBe(200);
      expect(mcpResources.body).toEqual({ v: 1, resources: [] });

      const runtimeMcp = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/runtime/mcp`)
        .set('Host', host());
      expect(runtimeMcp.status).toBe(200);
      expect(runtimeMcp.body).toMatchObject({
        workspaceCwd: h.secondaryCwd,
        runtimeEpoch: 1,
        source: 'live',
      });
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes workspace-qualified settings and rejects user scope or untrusted access', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const get = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/settings`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(get.status).toBe(200);

      const post = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/settings`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({
          scope: 'workspace',
          key: 'general.cleanupPeriodDays',
          value: 30,
        });
      expect(post.status).toBe(200);
      expect(h.persistSetting).toHaveBeenCalledWith(
        h.secondaryCwd,
        expect.any(String),
        'general.cleanupPeriodDays',
        30,
        expect.any(Function),
      );

      const badScope = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/settings`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({
          scope: 'user',
          key: 'general.cleanupPeriodDays',
          value: 30,
        });
      expect(badScope.status).toBe(400);
      expect(badScope.body.code).toBe('invalid_scope');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }

    const untrusted = await makeHarness({
      secondaryTrusted: false,
      token: 'secret',
    });
    try {
      const res = await request(untrusted.app)
        .get(
          `/workspaces/${encodeURIComponent(untrusted.secondaryId)}/settings`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
      expect(res.body.error).toBe('Workspace is not trusted.');
      expect(res.body).not.toHaveProperty('workspaceCwd');
      expect(res.body).not.toHaveProperty('workspaceId');
    } finally {
      await fsp.rm(untrusted.scratch, { recursive: true, force: true });
    }
  });

  it('does not publish qualified settings from a closed generation', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const entry = h.workspaceRegistry.getEntryByWorkspaceId(h.secondaryId)!;
      h.persistSetting.mockImplementationOnce(async () => {
        entry.current!.guard.close();
      });

      const res = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/settings`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({
          scope: 'workspace',
          key: 'general.cleanupPeriodDays',
          value: 30,
        });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('workspace_runtime_unavailable');
      expect(
        entry.current!.runtime.bridge.publishWorkspaceEvent,
      ).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes workspace-qualified permissions and rejects non-workspace scope', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const get = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/permissions`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(get.status).toBe(200);

      const post = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/permissions`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ scope: 'workspace', ruleType: 'allow', rules: ['Shell(ls)'] });
      expect(post.status).toBe(200);
      expect(post.body.workspace.rules.allow).toEqual(['Shell(ls)']);

      const badScope = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/permissions`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ scope: 'user', ruleType: 'allow', rules: ['Shell(ls)'] });
      expect(badScope.status).toBe(400);
      expect(badScope.body.code).toBe(
        'global_scope_not_supported_for_workspace_route',
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }

    const untrusted = await makeHarness({
      secondaryTrusted: false,
      token: 'secret',
    });
    try {
      const res = await request(untrusted.app)
        .get(
          `/workspaces/${encodeURIComponent(untrusted.secondaryId)}/permissions`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
    } finally {
      await fsp.rm(untrusted.scratch, { recursive: true, force: true });
    }
  });

  it('allows workspace-qualified trust status and requests while untrusted', async () => {
    const h = await makeHarness({ secondaryTrusted: false, token: 'secret' });
    try {
      const get = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/trust`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(get.status).toBe(200);
      expect(get.body.workspaceCwd).toBe(h.secondaryCwd);

      const post = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/trust/request`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ desiredState: 'trusted', reason: 'tests' });
      expect(post.status).toBe(202);
      expect(post.body.requestedState).toBe('trusted');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes workspace-qualified file writes and trust-gates untrusted writes', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const res = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/file/write`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ path: 'created.txt', content: 'created', mode: 'create' });
      expect(res.status).toBe(201);
      expect(res.body.path).toBe('created.txt');
      await expect(
        fsp.readFile(path.join(h.secondaryCwd, 'created.txt'), 'utf8'),
      ).resolves.toBe('created');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }

    const untrusted = await makeHarness({
      secondaryTrusted: false,
      token: 'secret',
    });
    try {
      const res = await request(untrusted.app)
        .post(
          `/workspaces/${encodeURIComponent(untrusted.secondaryId)}/file/write`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ path: 'blocked.txt', content: 'blocked', mode: 'create' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
    } finally {
      await fsp.rm(untrusted.scratch, { recursive: true, force: true });
    }
  });

  it('routes workspace-qualified file uploads and never falls back to primary', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const data = Buffer.from([1, 2, 3, 4]);
      const res = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/file/upload`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .set('Content-Type', 'application/octet-stream')
        .query({ path: 'blob.bin' })
        .send(data);
      expect(res.status).toBe(201);
      expect(res.body.path).toBe('blob.bin');
      // Landed in the SECONDARY workspace, not the primary.
      await expect(
        fsp.readFile(path.join(h.secondaryCwd, 'blob.bin')),
      ).resolves.toEqual(data);
      await expect(
        fsp.stat(path.join(h.primaryCwd, 'blob.bin')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }

    // Untrusted secondary: 403, and nothing is written to primary either.
    const untrusted = await makeHarness({
      secondaryTrusted: false,
      token: 'secret',
    });
    try {
      const res = await request(untrusted.app)
        .post(
          `/workspaces/${encodeURIComponent(untrusted.secondaryId)}/file/upload`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .set('Content-Type', 'application/octet-stream')
        .query({ path: 'blocked.bin' })
        .send(Buffer.from('x'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
      await expect(
        fsp.stat(path.join(untrusted.primaryCwd, 'blocked.bin')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(untrusted.scratch, { recursive: true, force: true });
    }
  });

  it('uploads into a workspace whose root path trips the suspicious-pattern check', async () => {
    // A canonical root with a trailing-dot segment matches
    // hasSuspiciousPathPattern; candidates must re-resolve from the
    // workspace-relative admission dir rather than the absolute root.
    const h = await makeHarness({
      token: 'secret',
      secondaryDirName: 'my proj.',
    });
    try {
      const res = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/file/upload`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .set('Content-Type', 'application/octet-stream')
        .query({ path: 'report.txt' })
        .send(Buffer.from('hi'));
      expect(res.status).toBe(201);
      expect(res.body.path).toBe('report.txt');
      await expect(
        fsp.readFile(path.join(h.secondaryCwd, 'report.txt'), 'utf-8'),
      ).resolves.toBe('hi');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('shares one upload gate between legacy and qualified routes', async () => {
    let started = 0;
    let releaseWrites: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const h = await makeHarness({
      token: 'secret',
      primaryWriteHold: { hold, onWriteStart: () => (started += 1) },
    });
    try {
      const legacyUpload = (name: string) =>
        request(h.app)
          .post('/file/upload')
          .set('Authorization', 'Bearer secret')
          .set('Host', host())
          .set('Content-Type', 'application/octet-stream')
          .query({ path: name })
          .send(Buffer.from('x'));

      const inFlight = [
        legacyUpload('a.bin'),
        legacyUpload('b.bin'),
        legacyUpload('c.bin'),
        legacyUpload('d.bin'),
      ];
      // Supertest Tests are lazy thenables — attach a catch to actually
      // send each request without awaiting it (they hang in the held write).
      inFlight.forEach((p) => void p.catch(() => {}));
      await vi.waitFor(() => {
        expect(started).toBe(4);
      });

      // All four gate slots are held through the LEGACY route; a qualified
      // upload must draw from the same shared gate and be turned away.
      const qualified = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/file/upload`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .set('Content-Type', 'application/octet-stream')
        .query({ path: 'q.bin' })
        .send(Buffer.from('x'));
      expect(qualified.status).toBe(429);
      expect(qualified.body).toMatchObject({
        errorKind: 'upload_busy',
        status: 429,
      });

      releaseWrites();
      const results = await Promise.all(inFlight);
      for (const res of results) {
        expect(res.status).toBe(201);
      }
    } finally {
      releaseWrites();
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('rejects qualified uploads for unknown, draining, and already removed workspaces', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const unknown = await request(h.app)
        .post('/workspaces/does-not-exist/file/upload')
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .set('Content-Type', 'application/octet-stream')
        .query({ path: 'a.bin' })
        .send(Buffer.from('x'));
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('workspace_mismatch');
      await expect(
        fsp.stat(path.join(h.primaryCwd, 'a.bin')),
      ).rejects.toMatchObject({ code: 'ENOENT' });

      const secondaryRuntime = h.workspaceRegistry.getByWorkspaceId(
        h.secondaryId,
      );
      expect(secondaryRuntime).toBeDefined();
      expect(h.workspaceRegistry.beginDrain(secondaryRuntime!)).toBe(true);

      const draining = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/file/upload`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .set('Content-Type', 'application/octet-stream')
        .query({ path: 'b.bin' })
        .send(Buffer.from('x'));
      expect(draining.status).toBe(503);
      expect(draining.body.code).toBe('workspace_runtime_unavailable');
      await expect(
        fsp.stat(path.join(h.primaryCwd, 'b.bin')),
      ).rejects.toMatchObject({ code: 'ENOENT' });

      h.workspaceRegistry.completeDrain(secondaryRuntime!);
      const removed = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/file/upload`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .set('Content-Type', 'application/octet-stream')
        .query({ path: 'c.bin' })
        .send(Buffer.from('x'));
      expect(removed.status).toBe(400);
      expect(removed.body.code).toBe('workspace_mismatch');
      await expect(
        fsp.stat(path.join(h.primaryCwd, 'c.bin')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes workspace-qualified lifecycle mutations and trust-gates them', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const init = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/init`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ force: true });
      expect(init.status).toBe(200);
      expect(init.body.path).toBe(`${h.secondaryCwd}/QWEN.md`);

      const reload = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/reload`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({});
      expect(reload.status).toBe(200);
      expect(reload.body.workspaceCwd).toBe(h.secondaryCwd);

      const badForce = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/init`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ force: 'yes' });
      expect(badForce.status).toBe(400);
      expect(badForce.body.code).toBe('invalid_force_flag');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }

    const untrusted = await makeHarness({
      secondaryTrusted: false,
      token: 'secret',
    });
    try {
      const res = await request(untrusted.app)
        .post(`/workspaces/${encodeURIComponent(untrusted.secondaryId)}/reload`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
    } finally {
      await fsp.rm(untrusted.scratch, { recursive: true, force: true });
    }
  });

  it('routes workspace-qualified MCP control through the selected runtime', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const restart = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/mcp/docs/restart`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({});
      expect(restart.status).toBe(200);
      expect(restart.body).toMatchObject({
        serverName: 'docs',
        restarted: true,
      });

      const runtimeRestart = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/runtime/mcp/docs/restart`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({});
      expect(runtimeRestart.status).toBe(200);
      expect(runtimeRestart.body).toMatchObject({
        serverName: 'docs',
        restarted: true,
      });

      const enable = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/mcp/docs/enable`,
        )
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .set('Host', host())
        .send({});
      expect(enable.status).toBe(200);
      expect(enable.body).toMatchObject({
        serverName: 'docs',
        action: 'enable',
        clientId: 'client-1',
      });

      const add = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/mcp/servers`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .set('Host', host())
        .send({ name: 'runtime', config: { command: 'node' } });
      expect(add.status).toBe(200);
      expect(add.body.name).toBe('runtime');

      const remove = await request(h.app)
        .delete(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/mcp/servers/runtime`,
        )
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .set('Host', host());
      expect(remove.status).toBe(200);
      expect(remove.body.removed).toBe(true);
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }

    const untrusted = await makeHarness({
      secondaryTrusted: false,
      token: 'secret',
    });
    try {
      const res = await request(untrusted.app)
        .post(
          `/workspaces/${encodeURIComponent(untrusted.secondaryId)}/mcp/docs/restart`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
    } finally {
      await fsp.rm(untrusted.scratch, { recursive: true, force: true });
    }
  });

  it('persists workspace MCP configuration through the selected workspace route', async () => {
    const h = await makeHarness({ token: 'secret' });
    vi.mocked(h.secondaryBridge.publishWorkspaceEvent).mockImplementationOnce(
      () => {
        throw new Error('subscriber unavailable');
      },
    );
    try {
      const response = await request(h.app)
        .put(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/config/mcp/servers/docs`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({
          scope: 'workspace',
          config: { command: 'node', args: ['server.js'] },
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        name: 'docs',
        scope: 'workspace',
        activation: 'reconciling',
      });
      expect(h.persistSetting).toHaveBeenCalledWith(
        h.secondaryCwd,
        expect.any(String),
        'mcpServers',
        { docs: { command: 'node', args: ['server.js'] } },
        expect.any(Function),
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('does not publish unchanged workspace MCP exclusions', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const response = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/config/mcp/docs/enable`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ scope: 'workspace' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ changed: false });
      expect(h.secondaryBridge.publishWorkspaceEvent).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('rejects enabling an MCP server blocked by a wildcard exclusion', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      await fsp.mkdir(path.join(h.secondaryCwd, '.qwen'), { recursive: true });
      await fsp.writeFile(
        path.join(h.secondaryCwd, '.qwen', 'settings.json'),
        JSON.stringify({ mcp: { excluded: ['docs*'] } }),
      );

      const response = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/config/mcp/docs/enable`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ scope: 'workspace' });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'mcp_excluded_by_pattern',
        patterns: ['docs*'],
      });
      expect(h.persistSetting).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('reconciles user MCP configuration across managed workspaces', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const response = await request(h.app)
        .put('/workspace/config/mcp/servers/global-docs')
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ scope: 'user', config: { command: 'node' } });

      expect(response.status).toBe(200);
      expect(response.body.activation).toBe('reconciling');
      expect(h.primaryBridge.publishWorkspaceEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'settings_changed' }),
      );
      expect(h.secondaryBridge.publishWorkspaceEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'settings_changed' }),
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('persists user MCP configuration without a live trusted primary runtime', async () => {
    const h = await makeHarness({ primaryTrusted: false, token: 'secret' });
    h.workspaceRegistry.beginReplacement(
      h.workspaceRegistry.primaryEntry,
      'policy-2',
    );
    try {
      const response = await request(h.app)
        .put('/workspace/config/mcp/servers/global-docs')
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ scope: 'user', config: { command: 'node' } });

      expect(h.persistSetting).toHaveBeenCalledWith(
        h.primaryCwd,
        expect.any(String),
        'mcpServers',
        expect.objectContaining({
          'global-docs': expect.objectContaining({ command: 'node' }),
        }),
        undefined,
      );
      expect(response.status).toBe(200);
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('reads untrusted workspace MCP configuration but rejects its mutation', async () => {
    const h = await makeHarness({ secondaryTrusted: false, token: 'secret' });
    try {
      const path = `/workspaces/${encodeURIComponent(h.secondaryId)}/config/mcp/servers`;
      const read = await request(h.app)
        .get(path)
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ v: 1 });

      const mutation = await request(h.app)
        .put(`${path}/docs`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ scope: 'workspace', config: { command: 'node' } });
      expect(mutation.status).toBe(403);
      expect(mutation.body.code).toBe('untrusted_workspace');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes workspace-qualified tool toggles and validates mutation bodies', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const enabled = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/tools/Bash/enable`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ enabled: false });
      expect(enabled.status).toBe(200);
      expect(enabled.body).toEqual({ toolName: 'Bash', enabled: false });

      const badBody = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/tools/Bash/enable`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ enabled: 'no' });
      expect(badBody.status).toBe(400);
      expect(badBody.body.code).toBe('invalid_enabled_flag');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }

    const untrusted = await makeHarness({
      secondaryTrusted: false,
      token: 'secret',
    });
    try {
      const res = await request(untrusted.app)
        .post(
          `/workspaces/${encodeURIComponent(untrusted.secondaryId)}/tools/Bash/enable`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ enabled: false });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
    } finally {
      await fsp.rm(untrusted.scratch, { recursive: true, force: true });
    }
  });

  it('routes workspace-qualified skill toggles and trust-gates writes', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const res = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/skills/review/enable`,
        )
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .set('Host', host())
        .send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        skillName: 'review',
        enabled: false,
        changed: true,
        activation: 'deferred',
        sessionsRefreshed: 0,
        sessionsFailed: 0,
      });

      const batch = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/skills/enable`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .set('Host', host())
        .send({ skillNames: ['review', 'deploy'], enabled: false });
      expect(batch.status).toBe(200);
      expect(batch.body).toEqual({
        enabled: false,
        activation: 'deferred',
        sessionsRefreshed: 0,
        sessionsFailed: 0,
        results: [
          {
            skillName: 'review',
            enabled: false,
            changed: true,
          },
          {
            skillName: 'deploy',
            enabled: false,
            changed: true,
          },
        ],
        errors: [],
      });
      expect(
        h.secondaryWorkspaceService.setWorkspaceSkillsEnabled,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceCwd: h.secondaryCwd,
          originatorClientId: 'client-1',
        }),
        ['review', 'deploy'],
        false,
      );

      vi.mocked(
        h.secondaryWorkspaceService.setWorkspaceSkillEnabled,
      ).mockRejectedValueOnce(new WorkspaceSkillNotFoundError('missing'));
      const missing = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/skills/missing/enable`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ enabled: false });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('skill_not_found');

      const invalidClient = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/skills/review/enable`,
        )
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'forged-client')
        .set('Host', host())
        .send({ enabled: false });
      expect(invalidClient.status).toBe(400);
      expect(invalidClient.body.code).toBe('invalid_client_id');

      const invalidBatchClient = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/skills/enable`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'forged-client')
        .set('Host', host())
        .send({ skillNames: ['review'], enabled: false });
      expect(invalidBatchClient.status).toBe(400);
      expect(invalidBatchClient.body.code).toBe('invalid_client_id');
      expect(
        h.secondaryWorkspaceService.setWorkspaceSkillsEnabled,
      ).toHaveBeenCalledTimes(1);

      const badBatchBody = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/skills/enable`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .set('Host', host())
        .send({ skillNames: [], enabled: false });
      expect(badBatchBody.status).toBe(400);
      expect(badBatchBody.body.code).toBe('invalid_skill_names');
      expect(
        h.secondaryWorkspaceService.setWorkspaceSkillsEnabled,
      ).toHaveBeenCalledTimes(1);

      const enableBatch = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/skills/enable`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .set('Host', host())
        .send({ skillNames: ['review'], enabled: true });
      expect(enableBatch.status).toBe(200);
      expect(enableBatch.body).toMatchObject({
        enabled: true,
        results: [{ skillName: 'review', enabled: true, changed: true }],
      });
      expect(
        h.secondaryWorkspaceService.setWorkspaceSkillsEnabled,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceCwd: h.secondaryCwd,
          originatorClientId: 'client-1',
        }),
        ['review'],
        true,
      );
      expect(
        h.secondaryWorkspaceService.setWorkspaceSkillsEnabled,
      ).toHaveBeenCalledTimes(2);

      vi.mocked(
        h.secondaryWorkspaceService.setWorkspaceSkillsEnabled,
      ).mockRejectedValueOnce(new Error('disk full'));
      const failedBatch = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/skills/enable`)
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'client-1')
        .set('Host', host())
        .send({ skillNames: ['review'], enabled: false });
      expect(failedBatch.status).toBe(500);
      expect(failedBatch.body.error).toBe('disk full');
      expect(
        h.secondaryWorkspaceService.setWorkspaceSkillsEnabled,
      ).toHaveBeenCalledTimes(3);
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }

    const untrusted = await makeHarness({
      secondaryTrusted: false,
      token: 'secret',
    });
    try {
      const res = await request(untrusted.app)
        .post(
          `/workspaces/${encodeURIComponent(untrusted.secondaryId)}/skills/review/enable`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ enabled: false });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');

      const batch = await request(untrusted.app)
        .post(
          `/workspaces/${encodeURIComponent(untrusted.secondaryId)}/skills/enable`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ skillNames: ['review'], enabled: false });
      expect(batch.status).toBe(403);
      expect(batch.body.code).toBe('untrusted_workspace');
      expect(
        untrusted.secondaryWorkspaceService.setWorkspaceSkillsEnabled,
      ).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(untrusted.scratch, { recursive: true, force: true });
    }
  });

  it('routes project agents to the selected workspace', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const create = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/agents`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({
          name: 'ws-agent',
          description: 'secondary agent',
          systemPrompt: 'Operate in the secondary workspace.',
          scope: 'workspace',
        });
      expect(create.status).toBe(201);
      expect(create.body.agent).toMatchObject({
        name: 'ws-agent',
        level: 'project',
      });

      const selected = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/agents`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(selected.status).toBe(200);
      expect(
        (selected.body.agents as Array<{ name: string }>).map((a) => a.name),
      ).toContain('ws-agent');

      const detail = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/agents/ws-agent`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        name: 'ws-agent',
        description: 'secondary agent',
        level: 'project',
      });

      const update = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/agents/ws-agent`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ description: 'updated secondary agent' });
      expect(update.status).toBe(200);
      expect(update.body).toMatchObject({
        changed: true,
        agent: {
          name: 'ws-agent',
          description: 'updated secondary agent',
          level: 'project',
        },
      });

      const primary = await request(h.app)
        .get('/workspaces/same-as-path/agents')
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(primary.status).toBe(200);
      expect(
        (primary.body.agents as Array<{ name: string }>).map((a) => a.name),
      ).not.toContain('ws-agent');

      const deleted = await request(h.app)
        .delete(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/agents/ws-agent`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(deleted.status).toBe(204);
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('rejects global and user scope on workspace-qualified agents routes', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const create = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/agents`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({
          name: 'bad-agent',
          description: 'bad agent',
          systemPrompt: 'Do not create.',
          scope: 'global',
        });
      expect(create.status).toBe(400);
      expect(create.body.code).toBe(
        'global_scope_not_supported_for_workspace_route',
      );

      const list = await request(h.app)
        .get(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/agents?scope=global`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(list.status).toBe(400);
      expect(list.body.code).toBe(
        'global_scope_not_supported_for_workspace_route',
      );

      const detail = await request(h.app)
        .get(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/agents/ws-agent?scope=user`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(detail.status).toBe(400);
      expect(detail.body.code).toBe(
        'global_scope_not_supported_for_workspace_route',
      );

      const update = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/agents/ws-agent?scope=user`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ description: 'bad update' });
      expect(update.status).toBe(400);
      expect(update.body.code).toBe(
        'global_scope_not_supported_for_workspace_route',
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes workspace-qualified memory reads and writes to the selected workspace', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const write = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/memory`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({
          scope: 'workspace',
          mode: 'replace',
          content: '# Secondary memory\n',
        });
      expect(write.status).toBe(200);
      expect(write.body.filePath).toBe(path.join(h.secondaryCwd, 'QWEN.md'));
      expect(write.body.changed).toBe(true);

      const read = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/memory`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(read.status).toBe(200);
      expect(read.body.workspaceCwd).toBe(h.secondaryCwd);
      expect(read.body.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: path.join(h.secondaryCwd, 'QWEN.md'),
            scope: 'workspace',
          }),
        ]),
      );
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('routes managed-memory tasks to the selected workspace bridge', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const queued = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/memory/remember`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ content: 'Secondary only', scope: 'project' });
      expect(queued.status).toBe(202);

      await vi.waitFor(() => {
        expect(
          h.secondaryBridge.runWorkspaceMemoryRemember,
        ).toHaveBeenCalledWith({
          content: 'Secondary only',
          contextMode: 'workspace',
          scope: 'project',
        });
      });
      expect(h.primaryBridge.runWorkspaceMemoryRemember).not.toHaveBeenCalled();

      const completed = await request(h.app)
        .get(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/memory/remember/${queued.body.taskId}`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(completed.status).toBe(200);
      expect(completed.body).toMatchObject({
        status: 'completed',
        result: { touchedScopes: ['project'] },
      });

      const userScope = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/memory/remember`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ content: 'Shared preference', scope: 'user' });
      expect(userScope.status).toBe(202);
      await vi.waitFor(() => {
        expect(
          h.secondaryBridge.runWorkspaceMemoryRemember,
        ).toHaveBeenNthCalledWith(2, {
          content: 'Shared preference',
          contextMode: 'workspace',
          scope: 'user',
        });
      });

      const invalidScope = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/memory/remember`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ content: 'Wrong scope', scope: 'global' });
      expect(invalidScope.status).toBe(400);
      expect(invalidScope.body).toMatchObject({ code: 'invalid_scope' });
      expect(
        h.secondaryBridge.runWorkspaceMemoryRemember,
      ).toHaveBeenCalledTimes(2);

      const forget = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/memory/forget`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ query: 'Secondary only', scope: 'user' });
      expect(forget.status).toBe(202);
      await vi.waitFor(() => {
        expect(h.secondaryBridge.runWorkspaceMemoryForget).toHaveBeenCalledWith(
          { query: 'Secondary only', scope: 'user' },
        );
      });
      expect(h.primaryBridge.runWorkspaceMemoryForget).not.toHaveBeenCalled();

      const invalidForgetScope = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/memory/forget`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ query: 'Wrong scope', scope: 'global' });
      expect(invalidForgetScope.status).toBe(400);
      expect(invalidForgetScope.body).toMatchObject({ code: 'invalid_scope' });
      expect(h.secondaryBridge.runWorkspaceMemoryForget).toHaveBeenCalledTimes(
        1,
      );

      const dream = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/memory/dream`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({});
      expect(dream.status).toBe(202);
      await vi.waitFor(() => {
        expect(h.secondaryBridge.runWorkspaceMemoryDream).toHaveBeenCalled();
      });
      expect(h.primaryBridge.runWorkspaceMemoryDream).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('rejects managed-memory tasks for an untrusted workspace', async () => {
    const h = await makeHarness({
      secondaryTrusted: false,
      token: 'secret',
    });
    try {
      const res = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/memory/remember`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ content: 'Do not save' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
      expect(
        h.secondaryBridge.runWorkspaceMemoryRemember,
      ).not.toHaveBeenCalled();
      expect(h.primaryBridge.runWorkspaceMemoryRemember).not.toHaveBeenCalled();

      const forget = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/memory/forget`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ query: 'Do not forget' });
      expect(forget.status).toBe(403);
      expect(forget.body.code).toBe('untrusted_workspace');
      expect(h.secondaryBridge.runWorkspaceMemoryForget).not.toHaveBeenCalled();
      expect(h.primaryBridge.runWorkspaceMemoryForget).not.toHaveBeenCalled();

      const dream = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/memory/dream`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({});
      expect(dream.status).toBe(403);
      expect(dream.body.code).toBe('untrusted_workspace');
      expect(h.secondaryBridge.runWorkspaceMemoryDream).not.toHaveBeenCalled();
      expect(h.primaryBridge.runWorkspaceMemoryDream).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('creates a managed-memory lane on demand for a dynamically-added workspace', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const lateCwd = canonicalizeWorkspace(path.join(h.scratch, 'late'));
      await fsp.mkdir(lateCwd, { recursive: true });
      const lateId = hashDaemonWorkspace(lateCwd);
      const lateBridge = makeBridge();
      h.workspaceRegistry.add({
        workspaceId: lateId,
        workspaceCwd: lateCwd,
        sessionRuntimeBaseDir: path.join(lateCwd, '.runtime'),
        primary: false,
        trusted: true,
        env: { mode: 'parent-process', overlayKeys: [] },
        bridge: lateBridge,
        workspaceService: makeWorkspaceService('late'),
        routeFileSystemFactory: createWorkspaceFileSystemFactory({
          boundWorkspaces: [lateCwd],
          trusted: true,
          emit: () => {},
        }),
        clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
        generationGuard: createWorkspaceGenerationGuard(),
      });

      const res = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(lateId)}/memory/remember`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ content: 'Late workspace' });

      expect(res.status).toBe(202);
      await vi.waitFor(() => {
        expect(lateBridge.runWorkspaceMemoryRemember).toHaveBeenCalledWith({
          content: 'Late workspace',
          contextMode: 'workspace',
        });
      });
      expect(h.primaryBridge.runWorkspaceMemoryRemember).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('shares the singular lane for the primary workspace qualified route', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const queued = await request(h.app)
        .post('/workspace/memory/remember')
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ content: 'Primary via singular' });
      expect(queued.status).toBe(202);
      const taskId = queued.body.taskId as string;

      await vi.waitFor(() => {
        expect(h.primaryBridge.runWorkspaceMemoryRemember).toHaveBeenCalled();
      });

      const viaQualified = await request(h.app)
        .get(`/workspaces/same-as-path/memory/remember/${taskId}`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(viaQualified.status).toBe(200);
      expect(viaQualified.body).toMatchObject({ taskId, status: 'completed' });
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('returns 404 when reading a task id from another workspace', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const queued = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/memory/remember`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ content: 'Secondary only' });
      expect(queued.status).toBe(202);
      const taskId = queued.body.taskId as string;

      const crossRead = await request(h.app)
        .get(`/workspaces/same-as-path/memory/remember/${taskId}`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(crossRead.status).toBe(404);
      expect(crossRead.body.code).toBe('remember_task_not_found');
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('returns 404 when polling a task on a workspace that never enqueued one', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const lateCwd = canonicalizeWorkspace(path.join(h.scratch, 'late'));
      await fsp.mkdir(lateCwd, { recursive: true });
      const lateId = hashDaemonWorkspace(lateCwd);
      const lateBridge = makeBridge();
      h.workspaceRegistry.add({
        workspaceId: lateId,
        workspaceCwd: lateCwd,
        sessionRuntimeBaseDir: path.join(lateCwd, '.runtime'),
        primary: false,
        trusted: true,
        env: { mode: 'parent-process', overlayKeys: [] },
        bridge: lateBridge,
        workspaceService: makeWorkspaceService('late'),
        routeFileSystemFactory: createWorkspaceFileSystemFactory({
          boundWorkspaces: [lateCwd],
          trusted: true,
          emit: () => {},
        }),
        clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
        generationGuard: createWorkspaceGenerationGuard(),
      });

      // No POST first, so the workspace has no lane: the poll must answer a
      // permanent 404 rather than allocate a mount or report a retryable 503.
      const res = await request(h.app)
        .get(
          `/workspaces/${encodeURIComponent(lateId)}/memory/remember/never-enqueued`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('remember_task_not_found');
      expect(lateBridge.runWorkspaceMemoryRemember).not.toHaveBeenCalled();
      const acpHandle = h.app.locals['acpHandle'] as AcpHttpHandle | undefined;
      expect(acpHandle?.getWorkspaceRememberLane(lateId)).toBeUndefined();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('fails closed for unknown and draining workspace runtimes', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      const unknown = await request(h.app)
        .post('/workspaces/does-not-exist/memory/remember')
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ content: 'x' });
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('workspace_mismatch');

      const secondaryRuntime = h.workspaceRegistry.getByWorkspaceId(
        h.secondaryId,
      );
      expect(secondaryRuntime).toBeDefined();
      expect(h.workspaceRegistry.beginDrain(secondaryRuntime!)).toBe(true);

      const draining = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/memory/remember`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ content: 'x' });
      expect(draining.status).toBe(503);
      expect(draining.body.code).toBe('workspace_runtime_unavailable');
      expect(
        h.secondaryBridge.runWorkspaceMemoryRemember,
      ).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('keeps the primary qualified route alive when ACP HTTP is disabled', async () => {
    const original = process.env['QWEN_SERVE_ACP_HTTP'];
    process.env['QWEN_SERVE_ACP_HTTP'] = '0';
    const h = await makeHarness({ token: 'secret' });
    try {
      const primary = await request(h.app)
        .post('/workspaces/same-as-path/memory/remember')
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ content: 'Primary without ACP HTTP' });
      expect(primary.status).toBe(202);
      await vi.waitFor(() => {
        expect(h.primaryBridge.runWorkspaceMemoryRemember).toHaveBeenCalled();
      });

      const secondary = await request(h.app)
        .post(
          `/workspaces/${encodeURIComponent(h.secondaryId)}/memory/remember`,
        )
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ content: 'Secondary without ACP HTTP' });
      expect(secondary.status).toBe(501);
      expect(secondary.body.code).toBe('workspace_memory_unavailable');
      expect(secondary.headers['retry-after']).toBeUndefined();
      expect(
        h.secondaryBridge.runWorkspaceMemoryRemember,
      ).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete process.env['QWEN_SERVE_ACP_HTTP'];
      } else {
        process.env['QWEN_SERVE_ACP_HTTP'] = original;
      }
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('rejects global and user scope on workspace-qualified memory routes', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      for (const scope of ['global', 'user']) {
        const res = await request(h.app)
          .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/memory`)
          .set('Authorization', 'Bearer secret')
          .set('Host', host())
          .send({ scope, mode: 'replace', content: '# ignored\n' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe(
          'global_scope_not_supported_for_workspace_route',
        );
      }
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });

  it('returns typed memory write errors on workspace-qualified routes', async () => {
    const h = await makeHarness({ token: 'secret' });
    try {
      await fsp.writeFile(
        path.join(h.secondaryCwd, 'QWEN.md'),
        'x'.repeat(17 * 1024 * 1024),
        'utf8',
      );

      const res = await request(h.app)
        .post(`/workspaces/${encodeURIComponent(h.secondaryId)}/memory`)
        .set('Authorization', 'Bearer secret')
        .set('Host', host())
        .send({ scope: 'workspace', mode: 'append', content: '- entry' });

      expect(res.status).toBe(413);
      expect(res.body.code).toBe('memory_file_too_large');
      expect(res.body.scope).toBe('workspace');
      expect(res.body.mode).toBe('append');
      expect(res.body.bytes).toBe(17 * 1024 * 1024);
      expect(res.body.limit).toBe(16 * 1024 * 1024);
      expect(res.body.filePath).toBeUndefined();
      expect(res.body.error).not.toContain(h.secondaryCwd);
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
    }
  });
});
