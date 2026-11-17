/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileChangedWatcher } from './file-changed-watcher.js';

const { watch } = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock('chokidar', () => ({ watch }));

function nativeWatcher() {
  return Object.assign(new EventEmitter(), {
    close: vi.fn().mockResolvedValue(undefined),
  });
}

describe('FileChangedWatcher lifecycle', () => {
  let watcher: FileChangedWatcher;
  let nativeWatchers: Array<ReturnType<typeof nativeWatcher>>;
  const root = path.resolve('retained');

  beforeEach(() => {
    nativeWatchers = [];
    watch.mockReset().mockImplementation(() => {
      const next = nativeWatcher();
      nativeWatchers.push(next);
      return next;
    });
  });

  afterEach(async () => {
    await watcher?.close();
  });

  it('bounds dynamic traversal while preserving explicit paths and discovery ancestors', async () => {
    watcher = new FileChangedWatcher(vi.fn().mockResolvedValue(undefined));
    const explicitRoot = path.join(root, 'node_modules', 'selected');
    const explicitFile = path.join(root, '.git', 'HEAD');
    const registration = watcher.setPaths(
      [root, explicitRoot, explicitFile],
      [explicitFile],
    );
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    const ignored = watch.mock.calls[0][1].ignored;
    const file = { isFile: () => true, isDirectory: () => false };
    const directory = { isFile: () => false, isDirectory: () => true };
    for (const candidate of [
      path.join(root, '.git', 'objects', 'pack'),
      path.join(root, 'node_modules', 'other', 'index.js'),
      path.join(root, 'deep', 'node_modules', 'package'),
      path.join(root, 'deep', '.git'),
      `${root}-other`,
    ]) {
      expect(ignored(candidate)).toBe(true);
      expect(ignored(candidate, directory)).toBe(true);
    }
    for (const candidate of [
      root,
      path.dirname(root),
      path.join(root, 'first', 'second', 'third', 'topic.md'),
      path.join(root, '.github', 'workflows', 'ci.yml'),
      path.join(root, 'node_modules-old', 'topic.md'),
      path.dirname(explicitFile),
      explicitFile,
      path.dirname(explicitRoot),
      explicitRoot,
      path.join(explicitRoot, 'lib', 'index.js'),
    ]) {
      expect(ignored(candidate)).toBe(false);
      expect(ignored(candidate, file)).toBe(false);
    }
    expect(ignored(explicitFile, directory)).toBe(true);
    expect(
      ignored(path.join(root, 'socket'), {
        isFile: () => false,
        isDirectory: () => false,
      }),
    ).toBe(true);
    nativeWatchers[0].emit('ready');
    await registration;
  });

  it.each(['before ready', 'after ready'])(
    'retries unchanged paths after an error %s',
    async (timing) => {
      watcher = new FileChangedWatcher(vi.fn().mockResolvedValue(undefined));
      const registration = watcher.setPaths([root]);
      await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
      if (timing === 'after ready') {
        nativeWatchers[0].emit('ready');
        await registration;
      }
      nativeWatchers[0].emit('error', new Error('watch limit exceeded'));
      await registration;

      const retry = watcher.setPaths([root]);
      await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(2));
      nativeWatchers[1].emit('ready');
      await retry;
      expect(nativeWatchers[0].close).toHaveBeenCalledOnce();

      nativeWatchers[0].emit('error', new Error('late error from old watcher'));
      await watcher.setPaths([root]);
      expect(watch).toHaveBeenCalledTimes(2);
    },
  );

  it('closes a failed watcher when clearing its paths', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    const registration = watcher.setPaths([root]);
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    nativeWatchers[0].emit('error', new Error('watch limit exceeded'));
    await registration;

    await watcher.setPaths([]);
    expect(nativeWatchers[0].close).toHaveBeenCalledOnce();
    nativeWatchers[0].emit('all', 'change', path.join(root, 'late.md'));
    expect(notify).not.toHaveBeenCalled();
  });

  it('settles registration when closing before the native ready event', async () => {
    watcher = new FileChangedWatcher(vi.fn().mockResolvedValue(undefined));
    const registration = watcher.setPaths([root]);
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    await Promise.all([registration, watcher.close()]);
    await watcher.setPaths([root]);
    expect(nativeWatchers[0].close).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledOnce();
  });

  it('preserves queued events in retained roots when a callback reconfigures paths', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const removed = path.resolve('removed');
    const added = path.resolve('added');
    const notify = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        await watcher.setPaths([root, added]);
      })
      .mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    try {
      const registration = watcher.setPaths([root, removed]);
      await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
      nativeWatchers[0].emit('ready');
      await registration;

      const running = path.join(root, 'running.md');
      const queued = path.join(root, 'queued.md');
      nativeWatchers[0].emit('all', 'change', running);
      nativeWatchers[0].emit('all', 'change', queued);
      nativeWatchers[0].emit('all', 'change', path.join(removed, 'dropped.md'));
      nativeWatchers[0].emit('all', 'change', `${root}-other/dropped.md`);
      expect(notify).toHaveBeenCalledTimes(1);
      release();

      await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(2));
      nativeWatchers[1].emit('ready');
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
      expect(notify.mock.calls.map(([filePath]) => filePath)).toEqual([
        running,
        queued,
      ]);
    } finally {
      release();
    }
  });
});
