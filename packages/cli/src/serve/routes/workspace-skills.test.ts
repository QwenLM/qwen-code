import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import { WorkspaceSkillManagementError } from '../workspace-skill-management.js';
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
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  registerWorkspaceSkillsRoutes(app, {
    workspaceRuntime: {
      workspaceCwd: '/workspace',
      trusted: true,
      workspaceService: {
        installWorkspaceSkill,
        deleteWorkspaceSkill,
      },
    } as unknown as WorkspaceRuntime,
    mutate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
    safeBody: (req) => req.body as Record<string, unknown>,
    sendBridgeError: vi.fn(),
    parseAndValidateClientId: () => 'client-1',
  });
  return { app, installWorkspaceSkill, deleteWorkspaceSkill };
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
        name: 'x'.repeat(101),
        scope: 'workspace',
        source: { type: 'folder', path: '/tmp/skill' },
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_skill_name');
    expect(harness.installWorkspaceSkill).not.toHaveBeenCalled();
  });
});
