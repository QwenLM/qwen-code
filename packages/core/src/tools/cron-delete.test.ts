import { describe, it, expect, beforeEach } from 'vitest';
import { CronDeleteTool } from './cron-delete.js';
import { CronScheduler } from '../services/cronScheduler.js';

function makeConfig() {
  const scheduler = new CronScheduler();
  return {
    getCronScheduler: () => scheduler,
    _scheduler: scheduler,
  } as unknown as import('../config/config.js').Config & {
    _scheduler: CronScheduler;
  };
}

describe('CronDeleteTool', () => {
  let config: ReturnType<typeof makeConfig>;
  let tool: CronDeleteTool;

  beforeEach(() => {
    config = makeConfig();
    tool = new CronDeleteTool(config);
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

  it('returns error for non-existent job', async () => {
    const invocation = tool.build({ id: 'nonexist' });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('not found');
  });

  it('validates required params', () => {
    expect(() => tool.build({} as never)).toThrow();
  });
});
