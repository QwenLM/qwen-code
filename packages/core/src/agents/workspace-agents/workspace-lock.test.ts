/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../../config/storage.js';
import {
  generateAgentId,
  getWorkspaceFilePath,
  readWorkspaceAgents,
  updateWorkspaceAgents,
} from './store.js';

const PROJECT_ROOT = '/agent-workspace-lock-test';

// Observability only: every `lockfile.lock` call still goes to the real
// implementation. A waiter reaching for the workspace lock tells the test its
// retry budget has started burning, which is what anchors the contention hold
// below to the waiter's own progress instead of the test's schedule.
const lockProbe = vi.hoisted(() => ({
  path: undefined as string | undefined,
  reached: undefined as (() => void) | undefined,
}));

vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  return {
    ...actual,
    default: {
      ...actual,
      lock(...args: Parameters<typeof actual.lock>) {
        if (String(args[0]) === lockProbe.path) lockProbe.reached?.();
        return actual.lock(...args);
      },
    },
  };
});

function runWorker(
  runtimeDir: string,
  tag: string,
  count: number,
): Promise<string[]> {
  const worker = fileURLToPath(
    new URL('./workspace-lock-worker.ts', import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker], {
      env: {
        ...process.env,
        AGENT_LOCK_RUNTIME_DIR: runtimeDir,
        AGENT_LOCK_PROJECT_ROOT: PROJECT_ROOT,
        AGENT_LOCK_TAG: tag,
        AGENT_LOCK_COUNT: String(count),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`workspace lock worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as string[]);
    });
  });
}

describe('agent workspace lock', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lock-test-'));
  });

  afterEach(async () => {
    lockProbe.path = undefined;
    lockProbe.reached = undefined;
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('loses no roster update when two processes write at once', async () => {
    const count = 8;
    const [first, second] = await Promise.all([
      runWorker(runtimeDir, 'a', count),
      runWorker(runtimeDir, 'b', count),
    ]);

    expect(first).toHaveLength(count);
    expect(second).toHaveLength(count);
    Storage.setRuntimeBaseDir(runtimeDir);
    try {
      const names = (await readWorkspaceAgents(PROJECT_ROOT)).map(
        (agent) => agent.name,
      );
      expect(names.sort()).toEqual([...first, ...second].sort());
    } finally {
      Storage.setRuntimeBaseDir(null);
    }
  });

  it('outlasts one slow foreign lock holder within the retry budget', async () => {
    Storage.setRuntimeBaseDir(runtimeDir);
    try {
      // Create the workspace record so the competing lock has a target.
      await readWorkspaceAgents(PROJECT_ROOT);
      const target = getWorkspaceFilePath(PROJECT_ROOT);

      // Hold the cross-process lock the way a slow foreign process would —
      // through proper-lockfile directly, leaving the in-process mutex free
      // so the store gets all the way to its own lock attempt.
      const release = await lockfile.lock(target, {
        retries: 0,
        realpath: false,
      });
      const waiterReached = new Promise<void>((resolve) => {
        lockProbe.reached = resolve;
      });
      lockProbe.path = target;

      const mutation = updateWorkspaceAgents(PROJECT_ROOT, (agents) => [
        ...agents,
        { id: generateAgentId(), name: 'contended', createdAt: Date.now() },
      ]);
      // Observe a rejection immediately so an early ELOCKED (the waiter gave
      // up before the hold ended) surfaces as a clean assertion failure, not
      // an unhandled rejection.
      const outcome = mutation.then(
        () => 'ok' as const,
        (error: unknown) => error,
      );

      // Start the hold only once the waiter provably reached its own lock
      // attempt: before that it has burned none of its retry budget, so a
      // stalled test schedule can no longer eat the margin between the fixed
      // hold and the budget. If the waiter never reaches the lock this await
      // fails the test on timeout rather than letting it pass unobserved.
      await waiterReached;

      // The 1.5s hold sits above the old 10-retry budget (~0.7s) and inside
      // the 30-retry budget (~2.7s), far under the 10s stale threshold, so
      // the waiter can only succeed by outlasting the hold through retries.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await release();

      expect(await outcome).toBe('ok');
      await expect(readWorkspaceAgents(PROJECT_ROOT)).resolves.toMatchObject([
        { name: 'contended' },
      ]);
    } finally {
      Storage.setRuntimeBaseDir(null);
    }
  });
});
