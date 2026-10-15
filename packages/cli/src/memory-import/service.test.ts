/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { scanAutoMemorySnapshot } from '@qwen-code/qwen-code-core/memory/structured-scan.js';
import { getImportedProjectMemoryRoot } from '@qwen-code/qwen-code-core/memory/import-paths.js';
import { getUserAutoMemoryRoot } from '@qwen-code/qwen-code-core/memory/paths.js';
import { MemoryImportService } from './service.js';
import { previewSource } from './source.js';
import type { MemoryImportProposal } from '@qwen-code/qwen-code-core/memory/import-model.js';
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));
const doc =
  '---\nname: Review migrations\ndescription: Validate database migrations before rollout\ntype: project\ncategory: testing_standard\nkeywords: [database migrations, rollback checks]\nusage_scenarios: [Reviewing schema migrations]\n---\nValidate rollback paths for every schema migration.\n';
const source = {
  version: 1,
  source: 'codex',
  files: [
    {
      path: 'MEMORY.md',
      content:
        '# Database\ncwd: /synthetic/project\nKeep rollback validation for schema migrations.',
    },
  ],
};
let root: string;
let runtime: string;
let project: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-import-test-'));
  runtime = path.join(root, 'runtime');
  project = path.join(root, 'project');
  await fs.mkdir(project);
  vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', runtime);
  vi.stubEnv('QWEN_CODE_MEMORY_LOCAL', '0');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
function context<T>(fn: () => T): T {
  return Storage.runWithResolvedRuntimeBaseDir(runtime, fn);
}
function service(
  propose = vi.fn(
    async (): Promise<MemoryImportProposal> => ({
      decision: 'new',
      reason: 'Durable project knowledge.',
      documents: [doc],
    }),
  ),
) {
  return new MemoryImportService({
    projectRoot: project,
    assertActive: () => {},
    propose,
  });
}
const selection = () => [
  { id: previewSource(source).sections[0].id, scope: 'project' },
];
describe('durable memory import', () => {
  it('previews without creating a runtime directory', async () => {
    previewSource(source);
    await expect(fs.stat(runtime)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains only selected sources and publishes native documents', () =>
    context(async () => {
      const extra = {
        ...source,
        files: [
          {
            path: 'MEMORY.md',
            content: `${source.files[0].content}\n# Other\ncwd: /synthetic/other\nUnselected private fact.`,
          },
        ],
      };
      const svc = service();
      const task = await svc.submit(extra, selection(), 'one');
      const done = await svc.idle(task.id);
      expect(done.items[0].status).toBe('added');
      const snapshot = await scanAutoMemorySnapshot(project, {
        scopes: ['project'],
        uncapped: true,
      });
      expect(snapshot.docs.map((d) => d.body.trim())).toEqual([
        'Validate rollback paths for every schema migration.',
      ]);
      const retained = await svc.source(task.id, selection()[0].id);
      expect(retained.content).not.toContain('Unselected');
      await expect(
        svc.source(task.id, previewSource(extra).sections[1].id),
      ).rejects.toThrow('not found');
    }));
  it('makes repeated submission idempotent and rejects a changed key', () =>
    context(async () => {
      const propose = vi.fn(
        async (): Promise<MemoryImportProposal> => ({
          decision: 'new',
          reason: 'new',
          documents: [doc],
        }),
      );
      const svc = service(propose);
      const task = await svc.submit(source, selection(), 'one');
      await svc.idle(task.id);
      expect((await svc.submit(source, selection(), 'one')).id).toBe(task.id);
      const second = await svc.submit(source, selection(), 'two');
      expect((await svc.idle(second.id)).items[0].status).toBe('duplicate');
      expect(propose).toHaveBeenCalledTimes(1);
      await expect(
        svc.submit(source, [{ ...selection()[0], scope: 'user' }], 'one'),
      ).rejects.toThrow('different selection');
    }));
  it.each(['edit', 'forget'])(
    'does not restore %s of an imported record',
    (action) =>
      context(async () => {
        const svc = service();
        const task = await svc.submit(source, selection(), 'one');
        await svc.idle(task.id);
        const snapshot = await scanAutoMemorySnapshot(project, {
          scopes: ['project'],
          uncapped: true,
        });
        const file = snapshot.docs[0].filePath;
        if (action === 'edit')
          await fs.writeFile(
            file,
            doc.replace('every schema', 'only additive schema'),
          );
        else await fs.unlink(file);
        const fresh = service();
        const retry = await fresh.submit(source, selection(), 'two');
        expect((await fresh.idle(retry.id)).items[0].status).toBe('conflict');
        if (action === 'forget')
          await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
        else expect(await fs.readFile(file, 'utf8')).toContain('only additive');
      }),
  );
  it('retains novel documents in a mixed duplicate/new proposal', () =>
    context(async () => {
      const first = service();
      const task = await first.submit(source, selection(), 'first');
      await first.idle(task.id);
      const novel = doc.replace(
        'Validate rollback paths for every schema migration.',
        'Verify replica convergence after migrations.',
      );
      const nextSource = {
        ...source,
        files: [
          {
            path: 'MEMORY.md',
            content:
              '# Replication\ncwd: /synthetic/project\nValidate rollback and replica convergence.',
          },
        ],
      };
      const next = service(
        vi.fn(async () => ({
          decision: 'new',
          reason: 'mixed',
          documents: [doc, novel],
        })),
      );
      const batch = await next.submit(
        nextSource,
        [{ id: previewSource(nextSource).sections[0].id, scope: 'project' }],
        'second',
      );
      const result = await next.idle(batch.id);
      expect(result.result?.newDocuments).toBe(1);
      expect(
        (
          await scanAutoMemorySnapshot(project, {
            scopes: ['project'],
            uncapped: true,
          })
        ).docs,
      ).toHaveLength(2);
    }));
  it('rejects invalid model documents without publishing memory', () =>
    context(async () => {
      const svc = service(
        vi.fn(async () => ({
          decision: 'new',
          reason: 'bad',
          documents: ['not native'],
        })),
      );
      const task = await svc.submit(source, selection(), 'bad');
      expect((await svc.idle(task.id)).status).toBe('partial');
      expect((await scanAutoMemorySnapshot(project)).docs).toEqual([]);
    }));
  it('rechecks changes made during model execution', () =>
    context(async () => {
      const svc = service(
        vi.fn(async () => {
          const target = getImportedProjectMemoryRoot(project);
          await fs.mkdir(target, { recursive: true });
          await fs.writeFile(path.join(target, 'existing.md'), doc);
          return { decision: 'new', reason: 'new', documents: [doc] };
        }),
      );
      const task = await svc.submit(source, selection(), 'race');
      expect((await svc.idle(task.id)).items[0].status).toBe('conflict');
    }));
  it('persists model failures for explicit retry after restart', () =>
    context(async () => {
      const first = service(
        vi.fn(async () => {
          throw new Error('provider offline');
        }),
      );
      const task = await first.submit(source, selection(), 'retry');
      expect((await first.idle(task.id)).status).toBe('partial');
      const second = service();
      await second.retry(task.id);
      expect((await second.idle(task.id)).items[0].status).toBe('added');
    }));
  it('cancels before publication and supports explicit retry', () =>
    context(async () => {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const svc = service(
        vi.fn(async () => {
          entered();
          await gate;
          return { decision: 'new', reason: 'new', documents: [doc] };
        }),
      );
      const task = await svc.submit(source, selection(), 'cancel');
      await ready;
      const cancelled = svc.cancel(task.id);
      release();
      expect((await cancelled).status).toBe('cancelled');
      expect((await scanAutoMemorySnapshot(project)).docs).toEqual([]);
    }));
  it('serializes simultaneous batches targeting one scope', () =>
    context(async () => {
      const a = service();
      const b = service();
      const [x, y] = await Promise.all([
        a.submit(source, selection(), 'a'),
        b.submit(source, selection(), 'b'),
      ]);
      const results = await Promise.all([a.idle(x.id), b.idle(y.id)]);
      expect(results.map((t) => t.items[0].status).sort()).toEqual([
        'added',
        'duplicate',
      ]);
    }));
  it.each(['before', 'after'])(
    'recovers original addition counts when publication fails %s rename',
    (phase) =>
      context(async () => {
        const original = fs.rename;
        let injected = false;
        const rename = vi
          .spyOn(fs, 'rename')
          .mockImplementation(async (from, to) => {
            const publication =
              path.basename(String(from)).startsWith('stage-') &&
              path.basename(path.dirname(String(to))) === 'imported';
            if (publication && !injected) {
              injected = true;
              if (phase === 'after') await original(from, to);
              throw new Error('Synthetic publication interruption');
            }
            return original(from, to);
          });
        try {
          const propose = vi.fn(
            async (): Promise<MemoryImportProposal> => ({
              decision: 'new',
              reason: 'new',
              documents: [doc],
            }),
          );
          const first = service(propose);
          const task = await first.submit(source, selection(), 'recover');
          expect((await first.idle(task.id)).status).toBe('partial');
          const second = service(propose);
          await second.retry(task.id);
          const result = await second.idle(task.id);
          expect(result.items[0].status).toBe('added');
          expect(result.result?.newDocuments).toBe(1);
          expect(result.items[0].refs).toHaveLength(1);
          expect(propose).toHaveBeenCalledTimes(1);
          expect((await scanAutoMemorySnapshot(project)).docs).toHaveLength(1);
        } finally {
          rename.mockRestore();
        }
      }),
  );
  it('rechecks native changes after staging and before publication', () =>
    context(async () => {
      const original = fs.rename;
      let injected = false;
      const target = getImportedProjectMemoryRoot(project);
      const rename = vi
        .spyOn(fs, 'rename')
        .mockImplementation(async (from, to) => {
          await original(from, to);
          if (!injected && path.basename(String(to)) === 'ledger.json') {
            injected = true;
            await fs.mkdir(target, { recursive: true });
            await fs.writeFile(
              path.join(target, 'user-edit.md'),
              doc.replace('every schema', 'only additive schema'),
            );
          }
        });
      try {
        const svc = service();
        const task = await svc.submit(source, selection(), 'late-edit');
        expect((await svc.idle(task.id)).items[0].status).toBe('conflict');
        const snapshot = await scanAutoMemorySnapshot(project);
        expect(snapshot.docs).toHaveLength(1);
        expect(snapshot.docs[0].body).toContain('only additive');
      } finally {
        rename.mockRestore();
      }
    }));
  it('honors cancellation from another service instance before publication', () =>
    context(async () => {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const worker = service(
        vi.fn(async () => {
          entered();
          await gate;
          return { decision: 'new', reason: 'new', documents: [doc] };
        }),
      );
      const task = await worker.submit(source, selection(), 'cross-cancel');
      await ready;
      expect((await service().cancel(task.id)).status).toBe('cancelled');
      release();
      expect((await worker.idle(task.id)).status).toBe('cancelled');
      expect((await scanAutoMemorySnapshot(project)).docs).toEqual([]);
    }));
  it('rejects a symlinked batch directory on reads', () =>
    context(async () => {
      const svc = service();
      const task = await svc.submit(source, selection(), 'symlink');
      await svc.idle(task.id);
      const batches = path.join(runtime, 'memory-import', 'batches');
      const [owner] = await fs.readdir(batches);
      const batch = path.join(batches, owner, task.id);
      const external = path.join(root, 'outside');
      await fs.rename(batch, external);
      await fs.symlink(external, batch, 'dir');
      await expect(svc.get(task.id)).rejects.toThrow(
        'Invalid import state directory',
      );
    }));
  it('keeps user and project selection separate', () =>
    context(async () => {
      const svc = service(
        vi.fn(async () => ({
          decision: 'new',
          reason: 'portable user preference',
          documents: [doc.replace('type: project', 'type: feedback')],
        })),
      );
      const task = await svc.submit(
        source,
        [{ ...selection()[0], scope: 'user' }],
        'user',
      );
      await svc.idle(task.id);
      expect(
        (await scanAutoMemorySnapshot(project, { scopes: ['project'] })).docs,
      ).toEqual([]);
      expect(
        (await scanAutoMemorySnapshot(project, { scopes: ['user'] })).docs,
      ).toHaveLength(1);
      expect(await fs.stat(getUserAutoMemoryRoot())).toBeDefined();
    }));
});
