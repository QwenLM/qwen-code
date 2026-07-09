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
    knownClientIds: () => new Set<string>(),
    publishWorkspaceEvent: vi.fn(),
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

  const app = createServeApp(
    { ...baseOpts, workspace: primaryCwd, token: opts?.token },
    undefined,
    {
      workspaceRegistry: createWorkspaceRegistry([primary, secondary]),
      persistSetting: vi.fn(async () => {}),
    },
  );

  return {
    app,
    scratch,
    primaryCwd,
    secondaryCwd,
    secondaryId: secondary.workspaceId,
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
  const app = createServeApp(
    { ...baseOpts, workspace: primaryCwd },
    undefined,
    {
      workspaceRegistry: createWorkspaceRegistry([primary, windowsRuntime]),
      persistSetting: vi.fn(async () => {}),
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
    } finally {
      await fsp.rm(h.scratch, { recursive: true, force: true });
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

      const primary = await request(h.app)
        .get('/workspaces/same-as-path/agents')
        .set('Authorization', 'Bearer secret')
        .set('Host', host());
      expect(primary.status).toBe(200);
      expect(
        (primary.body.agents as Array<{ name: string }>).map((a) => a.name),
      ).not.toContain('ws-agent');
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
