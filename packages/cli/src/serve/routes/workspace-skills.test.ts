import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { sendBridgeError } from '../server/error-response.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { WorkspaceSkillManagementError } from '../workspace-skill-management.js';
import type { WorkspaceSkillBatchToggleResult } from '../workspace-service/types.js';
import { registerWorkspaceSkillsRoutes } from './workspace-skills.js';

function createHarness() {
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
    async (_ctx: unknown, skillName: string, enabled: boolean) => ({
      skillName: skillName.toLowerCase(),
      enabled,
      changed: true,
      activation: 'applied' as const,
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
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  registerWorkspaceSkillsRoutes(app, {
    workspaceRuntime: {
      workspaceCwd: '/workspace',
      trusted: true,
      workspaceService: {
        installWorkspaceSkill,
        deleteWorkspaceSkill,
        setWorkspaceSkillEnabled,
        setWorkspaceSkillsEnabled,
      },
    } as unknown as WorkspaceRuntime,
    mutate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    safeBody: (req) => req.body as Record<string, unknown>,
    sendBridgeError,
    parseAndValidateClientId: () => 'client-1',
  });
  return {
    app,
    installWorkspaceSkill,
    deleteWorkspaceSkill,
    setWorkspaceSkillEnabled,
    setWorkspaceSkillsEnabled,
  };
}

describe('workspace Skill management routes', () => {
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

  it('toggles a deduplicated Skill batch and returns per-target outcomes', async () => {
    const harness = createHarness();
    harness.setWorkspaceSkillsEnabled.mockResolvedValueOnce({
      enabled: false,
      activation: 'applied',
      sessionsRefreshed: 1,
      sessionsFailed: 0,
      results: [
        { skillName: 'review', enabled: false, changed: true },
        { skillName: 'missing', enabled: false, changed: true },
      ],
      errors: [
        {
          skillName: 'locked',
          code: 'skill_not_toggleable',
          error: 'Skill locked is locked by user settings',
          reason: 'locked',
          lockedScope: 'user',
        },
      ],
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
      ],
      errors: [
        {
          skillName: 'locked',
          code: 'skill_not_toggleable',
          error: 'Skill locked is locked by user settings',
          reason: 'locked',
          lockedScope: 'user',
        },
      ],
    });
    expect(harness.setWorkspaceSkillsEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'POST /workspace/skills/enable',
        originatorClientId: 'client-1',
      }),
      ['Review', 'missing', 'locked'],
      false,
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
