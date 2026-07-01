import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApprovalMode,
  writeTask,
  type ScheduledTask,
} from '@qwen-code/qwen-code-core';

import { scheduleCommand } from './schedule-command.js';
import type { MessageActionReturn, SlashCommand } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

function sub(name: string): SlashCommand {
  const found = scheduleCommand.subCommands?.find(
    (c) => c.name === name || c.altNames?.includes(name),
  );
  if (!found) throw new Error(`subcommand ${name} not found`);
  return found;
}

async function runAction(
  command: SlashCommand,
  args: string,
): Promise<MessageActionReturn> {
  const ctx = createMockCommandContext();
  const result = await command.action!(ctx, args);
  return result as MessageActionReturn;
}

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

describe('/schedule command', () => {
  let tmpDir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-cmd-'));
    prevHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tmpDir;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('list renders an empty state', async () => {
    const res = await runAction(sub('list'), '');
    expect(res.messageType).toBe('info');
    expect(res.content).toContain('No scheduled tasks');
  });

  it('list renders tasks with a human-readable schedule', async () => {
    await writeTask(makeTask());
    await writeTask(
      makeTask({
        id: 'once-thing',
        name: 'once-thing',
        schedule: { fireAt: '2026-07-02T15:00:00+08:00', enabled: true },
      }),
    );
    const res = await runAction(sub('list'), '');
    expect(res.content).toContain('[daily-review]');
    expect(res.content).toContain('[once-thing]');
    expect(res.content).toContain('once at 2026-07-02T15:00:00+08:00');
  });

  it('delete removes an existing task and reports missing ones', async () => {
    await writeTask(makeTask({ id: 'gone' }));
    const ok = await runAction(sub('delete'), 'gone');
    expect(ok.messageType).toBe('info');
    expect(ok.content).toContain('Deleted');

    const missing = await runAction(sub('delete'), 'gone');
    expect(missing.messageType).toBe('error');
    expect(missing.content).toContain('No scheduled task');
  });

  it('delete without an id shows usage', async () => {
    const res = await runAction(sub('delete'), '   ');
    expect(res.messageType).toBe('error');
    expect(res.content).toContain('Usage');
  });

  it('run rejects an unknown id without spawning', async () => {
    const res = await runAction(sub('run'), 'nope');
    expect(res.messageType).toBe('error');
    expect(res.content).toContain('No scheduled task');
  });

  it('run without an id shows usage', async () => {
    const res = await runAction(sub('run'), '');
    expect(res.messageType).toBe('error');
    expect(res.content).toContain('Usage');
  });

  it('parent action shows usage and the current list', async () => {
    await writeTask(makeTask());
    const res = await runAction(scheduleCommand, '');
    expect(res.content).toContain('Subcommands');
    expect(res.content).toContain('[daily-review]');
  });
});
