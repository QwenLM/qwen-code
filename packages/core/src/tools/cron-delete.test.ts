import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CronDeleteTool } from './cron-delete.js';
import { CronScheduler } from '../services/cronScheduler.js';
import { readCronTasks, writeCronTasks } from '../services/cronTasksFile.js';
import { Storage } from '../config/storage.js';

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

  it('deletes a pending loop wakeup', async () => {
    const wakeup = config._scheduler.scheduleWakeup(300, 'continue loop');

    const invocation = tool.build({ id: wakeup.id });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain(`Cancelled job ${wakeup.id}`);
    expect(config._scheduler.sessionSize).toBe(0);
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
