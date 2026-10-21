/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import lockfile from 'proper-lockfile';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { scanAutoMemorySnapshot } from '@qwen-code/qwen-code-core/memory/structured-scan.js';
import { getImportedProjectMemoryRoot } from '@qwen-code/qwen-code-core/memory/import-paths.js';
import { getUserAutoMemoryRoot } from '@qwen-code/qwen-code-core/memory/paths.js';
import { MemoryImportService } from './service.js';
import { digest, previewSource } from './source.js';
import type {
  MemoryImportProposal,
  MemoryImportModelInput,
} from '@qwen-code/qwen-code-core/memory/import-model.js';
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
  vi.restoreAllMocks();
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
    propose: async (input) => {
      const result = await propose();
      return { items: input.sources.map(({ id }) => ({ id, ...result })) };
    },
  });
}
const selection = () => [
  { id: previewSource(source).sections[0].id, scope: 'project' },
];
describe('durable memory import', () => {
  it.each(['LF', 'CRLF'])(
    'uses native metadata parsing with %s closing-fence whitespace',
    (newline) =>
      context(async () => {
        const memory = getImportedProjectMemoryRoot(project);
        await fs.mkdir(memory, { recursive: true });
        let content = doc.replace('\n---\n', '\n--- \n');
        if (newline === 'CRLF') content = content.replaceAll('\n', '\r\n');
        await fs.writeFile(path.join(memory, 'existing.md'), content);
        const input = {
          ...source,
          files: [
            {
              path: 'MEMORY.md',
              content:
                '# Cloud\ncwd: /synthetic/project\nCloud widget deployment.',
            },
          ],
        };
        const propose = vi.fn(async (request: MemoryImportModelInput) => ({
          items: request.sources.map(({ id }) => ({
            id,
            decision: 'skip' as const,
            reason: 'No new facts.',
            documents: [],
          })),
        }));
        const svc = new MemoryImportService({
          projectRoot: project,
          assertActive: () => {},
          propose,
        });
        const task = await svc.submit(
          input,
          [{ id: previewSource(input).sections[0].id, scope: 'project' }],
          'native-metadata',
        );
        expect((await svc.idle(task.id)).items[0].status).toBe('skipped');
        expect(propose).toHaveBeenCalledTimes(1);
        const existing = propose.mock.calls[0][0].existing[0];
        expect(existing.indexOnly).toBe(true);
        expect(JSON.parse(existing.content)).toMatchObject({
          name: 'Review migrations',
          type: 'project',
          keywords: ['database migrations', 'rollback checks'],
        });
      }),
  );

  it.each(['new', 'retained'])(
    'retries a %s scope-invalid model proposal without resetting usage',
    (mode) =>
      context(async () => {
        const proposed = vi
          .fn()
          .mockResolvedValueOnce({
            decision: 'new',
            reason: 'Invalid user scope.',
            documents: [doc],
          })
          .mockResolvedValue({
            decision: 'new',
            reason: 'Portable knowledge.',
            documents: [doc.replace('type: project', 'type: user')],
          });
        const svc = service(proposed);
        const selected = [{ ...selection()[0], scope: 'user' }];
        const task = await svc.submit(source, selected, 'scope-retry');
        const first = await svc.idle(task.id);
        expect(first.items[0].status).toBe('failed');
        const journal = path.join(
          runtime,
          'memory-import',
          'batches',
          digest(project),
          task.id,
          'proposals.json',
        );
        if (mode === 'new')
          await expect(fs.stat(journal)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        else
          await fs.writeFile(
            journal,
            JSON.stringify([
              {
                scope: 'user',
                sections: [{ id: selected[0].id, key: selected[0].id }],
                baseline: [],
                proposal: {
                  items: [
                    {
                      id: selected[0].id,
                      decision: 'new',
                      reason: 'Legacy invalid scope.',
                      documents: [doc],
                    },
                  ],
                },
              },
            ]),
          );
        const restarted = service(proposed);
        await restarted.retry(task.id);
        const done = await restarted.idle(task.id);
        expect(done.items[0].status).toBe('added');
        expect(proposed).toHaveBeenCalledTimes(2);
        expect(done.usage.modelCalls).toBe(2);
        expect(done.usage.reservedTokens).toBeGreaterThan(
          first.usage.reservedTokens,
        );
      }),
  );

  it('does not allocate state for unknown retry IDs', () =>
    context(async () => {
      const svc = service();
      for (const char of ['d', 'e', 'f'])
        await expect(svc.retry(char.repeat(64))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      const owner = path.join(
        runtime,
        'memory-import',
        'batches',
        digest(project),
      );
      expect(await fs.readdir(owner).catch(() => [])).toEqual([]);
    }));

  it.each(['model', 'state write'])(
    'fences a lost task lock during %s without cancelling another task',
    (phase) =>
      context(async () => {
        const locks = new Map<
          string,
          {
            release: () => Promise<void>;
            compromise: () => void;
          }
        >();
        const realLock = lockfile.lock.bind(lockfile);
        vi.spyOn(lockfile, 'lock').mockImplementation(async (file, options) => {
          const release = await realLock(file, options);
          locks.set(file, {
            release,
            compromise: () =>
              options?.onCompromised?.(
                Object.assign(new Error('Synthetic lock loss'), {
                  code: 'ECOMPROMISED',
                }),
              ),
          });
          return release;
        });
        let entered!: () => void;
        const modelEntered = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let enteredUser!: () => void;
        const userEntered = new Promise<void>((resolve) => {
          enteredUser = resolve;
        });
        let proceed!: () => void;
        const gate = new Promise<void>((resolve) => {
          proceed = resolve;
        });
        const svc = new MemoryImportService({
          projectRoot: project,
          assertActive: () => {},
          propose: async (input) => {
            if (input.scope === 'project') entered();
            else enteredUser();
            await gate;
            return {
              items: input.sources.map(({ id }) => ({
                id,
                decision: 'new' as const,
                reason: 'Synthetic knowledge.',
                documents: [
                  input.scope === 'user'
                    ? doc.replace('type: project', 'type: user')
                    : doc,
                ],
              })),
            };
          },
        });
        const a = await svc.submit(source, selection(), 'lost-lock');
        await modelEntered;
        const dir = path.join(
          runtime,
          'memory-import',
          'batches',
          digest(project),
          a.id,
        );
        const file = path.join(dir, 'task.json');
        const held = locks.get(dir)!;
        const replacement = JSON.parse(await fs.readFile(file, 'utf8'));
        replacement.updatedAt = '2030-01-01T00:00:00.000Z';
        replacement.usage = { modelCalls: 17, reservedTokens: 123456 };
        const bytes = JSON.stringify(replacement);
        const realWrite = fs.writeFile;
        let replacementRelease: (() => Promise<void>) | undefined;
        const loseLock = async () => {
          await held.release();
          replacementRelease = await realLock(dir, { realpath: false });
          await realWrite(file, bytes);
          held.compromise();
        };
        if (phase === 'state write')
          vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
            await realWrite(...args);
            if (
              String(args[0]).startsWith(`${file}.`) &&
              String(args[1]).includes('"status":"added"') &&
              !replacementRelease
            )
              await loseLock();
          });
        try {
          const b = await svc.submit(
            source,
            [{ ...selection()[0], scope: 'user' }],
            'unrelated',
          );
          await userEntered;
          if (phase === 'model') await loseLock();
          proceed();
          await svc.idle(a.id);
          const doneB = await svc.idle(b.id);
          expect(replacementRelease).toBeDefined();
          expect(await fs.readFile(file, 'utf8')).toBe(bytes);
          expect(doneB.status).toBe('completed');
          expect(doneB.items[0].status).toBe('added');
        } finally {
          proceed();
          await svc.idle(a.id);
          await replacementRelease?.();
        }
      }),
  );
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
  it('retries failed items even while the submit worker is still registered', () =>
    context(async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const propose = vi.fn(async (): Promise<MemoryImportProposal> => {
        calls++;
        if (calls === 1) {
          await gate;
          throw new Error('model unavailable');
        }
        return { decision: 'new', reason: 'new', documents: [doc] };
      });
      const svc = service(propose);
      const task = await svc.submit(source, selection(), 'race');
      // The first worker is blocked inside propose; an explicit retry issued
      // now must wait it out, reset the failed item and run again rather
      // than returning early with the failure still pending.
      const retrying = svc.retry(task.id);
      release();
      const retried = await retrying;
      const done = await svc.idle(retried.id);
      expect(done.items[0].status).toBe('added');
      expect(propose).toHaveBeenCalledTimes(2);
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
        const state = path.join(
          runtime,
          'memory-import',
          'scopes',
          digest(target),
        );
        const ledger = JSON.parse(
          await fs.readFile(path.join(state, 'ledger.json'), 'utf8'),
        );
        expect(ledger[selection()[0].id]).toBeUndefined();
        expect(
          (await fs.readdir(state)).some((entry) => entry.startsWith('stage-')),
        ).toBe(false);
        const next = await svc.submit(source, selection(), 'after-late-edit');
        expect((await svc.idle(next.id)).items[0].status).toBe('added');
        expect(
          await fs.readFile(path.join(target, 'user-edit.md'), 'utf8'),
        ).toBe(doc.replace('every schema', 'only additive schema'));
      } finally {
        rename.mockRestore();
      }
    }));
  it('reconsolidates an unpublished interrupted intent against changed memory in a new task', () =>
    context(async () => {
      const original = fs.rename;
      const rename = vi
        .spyOn(fs, 'rename')
        .mockImplementation(async (from, to) => {
          if (path.basename(String(from)).startsWith('stage-'))
            throw new Error('Synthetic interruption before publication');
          return original(from, to);
        });
      const propose = vi.fn(
        async (): Promise<MemoryImportProposal> => ({
          decision: 'new',
          reason: 'new',
          documents: [doc],
        }),
      );
      const svc = service(propose);
      const first = await svc.submit(source, selection(), 'interrupted-intent');
      expect((await svc.idle(first.id)).items[0].status).toBe('failed');
      rename.mockRestore();
      const target = getImportedProjectMemoryRoot(project);
      const edited = doc.replace('every schema', 'only additive schema');
      await fs.writeFile(path.join(target, 'external.md'), edited);
      const next = await svc.submit(
        source,
        selection(),
        'fresh-after-interruption',
      );
      expect((await svc.idle(next.id)).items[0].status).toBe('added');
      expect(propose).toHaveBeenCalledTimes(2);
      expect(await fs.readFile(path.join(target, 'external.md'), 'utf8')).toBe(
        edited,
      );
    }));
  it.each([
    'unpublished',
    'abandoned',
    'published-edited',
    'published-forgotten',
    'committed-forgotten',
  ])(
    'distinguishes %s records when another source proposes the same body',
    (state) =>
      context(async () => {
        const original = fs.rename;
        const rename = vi
          .spyOn(fs, 'rename')
          .mockImplementation(async (from, to) => {
            if (
              path.basename(String(from)).startsWith('stage-') &&
              state !== 'committed-forgotten'
            ) {
              if (state.startsWith('published-')) await original(from, to);
              throw new Error('Synthetic interruption at publication');
            }
            return original(from, to);
          });
        const svc = service();
        const first = await svc.submit(source, selection(), 'first-source');
        expect((await svc.idle(first.id)).items[0].status).toBe(
          state === 'committed-forgotten' ? 'added' : 'failed',
        );
        rename.mockRestore();
        const memory = getImportedProjectMemoryRoot(project);
        if (state === 'abandoned')
          await fs.rm(
            path.join(
              runtime,
              'memory-import',
              'scopes',
              digest(memory),
              `stage-${selection()[0].id}`,
            ),
            { recursive: true, force: true },
          );
        const file = path.join(memory, 'imported', selection()[0].id, '0.md');
        if (state === 'published-edited')
          await fs.appendFile(file, '\nUser edit.\n');
        if (state.endsWith('forgotten')) await fs.unlink(file);
        const nextSource = {
          ...source,
          files: [
            {
              path: 'MEMORY.md',
              content:
                '# Another source\ncwd: /synthetic/project\nRemember the migration rollback requirement.',
            },
          ],
        };
        const next = await svc.submit(
          nextSource,
          [{ id: previewSource(nextSource).sections[0].id, scope: 'project' }],
          'second-source',
        );
        expect((await svc.idle(next.id)).items[0].status).toBe(
          state === 'unpublished' || state === 'abandoned'
            ? 'added'
            : 'conflict',
        );
        if (state === 'published-edited')
          expect(await fs.readFile(file, 'utf8')).toBe(doc + '\nUser edit.\n');
        if (state.endsWith('forgotten'))
          await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      }),
  );
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
  it('rejects a symlinked user memory root before model usage, including retry', () =>
    context(async () => {
      const external = path.join(root, 'dotfiles-memories');
      await fs.mkdir(external);
      const existing = doc.replace('type: project', 'type: user');
      await fs.writeFile(path.join(external, 'existing.md'), existing);
      const memory = getUserAutoMemoryRoot();
      await fs.mkdir(path.dirname(memory), { recursive: true });
      await fs.symlink(external, memory, 'dir');
      const propose = vi.fn(
        async (): Promise<MemoryImportProposal> => ({
          decision: 'new',
          reason: 'Portable preference.',
          documents: [
            existing.replace(
              'Validate rollback paths for every schema migration.',
              'Prefer concise explanations with runnable examples.',
            ),
          ],
        }),
      );
      const svc = service(propose);
      const task = await svc.submit(
        source,
        [{ ...selection()[0], scope: 'user' }],
        'symlinked-user-root',
      );
      for (const retry of [false, true]) {
        if (retry) await svc.retry(task.id);
        const result = await svc.idle(task.id);
        expect(result.status).toBe('partial');
        expect(result.items[0]).toMatchObject({
          status: 'failed',
          reason: expect.stringContaining('symlinked memory root'),
        });
        expect(result.usage).toEqual({ modelCalls: 0, reservedTokens: 0 });
      }
      expect(propose).not.toHaveBeenCalled();
      expect(await fs.readdir(external)).toEqual(['existing.md']);
      expect(
        await fs.readFile(path.join(external, 'existing.md'), 'utf8'),
      ).toBe(existing);
      expect((await fs.lstat(memory)).isSymbolicLink()).toBe(true);
      expect(
        (await scanAutoMemorySnapshot(project, { scopes: ['user'] })).docs,
      ).toHaveLength(1);
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

describe('bounded project batches', () => {
  const many = (count: number, separate = false) => ({
    ...source,
    files: [
      {
        path: 'MEMORY.md',
        content: Array.from(
          { length: count },
          (_, i) =>
            `# Topic ${i}\ncwd: /synthetic/${separate ? `project-${i}` : 'project'}\nIndependent durable fact number ${i}.`,
        ).join('\n\n'),
      },
    ],
  });
  const selections = (input: ReturnType<typeof many>) =>
    previewSource(input).sections.map(({ id }) => ({ id, scope: 'project' }));
  const skipped = (input: { sources: Array<{ id: string }> }) => ({
    items: input.sources.map(({ id }) => ({
      id,
      decision: 'skip' as const,
      reason: 'No new facts.',
      documents: [],
    })),
  });
  it('packs same-project sources, separates projects and exposes deterministic offline estimates', () =>
    context(async () => {
      const propose = vi.fn(async (input: MemoryImportModelInput) =>
        skipped(input),
      );
      const svc = new MemoryImportService({
        projectRoot: project,
        assertActive: () => {},
        propose,
      });
      const input = many(12);
      expect(previewSource(input).estimate.modelCalls).toBe(4);
      await expect(fs.stat(runtime)).rejects.toMatchObject({ code: 'ENOENT' });
      const task = await svc.submit(input, selections(input), 'packed');
      const result = await svc.idle(task.id);
      expect(result.status).toBe('completed');
      expect(propose.mock.calls.map(([input]) => input.sources.length)).toEqual(
        [8, 4],
      );
      expect(result.usage.modelCalls).toBe(2);
      const separate = many(3, true);
      expect(
        previewSource(separate).groups.map(
          (group) => group.estimate.modelCalls,
        ),
      ).toEqual([2, 2, 2]);
      const second = await svc.submit(
        separate,
        selections(separate),
        'separate',
      );
      await svc.idle(second.id);
      expect(
        propose.mock.calls.slice(2).map(([input]) => input.sources.length),
      ).toEqual([1, 1, 1]);
    }));
  it('finishes each project batch before another group can change its baseline', () =>
    context(async () => {
      const input = {
        ...source,
        files: [
          {
            path: 'MEMORY.md',
            content: Array.from(
              { length: 16 },
              (_, i) =>
                `# Source ${i}\ncwd: /synthetic/${i % 2 ? 'alpha' : 'beta'}\nIndependent durable fact ${i}.`,
            ).join('\n\n'),
          },
        ],
      };
      const sorted = [...previewSource(input).sections].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      const groups = sorted.map((item) => item.groupId);
      expect(
        groups.some(
          (group, i) =>
            i > 1 &&
            group !== groups[i - 1] &&
            groups.slice(0, i - 1).includes(group),
        ),
      ).toBe(true);
      const propose = vi.fn(async (input: MemoryImportModelInput) => ({
        items: input.sources.map(({ id }) => ({
          id,
          decision: 'new' as const,
          reason: 'Independent fact',
          documents: [
            doc.replace(
              'Validate rollback paths for every schema migration.',
              `Independent fact ${id}.`,
            ),
          ],
        })),
      }));
      const svc = new MemoryImportService({
        projectRoot: project,
        assertActive: () => {},
        propose,
      });
      const task = await svc.submit(input, selections(input), 'interleaved');
      const result = await svc.idle(task.id);
      expect(result.items.map((item) => item.status)).toEqual(
        Array(16).fill('added'),
      );
      expect(propose).toHaveBeenCalledTimes(2);
    }));
  it('reuses a journal after another batch commits to the same scope', () =>
    context(async () => {
      const input = many(2);
      const proposeFor = (tag: string) =>
        vi.fn(async (request: MemoryImportModelInput) => ({
          items: request.sources.map(({ id }) => ({
            id,
            decision: 'new' as const,
            reason: `${tag} fact`,
            documents: [
              doc.replace(
                'Validate rollback paths for every schema migration.',
                `${tag} fact ${id}.`,
              ),
            ],
          })),
        }));
      const a = new MemoryImportService({
        projectRoot: project,
        assertActive: () => {},
        propose: proposeFor('first'),
      });
      const b = new MemoryImportService({
        projectRoot: project,
        assertActive: () => {},
        propose: proposeFor('second'),
      });
      const original = fs.rename;
      let publications = 0;
      const rename = vi
        .spyOn(fs, 'rename')
        .mockImplementation(async (from, to) => {
          if (
            path.basename(String(from)).startsWith('stage-') &&
            path.basename(path.dirname(String(to))) === 'imported' &&
            ++publications === 2
          )
            throw new Error('Synthetic publication interruption');
          return original(from, to);
        });
      const task = await a.submit(input, selections(input), 'cross-batch-a');
      const first = await a.idle(task.id);
      rename.mockRestore();
      expect(first.items.map((item) => item.status).sort()).toEqual([
        'added',
        'failed',
      ]);
      const other = {
        version: 1,
        source: 'codex',
        files: [
          {
            path: 'MEMORY.md',
            content: '# Other\ncwd: /synthetic/project\nAnother durable fact.',
          },
        ],
      };
      const otherTask = await b.submit(
        other,
        selections(other),
        'cross-batch-b',
      );
      expect((await b.idle(otherTask.id)).items[0].status).toBe('added');
      await a.retry(task.id);
      const done = await a.idle(task.id);
      expect(done.items.map((item) => item.status).sort()).toEqual([
        'added',
        'added',
      ]);
    }));
  it('sends metadata instead of unrelated full bodies and rejects excessive evidence before calling the model', () =>
    context(async () => {
      const memory = getUserAutoMemoryRoot();
      await fs.mkdir(memory, { recursive: true });
      const unrelated = doc
        .replaceAll('Review migrations', 'Aquamarine palette')
        .replaceAll(
          'Validate database migrations before rollout',
          'Preferred visual colors',
        )
        .replaceAll(
          'database migrations, rollback checks',
          'color palette, paint settings',
        )
        .replaceAll('Reviewing schema migrations', 'Selecting colors')
        .replace(
          'Validate rollback paths for every schema migration.',
          'HIDDEN_FULL_BODY '.repeat(100),
        );
      await fs.writeFile(
        path.join(memory, 'unrelated.md'),
        unrelated.replace('type: project', 'type: user'),
      );
      const propose = vi.fn(async (input: MemoryImportModelInput) =>
        skipped(input),
      );
      const svc = new MemoryImportService({
        projectRoot: project,
        assertActive: () => {},
        propose,
      });
      const input = many(1);
      const task = await svc.submit(
        input,
        selections(input).map((item) => ({ ...item, scope: 'user' })),
        'compact',
      );
      await svc.idle(task.id);
      expect(propose).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(propose.mock.calls[0][0])).not.toContain(
        'HIDDEN_FULL_BODY',
      );
      expect(propose.mock.calls[0][0].existing[0].indexOnly).toBe(true);
      await fs.writeFile(
        path.join(memory, 'large.md'),
        unrelated
          .replace('Aquamarine palette', 'Independent durable')
          .replace('HIDDEN_FULL_BODY '.repeat(100), 'x'.repeat(40_000)),
      );
      const second = await svc.submit(
        input,
        selections(input).map((item) => ({ ...item, scope: 'user' })),
        'too-large',
      );
      // A processed source skips the model; a different source must evaluate the context.
      await svc.idle(second.id);
      const changed = many(2);
      const third = await svc.submit(
        changed,
        selections(changed).map((item) => ({ ...item, scope: 'user' })),
        'large-context',
      );
      const done = await svc.idle(third.id);
      expect(done.items.some((item) => item.reason?.includes('32 KiB'))).toBe(
        true,
      );
      expect(propose).toHaveBeenCalledTimes(1);
    }));
  it.each(['exact-body', 'reordered-terms'])(
    'includes CJK evidence for %s sources',
    (mode) =>
      context(async () => {
        const memory = getUserAutoMemoryRoot();
        await fs.mkdir(memory, { recursive: true });
        const body = '先检查蓝色图表，再确认灰色背景。';
        const content =
          '---\nname: 发布流程\ndescription: 上线检查与回滚验证\ntype: user\ncategory: testing_standard\nkeywords: [回滚验证, 上线检查]\nusage_scenarios: [上线检查]\n---\n' +
          body +
          '\n';
        await fs.writeFile(path.join(memory, 'existing.md'), content);
        const input = {
          version: 1,
          source: 'codex',
          files: [
            {
              path: 'MEMORY.md',
              content:
                '# 新偏好\n' +
                (mode === 'exact-body' ? body : '先做回滚验证再进行上线检查。'),
            },
          ],
        };
        const propose = vi.fn(async (request: MemoryImportModelInput) =>
          skipped(request),
        );
        const svc = new MemoryImportService({
          projectRoot: project,
          assertActive: () => {},
          propose,
        });
        const task = await svc.submit(
          input,
          [{ id: previewSource(input).sections[0].id, scope: 'user' }],
          'cjk',
        );
        expect((await svc.idle(task.id)).items[0].status).toBe('skipped');
        expect(propose).toHaveBeenCalledTimes(1);
        expect(propose.mock.calls[0][0].existing).toEqual([
          { ref: 'user:existing.md', content, indexOnly: false },
        ]);
      }),
  );
  it('matches tokens from the middle of a long source section', () =>
    context(async () => {
      const memory = getUserAutoMemoryRoot();
      await fs.mkdir(memory, { recursive: true });
      const existing =
        '---\nname: pnpm lockfile drift\ndescription: Keep the frozen lockfile reproducible\ntype: user\ncategory: dependency_configuration\nkeywords: [pnpm, lockfile, frozen-lockfile]\nusage_scenarios: [Updating dependencies]\n---\nUse the frozen lockfile in CI.\n';
      await fs.writeFile(path.join(memory, 'existing.md'), existing);
      const filler = (start: number, count: number) =>
        Array.from({ length: count }, (_, i) => `token${start + i}`).join(' ');
      const input = {
        version: 1,
        source: 'codex',
        files: [
          {
            path: 'MEMORY.md',
            content:
              '# Workflow\n' +
              `${filler(0, 32)} pnpm lockfile ${filler(32, 80)}`,
          },
        ],
      };
      const propose = vi.fn(async (request: MemoryImportModelInput) =>
        skipped(request),
      );
      const svc = new MemoryImportService({
        projectRoot: project,
        assertActive: () => {},
        propose,
      });
      const task = await svc.submit(
        input,
        [{ id: previewSource(input).sections[0].id, scope: 'user' }],
        'middle-tokens',
      );
      expect((await svc.idle(task.id)).items[0].status).toBe('skipped');
      expect(propose).toHaveBeenCalledTimes(1);
      expect(propose.mock.calls[0][0].existing).toEqual([
        { ref: 'user:existing.md', content: existing, indexOnly: false },
      ]);
    }));
  it('does not expand unrelated mature-store bodies for generic shared words', () =>
    context(async () => {
      const memory = getUserAutoMemoryRoot();
      await fs.mkdir(memory, { recursive: true });
      for (let i = 0; i < 40; i++) {
        const content =
          `---\nname: Database migration ${i}\ndescription: Review project changes before release and verify database migrations\ntype: user\ncategory: testing_standard\nkeywords: [database migration, rollback verification]\nusage_scenarios: [Review project configuration before release]\n---\n` +
          'Check transactional constraints and restore ordering. '.repeat(24);
        await fs.writeFile(path.join(memory, `existing-${i}.md`), content);
      }
      const input = {
        version: 1,
        source: 'codex',
        files: [
          {
            path: 'MEMORY.md',
            content:
              '# Chart preferences\nReview project changes before release and verify forest green charts on a white background.',
          },
        ],
      };
      const propose = vi.fn(async (request: MemoryImportModelInput) =>
        skipped(request),
      );
      const svc = new MemoryImportService({
        projectRoot: project,
        assertActive: () => {},
        propose,
      });
      const task = await svc.submit(
        input,
        [{ id: previewSource(input).sections[0].id, scope: 'user' }],
        'generic-words',
      );
      expect((await svc.idle(task.id)).items[0].status).toBe('skipped');
      expect(propose).toHaveBeenCalledTimes(1);
      expect(propose.mock.calls[0][0].existing).toHaveLength(40);
      expect(
        propose.mock.calls[0][0].existing.every((item) => item.indexOnly),
      ).toBe(true);
      expect(JSON.stringify(propose.mock.calls[0][0].existing)).not.toContain(
        'transactional constraints',
      );
    }));
  it('bounds the metadata index when a mature memory store exceeds the context budget', () =>
    context(async () => {
      const memory = getUserAutoMemoryRoot();
      await fs.mkdir(memory, { recursive: true });
      for (let i = 0; i < 150; i++)
        await fs.writeFile(
          path.join(memory, `existing-${i}.md`),
          doc.replace(
            'Validate rollback paths for every schema migration.',
            `Validate rollback paths for every schema migration ${i}.`,
          ),
        );
      const unrelated = {
        version: 1,
        source: 'codex',
        files: [
          {
            path: 'MEMORY.md',
            content:
              '# Visual\ncwd: /synthetic/project\nPrefer forest green charts.',
          },
        ],
      };
      const propose = vi.fn(async (input: MemoryImportModelInput) => ({
        items: input.sources.map(({ id }) => ({
          id,
          decision: 'new' as const,
          reason: 'Portable knowledge.',
          documents: [doc.replace('type: project', 'type: user')],
        })),
      }));
      const svc = new MemoryImportService({
        projectRoot: project,
        assertActive: () => {},
        propose,
      });
      const task = await svc.submit(
        unrelated,
        [{ id: previewSource(unrelated).sections[0].id, scope: 'user' }],
        'bounded-index',
      );
      const done = await svc.idle(task.id);
      expect(done.status).toBe('completed');
      expect(done.items[0].status).toBe('added');
      expect(propose).toHaveBeenCalledTimes(1);
      const existing = propose.mock.calls[0][0].existing;
      expect(existing.length).toBeGreaterThan(0);
      expect(existing.length).toBeLessThan(150);
      expect(existing.every((item) => item.indexOnly)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(existing))).toBeLessThanOrEqual(
        32_768,
      );
    }));
  it('persists reservations across failed calls, restart and retry and stops at the total limit', () =>
    context(async () => {
      const propose = vi.fn(async () => {
        throw new Error('provider unavailable');
      });
      const create = () =>
        new MemoryImportService({
          projectRoot: project,
          assertActive: () => {},
          propose,
        });
      const input = many(40, true);
      const svc = create();
      const task = await svc.submit(input, selections(input), 'budget');
      const first = await svc.idle(task.id);
      expect(first.status).toBe('partial');
      expect(first.usage.modelCalls).toBeLessThanOrEqual(first.budget.maxCalls);
      expect(first.usage.reservedTokens).toBeLessThanOrEqual(
        first.budget.maxReservedTokens,
      );
      expect(
        first.items.some((item) => item.reason?.includes('budget exhausted')),
      ).toBe(true);
      const calls = propose.mock.calls.length;
      const restarted = create();
      await restarted.retry(task.id);
      const retried = await restarted.idle(task.id);
      expect(retried.usage).toEqual(first.usage);
      expect(propose).toHaveBeenCalledTimes(calls);
    }));
  it('does not replenish legacy tasks with unknown historical usage', () =>
    context(async () => {
      const propose = vi.fn(async () => {
        throw new Error('unavailable');
      });
      const svc = service(propose);
      const task = await svc.submit(source, selection(), 'legacy-budget');
      await svc.idle(task.id);
      const owners = await fs.readdir(
        path.join(runtime, 'memory-import', 'batches'),
      );
      const file = path.join(
        runtime,
        'memory-import',
        'batches',
        owners[0],
        task.id,
        'task.json',
      );
      const stored = JSON.parse(await fs.readFile(file, 'utf8'));
      delete stored.usage;
      delete stored.budget;
      await fs.writeFile(file, JSON.stringify(stored));
      const restarted = service(propose);
      await restarted.retry(task.id);
      const result = await restarted.idle(task.id);
      expect(propose).toHaveBeenCalledTimes(1);
      expect(result.budget).toEqual({ maxCalls: 0, maxReservedTokens: 0 });
      expect(result.usage).toEqual({ modelCalls: 0, reservedTokens: 0 });
      expect(result.items[0].reason).toContain('budget exhausted');
    }));
  it('journals a complete batch before publication and resumes remaining sources without another model call', () =>
    context(async () => {
      const input = many(2);
      const propose = vi.fn(async (input: MemoryImportModelInput) => ({
        items: input.sources.map(({ id }: { id: string }) => ({
          id,
          decision: 'new' as const,
          reason: 'new',
          documents: [
            doc.replace(
              'Validate rollback paths for every schema migration.',
              `Distinct fact ${id}.`,
            ),
          ],
        })),
      }));
      const create = () =>
        new MemoryImportService({
          projectRoot: project,
          assertActive: () => {},
          propose,
        });
      const original = fs.rename;
      let publications = 0;
      const rename = vi
        .spyOn(fs, 'rename')
        .mockImplementation(async (from, to) => {
          if (String(from).includes('stage-') && ++publications === 2)
            throw new Error('synthetic crash before second publication');
          return original(from, to);
        });
      const svc = create();
      const task = await svc.submit(input, selections(input), 'resume-batch');
      const first = await svc.idle(task.id);
      expect(first.items.map((item) => item.status)).toEqual([
        'added',
        'failed',
      ]);
      rename.mockRestore();
      const restarted = create();
      await restarted.retry(task.id);
      const done = await restarted.idle(task.id);
      expect(done.items.map((item) => item.status)).toEqual(['added', 'added']);
      expect(propose).toHaveBeenCalledTimes(1);
      expect(done.usage).toEqual(first.usage);
    }));
  it.each(['unchanged', 'edited', 'forgotten', 'unrelated'])(
    'retries earlier groups after a later group publishes: %s',
    (change) =>
      context(async () => {
        const input = many(2, true);
        const propose = vi.fn(async (request: MemoryImportModelInput) => ({
          items: request.sources.map(({ id }) => ({
            id,
            decision: 'new' as const,
            reason: 'new',
            documents: [
              doc.replace(
                'Validate rollback paths for every schema migration.',
                `Distinct fact ${id}.`,
              ),
            ],
          })),
        }));
        const create = () =>
          new MemoryImportService({
            projectRoot: project,
            assertActive: () => {},
            propose,
          });
        const original = fs.writeFile;
        let interrupted = false;
        const write = vi
          .spyOn(fs, 'writeFile')
          .mockImplementation(async (file, ...args) => {
            if (
              !interrupted &&
              path.basename(path.dirname(String(file))).startsWith('stage-')
            ) {
              interrupted = true;
              throw new Error(
                'Synthetic failure after proposal and before intent',
              );
            }
            return original(file, ...args);
          });
        const svc = create();
        const task = await svc.submit(input, selections(input), 'cross-group');
        const first = await svc.idle(task.id);
        expect(first.items.map((item) => item.status).sort()).toEqual([
          'added',
          'failed',
        ]);
        write.mockRestore();
        const snapshot = await scanAutoMemorySnapshot(project);
        expect(snapshot.docs).toHaveLength(1);
        const file = snapshot.docs[0].filePath;
        const existing = await fs.readFile(file, 'utf8');
        if (change === 'edited')
          await fs.writeFile(file, existing + '\nUser correction.\n');
        if (change === 'forgotten') await fs.unlink(file);
        if (change === 'unrelated')
          await fs.writeFile(
            path.join(getImportedProjectMemoryRoot(project), 'unrelated.md'),
            doc,
          );
        const restarted = create();
        await restarted.retry(task.id);
        const done = await restarted.idle(task.id);
        const retried = done.items.find(
          (item) =>
            item.id ===
            first.items.find((item) => item.status === 'failed')!.id,
        )!;
        expect(retried.status).toBe(
          change === 'unchanged' ? 'added' : 'conflict',
        );
        expect(propose).toHaveBeenCalledTimes(2);
        expect(done.usage).toEqual(first.usage);
        if (change === 'forgotten')
          await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
        else
          expect(await fs.readFile(file, 'utf8')).toBe(
            existing + (change === 'edited' ? '\nUser correction.\n' : ''),
          );
      }),
  );
  it('rejects missing response IDs as a whole batch without repeated calls', () =>
    context(async () => {
      const input = many(3);
      const propose = vi.fn(async (input: MemoryImportModelInput) => ({
        items: [skipped(input).items[0]],
      }));
      const svc = new MemoryImportService({
        projectRoot: project,
        assertActive: () => {},
        propose,
      });
      const task = await svc.submit(input, selections(input), 'bad-ids');
      const done = await svc.idle(task.id);
      expect(done.items.every((item) => item.status === 'failed')).toBe(true);
      expect(propose).toHaveBeenCalledTimes(1);
      expect((await scanAutoMemorySnapshot(project)).docs).toEqual([]);
    }));
  it('clears the previous failure reason when an explicit retry succeeds', () =>
    context(async () => {
      let fail = true;
      const propose = vi.fn(async (): Promise<MemoryImportProposal> => {
        if (fail) throw new Error('model unavailable');
        return { decision: 'new', reason: '', documents: [doc] };
      });
      const svc = service(propose);
      const task = await svc.submit(source, selection(), 'flaky-model');
      const failed = await svc.idle(task.id);
      expect(failed.items[0].status).toBe('failed');
      expect(failed.items[0].reason).toBeTruthy();
      fail = false;
      await svc.retry(task.id);
      const done = await svc.idle(task.id);
      expect(done.items[0].status).toBe('added');
      expect(done.items[0]).not.toHaveProperty('reason');
    }));
  it('isolates a damaged batch directory from listing and recovery', () =>
    context(async () => {
      const svc = service();
      const task = await svc.submit(source, selection(), 'healthy');
      await svc.idle(task.id);
      const ownerState = path.join(
        runtime,
        'memory-import',
        'batches',
        digest(path.resolve(project)),
      );
      const damagedId = 'f'.repeat(64);
      await fs.mkdir(path.join(ownerState, damagedId), { recursive: true });
      await fs.writeFile(
        path.join(ownerState, damagedId, 'task.json'),
        'not json',
      );
      await expect(svc.list()).resolves.toHaveLength(1);
      await expect(svc.recover()).resolves.toBeUndefined();
      // The damaged batch itself still reports its storage failure.
      await expect(svc.get(damagedId)).rejects.toThrow();
    }));
  it('refuses to recover batches once the runtime sits inside a Git checkout', () =>
    context(async () => {
      let release!: (value: MemoryImportProposal) => void;
      const parked = new Promise<MemoryImportProposal>((resolve) => {
        release = resolve;
      });
      const admitted = vi.fn(() => parked);
      const first = service(admitted);
      const task = await first.submit(source, selection(), 'git-guard');
      await vi.waitFor(() => expect(admitted).toHaveBeenCalled());
      await fs.mkdir(path.join(root, '.git'));
      const recovered = vi.fn();
      const restarted = service(recovered);
      await expect(restarted.recover()).rejects.toThrow('Git checkout');
      expect(recovered).not.toHaveBeenCalled();
      release({
        decision: 'new',
        reason: 'Durable project knowledge.',
        documents: [doc],
      });
      await first.idle(task.id);
    }));
  it('reports an identical section from a second file as duplicate, not added', () =>
    context(async () => {
      const duplicated = {
        version: 1,
        source: 'codex',
        files: [
          {
            path: 'MEMORY.md',
            content:
              '# Shared\ncwd: /synthetic/project\nShared durable fact.\n# Pointer\ncwd: /synthetic/project\nSee rollout_summaries/note.md',
          },
          {
            path: 'rollout_summaries/note.md',
            content: '# Shared\ncwd: /synthetic/project\nShared durable fact.',
          },
        ],
      };
      const sections = previewSource(duplicated).sections.filter(
        (section) => section.title === 'Shared',
      );
      expect(sections).toHaveLength(2);
      expect(sections[0].content).toBe(sections[1].content);
      const svc = service();
      const task = await svc.submit(
        duplicated,
        sections.map((section) => ({ id: section.id, scope: 'project' })),
        'identical-text',
      );
      const done = await svc.idle(task.id);
      expect(done.items.map((item) => item.status).sort()).toEqual([
        'added',
        'duplicate',
      ]);
      expect(done.result?.newDocuments).toBe(1);
    }));
});
