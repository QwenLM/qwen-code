/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('file watcher backend', () => {
  it.each([
    ['darwin', '1.4.4', true],
    ['darwin', undefined, false],
    ['linux', '1.4.4', false],
    ['win32', '1.4.4', false],
    ['linux', undefined, false],
  ])('selects polling for %s / Bun %s: %s', async (platform, bun, expected) => {
    const originalPlatform = process.platform;
    const originalBun = Object.getOwnPropertyDescriptor(
      process.versions,
      'bun',
    );
    try {
      Object.defineProperty(process, 'platform', { value: platform });
      Object.defineProperty(process.versions, 'bun', {
        configurable: true,
        value: bun,
      });
      const { shouldPollFileWatchers } = await import(
        './file-watcher-cleanup.js'
      );
      expect(shouldPollFileWatchers()).toBe(expected);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalBun) {
        Object.defineProperty(process.versions, 'bun', originalBun);
      } else {
        delete process.versions['bun'];
      }
    }
  });
});

describe('file watcher cleanup', () => {
  const platform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  it('closes watchers normally before final process exit', async () => {
    const { closeFileWatcher } = await import('./file-watcher-cleanup.js');
    let finish!: () => void;
    const closed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(() => closed),
    });

    expect(closeFileWatcher(watcher)).toBe(closed);
    expect(watcher.close).toHaveBeenCalledOnce();
    finish();
    await closed;
  });

  it('detaches events without entering a native close during macOS exit', async () => {
    const { closeFileWatcher, prepareFileWatchersForProcessExit } =
      await import('./file-watcher-cleanup.js');
    const onChange = vi.fn();
    const onError = vi.fn();
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(() => {
        throw new Error('Native close must not run during process exit');
      }),
    });
    watcher.on('all', onChange).on('change', onChange).on('error', onError);

    prepareFileWatchersForProcessExit();
    prepareFileWatchersForProcessExit();
    await closeFileWatcher(watcher);
    watcher.emit('all', 'change', 'settings.json');
    watcher.emit('change', 'rename', 'tasks.json');
    const error = new Error('Late watch error');
    watcher.emit('error', error);

    expect(watcher.close).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it.each(['linux', 'win32'])(
    'still closes watchers on %s exit',
    async (os) => {
      Object.defineProperty(process, 'platform', { value: os });
      const { closeFileWatcher, prepareFileWatchersForProcessExit } =
        await import('./file-watcher-cleanup.js');
      const watcher = Object.assign(new EventEmitter(), {
        close: vi.fn(),
      });
      prepareFileWatchersForProcessExit();
      await closeFileWatcher(watcher);
      expect(watcher.close).toHaveBeenCalledOnce();
    },
  );

  it('preserves normal close failures and accepts an uninitialized watcher', async () => {
    const { closeFileWatcher } = await import('./file-watcher-cleanup.js');
    await expect(closeFileWatcher(undefined)).resolves.toBeUndefined();
    const error = new Error('Close failed');
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn<() => void | Promise<void>>(() => {
        throw error;
      }),
    });
    expect(() => closeFileWatcher(watcher)).toThrow(error);
    watcher.close.mockImplementation(() => Promise.reject(error));
    await expect(closeFileWatcher(watcher)).rejects.toBe(error);
  });
});
