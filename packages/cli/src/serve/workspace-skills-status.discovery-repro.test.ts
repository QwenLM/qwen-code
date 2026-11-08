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
import { watch } from 'chokidar';
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
import { SkillInstallAttemptStore } from './skill-install-attempts.js';

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

afterEach(() => vi.unstubAllEnvs());

it('arms a real watcher after initially missing parent directories are created', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-missing-roots-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  await fs.mkdir(workspace);
  await fs.mkdir(home);
  vi.stubEnv('QWEN_HOME', home);
  const provider = createWorkspaceSkillsStatusProvider({ autoDiscover: true });
  const directory = path.join(workspace, '.qwen', 'skills');
  const subscriptions = () =>
    vi
      .mocked(watch)
      .mock.results.flatMap((result, index) =>
        vi.mocked(watch).mock.calls[index]?.[0] === directory &&
        result.type === 'return'
          ? [result.value]
          : [],
      );
  try {
    await provider(workspace);
    expect(subscriptions()).toHaveLength(0);
    await fs.mkdir(directory, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await provider(workspace);
    await vi.waitFor(() => expect(subscriptions()).toHaveLength(1));
    const watcher = subscriptions()[0]!;
    await vi.waitFor(() => expect(watcher.getWatched()[directory]).toEqual([]));
    const event = new Promise<void>((resolve) =>
      watcher.once('all', () => resolve()),
    );
    const skill = path.join(directory, 'external');
    await fs.mkdir(skill);
    await fs.writeFile(
      path.join(skill, 'SKILL.md'),
      '---\nname: external\ndescription: external\n---\nInstructions\n',
    );
    await event;
  } finally {
    await provider.dispose?.();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 10000);

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
    archiveInstalls: new SkillInstallAttemptStore(),
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
