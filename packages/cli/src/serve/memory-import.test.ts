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
import { createHash } from 'node:crypto';
import { MemoryImportService } from '../memory-import/service.js';
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
  vi.restoreAllMocks();
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
    const invoke = vi.fn(
      async (_method: string, input: { sources: Array<{ id: string }> }) => ({
        items: input.sources.map(({ id }) => ({
          id,
          decision: 'new',
          reason: 'durable',
          documents: [document],
        })),
      }),
    );
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
      bridge: {
        invokeWorkspaceCommand: invoke,
        isWorkspaceMemoryRememberAvailable: vi.fn(async () => true),
      },
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
  it('retries failed startup recovery and resumes a queued task', async () => {
    const h = await setup();
    const invoke = vi.mocked(h.secondary.bridge.invokeWorkspaceCommand);
    const originalModel = invoke.getMockImplementation()!;
    invoke.mockRejectedValueOnce(new Error('Synthetic model interruption'));
    const base = '/workspaces/secondary/memory/import';
    const submitted = await request(h.app)
      .post(`${base}/batches`)
      .set('x-confirm', 'yes')
      .send({ source, selection: selection(), idempotencyKey: 'restart' });
    expect((await terminal(h.app, base, submitted.body.id))['status']).toBe(
      'partial',
    );
    const owner = createHash('sha256')
      .update(path.resolve(h.secondary.workspaceCwd))
      .digest('hex');
    const taskPath = path.join(
      h.secondary.sessionRuntimeBaseDir,
      'memory-import',
      'batches',
      owner,
      submitted.body.id,
      'task.json',
    );
    const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
    task.status = 'queued';
    task.items[0].status = 'pending';
    await fs.writeFile(taskPath, JSON.stringify(task));
    invoke.mockImplementation(originalModel);
    invoke.mockClear();
    const originalRecover = MemoryImportService.prototype.recover;
    const attempted = new Set<MemoryImportService>();
    const recover = vi
      .spyOn(MemoryImportService.prototype, 'recover')
      .mockImplementation(async function (this: MemoryImportService) {
        if (!attempted.has(this)) {
          attempted.add(this);
          throw Object.assign(new Error('Synthetic root I/O failure'), {
            code: 'EIO',
          });
        }
        return originalRecover.call(this);
      });
    const app = express();
    app.use(express.json());
    mountMemoryImportRoutes(app, {
      workspaceRegistry: h.registry,
      mutate: () => (_req, _res, next) => next(),
    });
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    expect((await terminal(app, base, submitted.body.id))['status']).toBe(
      'completed',
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledTimes(3);
    await request(app).get(`${base}/batches`);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(h.primary.bridge.invokeWorkspaceCommand).not.toHaveBeenCalled();
  });
  it('reports recovery failure without returning stale status or affecting preview', async () => {
    const recover = vi
      .spyOn(MemoryImportService.prototype, 'recover')
      .mockRejectedValue(
        Object.assign(new Error('Synthetic recovery I/O failure'), {
          code: 'EIO',
        }),
      );
    const h = await setup();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    const base = '/workspaces/secondary/memory/import';
    const preview = await request(h.app)
      .post(`${base}/preview`)
      .set('x-confirm', 'yes')
      .send(source);
    expect(preview.status).toBe(200);
    expect(recover).toHaveBeenCalledTimes(2);
    for (const suffix of ['/batches', `/batches/${'a'.repeat(64)}`]) {
      const response = await request(h.app).get(base + suffix);
      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
      expect(response.body.code).toBe('memory_import_recovery_unavailable');
      expect(response.body).not.toHaveProperty('status');
    }
    expect(recover).toHaveBeenCalledTimes(4);
    expect(h.secondary.bridge.invokeWorkspaceCommand).not.toHaveBeenCalled();
    await expect(
      fs.stat(h.secondary.sessionRuntimeBaseDir),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('shares an in-flight recovery and does not rescan after success', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recover = vi
      .spyOn(MemoryImportService.prototype, 'recover')
      .mockReturnValue(gate);
    const h = await setup();
    const list = vi.spyOn(MemoryImportService.prototype, 'list');
    let completed = 0;
    const requests = [0, 1].map(() =>
      request(h.app)
        .get('/workspaces/secondary/memory/import/batches')
        .then((response) => {
          completed++;
          return response;
        }),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(completed).toBe(0);
      expect(list).not.toHaveBeenCalled();
      expect(recover).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }
    expect(
      (await Promise.all(requests)).map((response) => response.status),
    ).toEqual([200, 200]);
    await request(h.app).get('/workspaces/secondary/memory/import/batches');
    expect(recover).toHaveBeenCalledTimes(2);
  });
  it('reports a closed generation as retryable runtime unavailability', async () => {
    const h = await setup();
    h.secondary.generationGuard!.close();
    const response = await request(h.app).get(
      '/workspaces/secondary/memory/import/batches',
    );
    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.body.code).toBe('workspace_runtime_unavailable');
    expect(h.secondary.bridge.invokeWorkspaceCommand).not.toHaveBeenCalled();
  });
  it.each(['EIO', 'ENOENT'])(
    'reports collection storage %s as server failure',
    async (code) => {
      const h = await setup();
      vi.spyOn(MemoryImportService.prototype, 'list').mockRejectedValue(
        Object.assign(new Error('Private storage details'), { code }),
      );
      const response = await request(h.app).get(
        '/workspaces/secondary/memory/import/batches',
      );
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('memory_import_failed');
      expect(JSON.stringify(response.body)).not.toContain(
        'Private storage details',
      );
    },
  );
  it('keeps client validation separate from an explicitly missing batch', async () => {
    const h = await setup();
    const base = '/workspaces/secondary/memory/import';
    for (const body of [
      { source: {}, selection: selection(), idempotencyKey: 'invalid-source' },
      { source, selection: [], idempotencyKey: 'invalid-selection' },
    ]) {
      const response = await request(h.app)
        .post(`${base}/batches`)
        .set('x-confirm', 'yes')
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('memory_import_rejected');
    }
    const missing = await request(h.app).get(
      `${base}/batches/${'a'.repeat(64)}`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('memory_import_not_found');
    expect((await request(h.app).get(`${base}/batches/invalid`)).status).toBe(
      400,
    );
    expect(h.secondary.bridge.invokeWorkspaceCommand).not.toHaveBeenCalled();
  });
  it('refuses admission and retry while managed memory is unavailable', async () => {
    const h = await setup();
    const base = '/workspaces/secondary/memory/import';
    const submitted = await request(h.app)
      .post(`${base}/batches`)
      .set('x-confirm', 'yes')
      .send({ source, selection: selection(), idempotencyKey: 'available' });
    expect(submitted.status).toBe(202);
    expect((await terminal(h.app, base, submitted.body.id))['status']).toBe(
      'completed',
    );
    expect(h.secondary.bridge.invokeWorkspaceCommand).toHaveBeenCalledTimes(1);

    vi.mocked(
      h.secondary.bridge.isWorkspaceMemoryRememberAvailable,
    ).mockResolvedValue(false);
    const refused = await request(h.app)
      .post(`${base}/batches`)
      .set('x-confirm', 'yes')
      .send({ source, selection: selection(), idempotencyKey: 'refused' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('memory_import_rejected');
    expect(refused.body.error).toContain('unavailable');
    const retried = await request(h.app)
      .post(`${base}/batches/${submitted.body.id}/retry`)
      .set('x-confirm', 'yes')
      .send({});
    expect(retried.status).toBe(400);
    expect(retried.body.code).toBe('memory_import_rejected');
    expect(h.secondary.bridge.invokeWorkspaceCommand).toHaveBeenCalledTimes(1);
  });
  it.each(['submit', 'retry'] as const)(
    'returns the durable %s receipt if the runtime drains after admission',
    async (method) => {
      const h = await setup();
      const base = '/workspaces/secondary/memory/import';
      const original = MemoryImportService.prototype[method];
      const owner = createHash('sha256')
        .update(path.resolve(h.secondary.workspaceCwd))
        .digest('hex');
      const batchRoot = path.join(
        h.secondary.sessionRuntimeBaseDir,
        'memory-import',
        'batches',
        owner,
      );
      let id: string | undefined;
      if (method === 'retry') {
        vi.mocked(
          h.secondary.bridge.invokeWorkspaceCommand,
        ).mockRejectedValueOnce(new Error('Synthetic model failure'));
        const seed = await request(h.app)
          .post(`${base}/batches`)
          .set('x-confirm', 'yes')
          .send({
            source,
            selection: selection(),
            idempotencyKey: 'durable-receipt',
          });
        id = seed.body.id;
        expect((await terminal(h.app, base, id!))['status']).toBe('partial');
      }
      let admitted!: Awaited<ReturnType<MemoryImportService['submit']>>;
      let settle!: () => Promise<unknown>;
      vi.spyOn(MemoryImportService.prototype, method).mockImplementation(
        async function (
          this: MemoryImportService,
          ...args:
            | Parameters<MemoryImportService['submit']>
            | Parameters<MemoryImportService['retry']>
        ) {
          const task =
            method === 'submit'
              ? await (original as MemoryImportService['submit']).apply(
                  this,
                  args as Parameters<MemoryImportService['submit']>,
                )
              : await (original as MemoryImportService['retry']).apply(
                  this,
                  args as Parameters<MemoryImportService['retry']>,
                );
          admitted = task;
          settle = this.idle.bind(this, task.id);
          h.registry.beginDrain(h.secondary);
          return task;
        },
      );
      const response = await request(h.app)
        .post(id ? `${base}/batches/${id}/retry` : `${base}/batches`)
        .set('x-confirm', 'yes')
        .send(
          id
            ? {}
            : {
                source,
                selection: selection(),
                idempotencyKey: 'durable-receipt',
              },
        );
      expect(response.status).toBe(202);
      expect(response.body.id).toBe(admitted.id);
      await expect(settle()).rejects.toThrow(
        'Workspace memory import is unavailable.',
      );
      const saved = JSON.parse(
        await fs.readFile(
          path.join(batchRoot, admitted.id, 'task.json'),
          'utf8',
        ),
      );
      expect(saved.id).toBe(admitted.id);
      expect(
        saved.items.some((item: { status: string }) => item.status === 'added'),
      ).toBe(false);
      expect(h.primary.bridge.invokeWorkspaceCommand).not.toHaveBeenCalled();
    },
  );
  it.each(['close', 'untrust'] as const)(
    'does not return retained source after runtime %s',
    async (change) => {
      const h = await setup();
      const base = '/workspaces/secondary/memory/import';
      const submitted = await request(h.app)
        .post(`${base}/batches`)
        .set('x-confirm', 'yes')
        .send({
          source,
          selection: selection(),
          idempotencyKey: 'protected-source',
        });
      await terminal(h.app, base, submitted.body.id);
      const original = MemoryImportService.prototype.source;
      vi.spyOn(MemoryImportService.prototype, 'source').mockImplementation(
        async function (this: MemoryImportService, ...args) {
          const retained = await original.apply(this, args);
          if (change === 'close') h.secondary.generationGuard!.close();
          else Object.assign(h.secondary, { trusted: false });
          return retained;
        },
      );
      const response = await request(h.app).get(
        `${base}/batches/${submitted.body.id}/sources/${selection()[0].id}`,
      );
      expect(response.status).toBe(503);
      expect(response.body).not.toHaveProperty('content');
      expect(JSON.stringify(response.body)).not.toContain(
        'Validate rollback paths',
      );
    },
  );
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
  it.each(['workspace', 'git-root', undefined, null] as const)(
    'uses selected runtime scope %s without falling back to the process scope',
    async (configuredScope) => {
      const h = await setup(true);
      const selectedScope = configuredScope ?? 'git-root';
      vi.stubEnv(
        'QWEN_CODE_MEMORY_PROJECT_SCOPE',
        selectedScope === 'workspace' ? 'git-root' : 'workspace',
      );
      Object.assign(h.secondary.env, {
        mode: configuredScope === null ? 'runtime-overlay' : 'parent-process',
        effectiveEnv:
          configuredScope === null
            ? undefined
            : configuredScope === undefined
              ? {}
              : { QWEN_CODE_MEMORY_PROJECT_SCOPE: configuredScope },
      });
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
                scope === selectedScope
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
    },
  );
  it.each(['QWEN_CODE_MEMORY_BASE_DIR', 'QWEN_CODE_MEMORY_LOCAL'])(
    'rejects legacy process override %s even when the runtime overlay clears it',
    async (key) => {
      const h = await setup();
      vi.stubEnv(
        key,
        key === 'QWEN_CODE_MEMORY_LOCAL'
          ? '1'
          : path.join(root, 'other-runtime'),
      );
      Object.assign(h.secondary.env, {
        effectiveEnv: {
          [key]: '',
          QWEN_CODE_MEMORY_PROJECT_SCOPE: 'workspace',
        },
      });
      const response = await request(h.app)
        .post('/workspaces/secondary/memory/import/batches')
        .set('x-confirm', 'yes')
        .send({
          source,
          selection: selection(),
          idempotencyKey: 'legacy-override',
        });
      expect(response.status).toBe(400);
      expect(h.secondary.bridge.invokeWorkspaceCommand).not.toHaveBeenCalled();
      await expect(
        fs.stat(h.secondary.sessionRuntimeBaseDir),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fs.stat(path.join(root, 'other-runtime')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
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
