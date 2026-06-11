import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DurableCronTask } from './cronTasksFile.js';
import {
  addCronTask,
  getCronFilePath,
  readCronTasks,
  removeCronTasks,
  updateCronTasks,
  writeCronTasks,
} from './cronTasksFile.js';

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
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('getCronFilePath', () => {
    it('returns path under .qwen/', () => {
      expect(getCronFilePath('/project')).toBe(
        '/project/.qwen/scheduled_tasks.json',
      );
    });
  });

  describe('readCronTasks', () => {
    it('returns [] when file does not exist', async () => {
      expect(await readCronTasks(tmpDir)).toEqual([]);
    });

    it('returns [] for malformed JSON', async () => {
      const dir = path.join(tmpDir, '.qwen');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'scheduled_tasks.json'), 'NOT JSON{{{');
      expect(await readCronTasks(tmpDir)).toEqual([]);
    });

    it('returns [] for non-array JSON', async () => {
      const dir = path.join(tmpDir, '.qwen');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'scheduled_tasks.json'), '{"foo":1}');
      expect(await readCronTasks(tmpDir)).toEqual([]);
    });

    it('filters out invalid entries', async () => {
      const dir = path.join(tmpDir, '.qwen');
      await fs.mkdir(dir, { recursive: true });
      const data = [
        makeTask(),
        { id: 'bad', missing: 'fields' },
        makeTask({ id: 'good2' }),
      ];
      await fs.writeFile(
        path.join(dir, 'scheduled_tasks.json'),
        JSON.stringify(data),
      );
      const result = await readCronTasks(tmpDir);
      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe('test001');
      expect(result[1]!.id).toBe('good2');
    });

    it('reads valid tasks', async () => {
      const task = makeTask();
      const dir = path.join(tmpDir, '.qwen');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'scheduled_tasks.json'),
        JSON.stringify([task]),
      );
      const result = await readCronTasks(tmpDir);
      expect(result).toEqual([task]);
    });
  });

  describe('writeCronTasks', () => {
    it('creates .qwen/ directory if missing', async () => {
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
      // The tasks file is project-controlled, so a cloned/edited repo could
      // pre-place it as a symlink to a file outside the repo. The write must
      // replace the link, not clobber its target.
      await fs.mkdir(path.join(tmpDir, '.qwen'), { recursive: true });
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
      // A miss must not mkdir .qwen/ or touch a lock file.
      expect(await removeCronTasks(tmpDir, ['ghost'])).toBe(0);
      await expect(fs.stat(path.join(tmpDir, '.qwen'))).rejects.toThrow();
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
  });
});
