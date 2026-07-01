import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApprovalMode,
  getTaskRunsDir,
  markRunsSurfaced,
  writeTask,
  type ScheduledTask,
  type TaskRunRecord,
} from '@qwen-code/qwen-code-core';

import { getScheduledRunsStartupNotice } from './startup-notice.js';

function makeTask(): ScheduledTask {
  return {
    id: 'nightly',
    name: 'nightly',
    description: 'nightly job',
    schedule: { cron: '0 3 * * *', enabled: true },
    cwd: '/tmp',
    approvalMode: ApprovalMode.YOLO,
    notify: 'next-session',
    sandbox: false,
    prompt: 'do it',
  };
}

async function writeRunRecord(rec: TaskRunRecord): Promise<void> {
  const dir = getTaskRunsDir(rec.taskId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${rec.runId}.json`), JSON.stringify(rec));
}

describe('schedule/startup-notice', () => {
  let tmpDir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-notice-'));
    prevHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tmpDir;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns [] when scheduling was never used', async () => {
    expect(await getScheduledRunsStartupNotice()).toEqual([]);
  });

  it('surfaces completed runs once, then nothing', async () => {
    await writeTask(makeTask());
    await writeRunRecord({
      taskId: 'nightly',
      runId: 'run0001',
      firedAt: 1000,
      finishedAt: 2000,
      exitCode: 0,
      ok: true,
      summary: 'completed',
    });
    // Seed the cursor in the past so the run counts as unsurfaced.
    await markRunsSurfaced(0);

    const first = await getScheduledRunsStartupNotice();
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('nightly');
    expect(first[0]).toContain('completed');
    expect(first[0]).toMatch(/1 scheduled task run completed/);

    // Cursor advanced — a second startup shows nothing.
    expect(await getScheduledRunsStartupNotice()).toEqual([]);
  });

  it('does not replay history on the very first use (cursor seeding)', async () => {
    await writeTask(makeTask());
    await writeRunRecord({
      taskId: 'nightly',
      runId: 'old',
      firedAt: 1000,
      finishedAt: 2000,
      exitCode: 0,
      ok: true,
      summary: 'completed',
    });
    // No cursor yet → first call seeds it to now and reports nothing.
    expect(await getScheduledRunsStartupNotice()).toEqual([]);
  });
});
