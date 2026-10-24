/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FileChangedWatcher } from './file-changed-watcher.js';

const waitOptions = { timeout: 5000, interval: 25 };

describe('FileChangedWatcher with real files', () => {
  let root: string;
  let watcher: FileChangedWatcher;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-changed-watcher-'));
  });

  afterEach(async () => {
    await watcher?.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not replay the initial scan and reports future nested add, change and unlink', async () => {
    await fs.writeFile(path.join(root, 'existing.md'), 'initial');
    // Let pending native write events settle before testing scan suppression.
    await delay(500);
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([root]);

    const nested = path.join(root, 'future', 'nested');
    const file = path.join(nested, 'topic.md');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(file, 'created');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith(file, 'add', expect.any(AbortSignal));
    }, waitOptions);
    await fs.writeFile(file, 'updated');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        file,
        'change',
        expect.any(AbortSignal),
      );
    }, waitOptions);
    await fs.unlink(file);
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        file,
        'unlink',
        expect.any(AbortSignal),
      );
    }, waitOptions);
    expect(notify.mock.calls.map(([filePath]) => filePath)).toEqual([
      file,
      file,
      file,
    ]);
  });

  it('replaces watched paths, retains a supplied static file and clears all paths', async () => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const staticFile = path.join(root, 'static.txt');
    await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
    await fs.writeFile(staticFile, 'initial');
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([first, staticFile]);
    await watcher.setPaths([second, staticFile]);
    await watcher.setPaths([staticFile, second, second]);

    await fs.writeFile(path.join(first, 'ignored.md'), 'ignored');
    await fs.writeFile(staticFile, 'updated');
    await fs.writeFile(path.join(second, 'included.md'), 'included');
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        staticFile,
        'change',
        expect.any(AbortSignal),
      );
      expect(notify).toHaveBeenCalledWith(
        path.join(second, 'included.md'),
        'add',
        expect.any(AbortSignal),
      );
    }, waitOptions);
    await delay(300);
    expect(notify.mock.calls).toHaveLength(2);

    await watcher.setPaths([]);
    notify.mockClear();
    await fs.writeFile(staticFile, 'after clearing');
    await fs.writeFile(path.join(second, 'after-clear.md'), 'after clearing');
    await delay(400);
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores implicit VCS and dependency subtrees while observing ordinary nested files', async () => {
    const excluded = [
      path.join(root, '.git', 'objects', 'pack'),
      path.join(root, 'node_modules', 'package', 'index.js'),
    ];
    for (const file of excluded) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'initial');
    }
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([root]);
    for (const file of excluded) await fs.writeFile(file, 'updated');
    const nested = path.join(root, 'memory', 'deep', 'topic.md');
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, 'included');
    await vi.waitFor(
      () =>
        expect(notify).toHaveBeenCalledWith(
          nested,
          'add',
          expect.any(AbortSignal),
        ),
      waitOptions,
    );
    await delay(400);
    expect(notify.mock.calls.map(([file]) => file)).toEqual([nested]);
  });

  it('ignores atomic-write temporary siblings, including delayed renames and orphans', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([root]);
    const target = path.join(root, 'topic.md');
    const temporary = `${target}.a1b2c3d4e5f6.tmp`;
    const orphan = path.join(root, 'orphan.md.0123456789ab.tmp');
    const ordinary = path.join(root, 'ordinary.tmp');
    const differentSuffix = path.join(root, 'topic.md.0123456789abc.tmp');
    for (const file of [temporary, orphan, ordinary, differentSuffix]) {
      await fs.writeFile(file, 'created');
    }
    await vi.waitFor(() => {
      for (const file of [ordinary, differentSuffix]) {
        expect(notify).toHaveBeenCalledWith(
          file,
          'add',
          expect.any(AbortSignal),
        );
      }
    }, waitOptions);
    await delay(700);
    expect(notify.mock.calls.map(([file]) => file).sort()).toEqual(
      [ordinary, differentSuffix].sort(),
    );

    await fs.rename(temporary, target);
    await fs.unlink(orphan);
    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith(
        target,
        'add',
        expect.any(AbortSignal),
      );
    }, waitOptions);
    await delay(300);
    expect(notify.mock.calls.map(([file]) => file).sort()).toEqual(
      [ordinary, differentSuffix, target].sort(),
    );
  });

  it.each(['static', 'dynamic'])(
    'preserves %s temporary-file registrations and similarly named directories',
    async (registration) => {
      const explicit = path.join(root, 'selected.md.a1b2c3d4e5f6.tmp');
      const nested = path.join(root, 'directory.a1b2c3d4e5f6.tmp', 'topic.md');
      const notify = vi.fn().mockResolvedValue(undefined);
      watcher = new FileChangedWatcher(notify);
      await watcher.setPaths(
        [root, explicit],
        registration === 'static' ? [explicit] : [],
      );
      await fs.mkdir(path.dirname(nested));
      for (const file of [explicit, nested])
        await fs.writeFile(file, 'created');
      await vi.waitFor(() => {
        for (const file of [explicit, nested]) {
          expect(notify).toHaveBeenCalledWith(
            file,
            'add',
            expect.any(AbortSignal),
          );
        }
      }, waitOptions);
      expect(notify.mock.calls).toHaveLength(2);
    },
  );

  it('watches both missing static files without traversing siblings and retains dynamic recursion', async () => {
    const parent = path.join(root, 'static');
    const dynamic = path.join(root, 'dynamic');
    await Promise.all([fs.mkdir(parent), fs.mkdir(dynamic)]);
    const files = ['.env', '.envrc'].map((name) => path.join(parent, name));
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([...files, dynamic], files);
    await fs.writeFile(files[1], 'rc');
    await fs.writeFile(files[0], 'env');
    await fs.mkdir(path.join(parent, 'unrelated'));
    await fs.writeFile(path.join(parent, 'unrelated', 'deep.md'), 'ignored');
    await fs.writeFile(path.join(parent, 'other.md'), 'ignored');
    await fs.mkdir(path.join(dynamic, 'nested'));
    const nested = path.join(dynamic, 'nested', 'topic.md');
    await fs.writeFile(nested, 'included');
    await vi.waitFor(() => {
      for (const file of [...files, nested]) {
        expect(notify).toHaveBeenCalledWith(
          file,
          'add',
          expect.any(AbortSignal),
        );
      }
    }, waitOptions);
    await delay(300);
    expect(notify.mock.calls.map(([file]) => file).sort()).toEqual(
      [...files, nested].sort(),
    );
  });

  it('reconfigures when a static-only path becomes a recursive dynamic root', async () => {
    const directory = path.join(root, 'role');
    await fs.mkdir(directory);
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([directory], [directory]);
    await fs.writeFile(path.join(directory, 'ignored.md'), 'ignored');
    await delay(400);
    expect(notify).not.toHaveBeenCalled();
    await watcher.setPaths([directory]);
    const file = path.join(directory, 'included.md');
    await fs.writeFile(file, 'included');
    await vi.waitFor(
      () =>
        expect(notify).toHaveBeenCalledWith(
          file,
          'add',
          expect.any(AbortSignal),
        ),
      waitOptions,
    );
  });

  it('discovers missing dynamic siblings and future nested files without observing unrelated paths', async () => {
    const files = ['.env', '.envrc'].map((name) => path.join(root, name));
    const directory = path.join(root, 'future');
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([...files, directory]);
    await fs.writeFile(files[1], 'rc');
    await fs.writeFile(files[0], 'env');
    await fs.mkdir(path.join(directory, 'nested'), { recursive: true });
    const nested = path.join(directory, 'nested', 'topic.md');
    await fs.writeFile(nested, 'included');
    await fs.mkdir(path.join(root, 'unrelated'));
    await fs.writeFile(path.join(root, 'unrelated', 'deep.md'), 'ignored');
    await fs.writeFile(path.join(root, 'other.md'), 'ignored');
    await vi.waitFor(() => {
      for (const file of [...files, nested]) {
        expect(notify).toHaveBeenCalledWith(
          file,
          'add',
          expect.any(AbortSignal),
        );
      }
    }, waitOptions);
    await delay(300);
    expect(notify.mock.calls.map(([file]) => file).sort()).toEqual(
      [...files, nested].sort(),
    );
  });

  it('discovers a dynamic root with multiple missing ancestors', async () => {
    const directory = path.join(root, 'first', 'second', 'third', 'memory');
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([directory]);
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'topic.md');
    await fs.writeFile(file, 'new memory');
    await vi.waitFor(
      () =>
        expect(notify).toHaveBeenCalledWith(
          file,
          'add',
          expect.any(AbortSignal),
        ),
      waitOptions,
    );
  });

  it('retries a path whose discovery parent was not a directory', async () => {
    const parent = path.join(root, 'blocked');
    await fs.writeFile(parent, 'not a directory');
    const directory = path.join(parent, 'memory');
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([directory]);
    await fs.unlink(parent);
    await fs.mkdir(directory, { recursive: true });
    await watcher.setPaths([directory]);
    const file = path.join(directory, 'topic.md');
    await fs.writeFile(file, 'retry');
    await vi.waitFor(
      () =>
        expect(notify).toHaveBeenCalledWith(
          file,
          'add',
          expect.any(AbortSignal),
        ),
      waitOptions,
    );
  });

  it('continues observing a root deleted and recreated after a gap', async () => {
    const directory = path.join(root, 'memory');
    await fs.mkdir(directory);
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([directory]);
    const before = path.join(directory, 'before.md');
    await fs.writeFile(before, 'before');
    await vi.waitFor(
      () =>
        expect(notify).toHaveBeenCalledWith(
          before,
          'add',
          expect.any(AbortSignal),
        ),
      waitOptions,
    );
    await fs.rm(directory, { recursive: true });
    await delay(200);
    await fs.mkdir(directory);
    const after = path.join(directory, 'after.md');
    await fs.writeFile(after, 'after');
    await vi.waitFor(
      () =>
        expect(notify).toHaveBeenCalledWith(
          after,
          'add',
          expect.any(AbortSignal),
        ),
      waitOptions,
    );
  });

  it('continues delivering after a callback failure', async () => {
    const notify = vi
      .fn()
      .mockRejectedValueOnce(new Error('hook failed'))
      .mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([root]);
    const first = path.join(root, 'first.md');
    const second = path.join(root, 'second.md');
    await fs.writeFile(first, 'first');
    await vi.waitFor(
      () => expect(notify).toHaveBeenCalledTimes(1),
      waitOptions,
    );
    await fs.writeFile(second, 'second');
    await vi.waitFor(
      () => expect(notify).toHaveBeenCalledTimes(2),
      waitOptions,
    );
    expect(notify.mock.calls.map(([filePath]) => filePath)).toEqual([
      first,
      second,
    ]);
  });

  it('serializes callbacks and aborts the running one while dropping queued events on close', async () => {
    let signal: AbortSignal | undefined;
    const notify = vi.fn(
      async (_file: string, _event: string, currentSignal: AbortSignal) => {
        signal = currentSignal;
        await new Promise<void>((resolve) =>
          currentSignal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      },
    );
    watcher = new FileChangedWatcher(notify);
    await watcher.setPaths([root]);
    await fs.writeFile(path.join(root, 'first.md'), 'first');
    await vi.waitFor(
      () => expect(notify).toHaveBeenCalledTimes(1),
      waitOptions,
    );
    await fs.writeFile(path.join(root, 'second.md'), 'second');
    await delay(500);
    expect(notify).toHaveBeenCalledTimes(1);
    await watcher.close();
    expect(signal?.aborted).toBe(true);
    await fs.writeFile(path.join(root, 'third.md'), 'third');
    await watcher.setPaths([root]);
    await delay(400);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('discards queued events from removed roots while allowing the running callback to finish', async () => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
    let finishFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const notify = vi
      .fn()
      .mockImplementationOnce(() => firstFinished)
      .mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    try {
      await watcher.setPaths([first]);
      await fs.writeFile(path.join(first, 'running.md'), 'first');
      await vi.waitFor(
        () => expect(notify).toHaveBeenCalledTimes(1),
        waitOptions,
      );
      await fs.writeFile(path.join(first, 'queued.md'), 'queued');
      await delay(500);
      await watcher.setPaths([second]);
      finishFirst();
      const replacement = path.join(second, 'replacement.md');
      await fs.writeFile(replacement, 'new root');
      await vi.waitFor(
        () => expect(notify).toHaveBeenCalledTimes(2),
        waitOptions,
      );
      expect(notify.mock.calls.map(([filePath]) => filePath)).toEqual([
        path.join(first, 'running.md'),
        replacement,
      ]);
    } finally {
      finishFirst();
    }
  });

  it('can close during initial registration without hanging or restarting', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    watcher = new FileChangedWatcher(notify);
    const registration = watcher.setPaths([root]);
    await Promise.all([registration, watcher.close()]);
    await watcher.setPaths([root]);
    await fs.writeFile(path.join(root, 'after-close.md'), 'after close');
    await delay(400);
    expect(notify).not.toHaveBeenCalled();
  });
});
