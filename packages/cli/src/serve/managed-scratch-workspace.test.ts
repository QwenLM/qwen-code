/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createManagedScratchDirectory,
  isManagedScratchChild,
  isScratchRootCompatible,
  prepareManagedScratchRoot,
} from './managed-scratch-workspace.js';

// Lets a test pose as a volume that exposes no inode numbers: lstatSync
// reports ino 0 while enabled, everything else delegates to the real thing.
const inoZeroVolume = vi.hoisted(() => ({ enabled: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const lstatSync = ((filePath: string) => {
    const stats = actual.lstatSync(filePath);
    if (inoZeroVolume.enabled) stats.ino = 0;
    return stats;
  }) as typeof actual.lstatSync;
  return { ...actual, lstatSync, default: { ...actual, lstatSync } };
});

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('managed scratch workspace boundary', () => {
  it('accepts only disjoint workspaces and scratch-* direct children', () => {
    expect(isScratchRootCompatible('/work/project', '/managed')).toBe(true);
    expect(isScratchRootCompatible('/managed/scratch-Ab3', '/managed')).toBe(
      true,
    );
    expect(isScratchRootCompatible('/managed', '/managed')).toBe(false);
    expect(isScratchRootCompatible('/', '/managed')).toBe(false);
    expect(isScratchRootCompatible('/managed/project', '/managed')).toBe(false);
    expect(
      isScratchRootCompatible('/managed/scratch-Ab3/nested', '/managed'),
    ).toBe(false);
  });

  it('creates a private direct child and revalidates the root identity', async () => {
    const parent = await mkdtemp(join(realpathSync.native(tmpdir()), 'qws-'));
    cleanup.push(parent);
    const root = prepareManagedScratchRoot(join(parent, 'root'), [
      join(parent, 'workspace'),
    ]);

    const child = await createManagedScratchDirectory(root);

    expect(isManagedScratchChild(child, root.canonicalRoot)).toBe(true);
    const childStats = await lstat(child);
    expect(childStats.isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(childStats.mode & 0o077).toBe(0);
    }
  });

  it('creates unique children for independent daemon root handles', async () => {
    const parent = await mkdtemp(join(realpathSync.native(tmpdir()), 'qws-'));
    cleanup.push(parent);
    const rootPath = join(parent, 'root');
    const firstDaemonRoot = prepareManagedScratchRoot(rootPath, []);
    const secondDaemonRoot = prepareManagedScratchRoot(rootPath, []);

    const [first, second] = await Promise.all([
      createManagedScratchDirectory(firstDaemonRoot),
      createManagedScratchDirectory(secondDaemonRoot),
    ]);

    expect(first).not.toBe(second);
    expect(isManagedScratchChild(first, firstDaemonRoot.canonicalRoot)).toBe(
      true,
    );
    expect(isManagedScratchChild(second, secondDaemonRoot.canonicalRoot)).toBe(
      true,
    );
  });

  it('rejects symlink and writable roots', async () => {
    if (process.platform === 'win32') return;
    const parent = await mkdtemp(join(realpathSync.native(tmpdir()), 'qws-'));
    cleanup.push(parent);
    const target = join(parent, 'target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(parent, 'link'));
    expect(() => prepareManagedScratchRoot(join(parent, 'link'), [])).toThrow(
      /non-symlink/,
    );

    await chmod(target, 0o722);
    expect(() => prepareManagedScratchRoot(target, [])).toThrow(
      /only to its owner/,
    );
  });

  it('rejects a root that conflicts with a startup workspace', async () => {
    const parent = await mkdtemp(join(realpathSync.native(tmpdir()), 'qws-'));
    cleanup.push(parent);
    const root = join(parent, 'root');
    expect(() => prepareManagedScratchRoot(root, [parent])).toThrow(
      /conflicts/,
    );
  });

  it('rejects a root whose identity cannot be inode-verified', async () => {
    // Volumes that expose no inode numbers (FAT/exFAT, some SMB mounts)
    // cannot identity-pin the root, so a later same-path replacement would
    // be indistinguishable — acceptance itself must fail closed there.
    const parent = await mkdtemp(join(realpathSync.native(tmpdir()), 'qws-'));
    cleanup.push(parent);
    const rootPath = join(parent, 'root');
    await mkdir(rootPath, { mode: 0o700 });
    inoZeroVolume.enabled = true;
    try {
      expect(() => prepareManagedScratchRoot(rootPath, [])).toThrow(
        /cannot be verified/,
      );
    } finally {
      inoZeroVolume.enabled = false;
    }
  });

  it('fails closed if the accepted root is replaced', async () => {
    const parent = await mkdtemp(join(realpathSync.native(tmpdir()), 'qws-'));
    cleanup.push(parent);
    const rootPath = join(parent, 'root');
    await mkdir(rootPath, { mode: 0o700 });
    if (Number(lstatSync(rootPath).ino) === 0) {
      // On a volume that exposes no inode numbers the root cannot be
      // identity-pinned, so acceptance fails closed before any swap can be
      // staged — assert that rejection instead.
      expect(() => prepareManagedScratchRoot(rootPath, [])).toThrow(
        /cannot be verified/,
      );
    } else {
      const root = prepareManagedScratchRoot(rootPath, []);
      await rename(rootPath, join(parent, 'old-root'));
      await mkdir(rootPath, { mode: 0o700 });
      await expect(createManagedScratchDirectory(root)).rejects.toThrow(
        /identity changed/,
      );
    }
  });
});
