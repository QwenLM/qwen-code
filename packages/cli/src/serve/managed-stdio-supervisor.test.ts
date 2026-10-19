/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchManagedStdio } from './managed-stdio-supervisor.js';

const SERVER = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const descendant = spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'],
  { stdio: 'inherit' },
);
writeFileSync(
  process.env.PIDS,
  JSON.stringify({ server: process.pid, descendant: descendant.pid }),
);
setInterval(() => {}, 1000);
process.stdin.resume();
`;

const WORKER = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const spec = JSON.parse(process.env.SPEC);
const launcher = spawn(spec.executable, spec.args, {
  env: spec.env,
  stdio: ['pipe', 'ignore', 'ignore'],
});
writeFileSync(process.env.LAUNCHER_PID, String(launcher.pid));
setInterval(() => {}, 1000);
`;

const BACKPRESSURE_SERVER = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const descendant = spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'],
  { stdio: 'inherit' },
);
writeFileSync(
  process.env.PIDS,
  JSON.stringify({ server: process.pid, descendant: descendant.pid }),
);
setInterval(() => {}, 1000);
`;

const BACKPRESSURE_WORKER = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const spec = JSON.parse(process.env.SPEC);
const launcher = spawn(spec.executable, spec.args, {
  env: spec.env,
  stdio: ['pipe', 'ignore', 'ignore'],
});
launcher.stdin.on('error', () => undefined);
writeFileSync(process.env.LAUNCHER_PID, String(launcher.pid));
const payload = Buffer.alloc(64 * 1024, 'x');
for (let index = 0; index < 32; index++) launcher.stdin.write(payload);
setTimeout(() => process.kill(process.pid, 'SIGKILL'), 500);
`;

const directories: string[] = [];

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), 'qwen-stdio-'));
  directories.push(created);
  return created;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  assertion: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition did not settle');
}

function readPids(path: string): { server: number; descendant: number } {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    server: number;
    descendant: number;
  };
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    try {
      const pids = readPids(join(path, 'pids.json'));
      for (const pid of [pids.server, pids.descendant]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The case already reaped it.
        }
      }
    } catch {
      // A case failed before the server recorded its pids.
    }
    try {
      const launcherPid = Number(
        readFileSync(join(path, 'launcher.pid'), 'utf8'),
      );
      try {
        process.kill(launcherPid, 'SIGKILL');
      } catch {
        // The launcher already exited.
      }
    } catch {
      // The case failed before the worker recorded the launcher pid.
    }
    rmSync(path, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')(
  'managed stdio supervisor',
  () => {
    it('reaps the server and its descendants when stdin closes', async () => {
      const root = directory();
      const pidsFile = join(root, 'pids.json');
      const launch = launchManagedStdio(process.execPath, ['-e', SERVER], {
        PATH: process.env['PATH'] ?? '',
        PIDS: pidsFile,
      });
      const launcher = spawn(launch.executable, launch.args, {
        env: launch.env,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      await waitFor(() => existsSync(pidsFile));
      const pids = readPids(pidsFile);
      expect(alive(pids.server)).toBe(true);
      expect(alive(pids.descendant)).toBe(true);

      launcher.stdin.end();

      await waitFor(() => !alive(pids.server) && !alive(pids.descendant));
      expect(alive(pids.server)).toBe(false);
      expect(alive(pids.descendant)).toBe(false);
      launcher.kill('SIGKILL');
    });

    it('reaps when the process holding stdin dies', async () => {
      const root = directory();
      const pidsFile = join(root, 'pids.json');
      const launcherPidFile = join(root, 'launcher.pid');
      const launch = launchManagedStdio(process.execPath, ['-e', SERVER], {
        PATH: process.env['PATH'] ?? '',
        PIDS: pidsFile,
      });
      const worker = spawn(process.execPath, ['-e', WORKER], {
        env: {
          PATH: process.env['PATH'] ?? '',
          SPEC: JSON.stringify(launch),
          LAUNCHER_PID: launcherPidFile,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      await waitFor(() => existsSync(pidsFile));
      const pids = readPids(pidsFile);

      // The worker owns the launcher's stdin. Killing it without any handler
      // is the SIGKILL a dead Runtime worker produces.
      worker.kill('SIGKILL');

      await waitFor(() => !alive(pids.server) && !alive(pids.descendant));
      expect(alive(pids.server)).toBe(false);
      expect(alive(pids.descendant)).toBe(false);
      await waitFor(() => existsSync(launcherPidFile));
      const launcherPid = Number(readFileSync(launcherPidFile, 'utf8'));
      await waitFor(() => !alive(launcherPid));
    });

    it('reaps under stdin backpressure when the stdin holder dies', async () => {
      const root = directory();
      const pidsFile = join(root, 'pids.json');
      const launcherPidFile = join(root, 'launcher.pid');
      const launch = launchManagedStdio(
        process.execPath,
        ['-e', BACKPRESSURE_SERVER],
        { PATH: process.env['PATH'] ?? '', PIDS: pidsFile },
      );
      spawn(process.execPath, ['-e', BACKPRESSURE_WORKER], {
        env: {
          PATH: process.env['PATH'] ?? '',
          SPEC: JSON.stringify(launch),
          LAUNCHER_PID: launcherPidFile,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      await waitFor(() => existsSync(pidsFile));
      const pids = readPids(pidsFile);

      // The worker fills the launcher's stdin while the server never reads,
      // then SIGKILLs itself. Reaping must not wait for the pipe to drain.
      await waitFor(() => !alive(pids.server) && !alive(pids.descendant));
      expect(alive(pids.server)).toBe(false);
      expect(alive(pids.descendant)).toBe(false);
      await waitFor(() => existsSync(launcherPidFile));
      const launcherPid = Number(readFileSync(launcherPidFile, 'utf8'));
      await waitFor(() => !alive(launcherPid));
    });
  },
);
