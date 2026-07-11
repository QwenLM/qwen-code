import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableCronTask } from './cronTasksFile.js';
import {
  addCronTask,
  appendCronRun,
  generateCronTaskId,
  getCronFilePath,
  MAX_TASK_RUNS,
  readCronTasks,
  removeCronTasks,
  updateCronTasks,
  writeCronTasks,
} from './cronTasksFile.js';
import { Storage } from '../config/storage.js';
import { getProjectHash } from '../utils/paths.js';

/** Seeds the on-disk tasks file directly, creating its (now hashed) dir. */
async function seedTasksFile(projectRoot: string, raw: string): Promise<void> {
  const file = getCronFilePath(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, raw);
}

// Hook for the stale-lock race test: runs just before the implementation
// renames a stale update lock aside, so a test can interleave a competing
// takeover between the stat and the rename. Pass-through while null.
const renameHook = vi.hoisted(() => ({
  current: null as ((src: string) => Promise<void>) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: (async (
      src: Parameters<typeof actual.rename>[0],
      dst: Parameters<typeof actual.rename>[1],
    ) => {
      if (renameHook.current) await renameHook.current(String(src));
      return actual.rename(src, dst);
    }) as typeof actual.rename,
  };
});

function makeTask(overrides?: Partial<DurableCronTask>): DurableCronTask {
  return {
    id: 'test001',
    cron: '*/5 * * * *',
    prompt: 'echo hello',
    recurring: true,
    createdAt: 1718000000000,
    lastFiredAt: null,
    ...overrides,
  };
}

describe('cronTasksFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-test-'));
    // Durable tasks live under the user runtime dir, not the working tree.
    // Redirect that base into the test temp dir so the per-project hash dir
    // lands under tmpDir instead of the real ~/.qwen.
    Storage.setRuntimeBaseDir(tmpDir);
  });

  afterEach(async () => {
    renameHook.current = null;
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getCronFilePath', () => {
    it('resolves to the per-project runtime dir, not the working tree', () => {
      const file = getCronFilePath('/project');
      expect(file).toBe(
        path.join(
          Storage.getGlobalTempDir(),
          getProjectHash('/project'),
          'scheduled_tasks.json',
        ),
      );
      // Crucially, not in the project working tree.
      expect(file.startsWith('/project')).toBe(false);
      expect(file).not.toContain(`${path.sep}.qwen${path.sep}scheduled_tasks`);
    });
  });

  describe('readCronTasks', () => {
    it('returns [] when file does not exist', async () => {
      expect(await readCronTasks(tmpDir)).toEqual([]);
    });

    // A file that exists but doesn't parse must throw, not read as an
    // empty schedule: [] would let a reload reconcile every loaded job
    // away and let the next write clobber the user's recoverable file.
    it('throws for malformed JSON', async () => {
      await seedTasksFile(tmpDir, 'NOT JSON{{{');
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/Malformed JSON/);
    });

    it('throws for non-array JSON', async () => {
      await seedTasksFile(tmpDir, '{"foo":1}');
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/JSON array/);
    });

    it('throws for invalid task entries', async () => {
      const data = [
        makeTask(),
        { id: 'bad', missing: 'fields' },
        makeTask({ id: 'good2' }),
      ];
      await seedTasksFile(tmpDir, JSON.stringify(data));
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/Invalid task entry/);
    });

    it('throws for non-finite timestamps', async () => {
      // JSON.parse turns -1e999 into -Infinity — typeof number, but it
      // poisons date math downstream (new Date(-Infinity).toISOString()
      // throws mid-load). Must be rejected like any other corrupt field.
      const raw = (createdAt: string, lastFiredAt: string) =>
        `[{"id":"t1","cron":"* * * * *","prompt":"p","recurring":true,` +
        `"createdAt":${createdAt},"lastFiredAt":${lastFiredAt}}]`;
      await seedTasksFile(tmpDir, raw('-1e999', 'null'));
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/Invalid task entry/);
      await seedTasksFile(tmpDir, raw(`${Date.now()}`, '1e999'));
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/Invalid task entry/);
    });

    it('reads valid tasks', async () => {
      const task = makeTask();
      await seedTasksFile(tmpDir, JSON.stringify([task]));
      const result = await readCronTasks(tmpDir);
      expect(result).toEqual([task]);
    });

    it('round-trips the optional name/enabled fields', async () => {
      const task = makeTask({ name: 'Weekly digest', enabled: false });
      await writeCronTasks(tmpDir, [task]);
      const result = await readCronTasks(tmpDir);
      expect(result).toEqual([task]);
    });

    it('accepts legacy tasks with no name/enabled fields', async () => {
      // A task written before the fields existed must still read back.
      const legacy = makeTask();
      await seedTasksFile(tmpDir, JSON.stringify([legacy]));
      const result = await readCronTasks(tmpDir);
      expect(result[0]!.name).toBeUndefined();
      expect(result[0]!.enabled).toBeUndefined();
    });

    it('rejects a task whose name is not a string', async () => {
      await seedTasksFile(
        tmpDir,
        JSON.stringify([{ ...makeTask(), name: 123 }]),
      );
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/Invalid task entry/);
    });

    it('rejects a task whose enabled is not a boolean', async () => {
      await seedTasksFile(
        tmpDir,
        JSON.stringify([{ ...makeTask(), enabled: 'yes' }]),
      );
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/Invalid task entry/);
    });

    it('round-trips the optional runs history', async () => {
      const task = makeTask({
        lastFiredAt: 1718000300000,
        runs: [
          { at: 1718000240000, kind: 'scheduled' },
          { at: 1718000300000, kind: 'catch-up' },
        ],
      });
      await writeCronTasks(tmpDir, [task]);
      expect(await readCronTasks(tmpDir)).toEqual([task]);
    });

    it('accepts a run entry with no kind (defaults on read)', async () => {
      await seedTasksFile(
        tmpDir,
        JSON.stringify([{ ...makeTask(), runs: [{ at: 1718000240000 }] }]),
      );
      const result = await readCronTasks(tmpDir);
      expect(result[0]!.runs).toEqual([{ at: 1718000240000 }]);
    });

    it('rejects a task whose runs is not an array', async () => {
      await seedTasksFile(
        tmpDir,
        JSON.stringify([{ ...makeTask(), runs: 'nope' }]),
      );
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/Invalid task entry/);
    });

    it('rejects a run entry with a non-finite/absent timestamp', async () => {
      await seedTasksFile(
        tmpDir,
        JSON.stringify([{ ...makeTask(), runs: [{ kind: 'scheduled' }] }]),
      );
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/Invalid task entry/);
      // -Infinity (from -1e999) is typeof number but not finite — must reject.
      await seedTasksFile(
        tmpDir,
        `[{"id":"t1","cron":"* * * * *","prompt":"p","recurring":true,` +
          `"createdAt":1718000000000,"lastFiredAt":null,"runs":[{"at":-1e999}]}]`,
      );
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/Invalid task entry/);
    });

    it('rejects a run entry whose kind is not a string', async () => {
      await seedTasksFile(
        tmpDir,
        JSON.stringify([
          { ...makeTask(), runs: [{ at: 1718000240000, kind: 7 }] },
        ]),
      );
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/Invalid task entry/);
    });

    it('round-trips a run entry with the legacy withheld marker', async () => {
      const task = makeTask({
        lastFiredAt: 1718000300000,
        runs: [{ at: 1718000300000, kind: 'scheduled', withheld: true }],
      });
      await writeCronTasks(tmpDir, [task]);
      expect(await readCronTasks(tmpDir)).toEqual([task]);
    });

    it('rejects a run entry whose withheld is not a boolean', async () => {
      await seedTasksFile(
        tmpDir,
        JSON.stringify([
          { ...makeTask(), runs: [{ at: 1718000240000, withheld: 'yes' }] },
        ]),
      );
      await expect(readCronTasks(tmpDir)).rejects.toThrow(/Invalid task entry/);
    });
  });

  describe('appendCronRun', () => {
    it('appends newest-last, treating absent history as empty', () => {
      const once = appendCronRun(undefined, { at: 1, kind: 'scheduled' });
      expect(once).toEqual([{ at: 1, kind: 'scheduled' }]);
      const twice = appendCronRun(once, { at: 2, kind: 'catch-up' });
      expect(twice).toEqual([
        { at: 1, kind: 'scheduled' },
        { at: 2, kind: 'catch-up' },
      ]);
    });

    it('is pure — does not mutate the input array', () => {
      const input = [{ at: 1, kind: 'scheduled' as const }];
      const result = appendCronRun(input, { at: 2 });
      expect(input).toEqual([{ at: 1, kind: 'scheduled' }]);
      expect(result).toHaveLength(2);
    });

    it('caps at MAX_TASK_RUNS, dropping the oldest', () => {
      let runs: ReturnType<typeof appendCronRun> = [];
      for (let i = 0; i < MAX_TASK_RUNS + 5; i++) {
        runs = appendCronRun(runs, { at: i });
      }
      expect(runs).toHaveLength(MAX_TASK_RUNS);
      // Oldest five dropped: the window is the last MAX_TASK_RUNS entries.
      expect(runs[0]!.at).toBe(5);
      expect(runs[runs.length - 1]!.at).toBe(MAX_TASK_RUNS + 4);
    });
  });

  describe('writeCronTasks', () => {
    it('creates the tasks dir if missing', async () => {
      await writeCronTasks(tmpDir, [makeTask()]);
      const content = await fs.readFile(getCronFilePath(tmpDir), 'utf-8');
      expect(JSON.parse(content)).toHaveLength(1);
    });

    it('overwrites existing file', async () => {
      await writeCronTasks(tmpDir, [makeTask()]);
      await writeCronTasks(tmpDir, []);
      const content = await fs.readFile(getCronFilePath(tmpDir), 'utf-8');
      expect(JSON.parse(content)).toEqual([]);
    });

    it('replaces a symlink at the tasks path instead of writing through it', async () => {
      // A pre-placed symlink at the tasks path (e.g. a tampered runtime dir)
      // must be replaced, not written through to clobber its target.
      await fs.mkdir(path.dirname(getCronFilePath(tmpDir)), {
        recursive: true,
      });
      const outside = path.join(tmpDir, 'outside.txt');
      await fs.writeFile(outside, 'PROTECTED');
      await fs.symlink(outside, getCronFilePath(tmpDir));

      await writeCronTasks(tmpDir, [makeTask()]);

      // Target untouched; the tasks path is now a regular file with the tasks.
      expect(await fs.readFile(outside, 'utf-8')).toBe('PROTECTED');
      expect((await fs.lstat(getCronFilePath(tmpDir))).isSymbolicLink()).toBe(
        false,
      );
      expect(await readCronTasks(tmpDir)).toHaveLength(1);
    });
  });

  describe('addCronTask', () => {
    it('appends to existing tasks', async () => {
      await writeCronTasks(tmpDir, [makeTask({ id: 'first' })]);
      await addCronTask(tmpDir, makeTask({ id: 'second' }));
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(2);
      expect(tasks[1]!.id).toBe('second');
    });

    it('creates file when none exists', async () => {
      await addCronTask(tmpDir, makeTask());
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(1);
    });
  });

  describe('removeCronTasks', () => {
    it('removes tasks by id', async () => {
      await writeCronTasks(tmpDir, [
        makeTask({ id: 'keep' }),
        makeTask({ id: 'remove' }),
      ]);
      await removeCronTasks(tmpDir, ['remove']);
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.id).toBe('keep');
    });

    it('handles missing ids gracefully', async () => {
      await writeCronTasks(tmpDir, [makeTask()]);
      await removeCronTasks(tmpDir, ['nonexistent']);
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(1);
    });

    it('returns the number of tasks removed', async () => {
      await writeCronTasks(tmpDir, [
        makeTask({ id: 'a' }),
        makeTask({ id: 'b' }),
      ]);
      expect(await removeCronTasks(tmpDir, ['a', 'b', 'missing'])).toBe(2);
      expect(await removeCronTasks(tmpDir, ['a'])).toBe(0);
    });

    it('leaves no trace when nothing matches', async () => {
      // A miss must not create the tasks dir or touch a lock file.
      expect(await removeCronTasks(tmpDir, ['ghost'])).toBe(0);
      await expect(
        fs.stat(path.dirname(getCronFilePath(tmpDir))),
      ).rejects.toThrow();
    });
  });

  describe('updateCronTasks', () => {
    it('applies the mutation in a single read-modify-write', async () => {
      await writeCronTasks(tmpDir, [
        makeTask({ id: 'a' }),
        makeTask({ id: 'b' }),
      ]);
      await updateCronTasks(tmpDir, (tasks) =>
        tasks
          .filter((t) => t.id !== 'b')
          .map((t) => ({ ...t, lastFiredAt: 9999999 })),
      );
      const tasks = await readCronTasks(tmpDir);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.id).toBe('a');
      expect(tasks[0]!.lastFiredAt).toBe(9999999);
    });

    it('does not lose mutations under concurrent updates', async () => {
      const ids = Array.from({ length: 10 }, (_, i) => `task-${i}`);
      await Promise.all(ids.map((id) => addCronTask(tmpDir, makeTask({ id }))));
      const tasks = await readCronTasks(tmpDir);
      expect(tasks.map((t) => t.id).sort()).toEqual([...ids].sort());
    });

    it('skips the write when mutate returns the input unchanged', async () => {
      await writeCronTasks(tmpDir, [makeTask()]);
      const filePath = getCronFilePath(tmpDir);
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(filePath, past, past);

      await updateCronTasks(tmpDir, (tasks) => tasks);

      const stat = await fs.stat(filePath);
      expect(stat.mtimeMs).toBeLessThan(Date.now() - 30_000);
    });

    it('steals a stale update lock left by a crashed holder', async () => {
      const lockPath = `${getCronFilePath(tmpDir)}.lock`;
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, '99999');
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, past, past);

      await addCronTask(tmpDir, makeTask());
      expect(await readCronTasks(tmpDir)).toHaveLength(1);
    });

    it('refuses to clobber a malformed file', async () => {
      const filePath = getCronFilePath(tmpDir);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'NOT JSON{{{');

      await expect(
        updateCronTasks(tmpDir, (tasks) => tasks.filter(() => true)),
      ).rejects.toThrow(/Malformed JSON/);
      // The corrupted (hand-recoverable) content survives untouched.
      expect(await fs.readFile(filePath, 'utf-8')).toBe('NOT JSON{{{');
    });

    it('refuses to clobber a file with invalid task entries', async () => {
      const filePath = getCronFilePath(tmpDir);
      const raw = JSON.stringify([makeTask(), { id: 'bad' }]);
      await seedTasksFile(tmpDir, raw);

      await expect(
        updateCronTasks(tmpDir, (tasks) => [
          ...tasks,
          makeTask({ id: 'new-task' }),
        ]),
      ).rejects.toThrow(/Invalid task entry/);
      expect(await fs.readFile(filePath, 'utf-8')).toBe(raw);
    });

    it('does not displace a fresh lock created after the stale inspection', async () => {
      const lockPath = `${getCronFilePath(tmpDir)}.lock`;
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, '99999');
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, past, past);

      // Between the stat seeing a stale lock and the rename-aside, a
      // competing process clears the stale lock and creates a fresh one.
      renameHook.current = async (src) => {
        if (src !== lockPath) return;
        renameHook.current = null;
        await fs.rm(lockPath, { force: true });
        await fs.writeFile(lockPath, '88888'); // fresh mtime — live holder
      };

      const update = updateCronTasks(tmpDir, (tasks) => [
        ...tasks,
        makeTask({ id: 'after-race' }),
      ]);

      // The yanked fresh lock must be restored, not destroyed, and the
      // update must stay blocked behind it.
      await vi.waitFor(async () => {
        expect(await fs.readFile(lockPath, 'utf-8')).toBe('88888');
        const entries = await fs.readdir(path.dirname(lockPath));
        expect(entries.filter((e) => e.includes('.lock.stale.'))).toEqual([]);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await fs.readFile(lockPath, 'utf-8')).toBe('88888');

      // The live holder releases; the blocked update proceeds.
      await fs.unlink(lockPath);
      await update;
      expect((await readCronTasks(tmpDir)).map((t) => t.id)).toContain(
        'after-race',
      );
    });
  });

  describe('generateCronTaskId', () => {
    it('returns an 8-character base36 id', () => {
      expect(generateCronTaskId()).toMatch(/^[a-z0-9]{8}$/);
    });

    it('is very unlikely to collide across calls', () => {
      const ids = new Set(
        Array.from({ length: 200 }, () => generateCronTaskId()),
      );
      // 36^8 space — 200 draws essentially never collide (P ~ 1e-8). Assert
      // near-uniqueness with a tiny margin so this can't flake.
      expect(ids.size).toBeGreaterThan(195);
    });
  });
});
