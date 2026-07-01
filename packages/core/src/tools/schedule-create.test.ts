import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ScheduleCreateTool } from './schedule-create.js';
import { ApprovalMode } from '../config/config.js';
import type { Config } from '../config/config.js';
import { readTask } from '../services/schedule/task-store.js';

const signal = () => new AbortController().signal;

describe('ScheduleCreateTool', () => {
  let tmpDir: string;
  let prevHome: string | undefined;
  let tool: ScheduleCreateTool;

  let prevNoAutostart: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-create-'));
    prevHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tmpDir;
    // Don't spawn a real background daemon from unit tests.
    prevNoAutostart = process.env['QWEN_SCHEDULE_NO_AUTOSTART'];
    process.env['QWEN_SCHEDULE_NO_AUTOSTART'] = '1';
    tool = new ScheduleCreateTool({
      getWorkingDir: () => '/tmp/default',
    } as unknown as Config);
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevHome;
    if (prevNoAutostart === undefined)
      delete process.env['QWEN_SCHEDULE_NO_AUTOSTART'];
    else process.env['QWEN_SCHEDULE_NO_AUTOSTART'] = prevNoAutostart;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has the right name', () => {
    expect(tool.name).toBe('schedule_create');
  });

  it('creates a recurring task with defaults', async () => {
    const result = await tool
      .build({
        name: 'Daily PR Review',
        description: 'review PRs',
        prompt: 'review new PRs',
        cron: '0 9 * * 1-5',
        cwd: '/tmp/proj',
      })
      .execute(signal());

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain(
      'Created scheduled task "daily-pr-review"',
    );

    const task = await readTask('daily-pr-review');
    expect(task).not.toBeNull();
    expect(task!.schedule.cron).toBe('0 9 * * 1-5');
    expect(task!.approvalMode).toBe(ApprovalMode.AUTO);
    expect(task!.cwd).toBe('/tmp/proj');
  });

  it('creates a one-shot fireAt task', async () => {
    const result = await tool
      .build({
        name: 'cleanup-once',
        description: 'cleanup',
        prompt: 'do cleanup',
        fireAt: '2099-01-01T00:00:00Z',
      })
      .execute(signal());
    expect(result.error).toBeUndefined();
    const task = await readTask('cleanup-once');
    expect(task!.schedule.fireAt).toBe('2099-01-01T00:00:00Z');
    expect(task!.schedule.cron).toBeUndefined();
  });

  it('reports "Updated" when overwriting an existing task', async () => {
    const params = {
      name: 'dup',
      description: 'd',
      prompt: 'p',
      cron: '0 9 * * *',
    };
    await tool.build(params).execute(signal());
    const second = await tool.build(params).execute(signal());
    expect(second.llmContent).toContain('Updated scheduled task "dup"');
  });

  it('rejects providing both cron and fireAt', async () => {
    const result = await tool
      .build({
        name: 'both',
        description: 'd',
        prompt: 'p',
        cron: '0 9 * * *',
        fireAt: '2099-01-01T00:00:00Z',
      })
      .execute(signal());
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('exactly one');
  });

  it('rejects providing neither cron nor fireAt', async () => {
    const result = await tool
      .build({ name: 'neither', description: 'd', prompt: 'p' })
      .execute(signal());
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('exactly one');
  });

  it('rejects an invalid approvalMode at the schema layer', () => {
    expect(() =>
      tool.build({
        name: 'bad-mode',
        description: 'd',
        prompt: 'p',
        cron: '0 9 * * *',
        approvalMode: 'banana',
      }),
    ).toThrow(/allowed values/);
  });

  it('rejects a past fireAt', async () => {
    const result = await tool
      .build({
        name: 'past',
        description: 'd',
        prompt: 'p',
        fireAt: '2000-01-01T00:00:00Z',
      })
      .execute(signal());
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('must be in the future');
  });

  it('validates required params at build time', () => {
    expect(() =>
      tool.build({
        name: '!!!',
        description: 'd',
        prompt: 'p',
        cron: '0 9 * * *',
      }),
    ).toThrow(/at least one letter or digit/);
    expect(() =>
      tool.build({
        name: 'ok',
        description: 'd',
        prompt: '',
        cron: '0 9 * * *',
      }),
    ).toThrow(/prompt/);
  });
});
