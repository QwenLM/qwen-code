/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';
import { mountMemoryImportRoutes } from './memory-import.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  getAutoMemoryRoot,
  runWithMemoryProjectScope,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import { previewSource } from '../memory-import/source.js';
const source = {
  version: 1,
  source: 'codex',
  files: [
    {
      path: 'MEMORY.md',
      content:
        '# Remote client source\ncwd: /client-only/project\nValidate rollback paths.',
    },
  ],
};
const document =
  '---\nname: Rollback checks\ndescription: Validate rollback paths\ntype: project\ncategory: testing_standard\nkeywords: [schema rollback, migration tests]\nusage_scenarios: [Reviewing schema changes]\n---\nValidate rollback paths.\n';
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'import-http-'));
  for (const key of [
    'QWEN_CODE_MEMORY_BASE_DIR',
    'QWEN_CODE_MEMORY_LOCAL',
    'QWEN_CODE_MEMORY_PROJECT_SCOPE',
  ])
    vi.stubEnv(key, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function setup(nested = false) {
  if (nested) {
    await fs.mkdir(path.join(root, 'repository'));
    await fs.mkdir(path.join(root, 'repository', '.git'));
  }
  const create = async (id: string, primary: boolean) => {
    const cwd =
      nested && !primary
        ? path.join(root, 'repository', id)
        : path.join(root, id);
    await fs.mkdir(cwd);
    const invoke = vi.fn(async () => ({
      decision: 'new',
      reason: 'durable',
      documents: [document],
    }));
    return {
      workspaceId: id,
      workspaceCwd: cwd,
      sessionRuntimeBaseDir: path.join(root, `${id}-runtime`),
      primary,
      trusted: true,
      env: {
        mode: 'parent-process',
        overlayKeys: [],
        effectiveEnv: { QWEN_CODE_MEMORY_PROJECT_SCOPE: 'workspace' },
      },
      bridge: { invokeWorkspaceCommand: invoke },
      routeFileSystemFactory: {},
      generationGuard: createWorkspaceGenerationGuard(),
    } as unknown as WorkspaceRuntime;
  };
  const primary = await create('primary', true);
  const secondary = await create('secondary', false);
  const registry = createWorkspaceRegistry([primary]);
  registry.add(secondary);
  const app = express();
  app.use(express.json());
  mountMemoryImportRoutes(app, {
    workspaceRegistry: registry,
    mutate: () => (req, res, next) => {
      if (req.header('x-confirm') !== 'yes') {
        res.status(403).json({ error: 'mutation authorization required' });
        return;
      }
      next();
    },
  });
  return { app, primary, secondary, registry };
}
const selection = () => [
  { id: previewSource(source).sections[0].id, scope: 'project' },
];
async function terminal(app: express.Application, base: string, id: string) {
  let value: Record<string, unknown> | undefined;
  await vi.waitFor(
    async () => {
      const response = await request(app).get(`${base}/batches/${id}`);
      expect(response.status).toBe(200);
      value = response.body;
      expect(['completed', 'partial', 'cancelled']).toContain(
        response.body.status,
      );
    },
    { timeout: 5000, interval: 20 },
  );
  return value!;
}
describe('selected-workspace memory import HTTP', () => {
  it('previews client contents with no local source access or model call', async () => {
    const h = await setup();
    const response = await request(h.app)
      .post('/workspaces/secondary/memory/import/preview')
      .set('x-confirm', 'yes')
      .send(source);
    expect(response.status).toBe(200);
    expect(response.body.kind).toBe('preview');
    expect(h.secondary.bridge.invokeWorkspaceCommand).not.toHaveBeenCalled();
    await expect(
      fs.stat(h.secondary.sessionRuntimeBaseDir),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('uses secondary model/storage and exposes only selected retained sources', async () => {
    const h = await setup();
    const base = '/workspaces/secondary/memory/import';
    const response = await request(h.app)
      .post(`${base}/batches`)
      .set('x-confirm', 'yes')
      .send({ source, selection: selection(), idempotencyKey: 'client-batch' });
    expect(response.status).toBe(202);
    const result = await terminal(h.app, base, response.body.id);
    expect(result['status']).toBe('completed');
    expect(h.secondary.bridge.invokeWorkspaceCommand).toHaveBeenCalledOnce();
    expect(h.primary.bridge.invokeWorkspaceCommand).not.toHaveBeenCalled();
    await expect(
      fs.stat(h.primary.sessionRuntimeBaseDir),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const retained = await request(h.app).get(
      `${base}/batches/${response.body.id}/sources/${selection()[0].id}`,
    );
    expect(retained.body.content).toContain('rollback');
    expect(
      (
        await request(h.app).get(
          `/workspaces/primary/memory/import/batches/${response.body.id}`,
        )
      ).status,
    ).toBe(404);
  });
  it('uses the selected runtime memory scope without reading the containing repository scope', async () => {
    const h = await setup(true);
    await Storage.runWithResolvedRuntimeBaseDir(
      h.secondary.sessionRuntimeBaseDir,
      async () => {
        for (const scope of ['workspace', 'git-root'] as const) {
          const directory = runWithMemoryProjectScope(scope, () =>
            getAutoMemoryRoot(h.secondary.workspaceCwd),
          );
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(
            path.join(directory, 'existing.md'),
            document.replace(
              'Validate rollback paths.',
              scope === 'workspace'
                ? 'SELECTED_SCOPE_ONLY'
                : 'WRONG_REPOSITORY_SCOPE',
            ),
          );
        }
      },
    );
    const base = '/workspaces/secondary/memory/import';
    const response = await request(h.app)
      .post(`${base}/batches`)
      .set('x-confirm', 'yes')
      .send({ source, selection: selection(), idempotencyKey: 'scope' });
    expect(response.status).toBe(202);
    await terminal(h.app, base, response.body.id);
    const input = vi.mocked(h.secondary.bridge.invokeWorkspaceCommand).mock
      .calls[0][1];
    expect(JSON.stringify(input)).toContain('SELECTED_SCOPE_ONLY');
    expect(JSON.stringify(input)).not.toContain('WRONG_REPOSITORY_SCOPE');
  });
  it('preserves mutation protection and rejects missing or untrusted workspace without fallback', async () => {
    const h = await setup();
    expect(
      (
        await request(h.app)
          .post('/workspaces/secondary/memory/import/preview')
          .send(source)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(h.app)
          .post('/workspaces/missing/memory/import/preview')
          .set('x-confirm', 'yes')
          .send(source)
      ).status,
    ).toBe(400);
    Object.assign(h.secondary, { trusted: false });
    expect(
      (
        await request(h.app)
          .post('/workspaces/secondary/memory/import/preview')
          .set('x-confirm', 'yes')
          .send(source)
      ).status,
    ).toBe(403);
    expect(h.primary.bridge.invokeWorkspaceCommand).not.toHaveBeenCalled();
  });
  it('stops publication when the selected generation closes during model work', async () => {
    const h = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(h.secondary.bridge.invokeWorkspaceCommand).mockImplementation(
      async () => {
        await gate;
        return {
          decision: 'new',
          reason: 'new',
          documents: [document],
        } as never;
      },
    );
    const base = '/workspaces/secondary/memory/import';
    const response = await request(h.app)
      .post(`${base}/batches`)
      .set('x-confirm', 'yes')
      .send({ source, selection: selection(), idempotencyKey: 'drain' });
    await vi.waitFor(() =>
      expect(h.secondary.bridge.invokeWorkspaceCommand).toHaveBeenCalled(),
    );
    h.registry.beginDrain(h.secondary);
    release();
    expect(
      (await request(h.app).get(`${base}/batches/${response.body.id}`)).status,
    ).toBe(503);
    await vi.waitFor(async () => {
      const batchRoot = path.join(
        h.secondary.sessionRuntimeBaseDir,
        'memory-import',
        'batches',
      );
      const owners = await fs.readdir(batchRoot);
      const task = JSON.parse(
        await fs.readFile(
          path.join(batchRoot, owners[0], response.body.id, 'task.json'),
          'utf8',
        ),
      );
      expect(task.status).toBe('partial');
    });
    await expect(
      fs.stat(
        path.join(h.secondary.sessionRuntimeBaseDir, 'imported-project-memory'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
