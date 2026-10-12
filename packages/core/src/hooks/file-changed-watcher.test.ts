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
