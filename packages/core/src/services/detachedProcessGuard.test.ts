/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DETACHED_PROCESS_GUARD_SOURCE,
  guardDetachedProcess,
  prepareDetachedProcessGuard,
  enableDetachedProcessGuard,
  stopDetachedProcessGuard,
  drainDetachedProcessGuard,
} from './detachedProcessGuard.js';

const children: ChildProcess[] = [];
afterEach(async () => {
  await drainDetachedProcessGuard();
  for (const child of children.splice(0)) {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
});

it.skipIf(process.platform === 'win32')('reaps registered groups on owner pipe loss and leaves other groups alone', async () => {
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  const owned = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'pipe',
  });
  const unrelated = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'pipe',
  });
  children.push(owned, unrelated);
  guardDetachedProcess(owned);
  const exited = once(owned, 'exit');
  stopDetachedProcessGuard();
  const [code, signal] = await exited;
  expect(code).toBeNull();
  expect(signal).toBe('SIGKILL');
  expect(unrelated.exitCode).toBeNull();
  expect(unrelated.signalCode).toBeNull();
}, 5000);

it.skipIf(process.platform === 'win32').each(['', 'sleep 1.2; '])('keeps redirected background children registered after their shell closes (%s)', async (prefix) => {
  enableDetachedProcessGuard();
  prepareDetachedProcessGuard();
  const shell = spawn('/bin/sh', ['-c', prefix + 'sleep 30 >/dev/null 2>&1 & echo $!'], {
    detached: true, stdio: 'pipe',
  });
  children.push(shell);
  guardDetachedProcess(shell);
  let output = '';
  shell.stdout!.on('data', (chunk) => { output += chunk; });
  await once(shell, 'close');
  const pid = Number(output.trim());
  expect(pid).toBeGreaterThan(1);
  // Shell 退出不能提前杀掉任务；到应用退出时才回收。
  expect(() => process.kill(pid, 0)).not.toThrow();
  stopDetachedProcessGuard();
  stopDetachedProcessGuard();
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
});

it.skipIf(process.platform === 'win32')('reaps background children when the owner disappears without calling stop', async () => {
  const owner = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { spawn } from 'node:child_process';
    const guard = spawn(process.execPath, ['--eval', ${JSON.stringify(DETACHED_PROCESS_GUARD_SOURCE)}], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
    const shell = spawn('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { stdio: 'pipe', detached: true });
    guard.stdin.write('+' + shell.pid + '\\n');
    let output = '';
    shell.stdout.on('data', chunk => output += chunk);
    shell.once('close', () => {
      guard.stdin.write('-' + shell.pid + '\\n');
      process.stdout.write(JSON.stringify({ shell: shell.pid, child: Number(output.trim()) }) + '\\n');
    });
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: 'pipe' });
  children.push(owner);
  let output = '';
  owner.stdout!.on('data', (chunk) => { output += chunk; });
  await vi.waitFor(() => expect(output).toContain('\n'), { timeout: 5000 });
  const { shell, child } = JSON.parse(output.trim()) as { shell: number; child: number };
  try {
    expect(() => process.kill(child, 0)).not.toThrow();
    const exited = once(owner, 'exit');
    owner.kill('SIGKILL');
    await exited;
    await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow(), { timeout: 5000 });
  } finally {
    try { process.kill(-shell, 'SIGKILL'); } catch { /* already reaped */ }
  }
});

it.each(['reused pid', 'missing group', 'snapshot failure'])('does not kill an unverified group: %s', async (scenario) => {
  // 跑同一份守护脚本，只替换进程快照来源；无需制造真实 PID 复用。
  let rows = '100 100 Fri Oct 16 12:00:00 2026\n101 100 Fri Oct 16 12:00:01 2026\n';
  const read = vi.fn(() => rows);
  const stdin = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const kill = vi.fn();
  const clear = vi.fn();
  const run = new Function('process', 'setInterval', 'clearInterval', 'loadModule',
    DETACHED_PROCESS_GUARD_SOURCE.replace("import('node:child_process')", 'loadModule()'));
  run({ stdin, env: {}, kill }, () => ({ unref() {} }), clear, async () => ({ execFileSync: read }));
  await vi.waitFor(() => expect(stdin.listenerCount('data')).toBe(1));
  stdin.emit('data', '+100\n');
  rows = '101 100 Fri Oct 16 12:00:01 2026\n';
  stdin.emit('data', '-100\n');
  if (scenario === 'snapshot failure') read.mockImplementation(() => { throw new Error('ps unavailable'); });
  else rows = scenario === 'reused pid' ? '101 100 Fri Oct 16 13:00:00 2026\n' : '';
  // 迟到的 Shell close 同样不能重新认领复用的编号。
  stdin.emit('data', '-100\n');
  stdin.emit('end');
  expect(kill).not.toHaveBeenCalled();
  expect(clear).toHaveBeenCalledOnce();
});
