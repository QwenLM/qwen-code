import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import request from 'supertest';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import { BridgeChannelClosedError } from '@qwen-code/acp-bridge/status';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendBridgeError } from '../server/error-response.js';
import type { DaemonTrustPolicySnapshot } from '../../config/daemon-trust-policy.js';
import { SkillInstallAttemptStore } from '../skill-install-attempts.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  WorkspaceSkillManagementError,
  WorkspaceSkillRecoveryError,
  type WorkspaceSkillInstallOptions,
  type WorkspaceSkillInstallRequest,
} from '../workspace-skill-management.js';
import {
  WorkspaceSkillNotFoundError,
  type WorkspaceSkillBatchToggleResult,
  type WorkspaceSkillToggleResult,
} from '../workspace-service/types.js';
import {
  registerWorkspaceQualifiedSkillsRoutes,
  registerWorkspaceSkillsRoutes,
} from './workspace-skills.js';

function createHarness(
  trusted = true,
  runtimeLive = false,
  getWorkspaceTrustPolicySnapshot?: () => DaemonTrustPolicySnapshot,
) {
  const configStatus = {
    v: 1 as const,
    workspaceCwd: '/workspace',
    initialized: true,
    skills: [
      {
        kind: 'skill' as const,
        status: 'ok' as const,
        name: 'configured',
        description: 'Configured Skill',
        level: 'project' as const,
        modelInvocable: true,
      },
      {
        kind: 'skill' as const,
        status: 'ok' as const,
        name: 'configured',
        description: 'Configured user Skill',
        level: 'user' as const,
        modelInvocable: true,
        installedPath: '/global/skills/configured/SKILL.md',
      },
    ],
  };
  const runtimeStatus = {
    v: 1 as const,
    workspaceCwd: '/workspace',
    initialized: true,
    runtimeEpoch: 2,
    skills: [{ name: 'runtime', level: 'extension' }],
  };
  const getWorkspaceSkillsConfigStatus = vi
    .fn()
    .mockResolvedValue(configStatus);
  const getWorkspaceSkillsRuntimeStatus = vi
    .fn()
    .mockResolvedValue(runtimeStatus);
  const getSkillsConfigStatus = vi.fn().mockResolvedValue(configStatus);
  const getSkillsSnapshot = vi.fn(async (workspaceCwd: string) => ({
    workspaceCwd,
    skills: [{ name: 'enabled', description: 'Test', body: 'BODY' }],
  }));
  const invalidateSkillsConfigStatus = vi.fn();
  const invalidateWorkspaceSkillsStatus = vi.fn();
  const installWorkspaceSkill = vi.fn(
    async (
      _ctx: unknown,
      input: WorkspaceSkillInstallRequest,
      options?: WorkspaceSkillInstallOptions,
    ) => {
      options?.beforePublish?.();
      const result = {
        skillName: input.name,
        scope: input.scope,
        installedPath: '/workspace/.qwen/skills/demo-skill/SKILL.md',
      };
      options?.onCommitted?.(result);
      return result;
    },
  );
  const deleteWorkspaceSkill = vi.fn().mockResolvedValue({
    skillName: 'demo-skill',
    scope: 'global',
    deleted: true,
  });
  const setWorkspaceSkillEnabled = vi.fn(
    async (
      _ctx: unknown,
      skillName: string,
      enabled: boolean,
    ): Promise<WorkspaceSkillToggleResult> => ({
      skillName: skillName.toLowerCase(),
      enabled,
      changed: true,
      activation: 'applied',
      sessionsRefreshed: 1,
      sessionsFailed: 0,
    }),
  );
  const setWorkspaceSkillsEnabled = vi.fn(
    async (
      _ctx: unknown,
      skillNames: readonly string[],
      enabled: boolean,
    ): Promise<WorkspaceSkillBatchToggleResult> => ({
      enabled,
      activation: 'applied',
      sessionsRefreshed: 1,
      sessionsFailed: 0,
      results: skillNames.map((skillName) => ({
        skillName: skillName.toLowerCase(),
        enabled,
        changed: true,
      })),
      errors: [],
    }),
  );
  const bridge = {
    knownClientIds: () => new Set(['client-1']),
    getSessionSummary: vi.fn((sessionId: string) => {
      if (sessionId === 'session-1') return { sessionId };
      throw new SessionNotFoundError(sessionId);
    }),
    getWorkspaceRuntimeLifecycleSnapshot: () => ({
      state: runtimeLive ? ('idle' as const) : ('cold' as const),
      runtimeLive,
      runtimeEpoch: runtimeLive ? 1 : 0,
      activeWork: false,
    }),
  };
  const refreshWorkspaceSkills = vi.fn().mockResolvedValue({
    sessionsRefreshed: 1,
    sessionsFailed: 0,
    configsRefreshed: 1,
    configsFailed: 0,
    reason: 'all',
  });
  const runtime = {
    workspaceId: 'workspace-1',
    workspaceCwd: '/workspace',
    primary: true,
    trusted,
    bridge,
    workspaceService: {
      refreshWorkspaceSkills,
      getWorkspaceSkillsConfigStatus,
      getWorkspaceSkillsRuntimeStatus,
      invalidateWorkspaceSkillsStatus,
      installWorkspaceSkill,
      deleteWorkspaceSkill,
      setWorkspaceSkillEnabled,
      setWorkspaceSkillsEnabled,
    },
  } as unknown as WorkspaceRuntime;
  const workspaceRegistry = createWorkspaceRegistry([runtime]);
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const routeDeps = {
    archiveInstalls: new SkillInstallAttemptStore(),
    getWorkspaceTrustPolicySnapshot,
    mutate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    safeBody: (req: Request) => req.body as Record<string, unknown>,
    sendBridgeError,
    getSkillsConfigStatus,
    getSkillsSnapshot,
    invalidateSkillsConfigStatus,
  };
  registerWorkspaceSkillsRoutes(app, {
    ...routeDeps,
    workspaceRuntime: runtime,
    workspaceRegistry,
    installSkillConfig: (workspaceCwd, request, options) =>
      options
        ? installWorkspaceSkill(workspaceCwd, request, options)
        : installWorkspaceSkill(workspaceCwd, request),
    deleteSkillConfig: (workspaceCwd, scope, skillName, installedPath) =>
      deleteWorkspaceSkill(workspaceCwd, scope, skillName, installedPath),
    parseAndValidateClientId: () => 'client-1',
  });
  registerWorkspaceQualifiedSkillsRoutes(app, {
    ...routeDeps,
    workspaceRegistry,
  });
  return {
    app,
    archiveInstalls: routeDeps.archiveInstalls,
    runtime,
    refreshWorkspaceSkills,
    workspaceRegistry,
    configStatus,
    runtimeStatus,
    getWorkspaceSkillsConfigStatus,
    getWorkspaceSkillsRuntimeStatus,
    getSkillsConfigStatus,
    getSkillsSnapshot,
    invalidateSkillsConfigStatus,
    installWorkspaceSkill,
    deleteWorkspaceSkill,
    setWorkspaceSkillEnabled,
    setWorkspaceSkillsEnabled,
  };
}

describe('workspace Skill management routes', () => {
  it('exports only the explicitly selected trusted source and rejects missing or untrusted sources', async () => {
    const h = createHarness();
    const response = await request(h.app)
      .get('/workspaces/workspace-1/config/skills/snapshot')
      .expect(200);
    expect(response.body).toMatchObject({
      workspaceCwd: '/workspace',
      skills: [{ body: 'BODY' }],
    });
    expect(response.headers['cache-control']).toBe('no-store');
    await request(h.app)
      .get('/workspaces/missing/config/skills/snapshot')
      .expect(400);
    expect(h.getSkillsSnapshot).toHaveBeenCalledTimes(1);
    const untrusted = createHarness(false);
    await request(untrusted.app)
      .get('/workspaces/workspace-1/config/skills/snapshot')
      .expect(403);
    expect(untrusted.getSkillsSnapshot).not.toHaveBeenCalled();
    h.getSkillsSnapshot.mockImplementation(async (cwd) => {
      h.workspaceRegistry
        .getManagedEntryByWorkspaceId('workspace-1')!
        .current!.guard.close();
      return {
        workspaceCwd: cwd,
        skills: [{ name: 'enabled', description: 'Test', body: 'BODY' }],
      };
    });
    const stale = await request(h.app).get(
      '/workspaces/workspace-1/config/skills/snapshot',
    );
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(stale.text).not.toContain('BODY');
  });

  it('refreshes only the selected secondary runtime and rejects primary-owned IDs', async () => {
    const h = createHarness();
    const secondaryRefresh = vi.fn().mockResolvedValue({
      sessionsRefreshed: 1,
      sessionsFailed: 0,
      configsRefreshed: 1,
      configsFailed: 0,
      reason: 'all',
    });
    h.workspaceRegistry.add({
      ...h.runtime,
      workspaceId: 'workspace-2',
      workspaceCwd: '/secondary',
      primary: false,
      bridge: {
        ...h.runtime.bridge,
        getSessionSummary: (sessionId) => {
          if (sessionId !== 'secondary-session') {
            throw new SessionNotFoundError(sessionId);
          }
          return {} as ReturnType<
            WorkspaceRuntime['bridge']['getSessionSummary']
          >;
        },
      },
      workspaceService: {
        ...h.runtime.workspaceService,
        refreshWorkspaceSkills: secondaryRefresh,
      },
    });
    const selected = await request(h.app)
      .post('/workspaces/workspace-2/skills/refresh')
      .send({ sessionIds: ['secondary-session'] });
    expect(selected.status).toBe(200);
    expect(secondaryRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: '/secondary' }),
      ['secondary-session'],
    );
    const foreign = await request(h.app)
      .post('/workspaces/workspace-2/skills/refresh')
      .send({ sessionIds: ['session-1'] });
    expect(foreign.status).toBe(404);
    expect(secondaryRefresh).toHaveBeenCalledOnce();
    expect(h.refreshWorkspaceSkills).not.toHaveBeenCalled();
  });

  describe.each([
    '/workspace/skills/refresh',
    '/workspaces/workspace-1/skills/refresh',
  ])('explicit refresh at %s', (path) => {
    it.each(['[]', '["session-1"]'])(
      'rejects the bare array %s before refreshing',
      async (body) => {
        const h = createHarness();
        const response = await request(h.app)
          .post(path)
          .set('Content-Type', 'application/json')
          .send(body);
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('invalid_request_body');
        expect(h.refreshWorkspaceSkills).not.toHaveBeenCalled();
      },
    );

    it('invalidates config status when the refresh loses its channel', async () => {
      const h = createHarness();
      h.refreshWorkspaceSkills.mockRejectedValue(
        new BridgeChannelClosedError('mid-request'),
      );

      const response = await request(h.app).post(path).send({});

      expect(response.status).toBe(500);
      expect(h.invalidateSkillsConfigStatus).toHaveBeenCalledExactlyOnceWith(
        '/workspace',
      );
    });

    it.each([undefined, [], ['session-1', 'session-1']])(
      'passes the selection %j to the bound workspace service',
      async (sessionIds) => {
        const h = createHarness();
        const response = await request(h.app)
          .post(path)
          .send(sessionIds === undefined ? {} : { sessionIds });
        expect(response.status).toBe(200);
        expect(response.body.reason).toBe('all');
        expect(h.refreshWorkspaceSkills).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceCwd: '/workspace' }),
          sessionIds === undefined ? undefined : [...new Set(sessionIds)],
        );
      },
    );

    it.each([null, 'session-1', [1], [' ']])(
      'rejects malformed selection %j before refreshing',
      async (sessionIds) => {
        const h = createHarness();
        const response = await request(h.app).post(path).send({ sessionIds });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('invalid_session_ids');
        expect(h.refreshWorkspaceSkills).not.toHaveBeenCalled();
      },
    );

    it('rejects an unknown or foreign session before refreshing any selection', async () => {
      const h = createHarness();
      const response = await request(h.app)
        .post(path)
        .send({ sessionIds: ['session-1', 'foreign-session'] });
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('session_not_found');
      expect(h.refreshWorkspaceSkills).not.toHaveBeenCalled();
    });

    it('rejects refresh on an untrusted workspace', async () => {
      const h = createHarness(false);
      const response = await request(h.app).post(path).send({ sessionIds: [] });
      expect(response.status).toBe(403);
      expect(h.refreshWorkspaceSkills).not.toHaveBeenCalled();
    });
  });

  it('keeps config reads daemon-local and runtime reads explicit', async () => {
    const harness = createHarness();

    const config = await request(harness.app).get('/workspace/config/skills');
    expect(config.status).toBe(200);
    expect(config.body).toEqual(harness.configStatus);
    expect(harness.getWorkspaceSkillsConfigStatus).not.toHaveBeenCalled();
    expect(harness.getSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace',
      true,
    );
    expect(harness.getWorkspaceSkillsRuntimeStatus).not.toHaveBeenCalled();

    const runtime = await request(harness.app).get('/workspace/runtime/skills');
    expect(runtime.status).toBe(200);
    expect(runtime.body).toEqual(harness.runtimeStatus);
    expect(harness.getWorkspaceSkillsRuntimeStatus).toHaveBeenCalledOnce();
  });

  it('keeps global config reads available but rejects untrusted writes', async () => {
    const harness = createHarness(false);
    const body = {
      name: 'demo-skill',
      scope: 'global',
      source: { type: 'folder', path: '/tmp/demo-skill' },
    };

    const config = await request(harness.app).get('/workspace/config/skills');
    const install = await request(harness.app)
      .post('/workspace/config/skills/install')
      .send(body);
    const remove = await request(harness.app).delete(
      '/workspace/config/skills/configured?scope=global',
    );

    expect(config.status).toBe(200);
    expect(install.status).toBe(403);
    expect(remove.status).toBe(403);
    expect(harness.getSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace',
      false,
    );
    expect(harness.installWorkspaceSkill).not.toHaveBeenCalled();
    expect(harness.deleteWorkspaceSkill).not.toHaveBeenCalled();
  });

  it('does not report a missing Skill when config enumeration fails', async () => {
    const harness = createHarness();
    harness.getSkillsConfigStatus.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/workspace',
      initialized: false,
      skills: [],
      errors: [{ kind: 'skills', status: 'error', error: 'boom' }],
    });

    const response = await request(harness.app).delete(
      '/workspace/config/skills/configured?scope=global',
    );

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('skills_config_unavailable');
    expect(harness.deleteWorkspaceSkill).not.toHaveBeenCalled();
  });

  it('prefers an exact-case configured Skill when names differ only by case', async () => {
    const harness = createHarness();
    const configured = harness.configStatus.skills.find(
      (skill) => skill.level === 'user',
    )!;
    harness.configStatus.skills = [
      {
        ...configured,
        name: 'Configured',
        installedPath: '/global/skills/Configured/SKILL.md',
      },
      configured,
    ];

    const response = await request(harness.app).delete(
      '/workspace/config/skills/configured?scope=global',
    );

    expect(response.status).toBe(200);
    expect(harness.deleteWorkspaceSkill).toHaveBeenCalledWith(
      '/workspace',
      'global',
      'configured',
      '/global/skills/configured/SKILL.md',
    );
  });

  it('handles unique and ambiguous case-insensitive config deletes', async () => {
    const harness = createHarness();
    const configured = harness.configStatus.skills.find(
      (skill) => skill.level === 'user',
    )!;
    harness.configStatus.skills = [
      {
        ...configured,
        name: 'Configured',
        installedPath: '/global/skills/Configured/SKILL.md',
      },
    ];

    const unique = await request(harness.app).delete(
      '/workspace/config/skills/configured?scope=global',
    );
    expect(unique.status).toBe(200);
    expect(harness.deleteWorkspaceSkill).toHaveBeenCalledWith(
      '/workspace',
      'global',
      'Configured',
      '/global/skills/Configured/SKILL.md',
    );

    harness.deleteWorkspaceSkill.mockClear();
    harness.configStatus.skills.push({
      ...configured,
      name: 'CONFIGURED',
      installedPath: '/global/skills/CONFIGURED/SKILL.md',
    });
    const ambiguous = await request(harness.app).delete(
      '/workspace/config/skills/configured?scope=global',
    );
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.code).toBe('skill_not_managed');
    expect(harness.deleteWorkspaceSkill).not.toHaveBeenCalled();
  });

  it('reads qualified config for untrusted and transitioning workspaces', async () => {
    const untrusted = createHarness(false);
    const first = await request(untrusted.app).get(
      '/workspaces/workspace-1/config/skills',
    );
    const replacing = createHarness(true);
    replacing.workspaceRegistry.beginReplacement(
      replacing.workspaceRegistry.primaryEntry,
      'next-policy',
    );
    const transitioning = await request(replacing.app).get(
      '/workspaces/workspace-1/config/skills',
    );
    const globalInstall = await request(replacing.app)
      .post('/workspace/config/skills/install')
      .send({
        name: 'global-during-replacement',
        scope: 'global',
        source: { type: 'folder', path: '/tmp/global-during-replacement' },
      });

    expect(first.status).toBe(200);
    expect(transitioning.status).toBe(200);
    expect(globalInstall.status).toBe(403);
    expect(untrusted.getSkillsConfigStatus).toHaveBeenNthCalledWith(
      1,
      '/workspace',
      false,
    );
    expect(replacing.getSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace',
      false,
    );
  });

  it('preserves qualified no-op activation and client identity', async () => {
    const harness = createHarness(true, true);
    harness.setWorkspaceSkillEnabled.mockResolvedValueOnce({
      skillName: 'configured',
      enabled: false,
      changed: false,
      activation: 'applied',
      sessionsRefreshed: 0,
      sessionsFailed: 0,
    });

    const response = await request(harness.app)
      .post('/workspaces/workspace-1/config/skills/configured/enable')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ enabled: false });

    expect(response.status).toBe(200);
    expect(response.body.activation).toBe('applied');
    expect(harness.setWorkspaceSkillEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ originatorClientId: 'client-1' }),
      'configured',
      false,
      { refreshRuntime: false },
    );
  });

  it('reports a live qualified toggle as reconciling', async () => {
    const harness = createHarness(true, true);

    const response = await request(harness.app)
      .post('/workspaces/workspace-1/config/skills/configured/enable')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ enabled: false });

    expect(response.status).toBe(200);
    expect(response.body.activation).toBe('reconciling');
  });

  it('returns a structured error for qualified config writes on a legacy bridge', async () => {
    const harness = createHarness();
    Reflect.deleteProperty(
      harness.runtime.bridge,
      'getWorkspaceRuntimeLifecycleSnapshot',
    );

    const response = await request(harness.app)
      .post('/workspaces/workspace-1/config/skills/install')
      .send({
        name: 'demo-skill',
        scope: 'workspace',
        source: { type: 'folder', path: '/tmp/demo-skill' },
      });

    expect(response.status).toBe(501);
    expect(response.body.code).toBe('workspace_runtime_not_supported');
    expect(harness.installWorkspaceSkill).not.toHaveBeenCalled();
  });

  it('returns 404 when a qualified config Skill is not found', async () => {
    const harness = createHarness();
    harness.deleteWorkspaceSkill.mockRejectedValueOnce(
      new WorkspaceSkillNotFoundError('missing'),
    );

    const response = await request(harness.app).delete(
      '/workspaces/workspace-1/config/skills/missing?scope=workspace',
    );

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('skill_not_found');
  });

  it('invalidates config status when a qualified mutation fails', async () => {
    const harness = createHarness();
    harness.installWorkspaceSkill.mockRejectedValueOnce(
      Object.assign(new Error('closed'), {
        code: 'workspace_generation_closed',
      }),
    );

    const response = await request(harness.app)
      .post('/workspaces/workspace-1/config/skills/install')
      .send({
        name: 'demo-skill',
        scope: 'workspace',
        source: { type: 'folder', path: '/tmp/demo-skill' },
      });

    expect(response.status).toBe(503);
    expect(harness.invalidateSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace',
    );
  });

  it('invalidates global config status when mutations fail', async () => {
    const install = createHarness();
    install.workspaceRegistry.add({
      ...install.runtime,
      workspaceId: 'workspace-2',
      workspaceCwd: '/workspace-2',
      primary: false,
    });
    install.installWorkspaceSkill.mockRejectedValueOnce(new Error('failed'));

    const installResponse = await request(install.app)
      .post('/workspace/config/skills/install')
      .send({
        name: 'demo-skill',
        scope: 'global',
        source: { type: 'folder', path: '/tmp/demo-skill' },
      });

    expect(installResponse.status).toBe(500);
    expect(install.invalidateSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace-2',
    );

    const remove = createHarness();
    remove.workspaceRegistry.add({
      ...remove.runtime,
      workspaceId: 'workspace-2',
      workspaceCwd: '/workspace-2',
      primary: false,
    });
    remove.deleteWorkspaceSkill.mockRejectedValueOnce(new Error('failed'));

    const deleteResponse = await request(remove.app).delete(
      '/workspace/config/skills/configured?scope=global',
    );

    expect(deleteResponse.status).toBe(500);
    expect(remove.invalidateSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace-2',
    );
  });

  it('maps a vanished configured Skill to not found', async () => {
    const harness = createHarness();
    harness.deleteWorkspaceSkill.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'ENOENT' }),
    );

    const response = await request(harness.app).delete(
      '/workspace/config/skills/configured?scope=global',
    );

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('skill_not_found');
    expect(harness.invalidateSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace',
    );
  });

  it('rejects wrong scopes and untrusted qualified config writes', async () => {
    const harness = createHarness();
    const wrongScope = await request(harness.app)
      .post('/workspaces/workspace-1/config/skills/install')
      .send({
        name: 'demo-skill',
        scope: 'global',
        source: { type: 'folder', path: '/tmp/demo-skill' },
      });
    const untrusted = createHarness(false);
    const trustRejected = await request(untrusted.app)
      .post('/workspaces/workspace-1/config/skills/install')
      .send({
        name: 'demo-skill',
        scope: 'workspace',
        source: { type: 'folder', path: '/tmp/demo-skill' },
      });

    expect(wrongScope.status).toBe(400);
    expect(wrongScope.body.code).toBe('global_scope_requires_singular_owner');
    expect(trustRejected.status).toBe(403);
    expect(trustRejected.body.code).toBe('untrusted_workspace');
  });

  it('commits global config without using the legacy runtime refresh', async () => {
    const harness = createHarness();
    harness.workspaceRegistry.add({
      ...harness.runtime,
      workspaceId: 'workspace-2',
      workspaceCwd: '/workspace-2',
      primary: false,
    });
    const body = {
      name: 'demo-skill',
      scope: 'global',
      source: { type: 'folder', path: '/tmp/demo-skill' },
    };

    const response = await request(harness.app)
      .post('/workspace/config/skills/install')
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body.activation).toBe('deferred');
    expect(harness.installWorkspaceSkill).toHaveBeenCalledWith(
      '/workspace',
      body,
    );
    expect(harness.invalidateSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace',
    );
    expect(harness.invalidateSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace-2',
    );

    const wrongOwner = await request(harness.app)
      .post('/workspace/config/skills/install')
      .send({ ...body, scope: 'workspace' });
    expect(wrongOwner.status).toBe(400);
    expect(wrongOwner.body.code).toBe(
      'workspace_scope_requires_qualified_workspace',
    );
  });

  it('forwards an install request to the workspace service', async () => {
    const harness = createHarness();
    const body = {
      name: 'demo-skill',
      scope: 'workspace',
      source: {
        type: 'github',
        url: 'https://github.com/owner/repo/blob/main/demo/SKILL.md',
      },
    };

    const response = await request(harness.app)
      .post('/workspace/skills/install')
      .send(body);

    expect(response.status).toBe(200);
    expect(harness.installWorkspaceSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceCwd: '/workspace',
        originatorClientId: 'client-1',
      }),
      body,
    );
    expect(harness.invalidateSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace',
    );
  });

  it('serializes aliased workspace and global installs on one directory', async () => {
    const harness = createHarness();
    const previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = '/workspace/.qwen';
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = 0;
    let maxActive = 0;
    harness.installWorkspaceSkill.mockImplementation(
      async (...args: unknown[]) => {
        const install = args[1] as WorkspaceSkillInstallRequest;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (install.scope === 'workspace') {
          entered();
          await pause;
        }
        active -= 1;
        return {
          skillName: install.name,
          scope: install.scope,
          installedPath: '/workspace/.qwen/skills/demo-skill/SKILL.md',
        };
      },
    );
    try {
      const first = Promise.resolve(
        request(harness.app)
          .post('/workspace/skills/install')
          .send({
            name: 'demo-skill',
            scope: 'workspace',
            source: { type: 'folder', path: '/tmp/demo-skill' },
          }),
      );
      await firstEntered;
      const second = Promise.resolve(
        request(harness.app)
          .post('/workspace/skills/install')
          .send({
            name: 'demo-skill',
            scope: 'global',
            source: { type: 'folder', path: '/tmp/demo-skill' },
          }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(maxActive).toBe(1);
      release();
      const [firstResponse, secondResponse] = await Promise.all([
        first,
        second,
      ]);
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(maxActive).toBe(1);
    } finally {
      release();
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
    }
  });

  it('invalidates config status after qualified legacy mutations', async () => {
    const harness = createHarness();

    const responses = await Promise.all([
      request(harness.app)
        .post('/workspaces/workspace-1/skills/install')
        .send({
          name: 'demo-skill',
          scope: 'workspace',
          source: { type: 'folder', path: '/tmp/demo-skill' },
        }),
      request(harness.app).delete(
        '/workspaces/workspace-1/skills/demo-skill?scope=workspace',
      ),
      request(harness.app)
        .post('/workspaces/workspace-1/skills/enable')
        .send({ skillNames: ['demo-skill'], enabled: false }),
      request(harness.app)
        .post('/workspaces/workspace-1/skills/demo-skill/enable')
        .send({ enabled: false }),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
    expect(harness.invalidateSkillsConfigStatus).toHaveBeenCalledTimes(4);
    expect(harness.invalidateSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace',
    );
  });

  it('forwards delete scope and rejects invalid scopes', async () => {
    const harness = createHarness();

    const response = await request(harness.app).delete(
      '/workspace/skills/demo-skill?scope=global',
    );
    const invalid = await request(harness.app).delete(
      '/workspace/skills/demo-skill?scope=extension',
    );

    expect(response.status).toBe(200);
    expect(harness.deleteWorkspaceSkill).toHaveBeenCalledWith(
      expect.objectContaining({ originatorClientId: 'client-1' }),
      'demo-skill',
      'global',
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_skill_scope');
    expect(harness.invalidateSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace',
    );
  });

  it('returns structured management errors', async () => {
    const harness = createHarness();
    harness.installWorkspaceSkill.mockRejectedValueOnce(
      new WorkspaceSkillManagementError(
        'skill_manifest_missing',
        'Skill package must contain a root SKILL.md',
      ),
    );

    const response = await request(harness.app)
      .post('/workspace/skills/install')
      .send({
        name: 'demo-skill',
        scope: 'workspace',
        source: { type: 'zip', contentBase64: 'eA==' },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Skill package must contain a root SKILL.md',
      code: 'skill_manifest_missing',
    });
  });

  it('rejects an oversized install name before calling the service', async () => {
    const harness = createHarness();
    const response = await request(harness.app)
      .post('/workspace/skills/install')
      .send({
        name: 'x'.repeat(257),
        scope: 'workspace',
        source: { type: 'folder', path: '/tmp/skill' },
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_skill_name');
    expect(harness.installWorkspaceSkill).not.toHaveBeenCalled();
  });

  it('rejects an invalid delete name before calling the service', async () => {
    const harness = createHarness();
    const response = await request(harness.app).delete(
      '/workspace/skills/invalid%20name?scope=workspace',
    );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_skill_name');
    expect(harness.deleteWorkspaceSkill).not.toHaveBeenCalled();
  });

  it('forwards a deduplicated Skill batch response', async () => {
    const harness = createHarness();
    harness.setWorkspaceSkillsEnabled.mockResolvedValueOnce({
      enabled: false,
      activation: 'applied',
      sessionsRefreshed: 1,
      sessionsFailed: 0,
      results: [
        { skillName: 'review', enabled: false, changed: true },
        { skillName: 'missing', enabled: false, changed: true },
        { skillName: 'locked', enabled: false, changed: true },
      ],
      errors: [],
    });

    const response = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({
        skillNames: [' Review ', 'review', 'missing', 'locked'],
        enabled: false,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      enabled: false,
      activation: 'applied',
      sessionsRefreshed: 1,
      sessionsFailed: 0,
      results: [
        {
          skillName: 'review',
          enabled: false,
          changed: true,
        },
        {
          skillName: 'missing',
          enabled: false,
          changed: true,
        },
        {
          skillName: 'locked',
          enabled: false,
          changed: true,
        },
      ],
      errors: [],
    });
    expect(harness.setWorkspaceSkillsEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'POST /workspace/skills/enable',
        originatorClientId: 'client-1',
      }),
      ['Review', 'missing', 'locked'],
      false,
    );
    expect(harness.invalidateSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace',
    );
  });

  it('invalidates config status after a singular Skill toggle', async () => {
    const harness = createHarness();

    const response = await request(harness.app)
      .post('/workspace/skills/demo-skill/enable')
      .send({ enabled: false });

    expect(response.status).toBe(200);
    expect(harness.invalidateSkillsConfigStatus).toHaveBeenCalledWith(
      '/workspace',
    );
  });

  it('validates Skill batch request shape before calling the service', async () => {
    const harness = createHarness();

    const empty = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({ skillNames: [], enabled: false });
    const tooMany = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({
        skillNames: Array.from({ length: 101 }, (_, i) => `s${i}`),
        enabled: false,
      });
    // The cap counts raw entries before deduplication (contract stated in
    // docs/developers/qwen-serve-protocol.md), so duplicates cannot bypass it.
    const duplicatesOverCap = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({
        skillNames: Array.from({ length: 101 }, () => 'review'),
        enabled: false,
      });
    const blank = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({ skillNames: ['  '], enabled: false });
    const invalidFlag = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({ skillNames: ['review'], enabled: 'no' });
    const nonString = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({ skillNames: ['review', 42], enabled: false });
    const tooLong = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({ skillNames: ['x'.repeat(257)], enabled: false });
    const exactLimit = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({
        skillNames: Array.from({ length: 100 }, (_, i) => `s${i}`),
        enabled: false,
      });

    const missingNames = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({ enabled: false });
    const nonArrayNames = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({ skillNames: 'review', enabled: false });

    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('invalid_skill_names');
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('invalid_skill_names');
    expect(duplicatesOverCap.status).toBe(400);
    expect(duplicatesOverCap.body.code).toBe('invalid_skill_names');
    expect(blank.status).toBe(400);
    expect(blank.body.code).toBe('invalid_skill_name');
    expect(invalidFlag.status).toBe(400);
    expect(invalidFlag.body.code).toBe('invalid_enabled_flag');
    expect(nonString.status).toBe(400);
    expect(nonString.body.code).toBe('invalid_skill_names');
    expect(missingNames.status).toBe(400);
    expect(missingNames.body.code).toBe('invalid_skill_names');
    expect(nonArrayNames.status).toBe(400);
    expect(nonArrayNames.body.code).toBe('invalid_skill_names');
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('invalid_skill_name');
    expect(exactLimit.status).toBe(200);
    expect(harness.setWorkspaceSkillsEnabled).toHaveBeenCalledTimes(1);
  });

  it('fails the whole batch when the workspace generation closes', async () => {
    const harness = createHarness();
    harness.setWorkspaceSkillsEnabled.mockRejectedValueOnce(
      Object.assign(new Error('closed'), {
        code: 'workspace_generation_closed',
      }),
    );

    const response = await request(harness.app)
      .post('/workspace/skills/enable')
      .send({ skillNames: ['review', 'deploy'], enabled: false });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('workspace_runtime_unavailable');
    expect(harness.setWorkspaceSkillsEnabled).toHaveBeenCalledOnce();
  });
});

describe('native Skill archive routes', () => {
  afterEach(() => vi.restoreAllMocks());
  const payload = Buffer.from('owned binary archive fixture');
  const sha256 = createHash('sha256').update(payload).digest('hex');

  it.each([
    ['/workspace/config/skills', true],
    ['/workspaces/workspace-1/config/skills', false],
  ])(
    'refreshes the owned runtime inventory after an archive install at %s',
    async (base, globalScope) => {
      const h = createHarness();
      const invalidateInternal = vi.fn();
      const internal = {
        ...h.runtime,
        workspaceId: 'live-conversation',
        workspaceCwd: '/live-conversation',
        primary: false,
        provenance: 'live-conversation' as const,
        workspaceService: {
          ...h.runtime.workspaceService,
          invalidateWorkspaceSkillsStatus: invalidateInternal,
        },
      };
      h.workspaceRegistry.add(internal);
      expect(h.workspaceRegistry.list()).not.toContain(internal);
      expect(h.workspaceRegistry.listManaged()).toContain(internal);

      await request(h.app)
        .post(
          `${base}/install-archive?name=demo-skill&attemptId=${randomUUID()}`,
        )
        .type('application/octet-stream')
        .send(payload)
        .expect(200);

      expect(
        h.runtime.workspaceService.invalidateWorkspaceSkillsStatus,
      ).toHaveBeenCalledOnce();
      expect(invalidateInternal).toHaveBeenCalledTimes(globalScope ? 1 : 0);
    },
  );

  it.each([
    '/workspace/config/skills',
    '/workspaces/workspace-1/config/skills',
  ])(
    'keeps a valid generation through a policy-only update at %s',
    async (base) => {
      const h = createHarness();
      const original = h.installWorkspaceSkill.getMockImplementation()!;
      const guard = h.workspaceRegistry.primaryEntry.current!.guard;
      h.installWorkspaceSkill.mockImplementationOnce(async (...args) => {
        h.workspaceRegistry.advancePolicyRevision(
          h.workspaceRegistry.primaryEntry,
          'unrelated-policy-change',
        );
        expect(h.workspaceRegistry.primaryEntry.current!.guard).toBe(guard);
        return original(...args);
      });
      const id = randomUUID();
      await request(h.app)
        .post(`${base}/install-archive?name=demo-skill&attemptId=${id}`)
        .type('application/octet-stream')
        .send(payload)
        .expect(200);
      const receipt = await request(h.app).get(
        `${base}/install-attempts/${id}`,
      );
      expect(receipt.body.state).toBe('committed');
    },
  );

  it.each([
    '/workspace/config/skills',
    '/workspaces/workspace-1/config/skills',
  ])(
    'invalidates cached config after recovery is required at %s',
    async (base) => {
      const h = createHarness();
      h.installWorkspaceSkill.mockRejectedValueOnce(
        new WorkspaceSkillRecoveryError(
          ['/backup'],
          new Error('restore failed'),
        ),
      );
      await request(h.app)
        .post(
          `${base}/install-archive?name=demo-skill&attemptId=${randomUUID()}`,
        )
        .type('application/octet-stream')
        .send(payload)
        .expect(500);
      expect(h.invalidateSkillsConfigStatus).toHaveBeenCalledWith('/workspace');
    },
  );

  it.each([
    ['/workspace/config/skills/install', 'global'],
    ['/workspaces/workspace-1/config/skills/install', 'workspace'],
  ])(
    'exposes retained recovery paths for an existing source at %s',
    async (route, scope) => {
      const h = createHarness();
      const retainedPaths = ['/workspace/.skills-demo.backup-1'];
      h.installWorkspaceSkill.mockRejectedValueOnce(
        new WorkspaceSkillRecoveryError(
          retainedPaths,
          new Error('restore failed'),
        ),
      );
      const response = await request(h.app)
        .post(route)
        .send({
          name: 'demo-skill',
          scope,
          source: { type: 'folder', path: '/fixture' },
        });
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        code: 'skill_install_recovery_required',
        retainedPaths,
      });
    },
  );

  it('records recovery materials when a native publication cannot be restored', async () => {
    const h = createHarness();
    const retainedPaths = ['/workspace/.skills-demo.backup-1'];
    h.installWorkspaceSkill.mockRejectedValueOnce(
      new WorkspaceSkillRecoveryError(
        retainedPaths,
        new Error('restore failed'),
      ),
    );
    const id = randomUUID();
    const response = await startUpload(h, id).done;
    expect(response?.status).toBe(500);
    expect(response?.body.retainedPaths).toEqual(retainedPaths);
    const receipt = await request(h.app).get(
      `/workspace/config/skills/install-attempts/${id}`,
    );
    expect(receipt.body).toMatchObject({
      state: 'recovery_required',
      error: { retainedPaths },
    });
  });

  function startUpload(h: ReturnType<typeof createHarness>, id: string) {
    const upload = request(h.app)
      .post(
        `/workspace/config/skills/install-archive?name=demo-skill&attemptId=${id}`,
      )
      .type('application/octet-stream')
      .send(payload);
    return {
      upload,
      done: upload.then(
        (response) => response,
        () => undefined,
      ),
    };
  }

  it('cancels a queued request, preserves its predecessor, and limits active operations', async () => {
    const h = createHarness();
    const settle = vi.spyOn(h.archiveInstalls, 'settle');
    const original = h.installWorkspaceSkill.getMockImplementation()!;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.installWorkspaceSkill.mockImplementationOnce(async (...args) => {
      await holding;
      return original(...args);
    });
    const a = startUpload(h, randomUUID());
    const uploads = [a];
    try {
      await vi.waitFor(() =>
        expect(h.installWorkspaceSkill).toHaveBeenCalledOnce(),
      );
      const bid = randomUUID();
      const b = startUpload(h, bid);
      uploads.push(b);
      await vi.waitFor(async () => {
        const response = await request(h.app).get(
          `/workspace/config/skills/install-attempts/${bid}`,
        );
        expect(response.body.phase).toBe('waiting');
      });
      const overflow = await request(h.app)
        .post(
          `/workspace/config/skills/install-archive?name=demo-skill&attemptId=${randomUUID()}`,
        )
        .type('application/octet-stream')
        .send(payload);
      expect(overflow.status).toBe(429);
      expect(overflow.headers['retry-after']).toBe('1');
      b.upload.abort();
      await b.done;
      await vi.waitFor(() =>
        expect(settle.mock.calls.some(([, id]) => id === bid)).toBe(true),
      );
      const cancelled = await request(h.app).get(
        `/workspace/config/skills/install-attempts/${bid}`,
      );
      expect(cancelled.body.state).toBe('not_committed');
      const cid = randomUUID();
      const c = startUpload(h, cid);
      uploads.push(c);
      await vi.waitFor(async () => {
        const response = await request(h.app).get(
          `/workspace/config/skills/install-attempts/${cid}`,
        );
        expect(response.body.phase).toBe('waiting');
      });
      expect(h.installWorkspaceSkill).toHaveBeenCalledOnce();
      release();
      expect((await a.done)?.status).toBe(200);
      expect((await c.done)?.status).toBe(200);
      expect(h.installWorkspaceSkill).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await Promise.all(uploads.map(({ done }) => done));
    }
  });

  it('finishes publication after a late HTTP cancellation and exposes its committed receipt', async () => {
    const h = createHarness();
    let admitted = false;
    let release!: () => void;
    const publishing = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.installWorkspaceSkill.mockImplementationOnce(
      async (_ctx, input, options) => {
        options?.beforePublish?.();
        admitted = true;
        await publishing;
        const result = {
          skillName: input.name,
          scope: input.scope,
          installedPath: '/workspace/.qwen/skills/demo-skill/SKILL.md',
        };
        options?.onCommitted?.(result);
        return result;
      },
    );
    const id = randomUUID();
    const { upload, done } = startUpload(h, id);
    try {
      await vi.waitFor(() => expect(admitted).toBe(true));
      upload.abort();
      await done;
      release();
      await vi.waitFor(async () => {
        const receipt = await request(h.app).get(
          `/workspace/config/skills/install-attempts/${id}`,
        );
        expect(receipt.body.state).toBe('committed');
      });
    } finally {
      release();
      await done;
    }
  });

  it('rejects a generation invalidated during intake before waiting on a held mutation lock', async () => {
    const h = createHarness();
    const original = h.installWorkspaceSkill.getMockImplementation()!;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.installWorkspaceSkill.mockImplementationOnce(async (...args) => {
      await holding;
      return original(...args);
    });
    const first = startUpload(h, randomUUID());
    try {
      await vi.waitFor(() =>
        expect(h.installWorkspaceSkill).toHaveBeenCalledOnce(),
      );
      const temporaryDirectory = fs.mkdtemp.bind(fs);
      vi.spyOn(fs, 'mkdtemp').mockImplementationOnce(async (...args) => {
        const directory = await temporaryDirectory(...args);
        h.workspaceRegistry.beginReplacement(
          h.workspaceRegistry.primaryEntry,
          'changed-during-intake',
        );
        return directory;
      });
      const id = randomUUID();
      const response = await request(h.app)
        .post(
          `/workspace/config/skills/install-archive?name=demo-skill&attemptId=${id}`,
        )
        .type('application/octet-stream')
        .send(payload)
        .timeout(1500);
      expect(response.status).toBe(409);
      expect(h.installWorkspaceSkill).toHaveBeenCalledOnce();
      const receipt = await request(h.app).get(
        `/workspace/config/skills/install-attempts/${id}`,
      );
      expect(receipt.body.state).toBe('not_committed');
    } finally {
      release();
      await first.done;
    }
  });

  it.each([
    '/workspace/config/skills',
    '/workspaces/workspace-1/config/skills',
  ])('returns a historical commit receipt through %s', async (base) => {
    const h = createHarness();
    const id = randomUUID();
    const response = await request(h.app)
      .post(`${base}/install-archive?name=demo-skill&attemptId=${id}`)
      .type('application/octet-stream')
      .send(payload);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      attemptId: id,
      archiveSha256: sha256,
      activation: 'deferred',
    });
    const receipt = await request(h.app).get(`${base}/install-attempts/${id}`);
    expect(receipt.status).toBe(200);
    expect(receipt.headers['cache-control']).toBe('no-store');
    expect(receipt.body).toMatchObject({
      state: 'committed',
      archiveSha256: sha256,
      workspaceId: 'workspace-1',
    });
    const source = h.installWorkspaceSkill.mock.calls[0][1].source;
    expect(source.type).toBe('prepared-zip');
    if (source.type !== 'prepared-zip')
      throw new Error('missing owned archive');
    await expect(fs.access(source.path)).rejects.toThrow();
    const duplicate = await request(h.app)
      .post(`${base}/install-archive?name=demo-skill&attemptId=${id}`)
      .type('application/octet-stream')
      .send(payload);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('skill_attempt_conflict');
    expect(h.installWorkspaceSkill).toHaveBeenCalledOnce();
    h.workspaceRegistry.beginReplacement(
      h.workspaceRegistry.primaryEntry,
      'next-policy',
    );
    const historical = await request(h.app).get(
      `${base}/install-attempts/${id}`,
    );
    expect(historical.body.state).toBe('committed');
  });

  it('binds a secondary archive to its selected runtime and hides its receipt from other owners', async () => {
    const h = createHarness();
    const install = vi.fn(h.installWorkspaceSkill.getMockImplementation()!);
    h.workspaceRegistry.add({
      ...h.runtime,
      workspaceId: 'secondary',
      workspaceCwd: '/secondary',
      primary: false,
      workspaceService: {
        ...h.runtime.workspaceService,
        installWorkspaceSkill: install,
      },
    });
    const id = randomUUID();
    const response = await request(h.app)
      .post(
        `/workspaces/secondary/config/skills/install-archive?name=demo-skill&attemptId=${id}`,
      )
      .type('application/octet-stream')
      .send(payload);
    expect(response.status).toBe(200);
    expect(h.installWorkspaceSkill).not.toHaveBeenCalled();
    expect(install.mock.calls[0][0]).toMatchObject({
      workspaceCwd: '/secondary',
    });
    const selected = await request(h.app).get(
      `/workspaces/secondary/config/skills/install-attempts/${id}`,
    );
    expect(selected.body).toMatchObject({
      workspaceId: 'secondary',
      state: 'committed',
    });
    for (const owner of ['/workspace', '/workspaces/workspace-1']) {
      const hidden = await request(h.app).get(
        `${owner}/config/skills/install-attempts/${id}`,
      );
      expect(hidden.status).toBe(404);
    }
  });

  it('copies a daemon file, verifies its digest and never removes the source', async () => {
    const h = createHarness();
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skill-route-input-'),
    );
    const file = path.join(directory, 'source.zip');
    try {
      await fs.writeFile(file, payload);
      const response = await request(h.app)
        .post('/workspace/config/skills/install')
        .send({
          name: 'demo-skill',
          scope: 'global',
          attemptId: randomUUID(),
          source: { type: 'zip-file', path: file, sha256 },
        });
      expect(response.status).toBe(200);
      await expect(fs.readFile(file)).resolves.toEqual(payload);
      const id = randomUUID();
      const mismatch = await request(h.app)
        .post('/workspace/config/skills/install')
        .send({
          name: 'demo-skill',
          scope: 'global',
          attemptId: id,
          source: { type: 'zip-file', path: file, sha256: '0'.repeat(64) },
        });
      expect(mismatch.body.code).toBe('skill_archive_digest_mismatch');
      const receipt = await request(h.app).get(
        `/workspace/config/skills/install-attempts/${id}`,
      );
      expect(receipt.body.state).toBe('not_committed');
      expect(h.installWorkspaceSkill).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    '/workspace/skills/install',
    '/workspaces/workspace-1/skills/install',
  ])('rejects zip-file on legacy runtime route %s', async (route) => {
    const h = createHarness();
    const response = await request(h.app)
      .post(route)
      .send({
        name: 'demo-skill',
        scope: 'workspace',
        attemptId: randomUUID(),
        source: { type: 'zip-file', path: '/tmp/source.zip' },
      });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('skill_source_requires_config_route');
    expect(h.installWorkspaceSkill).not.toHaveBeenCalled();
  });

  it('validates media and encoding before reserving an attempt', async () => {
    const h = createHarness();
    const id = randomUUID();
    const route = `/workspace/config/skills/install-archive?name=demo-skill&attemptId=${id}`;
    const wrongType = await request(h.app)
      .post(route)
      .type('text/plain')
      .send('ZIP');
    expect(wrongType.status).toBe(415);
    const encoded = await request(h.app)
      .post(route)
      .type('application/octet-stream')
      .set('Content-Encoding', 'gzip')
      .send(payload);
    expect(encoded.status).toBe(415);
    const lookup = await request(h.app).get(
      `/workspace/config/skills/install-attempts/${id}`,
    );
    expect(lookup.body.code).toBe('skill_install_attempt_unknown');
    expect(h.installWorkspaceSkill).not.toHaveBeenCalled();
  });

  it('preserves commit when later activation fails', async () => {
    const h = createHarness();
    vi.mocked(
      h.runtime.workspaceService.invalidateWorkspaceSkillsStatus,
    ).mockImplementationOnce(() => {
      throw new Error('activation unavailable');
    });
    const id = randomUUID();
    const response = await request(h.app)
      .post(
        `/workspace/config/skills/install-archive?name=demo-skill&attemptId=${id}`,
      )
      .type('application/octet-stream')
      .send(payload);
    expect(response.status).toBe(200);
    expect(response.body.activationWarning).toBe('activation unavailable');
    const receipt = await request(h.app).get(
      `/workspace/config/skills/install-attempts/${id}`,
    );
    expect(receipt.body).toMatchObject({
      state: 'committed',
      result: { activationWarning: 'activation unavailable' },
    });
  });

  it('checks the monotonic budget immediately before publication', async () => {
    const h = createHarness();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    h.installWorkspaceSkill.mockImplementationOnce(
      async (_ctx, input, options) => {
        now.mockReturnValue(120_001);
        options?.beforePublish?.();
        throw new Error(`unexpected publication of ${input.name}`);
      },
    );
    const id = randomUUID();
    const response = await request(h.app)
      .post(
        `/workspace/config/skills/install-archive?name=demo-skill&attemptId=${id}`,
      )
      .type('application/octet-stream')
      .send(payload);
    expect(response.status).toBe(408);
    const receipt = await request(h.app).get(
      `/workspace/config/skills/install-attempts/${id}`,
    );
    expect(receipt.body).toMatchObject({
      state: 'not_committed',
      error: { code: 'skill_install_timeout' },
    });
  });

  it('rejects history immediately after configured trust is revoked, even with the old trusted runtime', async () => {
    let folderTrustEnabled = false;
    const h = createHarness(true, false, () => ({
      revision: 'policy',
      folderTrustEnabled,
      ideTrust: undefined,
      trustedFolders: {},
    }));
    const id = randomUUID();
    await request(h.app)
      .post(
        `/workspace/config/skills/install-archive?name=demo-skill&attemptId=${id}`,
      )
      .type('application/octet-stream')
      .send(payload)
      .expect(200);
    const trustedReceipt = await request(h.app)
      .get(`/workspace/config/skills/install-attempts/${id}`)
      .expect(200);
    expect(trustedReceipt.body.state).toBe('committed');
    folderTrustEnabled = true;
    h.workspaceRegistry.beginReplacement(
      h.workspaceRegistry.primaryEntry,
      'revoked',
    );
    expect(h.runtime.trusted).toBe(true);
    const receipt = await request(h.app).get(
      `/workspace/config/skills/install-attempts/${id}`,
    );
    expect(receipt.status).toBe(403);
  });
});
