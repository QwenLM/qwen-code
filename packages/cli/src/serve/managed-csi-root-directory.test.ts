/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ManagedCsiRootDirectory } from './managed-csi-root-directory.js';

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function fixture() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-csi-fd-'));
  const parent = await fs.realpath(temporary);
  const root = path.join(parent, 'root');
  await fs.mkdir(root);
  const stats = await fs.lstat(root, { bigint: true });
  const directories: ManagedCsiRootDirectory[] = [];
  onTestFinished(async () => {
    await Promise.all(directories.map((directory) => directory.close()));
    await fs.rm(parent, { recursive: true, force: true });
  });
  return {
    parent,
    root,
    stats,
    async open() {
      const directory = await ManagedCsiRootDirectory.open(
        root,
        stats.dev.toString(),
      );
      directories.push(directory);
      return directory;
    },
  };
}

describe.runIf(process.platform !== 'win32')('CSI root directory fd', () => {
  it('retains one real descriptor and closes it once after repeated verification', async () => {
    const owned = await fixture();
    const nativeOpen = fs.open;
    let handle: FileHandle | undefined;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      handle = await nativeOpen(...args);
      return handle;
    });
    const directory = await owned.open();
    expect(open).toHaveBeenCalledExactlyOnceWith(
      owned.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    expect(directory.rootDevice).toBe(owned.stats.dev.toString());
    expect(directory.rootInode).toBe(owned.stats.ino.toString());
    expect(directory.isAvailable).toBe(true);
    await directory.withVerifiedDirectory(async (borrowed) => {
      expect(borrowed).toBe(handle);
      expect((await borrowed.stat({ bigint: true })).ino).toBe(owned.stats.ino);
    });
    await directory.verify();
    await directory.verify();
    expect(open).toHaveBeenCalledTimes(1);
    const close = vi.spyOn(handle!, 'close');
    await Promise.all([directory.close(), directory.close()]);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(handle!.stat()).rejects.toMatchObject({ code: 'EBADF' });
    await expect(directory.verify()).rejects.toThrow('unavailable');
    expect(directory.isAvailable).toBe(false);
  });

  it('refuses another device before opening a descriptor', async () => {
    const owned = await fixture();
    const open = vi.spyOn(fs, 'open');
    await expect(
      ManagedCsiRootDirectory.open(
        owned.root,
        (owned.stats.dev + 1n).toString(),
      ),
    ).rejects.toThrow('unavailable');
    expect(open).not.toHaveBeenCalled();
  });

  it('does not adopt a replacement after the original root is renamed', async () => {
    const owned = await fixture();
    const directory = await owned.open();
    const original = path.join(owned.parent, 'original');
    await fs.rename(owned.root, original);
    await fs.mkdir(owned.root);
    await expect(directory.verify()).rejects.toThrow('unavailable');
    await fs.rmdir(owned.root);
    await fs.rename(original, owned.root);
    await expect(directory.verify()).rejects.toThrow('unavailable');
  });

  it('refuses a root symlink and a symlinked ancestor', async () => {
    const owned = await fixture();
    const alias = path.join(owned.parent, 'alias');
    await fs.symlink(owned.root, alias);
    await expect(
      ManagedCsiRootDirectory.open(alias, owned.stats.dev.toString()),
    ).rejects.toThrow('unavailable');
    const ancestor = path.join(owned.parent, 'ancestor');
    await fs.symlink(owned.parent, ancestor);
    await expect(
      ManagedCsiRootDirectory.open(
        path.join(ancestor, 'root'),
        owned.stats.dev.toString(),
      ),
    ).rejects.toThrow('unavailable');
  });

  it('fences and closes when a directory becomes a symlink or disappears', async () => {
    for (const replacement of ['symlink', 'missing']) {
      const owned = await fixture();
      const directory = await owned.open();
      const original = path.join(owned.parent, 'original');
      await fs.rename(owned.root, original);
      if (replacement === 'symlink') await fs.symlink(original, owned.root);
      await expect(directory.verify()).rejects.toThrow();
      if (replacement === 'symlink') await fs.unlink(owned.root);
      await fs.rename(original, owned.root);
      await expect(directory.verify()).rejects.toThrow('unavailable');
    }
  });

  it('refuses ordinary files before opening them', async () => {
    const owned = await fixture();
    const file = path.join(owned.parent, 'file');
    await fs.writeFile(file, 'ordinary file');
    const open = vi.spyOn(fs, 'open');
    await expect(
      ManagedCsiRootDirectory.open(file, owned.stats.dev.toString()),
    ).rejects.toThrow('unavailable');
    expect(open).not.toHaveBeenCalled();
  });

  it('closes the original fd when the named root changes during opening', async () => {
    const owned = await fixture();
    const nativeOpen = fs.open;
    let handle: FileHandle | undefined;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      handle = await nativeOpen(...args);
      await fs.rename(owned.root, path.join(owned.parent, 'original'));
      await fs.mkdir(owned.root);
      return handle;
    });
    await expect(owned.open()).rejects.toThrow('unavailable');
    expect(open).toHaveBeenCalledTimes(1);
    await expect(handle!.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('closes an acquired fd when fstat fails before the pin is published', async () => {
    const owned = await fixture();
    const nativeOpen = fs.open;
    let handle: FileHandle | undefined;
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      handle = await nativeOpen(...args);
      close = vi.spyOn(handle, 'close');
      vi.spyOn(handle, 'stat').mockRejectedValue(new Error('fstat failed'));
      return handle;
    });
    await expect(owned.open()).rejects.toThrow('fstat failed');
    expect(close).toHaveBeenCalledTimes(1);
    vi.mocked(handle!.stat).mockRestore();
    await expect(handle!.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('does not recover after a transient named-root inspection failure', async () => {
    const owned = await fixture();
    const directory = await owned.open();
    const lstat = vi
      .spyOn(fs, 'lstat')
      .mockRejectedValue(new Error('inspection failed'));
    await expect(directory.verify()).rejects.toThrow('inspection failed');
    lstat.mockRestore();
    await expect(directory.verify()).rejects.toThrow('unavailable');
  });

  it('joins verification already waiting on named metadata before closing the real fd', async () => {
    const owned = await fixture();
    const nativeOpen = fs.open;
    let handle!: FileHandle;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      handle = await nativeOpen(...args);
      return handle;
    });
    const directory = await owned.open();
    const entered = deferred();
    const release = deferred();
    const nativeLstat = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementationOnce(async (...args) => {
      const stats = await nativeLstat(...args);
      entered.resolve();
      await release.promise;
      return stats;
    });
    const verifying = directory.verify().catch((error: unknown) => error);
    try {
      await entered.promise;
      let closed = false;
      const closing = directory.close().then(() => {
        closed = true;
      });
      await new Promise(setImmediate);
      expect(closed).toBe(false);
      expect((await handle.stat()).isDirectory()).toBe(true);
      await expect(directory.verify()).rejects.toThrow('unavailable');
      release.resolve();
      await expect(verifying).resolves.toMatchObject({
        message: expect.stringContaining('unavailable'),
      });
      await closing;
      await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    } finally {
      release.resolve();
      await verifying;
    }
  });

  it('joins every full callback and immediately fences new callbacks on close', async () => {
    const owned = await fixture();
    const nativeOpen = fs.open;
    let handle!: FileHandle;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      handle = await nativeOpen(...args);
      return handle;
    });
    const directory = await owned.open();
    const close = vi.spyOn(handle, 'close');
    const gates = [deferred(), deferred()];
    const entered = gates.map(() => deferred());
    const operations = gates.map((gate, index) =>
      expect(
        directory.withVerifiedDirectory(async () => {
          entered[index].resolve();
          await gate.promise;
        }),
      ).rejects.toThrow('unavailable'),
    );
    try {
      await Promise.all(entered.map((gate) => gate.promise));
      const closing = directory.close();
      expect(directory.close()).toBe(closing);
      const late = vi.fn(async () => {});
      await expect(directory.withVerifiedDirectory(late)).rejects.toThrow(
        'unavailable',
      );
      expect(late).not.toHaveBeenCalled();
      gates[0].resolve();
      await operations[0];
      expect(close).not.toHaveBeenCalled();
      expect((await handle.stat()).isDirectory()).toBe(true);
      gates[1].resolve();
      await operations[1];
      await closing;
      expect(close).toHaveBeenCalledTimes(1);
      await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    } finally {
      gates.forEach((gate) => gate.resolve());
      await Promise.all(operations);
    }
  });

  it('fences a replacement without self-waiting or closing an admitted callback early', async () => {
    const owned = await fixture();
    const nativeOpen = fs.open;
    let handle!: FileHandle;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      handle = await nativeOpen(...args);
      return handle;
    });
    const directory = await owned.open();
    const entered = deferred();
    const release = deferred();
    const operation = directory
      .withVerifiedDirectory(async () => {
        entered.resolve();
        await release.promise;
      })
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      const original = path.join(owned.parent, 'original');
      await fs.rename(owned.root, original);
      await fs.mkdir(owned.root);
      await expect(directory.verify()).rejects.toThrow('unavailable');
      expect((await handle.stat()).isDirectory()).toBe(true);
      await fs.rmdir(owned.root);
      await fs.rename(original, owned.root);
      await expect(directory.verify()).rejects.toThrow('unavailable');
      release.resolve();
      await expect(operation).resolves.toMatchObject({
        message: expect.stringContaining('unavailable'),
      });
      await directory.close();
      await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    } finally {
      release.resolve();
      await operation;
    }
  });

  it('checks identity after a failing callback and retains a usable original owner', async () => {
    const owned = await fixture();
    const directory = await owned.open();
    await expect(
      directory.withVerifiedDirectory(async () => {
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('callback failed');
    await expect(directory.verify()).resolves.toBeUndefined();
    await expect(
      directory.withVerifiedDirectory(async () => 'original'),
    ).resolves.toBe('original');
    await expect(
      directory.withVerifiedDirectory(async () => {
        await fs.rename(owned.root, path.join(owned.parent, 'original'));
        await fs.mkdir(owned.root);
        throw new Error('callback failed');
      }),
    ).rejects.toThrow('unavailable');
    await expect(directory.verify()).rejects.toThrow('unavailable');
  });

  it('joins a callback-issued close after the callback returns', async () => {
    const owned = await fixture();
    const directory = await owned.open();
    let closing!: Promise<void>;
    await expect(
      directory.withVerifiedDirectory(async () => {
        closing = directory.close();
      }),
    ).rejects.toThrow('unavailable');
    await closing;
    expect(directory.close()).toBe(closing);
  });

  it.runIf(process.platform === 'linux')(
    'lends a real Linux procfd root without reopening its pathname',
    async () => {
      const owned = await fixture();
      await fs.mkdir(path.join(owned.root, 'child'));
      await fs.writeFile(path.join(owned.root, 'child', 'marker'), 'original');
      const directory = await owned.open();
      await directory.withVerifiedDirectory(async (root) => {
        const child = await fs.open(
          `/proc/self/fd/${root.fd}/child`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await fs.rename(
            path.join(owned.root, 'child'),
            path.join(owned.root, 'old-child'),
          );
          await fs.mkdir(path.join(owned.root, 'child'));
          await fs.writeFile(
            path.join(owned.root, 'child', 'marker'),
            'replacement',
          );
          const marker = await fs.open(
            `/proc/self/fd/${child.fd}/marker`,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            expect(await marker.readFile('utf8')).toBe('original');
          } finally {
            await marker.close();
          }
        } finally {
          await child.close();
        }
      });
    },
  );
});
