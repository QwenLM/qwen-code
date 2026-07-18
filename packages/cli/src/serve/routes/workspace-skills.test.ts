import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { getWorkspaceRuntimeCoordinator } from '../workspace-runtime-coordinator.js';
import { WorkspaceSkillManagementError } from '../workspace-skill-management.js';
import { registerWorkspaceSkillsRoutes } from './workspace-skills.js';

function createHarness(trusted = true) {
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
  const setWorkspaceSkillEnabled = vi.fn().mockResolvedValue({
    skillName: 'demo-skill',
    enabled: false,
  });
  const getWorkspaceSkillsConfigStatus = vi.fn().mockResolvedValue({
    v: 1,
    workspaceCwd: '/workspace',
    initialized: true,
    source: 'config',
    skills: [{ name: 'demo-skill', status: 'ok' }],
  });
  const invalidateWorkspaceSkillsStatus = vi.fn();
  const invalidateSecondarySkillsStatus = vi.fn();
  const refreshSecondarySkills = vi.fn(async () => ({
    sessionsRefreshed: 0,
    sessionsFailed: 0,
  }));
  let secondaryLive = false;
  const primaryRuntime = {
    workspaceCwd: '/workspace',
    trusted,
    bridge: {
      isChannelLive: () => false,
      publishWorkspaceEvent: vi.fn(),
    },
    workspaceService: {
      installWorkspaceSkill,
      deleteWorkspaceSkill,
      setWorkspaceSkillEnabled,
      getWorkspaceSkillsConfigStatus,
      invalidateWorkspaceSkillsStatus,
    },
  } as unknown as WorkspaceRuntime;
  const secondaryRuntime = {
    workspaceCwd: '/secondary',
    trusted: true,
    bridge: {
      isChannelLive: () => secondaryLive,
      getRuntimeEpoch: () => (secondaryLive ? 1 : 0),
      invokeWorkspaceCommand: refreshSecondarySkills,
      publishWorkspaceEvent: vi.fn(),
    },
    workspaceService: {
      invalidateWorkspaceSkillsStatus: invalidateSecondarySkillsStatus,
      getWorkspaceSkillsStatus: vi.fn(async () => ({
        v: 1,
        workspaceCwd: '/secondary',
        initialized: true,
        source: 'live',
        runtimeEpoch: 1,
        skills: [],
      })),
    },
  } as unknown as WorkspaceRuntime;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  registerWorkspaceSkillsRoutes(app, {
    workspaceRuntime: primaryRuntime,
    workspaceRegistry: {
      list: () => [primaryRuntime],
      listManaged: () => [primaryRuntime, secondaryRuntime],
    } as never,
    mutate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    safeBody: (req) => req.body as Record<string, unknown>,
    sendBridgeError: vi.fn(),
    parseAndValidateClientId: () => 'client-1',
  });
  return {
    app,
    installWorkspaceSkill,
    deleteWorkspaceSkill,
    setWorkspaceSkillEnabled,
    getWorkspaceSkillsConfigStatus,
    invalidateWorkspaceSkillsStatus,
    invalidateSecondarySkillsStatus,
    refreshSecondarySkills,
    secondaryRuntime,
    setSecondaryLive: (value: boolean) => {
      secondaryLive = value;
    },
  };
}

describe('workspace Skill management routes', () => {
  it('keeps global config available when the primary workspace is untrusted', async () => {
    const harness = createHarness(false);
    const body = {
      name: 'demo-skill',
      scope: 'global',
      source: { type: 'folder', path: '/tmp/demo-skill' },
    } as const;

    const inventory = await request(harness.app).get(
      '/workspace/config/skills',
    );
    const install = await request(harness.app)
      .post('/workspace/config/skills/install')
      .send(body);
    const legacyInstall = await request(harness.app)
      .post('/workspace/skills/install')
      .send(body);

    expect(inventory.status).toBe(200);
    expect(install.status).toBe(200);
    expect(legacyInstall.status).toBe(403);
    expect(legacyInstall.body).toMatchObject({ code: 'untrusted_workspace' });
    expect(harness.installWorkspaceSkill).toHaveBeenCalledOnce();
    expect(harness.installWorkspaceSkill).toHaveBeenCalledWith(
      expect.not.objectContaining({ originatorClientId: expect.anything() }),
      body,
    );
  });

  it('reads the daemon-local config inventory without a runtime command', async () => {
    const harness = createHarness();

    const response = await request(harness.app).get('/workspace/config/skills');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      source: 'config',
      skills: [{ name: 'demo-skill' }],
    });
    expect(harness.getWorkspaceSkillsConfigStatus).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: '/workspace' }),
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
  });

  it('keeps the legacy workspace toggle route available', async () => {
    const harness = createHarness();

    const response = await request(harness.app)
      .post('/workspace/skills/demo-skill/enable')
      .send({ enabled: false });

    expect(response.status).toBe(200);
    expect(harness.setWorkspaceSkillEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ originatorClientId: 'client-1' }),
      'demo-skill',
      false,
    );
  });

  it('uses the global config route without a client identity', async () => {
    const harness = createHarness();
    const body = {
      name: 'demo-skill',
      scope: 'global',
      source: { type: 'folder', path: '/tmp/demo-skill' },
    };

    const response = await request(harness.app)
      .post('/workspace/config/skills/install')
      .send(body);

    expect(response.status).toBe(200);
    expect(harness.installWorkspaceSkill).toHaveBeenCalledWith(
      expect.not.objectContaining({ originatorClientId: expect.anything() }),
      body,
    );
  });

  it('rejects workspace mutations through singular config routes', async () => {
    const harness = createHarness();
    const expectedError = {
      error:
        'Workspace Skill scope must be changed through /workspaces/:workspace/config/skills',
      code: 'workspace_scope_requires_qualified_workspace',
    };

    const install = await request(harness.app)
      .post('/workspace/config/skills/install')
      .send({
        name: 'demo-skill',
        scope: 'workspace',
        source: { type: 'folder', path: '/tmp/demo-skill' },
      });
    const remove = await request(harness.app).delete(
      '/workspace/config/skills/demo-skill?scope=workspace',
    );
    expect(install.status).toBe(400);
    expect(install.body).toEqual(expectedError);
    expect(remove.status).toBe(400);
    expect(remove.body).toEqual(expectedError);
    expect(harness.installWorkspaceSkill).not.toHaveBeenCalled();
    expect(harness.deleteWorkspaceSkill).not.toHaveBeenCalled();
    expect(harness.setWorkspaceSkillEnabled).not.toHaveBeenCalled();
  });

  it('invalidates cached inventories in active and draining workspaces after global changes', async () => {
    const harness = createHarness();
    harness.setSecondaryLive(true);
    const secondaryCoordinator = getWorkspaceRuntimeCoordinator(
      harness.secondaryRuntime,
    );
    secondaryCoordinator.beginDrain();
    const body = {
      name: 'demo-skill',
      scope: 'global',
      source: { type: 'folder', path: '/tmp/demo-skill' },
    };

    const install = await request(harness.app)
      .post('/workspace/config/skills/install')
      .send(body);
    const remove = await request(harness.app).delete(
      '/workspace/config/skills/demo-skill?scope=global',
    );

    expect(install.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(harness.invalidateWorkspaceSkillsStatus).toHaveBeenCalledTimes(2);
    expect(harness.invalidateSecondarySkillsStatus).toHaveBeenCalledTimes(2);
    expect(harness.refreshSecondarySkills).not.toHaveBeenCalled();

    secondaryCoordinator.cancelDrain();
    await vi.waitFor(() => {
      expect(harness.refreshSecondarySkills).toHaveBeenCalledOnce();
    });
  });

  it('keeps a durable global install successful when runtime invalidation fails', async () => {
    const harness = createHarness();
    harness.invalidateSecondarySkillsStatus.mockImplementationOnce(() => {
      throw new Error('runtime removed');
    });

    const response = await request(harness.app)
      .post('/workspace/config/skills/install')
      .send({
        name: 'demo-skill',
        scope: 'global',
        source: { type: 'folder', path: '/tmp/demo-skill' },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      skillName: 'demo-skill',
      activation: 'deferred',
    });
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
});
