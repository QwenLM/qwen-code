import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { WorkspaceSkillManagementError } from '../workspace-skill-management.js';
import {
  WorkspaceSkillNotFoundError,
  type WorkspaceSkillBatchToggleResult,
  type WorkspaceSkillToggleResult,
} from '../workspace-service/types.js';
import {
  registerWorkspaceQualifiedSkillsRoutes,
  registerWorkspaceSkillsRoutes,
} from './workspace-skills.js';

function createHarness(trusted = true, runtimeLive = false) {
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
  const invalidateSkillsConfigStatus = vi.fn();
  const invalidateWorkspaceSkillsStatus = vi.fn();
  const installWorkspaceSkill = vi.fn().mockResolvedValue({
    skillName: 'demo-skill',
    scope: 'workspace',
    installedPath: '/workspace/.qwen/skills/demo-skill/SKILL.md',
  });
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
    getWorkspaceRuntimeLifecycleSnapshot: () => ({
      state: runtimeLive ? ('idle' as const) : ('cold' as const),
      runtimeLive,
      runtimeEpoch: runtimeLive ? 1 : 0,
      activeWork: false,
    }),
  };
  const runtime = {
    workspaceId: 'workspace-1',
    workspaceCwd: '/workspace',
    primary: true,
    trusted,
    bridge,
    workspaceService: {
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
    mutate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    safeBody: (req: Request) => req.body as Record<string, unknown>,
    sendBridgeError,
    getSkillsConfigStatus,
    invalidateSkillsConfigStatus,
  };
  registerWorkspaceSkillsRoutes(app, {
    ...routeDeps,
    workspaceRuntime: runtime,
    workspaceRegistry,
    installSkillConfig: (workspaceCwd, request) =>
      installWorkspaceSkill(workspaceCwd, request),
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
    runtime,
    workspaceRegistry,
    configStatus,
    runtimeStatus,
    getWorkspaceSkillsConfigStatus,
    getWorkspaceSkillsRuntimeStatus,
    getSkillsConfigStatus,
    invalidateSkillsConfigStatus,
    installWorkspaceSkill,
    deleteWorkspaceSkill,
    setWorkspaceSkillEnabled,
    setWorkspaceSkillsEnabled,
  };
}

describe('workspace Skill management routes', () => {
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
