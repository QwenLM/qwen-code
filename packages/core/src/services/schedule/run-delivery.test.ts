import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApprovalMode } from '../../config/config.js';
import {
  collectUnsurfacedRuns,
  formatRunNotification,
  markRunsSurfaced,
  readAllRunRecords,
  readTaskRunRecords,
  type TaskRunRecord,
} from './run-delivery.js';
import { getTaskRunsDir, writeTask, type ScheduledTask } from './task-store.js';

function makeTask(id: string): ScheduledTask {
  return {
    id,
    name: id,
    description: 'd',
    schedule: { cron: '*/5 * * * *', enabled: true },
    cwd: '/tmp',
    approvalMode: ApprovalMode.AUTO,
    notify: 'next-session',
    sandbox: false,
    prompt: 'p',
  };
}

async function writeRun(rec: TaskRunRecord): Promise<void> {
  const dir = getTaskRunsDir(rec.taskId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${rec.runId}.json`), JSON.stringify(rec));
}

function rec(overrides: Partial<TaskRunRecord>): TaskRunRecord {
  return {
    taskId: 't1',
    runId: 'r1',
    firedAt: 0,
    finishedAt: 1000,
    exitCode: 0,
    ok: true,
    summary: 'completed',
    ...overrides,
  };
}

describe('schedule/run-delivery', () => {
  let tmpDir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-delivery-'));
    prevHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tmpDir;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads a task’s run records newest-first, skipping corrupt files', async () => {
    await writeRun(rec({ runId: 'r1', finishedAt: 1000 }));
    await writeRun(rec({ runId: 'r2', finishedAt: 2000 }));
    await fs.writeFile(
      path.join(getTaskRunsDir('t1'), 'broken.json'),
      '{not json',
    );

    const records = await readTaskRunRecords('t1');
    expect(records.map((r) => r.runId)).toEqual(['r2', 'r1']);
  });

  it('returns [] for a task with no runs', async () => {
    expect(await readTaskRunRecords('nope')).toEqual([]);
  });

  it('reads all records across tasks, newest-first', async () => {
    await writeTask(makeTask('t1'));
    await writeTask(makeTask('t2'));
    await writeRun(rec({ taskId: 't1', runId: 'a', finishedAt: 1000 }));
    await writeRun(rec({ taskId: 't2', runId: 'b', finishedAt: 3000 }));
    await writeRun(rec({ taskId: 't1', runId: 'c', finishedAt: 2000 }));

    const all = await readAllRunRecords();
    expect(all.map((r) => r.runId)).toEqual(['b', 'c', 'a']);
  });

  it('seeds the cursor on first call and returns unsurfaced runs after', async () => {
    await writeTask(makeTask('t1'));
    await writeRun(rec({ runId: 'r1', finishedAt: 1000 }));
    await writeRun(rec({ runId: 'r2', finishedAt: 2000 }));

    // First ever call: seed the cursor to now, report nothing (no backlog dump).
    expect(await collectUnsurfacedRuns(500)).toEqual([]);

    // Cursor is now 500; both runs finished after it.
    const unsurfaced = await collectUnsurfacedRuns(9999);
    expect(unsurfaced.map((r) => r.runId)).toEqual(['r2', 'r1']);

    // After marking up to 2000, nothing new remains.
    await markRunsSurfaced(2000);
    expect(await collectUnsurfacedRuns(9999)).toEqual([]);
  });

  it('formats a completed-runs notification', () => {
    const text = formatRunNotification([
      rec({ taskId: 'daily', runId: 'x', ok: true, summary: 'completed' }),
      rec({
        taskId: 'nightly',
        runId: 'y',
        ok: false,
        summary: 'failed (exit 1)',
      }),
    ]);
    expect(text).toContain('2 scheduled task runs completed');
    expect(text).toContain('✓ [daily]');
    expect(text).toContain('✗ [nightly]');
    expect(formatRunNotification([])).toBe('');
  });
});
