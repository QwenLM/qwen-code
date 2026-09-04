/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ProcessRegistry } from './process-registry.js';

interface TreePids {
  ordinary: number;
  detached: number;
}

const LEAF_SCRIPT = `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

const ROOT_SCRIPT = `
const { spawn } = require('node:child_process');
const leafScript = ${JSON.stringify(LEAF_SCRIPT)};
const ordinary = spawn(process.execPath, ['-e', leafScript], { stdio: 'ignore' });
const detached = spawn(process.execPath, ['-e', leafScript], {
  detached: true,
  stdio: 'ignore',
});
detached.unref();
process.stdout.write(JSON.stringify({ ordinary: ordinary.pid, detached: detached.pid }) + '\\n');
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

const ROOT_EXITS_FIRST_SCRIPT = `${ROOT_SCRIPT}
setTimeout(() => process.exit(0), 100);
`;

function spawnTree(script = ROOT_SCRIPT): ChildProcess {
  return spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

async function readTreePids(child: ChildProcess): Promise<TreePids> {
  const stdout = child.stdout;
  if (!stdout) throw new Error('test child stdout is unavailable');
  stdout.setEncoding('utf8');
  return await new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      resolve(JSON.parse(buffered.slice(0, newline)) as TreePids);
    };
    const onExit = () => {
      cleanup();
      reject(new Error('test root exited before reporting descendants'));
    };
    const cleanup = () => {
      stdout.off('data', onData);
      child.off('exit', onExit);
    };
    stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForGone(pid: number): Promise<void> {
  await expect.poll(() => isAlive(pid), { timeout: 3_000 }).toBe(false);
}

function forceKill(target: number): void {
  try {
    process.kill(target, 'SIGKILL');
  } catch {
    // The test or implementation already reaped it.
  }
}

async function cleanupTree(rootPid: number, tree?: TreePids): Promise<void> {
  forceKill(-rootPid);
  if (tree) {
    forceKill(-tree.detached);
    forceKill(tree.ordinary);
    forceKill(tree.detached);
  }
  forceKill(rootPid);
  await Promise.all(
    [rootPid, tree?.ordinary, tree?.detached]
      .filter((pid): pid is number => pid !== undefined)
      .map((pid) => waitForGone(pid).catch(() => {})),
  );
}

describe.skipIf(process.platform === 'win32')(
  'ProcessRegistry real process trees',
  () => {
    it('reaps ordinary and detached descendants after graceful escalation', async () => {
      const child = spawnTree();
      const rootPid = child.pid;
      if (!rootPid) throw new Error('test root has no pid');
      const tracked = new ProcessRegistry()
        .reserve()
        .attach(child, { ownsProcessTree: true });
      let tree: TreePids | undefined;
      try {
        tree = await readTreePids(child);

        await expect(tracked.terminate()).rejects.toThrow(
          'exited uncleanly during shutdown',
        );

        await waitForGone(tree.ordinary);
        await waitForGone(tree.detached);
      } finally {
        await cleanupTree(rootPid, tree);
      }
    }, 15_000);

    it('reaps ordinary and detached descendants synchronously', async () => {
      const child = spawnTree();
      const rootPid = child.pid;
      if (!rootPid) throw new Error('test root has no pid');
      const tracked = new ProcessRegistry()
        .reserve()
        .attach(child, { ownsProcessTree: true });
      let tree: TreePids | undefined;
      try {
        tree = await readTreePids(child);

        tracked.killSync();

        await waitForGone(rootPid);
        await waitForGone(tree.ordinary);
        await waitForGone(tree.detached);
      } finally {
        await cleanupTree(rootPid, tree);
      }
    });

    it('limits unexpected root-exit cleanup to the known root group', async () => {
      const child = spawnTree(ROOT_EXITS_FIRST_SCRIPT);
      const rootPid = child.pid;
      if (!rootPid) throw new Error('test root has no pid');
      const registry = new ProcessRegistry();
      const tracked = registry
        .reserve()
        .attach(child, { ownsProcessTree: true });
      let tree: TreePids | undefined;
      try {
        tree = await readTreePids(child);

        await tracked.exited;

        await waitForGone(tree.ordinary);
        expect(isAlive(tree.detached)).toBe(true);
        await expect
          .poll(() => registry.activeProcessCount, { timeout: 3_000 })
          .toBe(0);
      } finally {
        await cleanupTree(rootPid, tree);
      }
    }, 15_000);
  },
);
