/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end integration tests for the cron module. Real fs (via tmpDir) +
 * real cron-tasks/cron-scheduler glue; only chokidar is mocked because it is
 * an environmental concern, not a behavioral one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks (hoisted so static-/dynamic-import paths share one capture object).
// ---------------------------------------------------------------------------

const { watcherCapture } = vi.hoisted(() => ({
  watcherCapture: {
    changeHandler: null as null | (() => void),
    addHandler: null as null | (() => void),
    unlinkHandler: null as null | (() => void),
  },
}));

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => {
      const watcher: {
        on: (event: string, handler: () => void) => typeof watcher;
        close: () => Promise<void>;
      } = {
        on: vi.fn((event: string, handler: () => void) => {
          if (event === 'change') watcherCapture.changeHandler = handler;
          else if (event === 'add') watcherCapture.addHandler = handler;
          else if (event === 'unlink') watcherCapture.unlinkHandler = handler;
          return watcher;
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      return watcher;
    }),
  },
}));

import { createCronScheduler } from './cron-scheduler.js';
import {
  readCronTasks,
  writeCronTasks,
  type CronTask,
} from './cron-tasks.js';
import { CronManager } from './cronManager.js';

/**
 * Create/list/clear now go through a cron manager: the in-memory store
 * belongs to a session, so there is no module-level function to call. Nothing
 * here starts the manager's own scheduler — the cases below build schedulers
 * directly and point them at `tmpDir`.
 */
const manager = new CronManager({ getSessionId: () => 'test-session' });
const addTask: CronManager['addTask'] = (...args) =>
  manager.addTask(...args);
const getSessionTasks = (): CronTask[] => manager.getSessionTasks();
const clearSessionTasks = (): void => manager.clearSessionTasks();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Yield to libuv so real fs callbacks (readCronTasks/writeCronTasks) can
 * complete even while setInterval/setTimeout are mocked. We deliberately
 * leave setImmediate real (see toFake list) for this purpose.
 *
 * The leading `await import('chokidar')` is a workaround for vitest's
 * fake-timer interaction with the scheduler's dynamic chokidar import:
 * forcing a fresh resolution here unblocks the scheduler's pending
 * `await import()` inside enable().
 */
async function flushAsync(): Promise<void> {
  await import('chokidar');
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setImmediate(resolve));
    await Promise.resolve();
  }
}

/**
 * Block until the scheduler's `enable()` has finished registering its
 * chokidar watcher. The scheduler captures handlers via our chokidar mock
 * only after `await import()` settles, so a non-null `changeHandler` is the
 * most reliable readiness signal under fake timers.
 */
async function waitForSchedulerReady(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (watcherCapture.changeHandler) {
      // Give load() one more round of microtasks to populate `tasks`.
      await flushAsync();
      return;
    }
    await import('chokidar');
    await new Promise(resolve => setImmediate(resolve));
    await Promise.resolve();
  }
  throw new Error('scheduler enable() did not complete in time');
}

/**
 * Advance the fake clock in 1s chunks, flushing real fs I/O between each
 * chunk. Required when the advance spans multiple check ticks: the scheduler
 * batches fs writes via fire-and-forget `void markCronTasksFired(...)`, and a
 * monolithic advance starves those writes — the resulting unfinished writes
 * leave `inFlight` set, which blocks every subsequent tick from firing.
 */
async function advanceChunked(totalMs: number): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0) {
    const step = Math.min(remaining, 1000);
    await vi.advanceTimersByTimeAsync(step);
    await flushAsync();
    remaining -= step;
  }
}

describe('Cron Integration Tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-integration-'));
    clearSessionTasks();
    watcherCapture.changeHandler = null;
    watcherCapture.addHandler = null;
    watcherCapture.unlinkHandler = null;
    // Keep setImmediate real so real fs callbacks still fire.
    vi.useFakeTimers({
      toFake: [
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
        'Date',
      ],
    });
    vi.setSystemTime(new Date('2026-05-20T10:00:30Z'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    clearSessionTasks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. recurring task: create on disk → scheduler fires → callback receives
  //    the prompt → lastFiredAt is persisted back to disk.
  // -------------------------------------------------------------------------
  describe('E2E: task create → fire → callback', () => {
    it('fires recurring task and stamps lastFiredAt to disk', async () => {
      const past = new Date('2026-05-20T09:00:00Z').getTime();
      await writeCronTasks(
        [
          {
            id: '11111111',
            cron: '* * * * *',
            prompt: 'recurring fire',
            createdAt: past,
            recurring: true,
          },
        ],
        tmpDir,
      );

      const onFire = vi.fn();
      const scheduler = createCronScheduler({
        onFire,
        isLoading: () => false,
        dir: tmpDir,
      });

      scheduler.start();
      await waitForSchedulerReady();
      // First check tick at +1000ms — the task is anchored to `past`, so its
      // computed next-fire is well behind `now` and fires immediately.
      await vi.advanceTimersByTimeAsync(1500);
      await flushAsync();

      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledWith('recurring fire');

      // markCronTasksFired is fire-and-forget — let its disk write settle.
      await flushAsync();
      const persisted = await readCronTasks(tmpDir);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.lastFiredAt).toBeDefined();
      expect(persisted[0]!.lastFiredAt!).toBeGreaterThanOrEqual(past);

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 2. one-shot task: fires, is removed from the file, and the scheduler does
  //    not refire it after the (mocked) chokidar reload.
  // -------------------------------------------------------------------------
  describe('E2E: one-shot task auto cleanup', () => {
    it('fires once, deletes from disk, and does not refire after reload', async () => {
      const created = new Date('2026-05-20T10:00:30Z').getTime();
      await writeCronTasks(
        [
          {
            id: '22222222',
            cron: '* * * * *',
            prompt: 'one-shot fire',
            createdAt: created,
          },
        ],
        tmpDir,
      );

      const onFire = vi.fn();
      const scheduler = createCronScheduler({
        onFire,
        isLoading: () => false,
        dir: tmpDir,
      });

      scheduler.start();
      await waitForSchedulerReady();

      // Walk past 10:01:00 — the next cron match for `* * * * *`.
      await vi.advanceTimersByTimeAsync(35_000);
      await flushAsync();

      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledWith('one-shot fire');

      // Wait for removeCronTasks to flush its rewrite.
      await flushAsync();
      const persisted = await readCronTasks(tmpDir);
      expect(persisted).toHaveLength(0);

      // Simulate chokidar's 'change' event so the scheduler reloads its
      // in-memory task list from the now-empty file.
      watcherCapture.changeHandler?.();
      await flushAsync();

      // Advance another full minute — the deleted task must not refire.
      onFire.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushAsync();
      expect(onFire).not.toHaveBeenCalled();

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 3. isLoading gate: while loading, check() bails before any fire; once
  //    isLoading flips false the next tick fires normally.
  // -------------------------------------------------------------------------
  describe('E2E: isLoading delays fire', () => {
    it('suppresses fire while loading then fires after isLoading flips', async () => {
      const past = new Date('2026-05-20T09:00:00Z').getTime();
      await writeCronTasks(
        [
          {
            id: '33333333',
            cron: '* * * * *',
            prompt: 'loading test',
            createdAt: past,
            recurring: true,
          },
        ],
        tmpDir,
      );

      let loading = true;
      const onFire = vi.fn();
      const scheduler = createCronScheduler({
        onFire,
        isLoading: () => loading,
        dir: tmpDir,
      });

      scheduler.start();
      await waitForSchedulerReady();

      // Tick #1 with loading=true — check() exits early, nothing fires.
      await vi.advanceTimersByTimeAsync(1500);
      await flushAsync();
      expect(onFire).not.toHaveBeenCalled();

      // Flip the gate and step one more tick.
      loading = false;
      await vi.advanceTimersByTimeAsync(1000);
      await flushAsync();
      expect(onFire).toHaveBeenCalled();
      expect(onFire).toHaveBeenCalledWith('loading test');

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 4. missed-task detection: a stale one-shot task triggers onMissed (not
  //    onFire) on initial load.
  // -------------------------------------------------------------------------
  describe('E2E: missed task detection', () => {
    it('invokes onMissed for stale one-shot tasks on startup', async () => {
      const longAgo = new Date('2026-05-19T09:00:00Z').getTime();
      await writeCronTasks(
        [
          {
            id: '44444444',
            cron: '* * * * *',
            prompt: 'missed task',
            createdAt: longAgo,
          },
        ],
        tmpDir,
      );

      const onFire = vi.fn();
      const onMissed = vi.fn();
      const scheduler = createCronScheduler({
        onFire,
        onMissed,
        isLoading: () => false,
        dir: tmpDir,
      });

      scheduler.start();
      await waitForSchedulerReady();
      // load(true) is fire-and-forget inside enable(); give its real fs
      // readCronTasks call a chance to resolve before asserting onMissed.
      await flushAsync();
      await vi.advanceTimersByTimeAsync(0);
      await flushAsync();

      expect(onMissed).toHaveBeenCalledTimes(1);
      const surfaced = onMissed.mock.calls[0]![0] as CronTask[];
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0]!.id).toBe('44444444');
      expect(surfaced[0]!.prompt).toBe('missed task');

      // onMissed taking the missed list short-circuits the buildMissed prompt
      // path on onFire.
      expect(onFire).not.toHaveBeenCalled();

      scheduler.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 5. session vs durable: durable=true → file; durable=false → memory.
  //    Re-reading the file proves only durable survives.
  // -------------------------------------------------------------------------
  describe('E2E: session vs durable task isolation', () => {
    it('persists durable tasks and keeps session tasks in memory only', async () => {
      const durableId = await addTask(
        '*/5 * * * *',
        'durable prompt',
        true,
        true,
        { dir: tmpDir },
      );
      const sessionId = await addTask(
        '*/5 * * * *',
        'session prompt',
        true,
        false,
      );

      // Session-only store: holds the non-durable task.
      const session = getSessionTasks();
      expect(session).toHaveLength(1);
      expect(session[0]!.id).toBe(sessionId);
      expect(session[0]!.prompt).toBe('session prompt');

      // Disk: only carries the durable task.
      const persisted = await readCronTasks(tmpDir);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.id).toBe(durableId);
      expect(persisted[0]!.prompt).toBe('durable prompt');
      expect(persisted.find(t => t.id === sessionId)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 6. concurrent fire + jitter: 5 tasks share a cron string; all fire on the
  //    first tick (anchored from the past), then re-fire staggered across
  //    several seconds because per-task jitter differs.
  // -------------------------------------------------------------------------
  describe('E2E: concurrent multi-task fire with jitter', () => {
    it('fires all due tasks at once and reschedules them with distinct jitter', async () => {
      const past = new Date('2026-05-20T09:00:00Z').getTime();
      // First 32 bits of each id span [0, 1) → forward delays 0, 1.5s, 3s,
      // 4.5s, ~6s for `* * * * *` under DEFAULT_CRON_JITTER_CONFIG.
      const ids = ['00000000', '40000000', '80000000', 'c0000000', 'ffffffff'];
      await writeCronTasks(
        ids.map(
          (id, i): CronTask => ({
            id,
            cron: '* * * * *',
            prompt: `task-${i}`,
            createdAt: past,
            recurring: true,
          }),
        ),
        tmpDir,
      );

      const onFire = vi.fn();
      const scheduler = createCronScheduler({
        onFire,
        isLoading: () => false,
        dir: tmpDir,
      });

      scheduler.start();
      await waitForSchedulerReady();
      // Tick #1 — every task is anchored to `past`, so all 5 are due.
      await vi.advanceTimersByTimeAsync(1500);
      await flushAsync();

      expect(onFire).toHaveBeenCalledTimes(5);
      const prompts = onFire.mock.calls.map(c => c[0] as string).sort();
      expect(prompts).toEqual([
        'task-0',
        'task-1',
        'task-2',
        'task-3',
        'task-4',
      ]);

      // All tasks rescheduled to (10:01:00 + per-task jitter). Walking the
      // clock to 10:01:00 fires only the zero-jitter task; reaching
      // 10:01:10 fires all of them. If the spread were collapsed (jitter
      // off), both counts would equal 5.
      onFire.mockClear();
      // Walk to t = 30_000 (10:01:00) one second at a time so the per-tick
      // markCronTasksFired writes can settle between ticks.
      await advanceChunked(28_500);
      const firedAtMinuteBoundary = onFire.mock.calls.length;

      // Walk another 10s to t = 10:01:10. By then every task should have
      // refired regardless of jitter (jitter cap for `* * * * *` is ~6s).
      await advanceChunked(10_000);
      const firedAfterFullSpread = onFire.mock.calls.length;

      expect(firedAfterFullSpread).toBe(5);
      // Strict inequality proves jitter actually staggered the fires.
      expect(firedAtMinuteBoundary).toBeLessThan(5);
      expect(firedAtMinuteBoundary).toBeGreaterThanOrEqual(1);

      scheduler.stop();
    });
  });
});
