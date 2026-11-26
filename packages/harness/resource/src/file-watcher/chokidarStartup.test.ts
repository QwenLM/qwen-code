/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FSWatcher } from 'chokidar';
import { expect, it, vi } from 'vitest';
import { FileSystemWatcher } from './fileWatcher.js';

it.each(['EIO', 'ENOTDIR', 'close', 'silent'])(
  'bounds startup with an unmodified Chokidar scanner ending in %s',
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'resource-startup-')));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let scanned!: () => void;
    const scanning = new Promise<void>((resolve) => { scanned = resolve; });
    // Fault injection only: production code uses public ready/error/close APIs.
    // Leave Chokidar's event filtering and internal wait unchanged.
    const read = vi
      .spyOn(FSWatcher.prototype, '_readdirp')
      .mockImplementation(function (this: FSWatcher) {
      const stream = new Readable({ objectMode: true, read() {} });
      this._streams.add(stream as never);
      queueMicrotask(() => {
        if (mode !== 'silent') stream.destroy(mode === 'close' ? undefined
          : Object.assign(new Error('injected scanner failure'), { code: mode }));
        scanned();
      });
      return stream as never;
    });
    const onError = vi.fn();
    const watcher = new FileSystemWatcher({ usePolling: true, onError });
    watcher.watch({ path: root, depth: 2 }, vi.fn());
    try {
      const pending = watcher.start().catch((error) => error);
      const finished = vi.fn();
      void pending.then(finished);
      await scanning;
      await new Promise((resolve) => setImmediate(resolve));
      if (mode === 'EIO') {
        expect(await pending).toMatchObject({ code: 'EIO' });
      } else {
        await vi.advanceTimersByTimeAsync(4999);
        expect(finished).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ code: 'ETIMEDOUT', paths: [root] });
      }
      expect(onError).toHaveBeenCalledTimes(1);
      await watcher.stop();
      // Unmodified Chokidar retains its own short readdir throttle timer.
      // It must expire without leaving Resource's 5-second deadline behind.
      await vi.advanceTimersByTimeAsync(1000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await watcher.stop();
      read.mockRestore();
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  },
);
