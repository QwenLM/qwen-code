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
import {
  canonicalizeWorkspace,
  createWorkspaceFileSystemFactory,
} from './fs/index.js';
import type { ServeOptions } from './types.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';
import type { DaemonWorkspaceService } from './workspace-service/types.js';

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
    getDaemonStatusSnapshot: vi.fn(() => ({
      limits: {
        maxSessions: 20,
        maxPendingPromptsPerSession: 5,
        eventRingSize: 8000,
        compactedReplayMaxBytes: 4 * 1024 * 1024,
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
  secondaryTrusted?: boolean;
  secondaryDirName?: string;
  token?: string;
  persistSetting?: boolean;
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

  const primaryFsFactory = createWorkspaceFileSystemFactory({
    boundWorkspaces: [primaryCwd],
    trusted: true,
    emit: () => {},
  });
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

  const primary: WorkspaceRuntime = {
    workspaceId: 'same-as-path',
    workspaceCwd: primaryCwd,
    primary: true,
    trusted: true,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: makeBridge(),
    workspaceService: makeWorkspaceService('primary'),
    routeFileSystemFactory: primaryFsFactory,
    clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
  };
  const secondary: WorkspaceRuntime = {
    workspaceId: hashDaemonWorkspace(secondaryCwd),
    workspaceCwd: secondaryCwd,
    primary: false,
    trusted: opts?.secondaryTrusted ?? true,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: makeBridge(),
    workspaceService: makeWorkspaceService('secondary'),
    routeFileSystemFactory:
      opts?.secondaryTrusted === false
        ? untrustedFsFactory
        : secondaryFsFactory,
    clientMcpSenderRegistry: new ClientMcpSenderRegistry(),
  };

  const persistSetting = vi.fn(async () => {});
  const app = createServeApp(
    { ...baseOpts, workspace: primaryCwd, token: opts?.token },
    undefined,
    {
      workspaceRegistry: createWorkspaceRegistry([primary, secondary]),
      ...(opts?.persistSetting === false ? {} : { persistSetting }),
    },
  );

  return {
    app,
    scratch,
    primaryCwd,
    secondaryCwd,
    secondaryId: secondary.workspaceId,
    persistSetting,
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

  it('allows untrusted workspace file reads but rejects other core reads', async () => {
    const h = await makeHarness({ secondaryTrusted: false });
    try {
      const file = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/file`)
        .query({ path: 'target.txt' })
        .set('Host', host());
      expect(file.status).toBe(200);
      expect(file.body.content).toBe('secondary');

      const mcp = await request(h.app)
        .get(`/workspaces/${encodeURIComponent(h.secondaryId)}/mcp`)
        .set('Host', host());
      expect(mcp.status).toBe(403);
      expect(mcp.body.code).toBe('untrusted_workspace');
      expect(mcp.body.error).toBe('Workspace is not trusted.');
      expect(mcp.body).not.toHaveProperty('workspaceCwd');
      expect(mcp.body).not.toHaveProperty('workspaceId');
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
