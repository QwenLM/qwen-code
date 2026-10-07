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
    await directory.verify();
    await directory.verify();
    expect(open).toHaveBeenCalledTimes(1);
    const close = vi.spyOn(handle!, 'close');
    await Promise.all([directory.close(), directory.close()]);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(handle!.stat()).rejects.toMatchObject({ code: 'EBADF' });
    await expect(directory.verify()).rejects.toThrow('unavailable');
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
});
