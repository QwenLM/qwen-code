/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const serviceUrl = new URL('./shellExecutionService.ts', import.meta.url).href;
const canReapDescendants =
  process.platform === 'linux' &&
  existsSync('/proc/self/stat') &&
  spawnSync('python3', [
    '-c',
    'import ctypes; assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0',
  ]).status === 0;

// A dedicated subreaper prevents orphaned fixture zombies in containers whose
// PID 1 does not reap. Neither Vitest nor other tests become subreapers.
const supervisor = String.raw`
import ctypes
import json
import os
import subprocess
import sys
import time

if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'Unable to reap test descendants')
controller = subprocess.Popen(sys.argv[1:])
try:
    code = controller.wait(timeout=12)
except subprocess.TimeoutExpired:
    controller.kill()
    controller.wait(timeout=3)
    code = 124
deadline = time.monotonic() + 8
while time.monotonic() < deadline:
    try:
        pid, status = os.waitpid(-1, os.WNOHANG)
        if not pid:
            time.sleep(0.01)
    except ChildProcessError:
        print('QWEN_PROCESS_REAPED:' + json.dumps(True), flush=True)
        sys.exit(code)
print('QWEN_PROCESS_REAPED:' + json.dumps(False), flush=True)
sys.exit(code or 1)
`;

const fixture = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const [mode, directory, scenario] = process.argv.slice(2);
const identity = (pid) => {
  const value = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
  return { pid, state: fields[0], pgid: Number(fields[2]), sid: Number(fields[3]), start: fields[19] };
};
setTimeout(() => process.exit(0), 6000);
if (mode === 'descendant') {
  process.on('SIGTERM', () => {
    fs.writeFileSync(directory + '/descendant-term', 'TERM');
    if (scenario === 'no-survivors') process.exit(0);
  });
  process.on('SIGHUP', () => {});
  process.send(identity(process.pid));
} else {
  const descendant = cp.fork(__filename, ['descendant', directory, scenario], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  descendant.on('message', (child) => {
    fs.writeFileSync(directory + '/ready.json', JSON.stringify({ leader: identity(process.pid), descendant: child }));
    process.stdout.write('OWNED_FIXTURE_READY\n');
    if (scenario === 'natural') setTimeout(() => process.exit(0), 80);
  });
  process.on('SIGTERM', () => {
    fs.writeFileSync(directory + '/leader-term', 'TERM');
    process.exit(0);
  });
}
`;

const driver = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { ShellExecutionService } from SERVICE_URL;

const [directory, scenario, transport] = process.argv.slice(2);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stat = (pid) => {
  try {
    const value = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
    return { pid, state: fields[0], pgid: Number(fields[2]), sid: Number(fields[3]), start: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
const isSame = (entry) => {
  const current = stat(entry.pid);
  return current?.start === entry.start && current.pgid === entry.pgid && current.sid === entry.sid;
};
const isRunning = (entry) => {
  const current = stat(entry.pid);
  return current?.start === entry.start && current.pgid === entry.pgid && current.sid === entry.sid && current.state !== 'Z';
};
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const waitFor = async (predicate, description, timeout = 2500) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(description + ' timed out');
    await delay(10);
  }
};
const bounded = async (promise) => {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Execution result timed out')), 2500);
    })]);
  } finally {
    clearTimeout(timeout);
  }
};
const realKill = process.kill.bind(process);
const controller = new AbortController();
let owned;
let summary;
const signals = [];
try {
  const handle = await ShellExecutionService.execute(
    'exec ' + quote(process.execPath) + ' ' + quote(path.join(directory, 'fixture.cjs')) + ' leader ' + quote(directory) + ' ' + quote(scenario),
    process.cwd(), () => {}, controller.signal, transport === 'pty',
    { terminalWidth: 80, terminalHeight: 24 },
  );
  await waitFor(() => fs.existsSync(directory + '/ready.json'), 'Fixture readiness');
  owned = JSON.parse(fs.readFileSync(directory + '/ready.json', 'utf8'));
  if (owned.leader.pid !== handle.pid || owned.leader.pgid !== handle.pid || owned.descendant.pgid !== handle.pid || owned.descendant.sid !== owned.leader.sid) {
    throw new Error('Fixture did not form the freshly owned process group');
  }
  const started = Date.now();
  process.kill = (pid, signal = 'SIGTERM') => {
    const entries = [owned.leader, owned.descendant];
    if (pid !== -owned.leader.pgid && !entries.some((entry) => entry.pid === pid)) {
      throw new Error('Refusing unrelated signal target ' + pid);
    }
    const matches = entries.filter((entry) => isSame(entry));
    if (!matches.some((entry) => pid < 0 || entry.pid === pid)) {
      const targets = pid < 0 ? entries : entries.filter((entry) => entry.pid === pid);
      if (targets.some((entry) => stat(entry.pid))) {
        throw new Error('Refusing an identity-mismatched fixture');
      }
      throw Object.assign(new Error('Owned fixture is gone'), { code: 'ESRCH' });
    }
    signals.push({ pid, signal, afterMs: Date.now() - started, leaderRunning: isRunning(owned.leader) });
    return realKill(pid, signal);
  };
  if (scenario === 'promotion') {
    controller.abort({ kind: 'background', shellId: 'owned-real-process-test' });
  } else if (scenario !== 'natural') {
    controller.abort({ kind: 'cancel' });
  }
  if (scenario === 'cleanup-race') {
    await waitFor(() => fs.existsSync(directory + '/leader-term'), 'Leader TERM');
    ShellExecutionService.cleanup();
    ShellExecutionService.cleanup();
  }
  const result = await bounded(handle.result);
  const descendantRunningAtResult = isRunning(owned.descendant);
  const leaderRunningAtResult = isRunning(owned.leader);
  const resultAfterMs = Date.now() - started;
  ShellExecutionService.cleanup();
  ShellExecutionService.cleanup();
  await delay(300);
  summary = {
    executionMethod: result.executionMethod,
    aborted: result.aborted,
    promoted: result.promoted === true,
    error: result.error?.message ?? null,
    descendantRunningAtResult,
    leaderRunningAtResult,
    descendantRunningAfterCleanup: isRunning(owned.descendant),
    leaderObservedTerm: fs.existsSync(directory + '/leader-term'),
    resultAfterMs,
    signals,
  };
} finally {
  process.kill = realKill;
  if (owned) {
    const entries = [owned.leader, owned.descendant];
    // Only a still-matching member authenticates this fixture group.
    if (entries.some(isRunning)) realKill(-owned.leader.pgid, 'SIGKILL');
    await waitFor(() => !entries.some(isRunning), 'Owned fixture teardown');
  }
}
console.log('QWEN_PROCESS_RESULT:' + JSON.stringify(summary));
`.replace('SERVICE_URL', JSON.stringify(serviceUrl));

interface ProcessResult {
  executionMethod: string;
  aborted: boolean;
  promoted: boolean;
  error: string | null;
  descendantRunningAtResult: boolean;
  leaderRunningAtResult: boolean;
  descendantRunningAfterCleanup: boolean;
  leaderObservedTerm: boolean;
  resultAfterMs: number;
  signals: Array<{
    pid: number;
    signal: string | number;
    afterMs: number;
    leaderRunning: boolean;
  }>;
}

async function runFixture(
  transport: 'child_process' | 'pty',
  scenario: string,
): Promise<ProcessResult> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qwen-owned-group-'));
  try {
    await Promise.all([
      writeFile(path.join(directory, 'supervisor.py'), supervisor),
      writeFile(path.join(directory, 'fixture.cjs'), fixture),
      writeFile(path.join(directory, 'driver.mjs'), driver),
    ]);
    const { stdout } = await execFileAsync(
      'python3',
      [
        path.join(directory, 'supervisor.py'),
        process.execPath,
        '--import',
        'tsx/esm',
        path.join(directory, 'driver.mjs'),
        directory,
        scenario,
        transport,
      ],
      { cwd: repositoryRoot, maxBuffer: 1024 * 1024 },
    );
    expect(stdout).toContain('QWEN_PROCESS_REAPED:true');
    const result = stdout
      .split('\n')
      .find((line) => line.startsWith('QWEN_PROCESS_RESULT:'));
    expect(result).toBeDefined();
    const parsed = JSON.parse(
      result!.slice('QWEN_PROCESS_RESULT:'.length),
    ) as ProcessResult;
    expect(parsed.executionMethod).toBe(
      transport === 'pty' ? 'lydell-node-pty' : 'child_process',
    );
    return parsed;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe.runIf(canReapDescendants)(
  'POSIX process-group cleanup (real Linux processes with Python subreaper)',
  () => {
    describe.each(['child_process', 'pty'] as const)('%s', (transport) => {
      it('kills a TERM-ignoring descendant after its leader exits, before resolving', async () => {
        const result = await runFixture(transport, 'survivor');
        expect(result.aborted).toBe(true);
        expect(result.error).toBeNull();
        expect(result.leaderObservedTerm).toBe(true);
        expect(result.leaderRunningAtResult).toBe(false);
        expect(result.descendantRunningAtResult).toBe(false);
        expect(result.descendantRunningAfterCleanup).toBe(false);
        const terms = result.signals.filter(
          (entry) => entry.signal === 'SIGTERM',
        );
        const kills = result.signals.filter(
          (entry) => entry.signal === 'SIGKILL',
        );
        expect(terms).toHaveLength(1);
        expect(kills).toHaveLength(1);
        expect(kills[0].pid).toBe(terms[0].pid);
        expect(kills[0].pid).toBeLessThan(-1);
        expect(kills[0].leaderRunning).toBe(false);
        expect(kills[0].afterMs - terms[0].afterMs).toBeGreaterThanOrEqual(190);
        expect(result.resultAfterMs).toBeGreaterThanOrEqual(kills[0].afterMs);
      });

      it('does not escalate when TERM leaves no running group members', async () => {
        const result = await runFixture(transport, 'no-survivors');
        expect(result.aborted).toBe(true);
        expect(result.error).toBeNull();
        expect(result.descendantRunningAtResult).toBe(false);
        expect(result.descendantRunningAfterCleanup).toBe(false);
        expect(
          result.signals.filter((entry) => entry.signal === 'SIGTERM'),
        ).toHaveLength(1);
        expect(
          result.signals.filter((entry) => entry.signal === 'SIGKILL'),
        ).toHaveLength(0);
      });

      it('forces pending cancellation exactly once across repeated synchronous cleanup', async () => {
        const result = await runFixture(transport, 'cleanup-race');
        expect(result.aborted).toBe(true);
        expect(result.error).toBeNull();
        expect(result.descendantRunningAtResult).toBe(false);
        expect(result.descendantRunningAfterCleanup).toBe(false);
        expect(
          result.signals.filter((entry) => entry.signal === 'SIGTERM'),
        ).toHaveLength(1);
        expect(
          result.signals.filter((entry) => entry.signal === 'SIGKILL'),
        ).toHaveLength(1);
      });

      it('releases ownership on natural exit without killing a surviving descendant', async () => {
        const result = await runFixture(transport, 'natural');
        expect(result.aborted).toBe(false);
        expect(result.promoted).toBe(false);
        expect(result.error).toBeNull();
        expect(result.leaderRunningAtResult).toBe(false);
        expect(result.descendantRunningAtResult).toBe(true);
        expect(result.descendantRunningAfterCleanup).toBe(true);
        expect(
          result.signals.filter((entry) => entry.signal !== 0),
        ).toHaveLength(0);
      });

      it('transfers ownership on promotion without service cleanup killing the group', async () => {
        const result = await runFixture(transport, 'promotion');
        expect(result.aborted).toBe(false);
        expect(result.promoted).toBe(true);
        expect(result.error).toBeNull();
        expect(result.leaderRunningAtResult).toBe(true);
        expect(result.descendantRunningAtResult).toBe(true);
        expect(result.descendantRunningAfterCleanup).toBe(true);
        expect(
          result.signals.filter((entry) => entry.signal !== 0),
        ).toHaveLength(0);
      });
    });
  },
);
