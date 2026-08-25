/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeReplKernelManager } from './kernel-manager.js';
import { NodeReplSecurityPolicy } from './security-policy.js';

// #9333 acceptance criterion 10: >=100 consecutive mixed cells on one kernel,
// and >=10 concurrent isolated kernels with no cross-talk and no residual
// processes / temp dirs.

const managers: NodeReplKernelManager[] = [];

function makeManager(): NodeReplKernelManager {
  const manager = new NodeReplKernelManager({
    cwd: process.cwd(),
    homeDir: os.homedir(),
    tmpRootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-node-repl-scale-')),
    policy: NodeReplSecurityPolicy.default(),
    readableRoots: [process.cwd()],
  });
  managers.push(manager);
  return manager;
}

afterEach(() => {
  while (managers.length > 0) {
    managers.pop()?.dispose();
  }
});

function firstText(events: Array<{ type: string; text?: string }>): string {
  return events
    .filter((e) => e.type === 'text')
    .map((e) => e.text ?? '')
    .join('');
}

describe('node_repl scale & isolation', () => {
  it('runs 100 consecutive mixed cells on a single kernel', async () => {
    const manager = makeManager();
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    // Seed an accumulator binding.
    await manager.exec({ code: 'let total = 0;', timeoutMs: 30_000 });

    for (let i = 1; i <= 100; i++) {
      if (i % 25 === 0) {
        // Every 25th cell: emit an image.
        const outcome = await manager.exec({
          code: `await nodeRepl.emitImage({ bytes: Uint8Array.from(atob(${JSON.stringify(
            png,
          )}), c => c.charCodeAt(0)), mimeType: 'image/png' });`,
          timeoutMs: 30_000,
        });
        expect(outcome.status).toBe('ok');
      } else if (i % 10 === 0) {
        // Every 10th cell: throw, then confirm state survived (partial commit
        // of the accumulator happened before the throw).
        const outcome = await manager.exec({
          code: `total += 1; throw new Error("boom ${i}");`,
          timeoutMs: 30_000,
        });
        expect(outcome.status).toBe('error');
      } else {
        const outcome = await manager.exec({
          code: `total += 1; nodeRepl.write(String(total));`,
          timeoutMs: 30_000,
        });
        expect(outcome.status).toBe('ok');
      }
    }

    // Of 100 cells: 4 image cells (i%25==0) do not increment; the other 96
    // each do `total += 1`. The 8 throwing cells (i%10==0, not %25) increment
    // BEFORE throwing, and that mutation must survive via partial-commit-on-
    // throw — so total = 96 (not 88). This asserts partial commit works.
    const final = await manager.exec({
      code: 'nodeRepl.write(String(total));',
      timeoutMs: 30_000,
    });
    expect(final.status).toBe('ok');
    expect(firstText(final.events).trim()).toBe('96');
  });

  it('isolates 10 concurrent kernels (no binding/pid/output cross-talk)', async () => {
    const count = 10;
    const kernels = Array.from({ length: count }, () => makeManager());

    // Each kernel binds a distinct value concurrently.
    await Promise.all(
      kernels.map((m, i) =>
        m.exec({ code: `const tag = ${i * 100};`, timeoutMs: 30_000 }),
      ),
    );

    // Read each back concurrently; values must not leak across kernels.
    const outcomes = await Promise.all(
      kernels.map((m) =>
        m.exec({ code: 'nodeRepl.write(String(tag));', timeoutMs: 30_000 }),
      ),
    );

    outcomes.forEach((outcome, i) => {
      expect(outcome.status).toBe('ok');
      expect(firstText(outcome.events).trim()).toBe(String(i * 100));
    });

    // Distinct PIDs => genuinely separate processes.
    const pids = new Set(kernels.map((m) => m.getKernelPid()));
    expect(pids.size).toBe(count);
    expect([...pids].every((pid) => typeof pid === 'number' && pid > 0)).toBe(
      true,
    );

    // Dispose and confirm every process tree is gone and temp dirs removed.
    const tmpDirs = kernels.map((m) => m.getSessionTmpDir());
    const livePids = kernels.map((m) => m.getKernelPid());
    while (managers.length > 0) managers.pop()?.dispose();
    // Give SIGKILL a moment to reap.
    await new Promise((r) => setTimeout(r, 500));

    for (const pid of livePids) {
      if (typeof pid !== 'number') continue;
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
    for (const dir of tmpDirs) {
      if (dir) expect(fs.existsSync(dir)).toBe(false);
    }
  });
});
