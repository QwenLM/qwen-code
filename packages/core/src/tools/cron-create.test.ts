import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CronCreateTool } from './cron-create.js';
import { CronScheduler } from '../services/cronScheduler.js';
import { readCronTasks } from '../services/cronTasksFile.js';

let tmpDir: string;

function makeConfig() {
  const scheduler = new CronScheduler(tmpDir);
  return {
    getCronScheduler: () => scheduler,
    getProjectRoot: () => tmpDir,
    _scheduler: scheduler,
  } as unknown as import('../config/config.js').Config & {
    _scheduler: CronScheduler;
  };
}

describe('CronCreateTool', () => {
  let config: ReturnType<typeof makeConfig>;
  let tool: CronCreateTool;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-create-test-'));
    config = makeConfig();
    tool = new CronCreateTool(config);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has the correct name', () => {
    expect(tool.name).toBe('cron_create');
  });

  it('creates a recurring job by default', async () => {
    const invocation = tool.build({
      cron: '*/5 * * * *',
      prompt: 'check status',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Scheduled recurring job');
    expect(result.llmContent).toContain('Auto-expires after 7 days');
    expect(result.llmContent).toContain('Session-only');
    expect(config._scheduler.list()).toHaveLength(1);
  });

  it('creates a one-shot job when recurring=false', async () => {
    const invocation = tool.build({
      cron: '*/1 * * * *',
      prompt: 'once',
      recurring: false,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Scheduled one-shot task');
    expect(result.llmContent).toContain('fire once then auto-delete');
    const jobs = config._scheduler.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.recurring).toBe(false);
  });

  it('creates a durable job and writes to disk', async () => {
    const invocation = tool.build({
      cron: '*/5 * * * *',
      prompt: 'durable check',
      durable: true,
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain(
      'Persisted to .qwen/scheduled_tasks.json',
    );
    expect(result.returnDisplay).toContain('[durable]');

    // Verify file was written
    const tasks = await readCronTasks(tmpDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.prompt).toBe('durable check');
  });

  it('does not write to disk when durable=false', async () => {
    const invocation = tool.build({
      cron: '*/5 * * * *',
      prompt: 'session only',
    });
    await invocation.execute(new AbortController().signal);

    const tasks = await readCronTasks(tmpDir);
    expect(tasks).toHaveLength(0);
  });

  it('returns error for invalid cron expression', async () => {
    const invocation = tool.build({
      cron: 'bad cron',
      prompt: 'fail',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
  });

  it('rejects a cron that never matches a real date', async () => {
    // Parses fine, but Feb 30 never exists — accepting it would
    // schedule a job that silently never fires.
    const invocation = tool.build({
      cron: '0 0 30 2 *',
      prompt: 'never fires',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('No matching fire time');
    expect(config._scheduler.list()).toHaveLength(0);
  });

  it('validates required params', () => {
    expect(() => tool.build({ cron: '*/1 * * * *' } as never)).toThrow();
    expect(() => tool.build({ prompt: 'test' } as never)).toThrow();
  });
});
