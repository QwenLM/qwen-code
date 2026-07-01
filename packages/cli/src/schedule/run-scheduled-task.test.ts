import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ApprovalMode,
  getTaskRunsDir,
  type FireContext,
  type ScheduledTask,
} from '@qwen-code/qwen-code-core';

import { runScheduledTask, type TaskRunRecord } from './run-scheduled-task.js';

function makeTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'runner-task',
    name: 'runner-task',
    description: 'd',
    schedule: { cron: '*/5 * * * *', enabled: true },
    cwd: '/tmp',
    approvalMode: ApprovalMode.AUTO,
    notify: 'next-session',
    sandbox: false,
    prompt: 'do the work',
    ...overrides,
  };
}

function ctxFor(task: ScheduledTask): FireContext {
  return { task, firedAtMs: 1_000, runId: 'run0001' };
}

interface Captured {
  command: string;
  args: string[];
  cwd: string;
}

/** A fake spawn that scripts stdout/stderr and an exit, and records argv. */
function fakeSpawn(script: {
  stdout?: string;
  stderr?: string;
  code?: number;
  throwOnSpawn?: boolean;
  emitError?: boolean;
}) {
  const captured: { value?: Captured } = {};
  const spawnFn = (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => {
    captured.value = { command, args, cwd: options.cwd };
    if (script.throwOnSpawn) throw new Error('spawn failed');
    const child = new EventEmitter() as unknown as {
      stdout: PassThrough;
      stderr: PassThrough;
      on: EventEmitter['on'];
      emit: EventEmitter['emit'];
    };
    (child as unknown as { stdout: PassThrough }).stdout = new PassThrough();
    (child as unknown as { stderr: PassThrough }).stderr = new PassThrough();
    setImmediate(() => {
      if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout));
      if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
      if (script.emitError) {
        child.emit('error', new Error('boom'));
        return;
      }
      child.emit('close', script.code ?? 0);
    });
    return child as never;
  };
  return { spawnFn: spawnFn as never, captured };
}

describe('schedule/run-scheduled-task', () => {
  let tmpDir: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-run-'));
    prevHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = tmpDir;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('spawns a headless child with the task’s flags and records a success', async () => {
    const task = makeTask({ model: 'claude-opus-4-8', sandbox: true });
    const { spawnFn, captured } = fakeSpawn({
      stdout: '{"type":"assistant"}\n',
      code: 0,
    });

    const record: TaskRunRecord = await runScheduledTask(ctxFor(task), {
      spawnFn,
      now: () => 2_000,
    });

    expect(record.ok).toBe(true);
    expect(record.summary).toBe('completed');
    expect(record.exitCode).toBe(0);
    expect(record.finishedAt).toBe(2_000);

    const args = captured.value!.args;
    expect(args).toContain('-p');
    expect(args).toContain('do the work');
    expect(args.join(' ')).toContain('--approval-mode auto');
    expect(args.join(' ')).toContain('-o stream-json');
    expect(args.join(' ')).toContain('--model claude-opus-4-8');
    expect(args).toContain('--sandbox');
    expect(captured.value!.cwd).toBe('/tmp');

    // Transcript + meta written under the task's runs/ dir.
    const runsDir = getTaskRunsDir('runner-task');
    const transcript = await fs.readFile(
      path.join(runsDir, 'run0001.jsonl'),
      'utf8',
    );
    expect(transcript).toContain('assistant');
    const meta = JSON.parse(
      await fs.readFile(path.join(runsDir, 'run0001.json'), 'utf8'),
    );
    expect(meta.ok).toBe(true);
    expect(meta.runId).toBe('run0001');
  });

  it('omits --model and --sandbox when unset', async () => {
    const { spawnFn, captured } = fakeSpawn({ code: 0 });
    await runScheduledTask(ctxFor(makeTask()), { spawnFn });
    const joined = captured.value!.args.join(' ');
    expect(joined).not.toContain('--model');
    expect(joined).not.toContain('--sandbox');
  });

  it('records a non-zero exit as a failure with stderr detail', async () => {
    const { spawnFn } = fakeSpawn({
      stderr: 'Error: something broke\nmore',
      code: 1,
    });
    const record = await runScheduledTask(ctxFor(makeTask()), { spawnFn });
    expect(record.ok).toBe(false);
    expect(record.summary).toContain('failed (exit 1)');
    expect(record.summary).toContain('something broke');
  });

  it('records a spawn error as a failed run rather than throwing', async () => {
    const { spawnFn } = fakeSpawn({ throwOnSpawn: true });
    const record = await runScheduledTask(ctxFor(makeTask()), { spawnFn });
    expect(record.ok).toBe(false);
    expect(record.exitCode).toBe(-1);
  });

  it('records a child error event as a failed run', async () => {
    const { spawnFn } = fakeSpawn({ emitError: true });
    const record = await runScheduledTask(ctxFor(makeTask()), { spawnFn });
    expect(record.ok).toBe(false);
    expect(record.exitCode).toBe(-1);
  });
});
