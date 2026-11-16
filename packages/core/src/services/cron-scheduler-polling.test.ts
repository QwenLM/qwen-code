/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import { CronScheduler } from './cronScheduler.js';
import { getCronFilePath, writeCronTasks } from './cronTasksFile.js';
import { getLockFilePath } from './cronTasksLock.js';

const seams = vi.hoisted(() => ({
  polling: vi.fn(),
  watch: vi.fn(),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../utils/file-watcher-cleanup.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../utils/file-watcher-cleanup.js')
  >()),
  shouldPollFileWatchers: seams.polling,
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  watch: seams.watch,
  watchFile: seams.watchFile,
  unwatchFile: seams.unwatchFile,
}));
vi.mock('./cronTasksFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cronTasksFile.js')>();
  seams.read.mockImplementation(actual.readCronTasks);
  return { ...actual, readCronTasks: seams.read };
});

describe('CronScheduler tasks-file watcher routing', () => {
  let root: string;
  let schedulers: CronScheduler[];
  let native: ReturnType<typeof nativeWatcher>;
  function nativeWatcher() {
    return Object.assign(new EventEmitter(), { close: vi.fn() });
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cron-polling-'));
    vi.stubEnv('QWEN_RUNTIME_DIR', root);
    Storage.setRuntimeBaseDir(root);
    schedulers = [];
    native = nativeWatcher();
    seams.polling.mockReset().mockReturnValue(true);
    seams.watch.mockReset().mockReturnValue(native);
    seams.watchFile.mockReset();
    seams.unwatchFile.mockReset();
    seams.read.mockClear();
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const scheduler of schedulers) scheduler.destroy();
    await vi.waitFor(async () => {
      await expect(fs.access(getLockFilePath(root))).rejects.toThrow();
    });
    Storage.setRuntimeBaseDir(null);
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  function scheduler() {
    const next = new CronScheduler(root);
    schedulers.push(next);
    return next;
  }

  it('registers the exact tasks file once and reloads externally persisted tasks', async () => {
    const current = scheduler();
    await current.enableDurable('first');
    await current.enableDurable('first');
    expect(seams.watch).not.toHaveBeenCalled();
    expect(seams.watchFile).toHaveBeenCalledExactlyOnceWith(
      getCronFilePath(root),
      { interval: 500, persistent: false },
      expect.any(Function),
    );
    expect(
      (await fs.stat(path.dirname(getCronFilePath(root)))).isDirectory(),
    ).toBe(true);
    await writeCronTasks(root, [
      {
        id: 'external',
        cron: '7 18 * * *',
        prompt: 'external task',
        recurring: true,
        createdAt: Date.now(),
        lastFiredAt: null,
      },
    ]);
    const listener = seams.watchFile.mock.calls[0][2];
    listener();
    await vi.waitFor(() =>
      expect(current.list().map((job) => job.id)).toContain('external'),
    );
    vi.useFakeTimers();
    listener();
    current.stop();
    expect(seams.unwatchFile).toHaveBeenCalledExactlyOnceWith(
      getCronFilePath(root),
      listener,
    );
    const reads = seams.read.mock.calls.length;
    listener();
    await vi.advanceTimersByTimeAsync(301);
    expect(seams.read).toHaveBeenCalledTimes(reads);
  });

  it('unsubscribes only the stopped session and permits re-enabling it', async () => {
    const first = scheduler();
    const second = scheduler();
    await first.enableDurable('first');
    await second.enableDurable('second');
    const firstListener = seams.watchFile.mock.calls[0][2];
    const secondListener = seams.watchFile.mock.calls[1][2];
    expect(firstListener).not.toBe(secondListener);
    first.stop();
    expect(seams.unwatchFile).toHaveBeenCalledExactlyOnceWith(
      getCronFilePath(root),
      firstListener,
    );
    await first.enableDurable('first-again');
    expect(seams.watchFile).toHaveBeenCalledTimes(3);
    await writeCronTasks(root, [
      {
        id: 'shared',
        cron: '7 18 * * *',
        prompt: 'shared task',
        recurring: true,
        createdAt: Date.now(),
        lastFiredAt: null,
      },
    ]);
    secondListener();
    seams.watchFile.mock.calls[2][2]();
    await vi.waitFor(() => {
      expect(second.list().map((job) => job.id)).toContain('shared');
      expect(first.list().map((job) => job.id)).toContain('shared');
    });
    second.stop();
    expect(seams.unwatchFile).toHaveBeenLastCalledWith(
      getCronFilePath(root),
      secondListener,
    );
  });

  it('retains the native directory route and filename filter elsewhere', async () => {
    seams.polling.mockReturnValue(false);
    const current = scheduler();
    await current.enableDurable('first');
    expect(seams.watchFile).not.toHaveBeenCalled();
    expect(seams.watch).toHaveBeenCalledExactlyOnceWith(
      path.dirname(getCronFilePath(root)),
      { persistent: false },
      expect.any(Function),
    );
    const listener = seams.watch.mock.calls[0][2];
    const reads = seams.read.mock.calls.length;
    vi.useFakeTimers();
    listener('change', 'unrelated.json');
    await vi.advanceTimersByTimeAsync(301);
    expect(seams.read).toHaveBeenCalledTimes(reads);
    current.stop();
    expect(native.close).toHaveBeenCalledOnce();
    expect(seams.unwatchFile).not.toHaveBeenCalled();
  });
});
