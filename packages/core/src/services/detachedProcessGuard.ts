/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { runLogger } from '../utils/runLogger.js';

// A private pipe is also a death notification: unlike signals/exit callbacks it
// closes when an IDE kills the CLI or a host terminates its Worker thread.
export const DETACHED_PROCESS_GUARD_SOURCE = String.raw`
void import('node:child_process').then(({ execFileSync }) => {
// 同组后台进程可以比 Shell 活得久。用成员 PID + 启动时间识别组的连续存活，
// 不把 Shell 的 close 当成整组结束，也不长期保留无身份的 PGID。
const groups = new Map();
let buffer = '';
function snapshot() {
  try {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,lstart='], {
      encoding: 'utf8', timeout: 1000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const result = new Map();
    for (const line of output.split('\n')) {
      const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!row) continue;
      const pgid = Number(row[2]);
      if (!result.has(pgid)) result.set(pgid, new Set());
      result.get(pgid).add(row[1] + ':' + row[3]);
    }
    return result;
  } catch { return undefined; }
}
function refresh() {
  if (!groups.size) return true;
  const current = snapshot();
  if (!current) return false; // 无法核实归属时不盲目发信号。
  for (const [pgid, known] of groups) {
    const members = current.get(pgid);
    if (members && continuesGroup(pgid, known, members)) {
      groups.set(pgid, members);
    } else {
      groups.delete(pgid);
    }
  }
  return true;
}
function continuesGroup(pgid, known, members) {
  if ([...known].some(member => members.has(member))) return true;
  // Shell 可以在两次快照间创建后台子进程并退出；允许这一次组长到子进程的交接。
  // 同号的新组长不是原任务，不能借此次交接重新登记。
  const leader = pgid + ':';
  return [...known].some(member => member.startsWith(leader)) &&
    ![...members].some(member => member.startsWith(leader));
}
const timer = setInterval(refresh, 1000);
timer.unref();
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const pid = Number(line.slice(1));
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (line[0] !== '+' && line[0] !== '-') continue;
    // + 登记新任务；- 只刷新现有任务，不能把已复用的进程组重新认领。
    const current = snapshot();
    if (!current) continue;
    const members = current.get(pid);
    const known = groups.get(pid);
    if (members?.size && (line[0] === '+' ||
        (known && continuesGroup(pid, known, members)))) groups.set(pid, members);
    else groups.delete(pid);
  }
});
process.stdin.on('end', () => {
  clearInterval(timer);
  if (!refresh()) return;
  for (const pid of groups.keys()) {
    // Only process groups explicitly created and registered by this owner.
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
});
});
`;

let guard: ChildProcess | undefined;
let enabled = false;
const pendingGuards = new Map<ChildProcess, Promise<void>>();
let drainTask: Promise<void> | undefined;

/** Opt in for hosts that can disappear independently of their children. No spawn. */
export function enableDetachedProcessGuard(): void {
  enabled = true;
  drainTask = undefined;
}

/** Call immediately before spawning a detached task, then register that child. */
export function prepareDetachedProcessGuard(): void {
  if (!enabled || guard || process.platform === 'win32') return;
  const compiledBun =
    (globalThis as unknown as { Bun?: { main: string } }).Bun?.main.startsWith(
      '/$bunfs/',
    ) === true;
  const instance = spawn(
    process.execPath,
    compiledBun
      ? ['--internal-process-guard']
      : ['--eval', DETACHED_PROCESS_GUARD_SOURCE],
    {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        ...(process.versions['electron'] ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
    },
  );
  guard = instance;
  let reaped!: () => void;
  pendingGuards.set(
    instance,
    new Promise<void>((resolve) => {
      reaped = resolve;
    }),
  );
  const completed = () => {
    pendingGuards.delete(instance);
    reaped();
  };
  // Old guards can emit error/exit/close after the next task has replaced them.
  // Retry lazily on that next task; never restart from an event callback.
  const release = (): boolean => {
    if (guard !== instance) return false;
    guard = undefined;
    return true;
  };
  instance.on('error', (error) => {
    release();
    if (instance.pid === undefined) completed();
    runLogger.warn('[process-guard] failed', error);
  });
  instance.on('exit', (code, signal) => {
    completed();
    if (release()) {
      runLogger.warn('[process-guard] exited unexpectedly', { code, signal });
    }
  });
  instance.on('close', () => {
    release();
    completed();
  });
  instance.stdin?.on('error', (error) => {
    release();
    runLogger.warn('[process-guard] registration failed', error);
  });
  instance.unref();
  (instance.stdin as typeof instance.stdin & { unref?: () => void })?.unref?.();
}

/** The child must be a POSIX process-group leader (spawn detached:true). */
export function guardDetachedProcess(child: ChildProcess): void {
  const input = guard?.stdin;
  if (!input || input.destroyed || !child.pid) return;
  const pid = child.pid;
  input.write(`+${pid}\n`);
  // close 只通知守护重新检查进程组；重定向输出的后台子进程可能仍在运行。
  child.once('close', () => {
    if (!input.destroyed && !input.writableEnded) input.write(`-${pid}\n`);
  });
}

/** Release protection without adding a process-exit delay. */
export function stopDetachedProcessGuard(): void {
  if (!enabled) return;
  enabled = false;
  guard = undefined;
  for (const child of pendingGuards.keys()) {
    try {
      if (!child.stdin?.writableEnded) child.stdin?.end();
    } catch {
      /* Worker draining below can still wait for exit or kill. */
    }
  }
}

/** Worker hosts must reap children before ending their own event loop. */
export function drainDetachedProcessGuard(): Promise<void> {
  stopDetachedProcessGuard();
  return (drainTask ??= drainGuards());
}

async function drainGuards(): Promise<void> {
  // Include failed/replaced guards: clearing the current reference does not
  // mean its child has exited and been reaped by this Worker event loop.
  const children = [...pendingGuards.keys()];
  const exited = Promise.all(children.map((child) => pendingGuards.get(child)));
  const wait = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  if (await wait()) return;
  for (const child of children) {
    if (!pendingGuards.has(child) || !child.pid) continue;
    try {
      child.kill('SIGKILL');
    } catch {
      /* A kill error is not an exit event. */
    }
  }
  if (!(await wait()))
    throw new Error('Process guard did not exit after SIGKILL');
}
