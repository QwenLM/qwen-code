/**
 * Production fire action for the `/schedule` daemon: each due task runs as a
 * fresh headless `qwen -p` child in the task's own cwd (D2 — full isolation,
 * no memory of any conversation), and its transcript + a result record are
 * written under the task's `runs/` dir for later delivery.
 *
 * The child is the same CLI re-invoked non-interactively, so it inherits the
 * user's auth and settings without a separate runtime.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteJSON } from '../../utils/atomicFileWrite.js';
import { getTaskRunsDir } from './task-store.js';
import type { FireContext } from './schedule-daemon.js';
import type { TaskRunRecord } from './run-delivery.js';

/** Wall-clock safety cap for an unattended run. */
const DEFAULT_MAX_WALL_TIME = '30m';
/** How much stderr tail to keep for a failure summary. */
const STDERR_TAIL_BYTES = 2000;

/** 8-char run id, shared by the daemon and manual `schedule_run`. */
export function generateRunId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export interface RunScheduledTaskDeps {
  /** Injectable spawn for tests. */
  spawnFn?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => ChildProcess;
  now?: () => number;
  maxWallTime?: string;
}

/**
 * Resolves how to re-invoke this CLI headlessly: `node <cli-entry>`. In a
 * packaged daemon `process.argv[1]` is `dist/cli.js`; from source it is the
 * dev entry. Overridable via `QWEN_SCHEDULE_CHILD_BIN` for unusual installs.
 */
export function resolveQwenChildCommand(): {
  command: string;
  prefixArgs: string[];
} {
  const override = process.env['QWEN_SCHEDULE_CHILD_BIN'];
  if (override) return { command: override, prefixArgs: [] };
  const cliEntry = process.env['QWEN_CLI_ENTRY'] || process.argv[1] || '';
  // Preserve the node flags this process was launched with so the child
  // re-enters the CLI the same way — critically, the tsx loader in `npm run
  // dev` (argv[1] is a .ts entry that plain node can't run) and `--expose-gc`
  // in a packaged install. Drop `--inspect*` so the child doesn't fight the
  // parent for the debugger port. (Same approach as acp-bridge/spawnChannel.)
  const execArgs = process.execArgv.filter(
    (a) => !/^--inspect(-brk)?($|=)/.test(a),
  );
  return { command: process.execPath, prefixArgs: [...execArgs, cliEntry] };
}

function buildArgs(ctx: FireContext, maxWallTime: string): string[] {
  const { task } = ctx;
  const args = [
    '-p',
    task.prompt,
    '--approval-mode',
    task.approvalMode,
    '-o',
    'stream-json',
    '--max-wall-time',
    maxWallTime,
  ];
  if (task.model) args.push('--model', task.model);
  if (task.sandbox) args.push('--sandbox');
  return args;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line?.trim() ?? '';
}

/**
 * Runs one scheduled task to completion, writing:
 *   - `runs/<runId>.jsonl` — the child's stream-json transcript
 *   - `runs/<runId>.json`  — a {@link TaskRunRecord} for delivery
 * Resolves with the record once the child exits (never rejects — a spawn
 * failure is recorded as a failed run).
 */
export async function runScheduledTask(
  ctx: FireContext,
  deps: RunScheduledTaskDeps = {},
): Promise<TaskRunRecord> {
  const spawnFn = deps.spawnFn ?? spawn;
  const now = deps.now ?? (() => Date.now());
  const maxWallTime = deps.maxWallTime ?? DEFAULT_MAX_WALL_TIME;
  const { task, runId, firedAtMs } = ctx;

  const runsDir = getTaskRunsDir(task.id);
  await fs.mkdir(runsDir, { recursive: true });
  const transcriptPath = path.join(runsDir, `${runId}.jsonl`);
  const metaPath = path.join(runsDir, `${runId}.json`);

  const { command, prefixArgs } = resolveQwenChildCommand();
  const args = [...prefixArgs, ...buildArgs(ctx, maxWallTime)];

  const out = createWriteStream(transcriptPath);
  let stderrTail = '';

  const exitCode = await new Promise<number>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(command, args, { cwd: task.cwd, env: process.env });
    } catch (err) {
      stderrTail = String(err);
      resolve(-1);
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => out.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (err) => {
      stderrTail = (stderrTail + String(err)).slice(-STDERR_TAIL_BYTES);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });

  await new Promise<void>((r) => out.end(r));

  const ok = exitCode === 0;
  const detail = stderrTail ? `: ${firstLine(stderrTail)}` : '';
  const record: TaskRunRecord = {
    taskId: task.id,
    runId,
    firedAt: firedAtMs,
    finishedAt: now(),
    exitCode,
    ok,
    summary: ok ? 'completed' : `failed (exit ${exitCode})${detail}`,
  };
  await atomicWriteJSON(metaPath, record, { noFollow: true });
  return record;
}
