import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import {
  writeTask,
  type ScheduledTask,
} from '../services/schedule/task-store.js';
import { ScheduleListTool } from './schedule-list.js';
import { ScheduleDeleteTool } from './schedule-delete.js';
import { ScheduleRunTool } from './schedule-run.js';

const signal = () => new AbortController().signal;
const config = {} as Config;

function makeTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'daily-review',
    name: 'daily-review',
    description: 'review PRs',
    schedule: { cron: '0 9 * * 1-5', enabled: true },
    cwd: '/tmp/project',
    approvalMode: ApprovalMode.AUTO,
    notify: 'next-session',
    sandbox: false,
    prompt: 'review',
    ...overrides,
  };
}

describe('schedule management tools', () => {
  let tmpDir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-tools-'));
    prevHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tmpDir;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('schedule_list', () => {
    it('reports an empty store', async () => {
      const res = await new ScheduleListTool(config)
        .build({})
        .execute(signal());
      expect(res.llmContent).toContain('No scheduled tasks');
    });

    it('lists tasks with schedule, state, and last-run', async () => {
      await writeTask(makeTask());
      await writeTask(
        makeTask({
          id: 'once-thing',
          name: 'once-thing',
          schedule: { fireAt: '2099-01-01T00:00:00Z', enabled: false },
        }),
      );
      const res = await new ScheduleListTool(config)
        .build({})
        .execute(signal());
      const content = String(res.llmContent);
      expect(content).toContain('daily-review');
      expect(content).toContain('once-thing');
      expect(content).toContain('[paused]');
      expect(content).toContain('never run');
    });
  });

  describe('schedule_delete', () => {
    it('deletes an existing task', async () => {
      await writeTask(makeTask({ id: 'gone' }));
      const res = await new ScheduleDeleteTool(config)
        .build({ id: 'gone' })
        .execute(signal());
      expect(res.error).toBeUndefined();
      expect(res.llmContent).toContain('Deleted');
    });

    it('errors on a missing task', async () => {
      const res = await new ScheduleDeleteTool(config)
        .build({ id: 'nope' })
        .execute(signal());
      expect(res.error).toBeDefined();
      expect(res.llmContent).toContain('No scheduled task');
    });
  });

  describe('schedule_run', () => {
    it('errors on a missing task without spawning', async () => {
      const res = await new ScheduleRunTool(config)
        .build({ id: 'nope' })
        .execute(signal());
      expect(res.error).toBeDefined();
      expect(res.llmContent).toContain('No scheduled task');
    });
  });
});
