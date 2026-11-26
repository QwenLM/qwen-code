/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { wrapSpawn } from './ShellCommand.js';
import { killProcessGroup } from './process-utils.js';
import { execFileNoThrow } from './execFileNoThrow.js';

// Real process fan-out deliberately widens Darwin's child-before-parent group
// signal delivery window. No signal traps or replacement sleep/touch binaries.
it.skipIf(process.platform !== 'darwin').each(['/bin/zsh', '/bin/bash'])(
  'cancels %s without advancing to the next command when group members exit',
  async (shell) => {
    for (const cancellation of ['abort', 'kill'] as const) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'test-cancel-shell-'));
      const fd = openSync(path.join(dir, 'output'), 'w');
      const original =
        'echo $$ > remote-shell.pid; sleep 30; touch remote-finished.txt';
      const script = `for i in {1..128}; do /bin/sleep 30 & done; eval '${original}' < /dev/null`;
      const child = spawn(shell, ['-c', script], {
        cwd: dir,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      closeSync(fd);
      const exited = once(child, 'exit');
      const controller = new AbortController();
      const command = wrapSpawn(child, controller.signal, 0);
      try {
        const deadline = Date.now() + 10_000;
        let ready = false;
        while (Date.now() < deadline) {
          if (existsSync(path.join(dir, 'remote-shell.pid'))) {
            const table = execFileSync(
              '/bin/ps',
              ['-axo', 'pid=,ppid=,pgid=,comm='],
              { encoding: 'utf8' },
            );
            const children = table.split('\n').filter((line) => {
              const fields = line.trim().split(/\s+/);
              return (
                Number(fields[1]) === child.pid &&
                Number(fields[2]) === child.pid &&
                fields[3]?.endsWith('sleep')
              );
            });
            if (children.length === 129) {
              ready = true;
              break;
            }
          }
          await delay(10);
        }
        expect(ready).toBe(true);
        expect(
          readFileSync(path.join(dir, 'remote-shell.pid'), 'utf8').trim(),
        ).toBe(String(child.pid));
        if (cancellation === 'abort') controller.abort();
        else await command.kill();
        const result = await command.result;
        await exited;
        expect(result.interrupted).toBe(true);
        expect(result.signal).toBe(os.constants.signals.SIGTERM);
        // The child can fork touch before the shell itself receives a group
        // signal. Observe beyond result settlement, not just root exit.
        await delay(100);
        expect(existsSync(path.join(dir, 'remote-finished.txt'))).toBe(false);
      } finally {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
        await exited;
        command.cleanup();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  },
);

it.skipIf(process.platform !== 'darwin')(
  'reclaims a known detached child after the leader exits before escalation',
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'test-cancel-orphan-'));
    const pidFile = path.join(dir, 'escaped.pid');
    const marker = path.join(dir, 'remote-finished.txt');
    const childScript = `
      process.on('SIGTERM', () => {});
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 30000);
    `;
    const leader = spawn(
      process.execPath,
      [
        '-e',
        `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {detached: true, stdio: 'ignore'});
      setInterval(() => {}, 1000);
    `,
      ],
      { detached: true, stdio: 'ignore' },
    );
    let exited = false;
    leader.on('exit', () => {
      exited = true;
    });
    const exit = once(leader, 'exit');
    let escapedPid: number | undefined;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const captured = existsSync(pidFile)
          ? Number(readFileSync(pidFile, 'utf8'))
          : NaN;
        if (Number.isInteger(captured) && captured > 1) {
          escapedPid = captured;
          break;
        }
        await delay(10);
      }
      expect(escapedPid).toBeDefined();
      if (escapedPid === undefined) throw new Error('escaped child not ready');
      expect(alive(escapedPid)).toBe(true);
      await killProcessGroup({
        pid: leader.pid!,
        escalate: true,
        isLeaderExited: () => exited,
      });
      await exit;
      const reapedDeadline = Date.now() + 2000;
      while (alive(escapedPid) && Date.now() < reapedDeadline) await delay(10);
      expect(alive(escapedPid)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const pid of [-leader.pid!, escapedPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await exit;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'win32').each(['timeout', 'cancelled'])(
  'reclaims a Windows process tree with inherited pipes after %s',
  async (stopReason) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'process-tree-cleanup-'));
    const pidFile = path.join(dir, 'processes.json');
    const controller = new AbortController();
    const script = `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, descendant.pid]));
      setInterval(() => {}, 1000);
    `;
    const running = execFileNoThrow(process.execPath, ['-e', script], {
      timeout: stopReason === 'timeout' ? 2000 : 15000,
      signal: controller.signal,
      windowsProcessTreeCleanup: { source: 'process-utils.integration' },
    });
    let pids: number[] = [];
    const cleanupErrors: unknown[] = [];
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    };
    try {
      const readyDeadline = performance.now() + 10000;
      while (!existsSync(pidFile) && performance.now() < readyDeadline) {
        await delay(20);
      }
      expect(existsSync(pidFile)).toBe(true);
      pids = JSON.parse(readFileSync(pidFile, 'utf8'));
      expect(pids).toHaveLength(2);
      expect(pids.every((pid) => Number.isInteger(pid) && pid > 1)).toBe(true);
      if (stopReason === 'cancelled') controller.abort();
      const result = await running;
      expect(result.code).toBe(1);
      expect(Boolean(result.timedOut)).toBe(stopReason === 'timeout');
      const cleanupDeadline = performance.now() + 10000;
      while (pids.some(alive) && performance.now() < cleanupDeadline) {
        await delay(20);
      }
      expect(pids.filter(alive)).toEqual([]);
    } finally {
      controller.abort();
      await running;
      if (pids.length === 0 && existsSync(pidFile)) {
        pids = JSON.parse(readFileSync(pidFile, 'utf8'));
      }
      for (const pid of pids) {
        if (!Number.isInteger(pid) || pid <= 1) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            cleanupErrors.push(error);
          }
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    expect(cleanupErrors).toEqual([]);
  },
);
