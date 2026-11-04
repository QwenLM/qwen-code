/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspaceSkillsStatusProvider } from './workspace-skills-status.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';
import {
  registerWorkspaceQualifiedSkillsRoutes,
  registerWorkspaceSkillsRoutes,
} from './routes/workspace-skills.js';
import { sendBridgeError } from './server/error-response.js';

afterEach(() => vi.unstubAllEnvs());

it('discovers externally created Skills through both config routes without a child', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-15645-routes-'));
  const workspace = path.join(root, 'workspace');
  const qwenHome = path.join(root, 'home');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(qwenHome, { recursive: true });
  await fs.writeFile(path.join(qwenHome, 'settings.json'), '{}');
  vi.stubEnv('QWEN_HOME', qwenHome);
  const provider = createWorkspaceSkillsStatusProvider({ autoDiscover: true });
  const runtime = {
    workspaceId: 'selected',
    workspaceCwd: workspace,
    primary: true,
    trusted: true,
  } as WorkspaceRuntime;
  const registry = createWorkspaceRegistry([runtime]);
  const app = express();
  const deps = {
    workspaceRegistry: registry,
    getSkillsConfigStatus: (cwd: string) => provider(cwd),
    invalidateSkillsConfigStatus: (cwd: string) => provider.invalidate?.(cwd),
    sendBridgeError,
    mutate:
      () =>
      (
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
      ) =>
        next(),
    safeBody: (req: express.Request) => req.body as Record<string, unknown>,
  };
  registerWorkspaceSkillsRoutes(app, {
    ...deps,
    workspaceRuntime: runtime,
    parseAndValidateClientId: () => null,
    installSkillConfig: async () => {
      throw new Error('unused mutation');
    },
    deleteSkillConfig: async () => {
      throw new Error('unused mutation');
    },
  });
  registerWorkspaceQualifiedSkillsRoutes(app, deps);
  const routes = [
    '/workspace/config/skills',
    '/workspaces/selected/config/skills',
  ];
  try {
    for (const route of routes) {
      const response = await request(app).get(route);
      expect(response.status).toBe(200);
      expect(response.body.initialized).toBe(true);
      expect(
        response.body.skills.some(
          (skill: { name: string }) => skill.name === 'external-project',
        ),
      ).toBe(false);
    }
    const skillDir = path.join(
      workspace,
      '.qwen',
      'skills',
      'external-project',
    );
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: external-project\ndescription: Created externally\n---\nInstructions\n',
    );
    expect(
      (await provider.snapshot(workspace)).skills.some(
        (skill) => skill.name === 'external-project',
      ),
    ).toBe(true);
    const started = Date.now();
    let seen = [false, false];
    do {
      seen = await Promise.all(
        routes.map(async (route) => {
          const response = await request(app).get(route);
          expect(response.status).toBe(200);
          expect(response.body.initialized).toBe(true);
          return response.body.skills.some(
            (skill: { name: string }) => skill.name === 'external-project',
          ) as boolean;
        }),
      );
      if (seen.every(Boolean)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (Date.now() - started < 35000);
    expect(
      seen,
      `Routes did not observe external creation after ${Date.now() - started} ms`,
    ).toEqual([true, true]);
  } finally {
    await provider.dispose?.();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 45000);
