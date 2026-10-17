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
  LOCK_OPTIONS,
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
  let foreignRelease: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lock-test-'));
  });

  afterEach(async () => {
    lockProbe.path = undefined;
    lockProbe.reached = undefined;
    // A test that aborts mid-hold leaves the foreign lock registered; release
    // it before deleting the runtime dir so its update timer never stats a
    // missing lockfile (ECOMPROMISED) inside the worker. A raced release
    // after a compromise rejects with ERELEASED, which is not a failure here.
    const release = foreignRelease;
    foreignRelease = undefined;
    if (release) await release().catch(() => {});
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
      // so the store gets all the way to its own lock attempt. The store's
      // own lock passes onCompromised for this hazard: without a handler, an
      // aborted hold outlives afterEach's directory delete and the default
      // handler throws uncaught from proper-lockfile's update timer.
      const release = await lockfile.lock(target, {
        retries: 0,
        realpath: false,
        onCompromised: () => {},
      });
      foreignRelease = release;
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
      foreignRelease = undefined;

      expect(await outcome).toBe('ok');
      await expect(readWorkspaceAgents(PROJECT_ROOT)).resolves.toMatchObject([
        { name: 'contended' },
      ]);
    } finally {
      Storage.setRuntimeBaseDir(null);
    }
  });

  it('keeps the workspace lock retry budget CI needs', () => {
    // The contention test above stays green down to 19 retries — its 1.5s
    // hold fits inside any budget that long — so pin the configured sizing
    // itself, as the whole knob set: trimming minTimeout/maxTimeout/factor
    // shortens the budget while retries stays 30, and an oversized retries
    // would outlast the lock's own stale window and let a waiter steal a
    // live holder's lock.
    expect(LOCK_OPTIONS.retries).toMatchObject({
      retries: 30,
      minTimeout: 5,
      maxTimeout: 100,
      factor: 2,
    });
  });
});
