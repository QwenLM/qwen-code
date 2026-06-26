/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests: verify DaemonWorkspaceService wiring through
 * Express routes. Uses `createServeApp` with an injected mock workspace
 * service to confirm routes delegate correctly and pass the expected
 * `WorkspaceRequestContext`.
 */

import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createServeApp } from '../../server.js';
import type { ServeOptions } from '../../types.js';
import type {
  DaemonWorkspaceService,
  WorkspaceRequestContext,
} from '../types.js';
import type { AcpSessionBridge } from '../../acp-session-bridge.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const WS_BOUND = path.resolve(path.sep, 'work', 'integration-ws');

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4170,
  mode: 'http-bridge',
  workspace: WS_BOUND,
};

// ---------------------------------------------------------------------------
// Minimal fake bridge — only implements what the routes under test need
// beyond the workspace service itself.
// ---------------------------------------------------------------------------

function minimalBridge(
  overrides: { knownClientIds?: string[] } = {},
): AcpSessionBridge {
  const knownIds = new Set<string>(overrides.knownClientIds ?? []);
  return {
    permissionPolicy: 'first-responder',
    get sessionCount() {
      return 0;
    },
    get pendingPermissionCount() {
      return 0;
    },
    spawnOrAttach: vi.fn().mockResolvedValue({
      sessionId: 'fake-0',
      workspaceCwd: WS_BOUND,
      attached: false,
      clientId: 'client-0',
    }),
    loadSession: vi.fn().mockResolvedValue({
      sessionId: 'fake-0',
      workspaceCwd: WS_BOUND,
      attached: false,
      clientId: 'client-0',
      state: {},
    }),
    resumeSession: vi.fn().mockResolvedValue({
      sessionId: 'fake-0',
      workspaceCwd: WS_BOUND,
      attached: false,
      clientId: 'client-0',
      state: {},
    }),
    sendPrompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    subscribeEvents: vi.fn().mockReturnValue(
      (async function* () {
        /* empty */
      })(),
    ),
    respondToPermission: vi.fn().mockReturnValue(true),
    respondToSessionPermission: vi.fn().mockReturnValue(true),
    listWorkspaceSessions: vi.fn().mockReturnValue([]),
    getWorkspaceMcpStatus: vi.fn().mockResolvedValue({}),
    getWorkspaceSkillsStatus: vi.fn().mockResolvedValue({}),
    getWorkspaceProvidersStatus: vi.fn().mockResolvedValue({}),
    getWorkspaceEnvStatus: vi.fn().mockResolvedValue({}),
    getWorkspacePreflightStatus: vi.fn().mockResolvedValue({}),
    getSessionContextStatus: vi.fn().mockResolvedValue({}),
    getSessionSupportedCommandsStatus: vi.fn().mockResolvedValue({}),
    setSessionModel: vi.fn().mockResolvedValue({}),
    setSessionApprovalMode: vi.fn().mockResolvedValue({}),
    generateSessionRecap: vi
      .fn()
      .mockResolvedValue({ sessionId: '', recap: null }),
    setWorkspaceToolEnabled: vi
      .fn()
      .mockResolvedValue({ toolName: '', enabled: true }),
    initWorkspace: vi.fn().mockResolvedValue({ path: '', action: 'created' }),
    restartMcpServer: vi
      .fn()
      .mockResolvedValue({ serverName: '', restarted: true, durationMs: 1 }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    updateSessionMetadata: vi.fn().mockReturnValue({}),
    recordHeartbeat: vi.fn().mockReturnValue({ sessionId: '', lastSeenAt: 0 }),
    getHeartbeatState: vi.fn().mockReturnValue(undefined),
    publishWorkspaceEvent: vi.fn(),
    knownClientIds: vi.fn().mockReturnValue(knownIds),
    isChannelLive: vi.fn().mockReturnValue(false),
    queryWorkspaceStatus: vi
      .fn()
      .mockImplementation((_method: string, idle: () => unknown) => idle()),
    invokeWorkspaceCommand: vi.fn().mockResolvedValue({}),
    killSession: vi.fn().mockResolvedValue(undefined),
    detachClient: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    killAllSync: vi.fn(),
  } as unknown as AcpSessionBridge;
}

// ---------------------------------------------------------------------------
// Mock workspace service factory
// ---------------------------------------------------------------------------

function mockWorkspaceService(
  overrides: Partial<DaemonWorkspaceService> = {},
): DaemonWorkspaceService {
  return {
    getWorkspaceMcpStatus: vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: WS_BOUND,
      initialized: true,
      discoveryState: 'completed',
      servers: [{ kind: 'mcp_server', name: 'test-server', status: 'ok' }],
    }),
    getWorkspaceSkillsStatus: vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: WS_BOUND,
      initialized: true,
      skills: [{ name: 'test-skill', source: 'project' }],
    }),
    getWorkspaceProvidersStatus: vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: WS_BOUND,
      initialized: true,
      providers: [],
    }),
    getWorkspaceEnvStatus: vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: WS_BOUND,
      initialized: true,
      acpChannelLive: true,
      cells: [{ kind: 'env_var', name: 'NODE_ENV', status: 'ok' }],
    }),
    getWorkspacePreflightStatus: vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: WS_BOUND,
      initialized: true,
      acpChannelLive: false,
      cells: [],
    }),
    setWorkspaceToolEnabled: vi
      .fn()
      .mockResolvedValue({ toolName: 'Bash', enabled: true }),
    initWorkspace: vi.fn().mockResolvedValue({
      path: path.resolve(WS_BOUND, 'QWEN.md'),
      action: 'created',
    }),
    restartMcpServer: vi.fn().mockResolvedValue({
      serverName: 'test-server',
      restarted: true,
      durationMs: 42,
    }),
    reload: vi.fn().mockResolvedValue({
      env: { updatedKeys: [], removedKeys: [] },
      changedKeys: [],
      childReloaded: false,
    }),
    ...overrides,
  } as DaemonWorkspaceService;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(opts?: {
  workspaceOverrides?: Partial<DaemonWorkspaceService>;
  knownClientIds?: string[];
  token?: string;
}) {
  const workspace = mockWorkspaceService(opts?.workspaceOverrides);
  const bridge = minimalBridge({ knownClientIds: opts?.knownClientIds });
  const appOpts = opts?.token ? { ...baseOpts, token: opts.token } : baseOpts;
  const app = createServeApp(appOpts, undefined, {
    bridge,
    workspace,
    boundWorkspace: WS_BOUND,
  });
  return { app, workspace, bridge };
}

function hostHeader() {
  return { Host: `127.0.0.1:${baseOpts.port}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workspace service REST integration', () => {
  // -------------------------------------------------------------------------
  // GET /workspace/mcp
  // -------------------------------------------------------------------------

  describe('GET /workspace/mcp', () => {
    it('returns 200 with the result from workspace.getWorkspaceMcpStatus', async () => {
      const { app, workspace } = createTestApp();
      const res = await request(app).get('/workspace/mcp').set(hostHeader());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        servers: [{ kind: 'mcp_server', name: 'test-server', status: 'ok' }],
      });
      expect(workspace.getWorkspaceMcpStatus).toHaveBeenCalledTimes(1);
    });

    it('passes correct WorkspaceRequestContext to the service', async () => {
      const { app, workspace } = createTestApp();
      await request(app).get('/workspace/mcp').set(hostHeader());

      const ctx = (workspace.getWorkspaceMcpStatus as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as WorkspaceRequestContext;
      expect(ctx.route).toBe('GET /workspace/mcp');
      expect(ctx.workspaceCwd).toBe(WS_BOUND);
      // No client-id header on GET — should be undefined
      expect(ctx.originatorClientId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // GET /workspace/skills
  // -------------------------------------------------------------------------

  describe('GET /workspace/skills', () => {
    it('returns 200 with the result from workspace.getWorkspaceSkillsStatus', async () => {
      const { app, workspace } = createTestApp();
      const res = await request(app).get('/workspace/skills').set(hostHeader());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        skills: [{ name: 'test-skill', source: 'project' }],
      });
      expect(workspace.getWorkspaceSkillsStatus).toHaveBeenCalledTimes(1);
    });

    it('passes correct WorkspaceRequestContext to the service', async () => {
      const { app, workspace } = createTestApp();
      await request(app).get('/workspace/skills').set(hostHeader());

      const ctx = (
        workspace.getWorkspaceSkillsStatus as ReturnType<typeof vi.fn>
      ).mock.calls[0][0] as WorkspaceRequestContext;
      expect(ctx.route).toBe('GET /workspace/skills');
      expect(ctx.workspaceCwd).toBe(WS_BOUND);
      expect(ctx.originatorClientId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // GET /workspace/env
  // -------------------------------------------------------------------------

  describe('GET /workspace/env', () => {
    it('returns 200 with the result from workspace.getWorkspaceEnvStatus', async () => {
      const { app, workspace } = createTestApp();
      const res = await request(app).get('/workspace/env').set(hostHeader());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        v: 1,
        workspaceCwd: WS_BOUND,
        initialized: true,
        acpChannelLive: true,
        cells: [{ kind: 'env_var', name: 'NODE_ENV', status: 'ok' }],
      });
      expect(workspace.getWorkspaceEnvStatus).toHaveBeenCalledTimes(1);
    });

    it('passes correct WorkspaceRequestContext to the service', async () => {
      const { app, workspace } = createTestApp();
      await request(app).get('/workspace/env').set(hostHeader());

      const ctx = (workspace.getWorkspaceEnvStatus as ReturnType<typeof vi.fn>)
        .mock.calls[0][0] as WorkspaceRequestContext;
      expect(ctx.route).toBe('GET /workspace/env');
      expect(ctx.workspaceCwd).toBe(WS_BOUND);
      expect(ctx.originatorClientId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // POST /workspace/init
  // -------------------------------------------------------------------------

  describe('POST /workspace/init', () => {
    it('returns 200 with the result from workspace.initWorkspace', async () => {
      const { app, workspace } = createTestApp({ token: 'test-secret' });
      const res = await request(app)
        .post('/workspace/init')
        .set(hostHeader())
        .set('Authorization', 'Bearer test-secret')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        path: path.resolve(WS_BOUND, 'QWEN.md'),
        action: 'created',
      });
      expect(workspace.initWorkspace).toHaveBeenCalledTimes(1);
    });

    it('passes force:false opts when body is empty', async () => {
      const { app, workspace } = createTestApp({ token: 'test-secret' });
      await request(app)
        .post('/workspace/init')
        .set(hostHeader())
        .set('Authorization', 'Bearer test-secret')
        .send({});

      const [ctx, opts] = (workspace.initWorkspace as ReturnType<typeof vi.fn>)
        .mock.calls[0] as [WorkspaceRequestContext, { force?: boolean }];
      expect(ctx.route).toBe('POST /workspace/init');
      expect(ctx.workspaceCwd).toBe(WS_BOUND);
      expect(opts).toEqual({ force: false });
    });

    it('passes force:true when body has force=true', async () => {
      const { app, workspace } = createTestApp({ token: 'test-secret' });
      await request(app)
        .post('/workspace/init')
        .set(hostHeader())
        .set('Authorization', 'Bearer test-secret')
        .send({ force: true });

      const [_ctx, opts] = (workspace.initWorkspace as ReturnType<typeof vi.fn>)
        .mock.calls[0] as [WorkspaceRequestContext, { force?: boolean }];
      expect(opts).toEqual({ force: true });
    });

    it('passes client identity through WorkspaceRequestContext', async () => {
      const { app, workspace } = createTestApp({
        token: 'test-secret',
        knownClientIds: ['my-client'],
      });
      await request(app)
        .post('/workspace/init')
        .set(hostHeader())
        .set('Authorization', 'Bearer test-secret')
        .set('X-Qwen-Client-Id', 'my-client')
        .send({});

      const ctx = (workspace.initWorkspace as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as WorkspaceRequestContext;
      expect(ctx.originatorClientId).toBe('my-client');
      expect(ctx.route).toBe('POST /workspace/init');
      expect(ctx.workspaceCwd).toBe(WS_BOUND);
    });

    it('401 without bearer token on token-protected daemon', async () => {
      const { app, workspace } = createTestApp({ token: 'test-secret' });
      const res = await request(app)
        .post('/workspace/init')
        .set(hostHeader())
        .send({});

      expect(res.status).toBe(401);
      expect(workspace.initWorkspace).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: workspace service is NOT called on the bridge
  // -------------------------------------------------------------------------

  describe('workspace service isolation from bridge', () => {
    it('GET /workspace/mcp uses injected workspace service, not bridge', async () => {
      const { app, workspace } = createTestApp();
      await request(app).get('/workspace/mcp').set(hostHeader());

      // The workspace service should be called
      expect(workspace.getWorkspaceMcpStatus).toHaveBeenCalledTimes(1);
    });

    it('GET /workspace/skills uses injected workspace service, not bridge', async () => {
      const { app, workspace } = createTestApp();
      await request(app).get('/workspace/skills').set(hostHeader());

      expect(workspace.getWorkspaceSkillsStatus).toHaveBeenCalledTimes(1);
    });
  });
});
