import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CronListTool } from './cron-list.js';
import { CronScheduler } from '../services/cronScheduler.js';
import { getCronFilePath, writeCronTasks } from '../services/cronTasksFile.js';
import type { DurableCronTask } from '../services/cronTasksFile.js';
import { Storage } from '../config/storage.js';

function makeDurableTask(
  overrides?: Partial<DurableCronTask>,
): DurableCronTask {
  return {
    id: 'durable01',
    cron: '0 */2 * * *',
    prompt: 'check deploy',
    recurring: true,
    createdAt: Date.now(),
    lastFiredAt: null,
    ...overrides,
  };
}

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

describe('CronListTool', () => {
  let tmpDir: string;
  let config: ReturnType<typeof makeConfig>;
  let tool: CronListTool;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-list-test-'));
    // Durable tasks live under the user runtime dir, not the tree.
    Storage.setRuntimeBaseDir(tmpDir);
    config = makeConfig(tmpDir);
    tool = new CronListTool(config);
  });

  afterEach(async () => {
    config._scheduler.destroy();
    Storage.setRuntimeBaseDir(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has the correct name', () => {
    expect(tool.name).toBe('cron_list');
  });

  it('returns empty message when no jobs or wakeups', async () => {
    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('No active cron jobs or loop wakeups');
  });

  it('lists created jobs', async () => {
    config._scheduler.create('*/5 * * * *', 'check build', true);
    config._scheduler.create('*/1 * * * *', 'ping', false);

    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain(
      '(recurring) [session-only]: check build',
    );
    expect(result.llmContent).toContain('(one-shot) [session-only]: ping');
    // Two lines, one per job
    expect(String(result.llmContent).split('\n')).toHaveLength(2);
    expect(result.returnDisplay).toContain('[session-only]');
  });

  it('lists pending wakeups', async () => {
    config._scheduler.scheduleWakeup(300, 'continue loop');

    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('@wakeup');
    expect(result.llmContent).toContain('[session-only]: continue loop');
    expect(result.returnDisplay).toContain('@wakeup [session-only]');
  });

  it('lists durable jobs from the tasks file without the scheduler loading them', async () => {
    // Headless situation: the task is on disk but this scheduler never
    // called enableDurable, so its job map is empty.
    await writeCronTasks(tmpDir, [makeDurableTask()]);

    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain(
      'durable01 — 0 */2 * * * (recurring) [durable]: check deploy',
    );
    expect(result.returnDisplay).toContain('[durable]');
  });

  it('merges file-backed durable jobs with session-only jobs', async () => {
    await writeCronTasks(tmpDir, [makeDurableTask()]);
    config._scheduler.create('*/10 * * * *', 'session task', true);

    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);
    const lines = String(result.llmContent).split('\n');
    expect(lines).toHaveLength(2);
    expect(result.llmContent).toContain('[durable]: check deploy');
    expect(result.llmContent).toContain('[session-only]: session task');
  });

  it('does not double-list a durable job the scheduler has also loaded', async () => {
    // Interactive situation: createDurable persists to file AND registers
    // the job in the scheduler's map. The file copy is authoritative.
    await config._scheduler.createDurable('*/5 * * * *', 'persisted', true);

    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);
    const lines = String(result.llmContent).split('\n');
    expect(lines).toHaveLength(1);
    expect(result.llmContent).toContain('[durable]: persisted');
  });

  it('surfaces a corrupted tasks file as an error instead of an empty list', async () => {
    const tasksFile = getCronFilePath(tmpDir);
    await fs.mkdir(path.dirname(tasksFile), { recursive: true });
    await fs.writeFile(tasksFile, '{broken json!!');

    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error?.message).toContain('Malformed JSON');
    expect(result.llmContent).not.toContain(
      'No active cron jobs or loop wakeups',
    );
  });
});
