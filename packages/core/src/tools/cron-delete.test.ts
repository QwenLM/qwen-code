import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CronDeleteTool } from './cron-delete.js';
import { CronScheduler } from '../services/cronScheduler.js';
import {
  getCronFilePath,
  readCronTasks,
  writeCronTasks,
} from '../services/cronTasksFile.js';
import { Storage } from '../config/storage.js';

const readFailure = vi.hoisted(() => ({ current: null as Error | null }));
vi.mock('../services/cronTasksFile.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/cronTasksFile.js')>();
  return {
    ...actual,
    readCronTasks: async (projectRoot: string) => {
      const failure = readFailure.current;
      readFailure.current = null;
      if (failure) throw failure;
      return actual.readCronTasks(projectRoot);
    },
  };
});

function makeConfig(projectRoot: string) {
  const scheduler = new CronScheduler(projectRoot);
  return {
    getCronScheduler: () => scheduler,
    getProjectRoot: () => projectRoot,
    _scheduler: scheduler,
  } as unknown as import('../config/config.js').Config & {
    _scheduler: CronScheduler;
  };
}

describe('CronDeleteTool', () => {
  let tmpDir: string;
  let config: ReturnType<typeof makeConfig>;
  let tool: CronDeleteTool;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-delete-test-'));
    // Durable tasks live under the user runtime dir, not the tree.
    Storage.setRuntimeBaseDir(tmpDir);
    config = makeConfig(tmpDir);
    tool = new CronDeleteTool(config);
  });

  afterEach(async () => {
    config._scheduler.destroy();
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has the correct name', () => {
    expect(tool.name).toBe('cron_delete');
  });

  it('deletes an existing job', async () => {
    const job = config._scheduler.create('*/1 * * * *', 'test', true);

    const invocation = tool.build({ id: job.id });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Cancelled job');
    expect(config._scheduler.list()).toHaveLength(0);
  });

  it('deletes a pending wakeup', async () => {
    const wakeup = config._scheduler.scheduleWakeup(300, 'continue loop');

    const invocation = tool.build({ id: wakeup.id });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain(`Cancelled job ${wakeup.id}`);
    expect(config._scheduler.sessionSize).toBe(0);
  });

  it('cancels session jobs and wakeups when the durable file is corrupt', async () => {
    const cronFile = getCronFilePath(tmpDir);
    await fs.mkdir(path.dirname(cronFile), { recursive: true });
    await fs.writeFile(cronFile, '{invalid json', 'utf8');
    const job = config._scheduler.create('*/1 * * * *', 'test', true);
    const wakeup = config._scheduler.scheduleWakeup(300, 'continue loop');

    const cronResult = await tool
      .build({ id: job.id })
      .execute(new AbortController().signal);
    const wakeupResult = await tool
      .build({ id: wakeup.id })
      .execute(new AbortController().signal);

    expect(cronResult.error).toBeUndefined();
    expect(wakeupResult.error).toBeUndefined();
    expect(config._scheduler.sessionSize).toBe(0);
  });

  it('refuses an ambiguous durable delete when its read fails once', async () => {
    const original = {
      id: 'shared-on-read-failure',
      cron: '0 */2 * * *',
      prompt: 'preserve owner',
      recurring: true,
      createdAt: Date.now(),
      lastFiredAt: null,
    };
    const tasks = [
      { ...original, sessionId: 'owner-a' },
      { ...original, prompt: 'preserve unbound' },
    ];
    await writeCronTasks(tmpDir, tasks);
    await config._scheduler.enableDurable('owner-b');
    expect(config._scheduler.list()).toHaveLength(2);
    readFailure.current = new Error('transient durable read failure');

    const result = await tool
      .build({ id: original.id })
      .execute(new AbortController().signal);

    expect(await readCronTasks(tmpDir)).toEqual(tasks);
    expect(result.error?.message).toContain('transient durable read failure');
  });

  it('does not delete a later durable record from a different owner after an empty read', async () => {
    let releaseDelete!: (deleted: boolean) => void;
    const pendingDelete = new Promise<boolean>((resolve) => {
      releaseDelete = resolve;
    });
    vi.spyOn(config._scheduler, 'delete').mockReturnValue(pendingDelete);
    const running = tool
      .build({ id: 'arrived-after-read' })
      .execute(new AbortController().signal);
    await vi.waitFor(() => {
      expect(config._scheduler.delete).toHaveBeenCalledOnce();
    });
    const later = {
      id: 'arrived-after-read',
      cron: '0 */2 * * *',
      prompt: 'preserve the separate owner',
      recurring: true,
      createdAt: Date.now(),
      lastFiredAt: null,
      sessionId: 'later-owner',
    };
    try {
      await writeCronTasks(tmpDir, [later]);
    } finally {
      releaseDelete(false);
    }
    const result = await running;

    expect(await readCronTasks(tmpDir)).toEqual([later]);
    expect(result.error?.message).toContain('not found');
    expect(result.llmContent).not.toContain('Cancelled job');
  });

  it('does not let a stale unbound runtime delete a newly written unbound task', async () => {
    const stale = await config._scheduler.createDurable(
      '* * * * *',
      'stale unbound',
      true,
    );
    const persistedStale = (await readCronTasks(tmpDir)).find(
      (task) => task.id === stale.id,
    );
    expect(persistedStale).toBeDefined();
    await writeCronTasks(tmpDir, []);
    let notifyDelete!: () => void;
    let releaseDelete!: () => void;
    const deleteEntered = new Promise<void>((resolve) => {
      notifyDelete = resolve;
    });
    const beforeDelete = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteFromRuntime = config._scheduler.delete.bind(config._scheduler);
    vi.spyOn(config._scheduler, 'delete').mockImplementation(
      async (...args) => {
        notifyDelete();
        await beforeDelete;
        return deleteFromRuntime(...args);
      },
    );
    const running = tool
      .build({ id: stale.id })
      .execute(new AbortController().signal);
    await deleteEntered;
    const later = {
      ...persistedStale!,
      prompt: 'new unbound after empty read',
    };
    await writeCronTasks(tmpDir, [later]);
    const bytesBeforeRelease = await fs.readFile(
      getCronFilePath(tmpDir),
      'utf8',
    );
    releaseDelete();

    const result = await running;

    expect(result.error).toBeUndefined();
    expect(config._scheduler.list().some((job) => job.id === stale.id)).toBe(
      false,
    );
    expect(await fs.readFile(getCronFilePath(tmpDir), 'utf8')).toBe(
      bytesBeforeRelease,
    );
    expect(await readCronTasks(tmpDir)).toEqual([later]);
  });

  it('returns error for non-existent job', async () => {
    const invocation = tool.build({ id: 'nonexist' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('not found');
  });

  it('deletes a durable job that exists only on disk', async () => {
    // Headless situation: the task is on disk but this scheduler never
    // called enableDurable, so scheduler.delete() does not know the id.
    await writeCronTasks(tmpDir, [
      {
        id: 'todelete1',
        cron: '0 */2 * * *',
        prompt: 'check deploy',
        recurring: true,
        createdAt: Date.now(),
        lastFiredAt: null,
      },
    ]);

    const invocation = tool.build({ id: 'todelete1' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Cancelled job todelete1');
    expect(await readCronTasks(tmpDir)).toEqual([]);
  });

  it('refuses an ambiguous same-id durable delete', async () => {
    const original = {
      id: 'shared',
      cron: '0 */2 * * *',
      recurring: true,
      createdAt: Date.now(),
      lastFiredAt: null,
    };
    const tasks = [
      { ...original, prompt: 'unbound' },
      { ...original, prompt: 'owned', sessionId: 'session-a' },
      { ...original, prompt: 'other owner', sessionId: 'session-b' },
    ];
    await writeCronTasks(tmpDir, tasks);

    const result = await tool
      .build({ id: 'shared' })
      .execute(new AbortController().signal);

    expect(result.error?.message).toContain('ambiguous');
    expect(await readCronTasks(tmpDir)).toEqual(tasks);
  });

  it('validates required params', () => {
    expect(() => tool.build({} as never)).toThrow();
  });

  it('reports failure when durable removal cannot persist', async () => {
    const job = config._scheduler.create('*/1 * * * *', 'durable', true);
    vi.spyOn(config._scheduler, 'delete').mockRejectedValue(
      new Error('disk unavailable'),
    );

    const invocation = tool.build({ id: job.id });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error?.message).toContain('Failed to cancel');
    expect(result.llmContent).toContain('disk unavailable');
  });
});
