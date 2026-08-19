/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationDirectoryIdentityError,
  createConversationRootIdentity,
  getConversationDirectoryName,
  inspectConversationDirectoryIdentity,
  materializeConversationDirectoryIdentity,
  revalidateConversationRootIdentity,
} from './conversation-directory-identity.js';

// fs-interception seam: lets a test commit a rename exactly between two fs
// calls inside the module under test.
vi.mock('node:fs/promises', { spy: true });

const realFsPromises =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempRoot() {
  const base = await mkdtemp(
    join(realpathSync.native(tmpdir()), 'qwen-conversation-identity-'),
  );
  cleanup.push(base);
  const configuredRoot = join(base, 'Conversations');
  return {
    base,
    root: await createConversationRootIdentity(configuredRoot),
  };
}

describe('conversation directory identity', () => {
  it('derives a deterministic case-sensitive child name', () => {
    expect(getConversationDirectoryName('session-a')).toMatch(
      /^conversation-[a-f0-9]{64}$/,
    );
    expect(getConversationDirectoryName('session-a')).toBe(
      getConversationDirectoryName('session-a'),
    );
    expect(getConversationDirectoryName('SESSION-A')).not.toBe(
      getConversationDirectoryName('session-a'),
    );
    expect(() => getConversationDirectoryName('')).toThrowError(
      ConversationDirectoryIdentityError,
    );
  });

  it('pins root and direct-child device and inode identity', async () => {
    const { root } = await tempRoot();
    const result = await materializeConversationDirectoryIdentity(
      root,
      'session-a',
    );
    const stats = await lstat(result.identity.canonicalPath);

    expect(result.created).toBe(true);
    expect(result.identity).toMatchObject({
      root,
      storageSessionId: 'session-a',
      name: getConversationDirectoryName('session-a'),
      device: stats.dev,
      inode: stats.ino,
    });
    await expect(
      inspectConversationDirectoryIdentity(root, 'session-a', result.identity),
    ).resolves.toEqual(result.identity);
  });

  it('reports a missing child without guessing an identity', async () => {
    const { root } = await tempRoot();

    await expect(
      inspectConversationDirectoryIdentity(root, 'missing'),
    ).resolves.toBeUndefined();
  });

  it('rejects same-path replacement against an expected identity', async () => {
    const { root } = await tempRoot();
    const original = await materializeConversationDirectoryIdentity(
      root,
      'replace',
    );
    // Keep the original inode alive under a sibling name so the replacement
    // cannot reuse it (ext4/overlayfs recycle freed inodes immediately).
    const preserved = `${original.identity.canonicalPath}.preserved`;
    await rename(original.identity.canonicalPath, preserved);
    await mkdir(original.identity.canonicalPath, { mode: 0o700 });

    await expect(
      inspectConversationDirectoryIdentity(root, 'replace', original.identity),
    ).rejects.toMatchObject({
      scope: 'child',
      reason: 'unexpected_identity',
    });
  });

  it('does not follow a replacement symlink', async () => {
    const { base, root } = await tempRoot();
    const original = await materializeConversationDirectoryIdentity(
      root,
      'replace',
    );
    const outside = join(base, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await rm(original.identity.canonicalPath, { recursive: true });
    await symlink(outside, original.identity.canonicalPath);

    await expect(
      inspectConversationDirectoryIdentity(root, 'replace'),
    ).rejects.toMatchObject({ scope: 'child', reason: 'not_directory' });
  });

  it('rejects permissive existing children without changing their mode', async () => {
    if (process.platform === 'win32') return;
    const { root } = await tempRoot();
    const original = await materializeConversationDirectoryIdentity(
      root,
      'permissive',
    );
    await chmod(original.identity.canonicalPath, 0o755);

    await expect(
      inspectConversationDirectoryIdentity(root, 'permissive'),
    ).rejects.toMatchObject({ scope: 'child', reason: 'wrong_mode' });
    expect((await lstat(original.identity.canonicalPath)).mode & 0o777).toBe(
      0o755,
    );
  });

  it('rejects a replaced root identity', async () => {
    const { root } = await tempRoot();
    await rename(root.configuredRoot, `${root.configuredRoot}-old`);
    await mkdir(root.configuredRoot, { mode: 0o700 });

    await expect(
      revalidateConversationRootIdentity(root),
    ).rejects.toMatchObject({ scope: 'root', reason: 'identity_changed' });
  });

  it('rejects a root swap committed during child inspection', async () => {
    const { root } = await tempRoot();
    const created = await materializeConversationDirectoryIdentity(
      root,
      'swapme',
    );

    // Fire after the child's post-realpath stat, before the trailing root
    // revalidation: rename the validated root aside and recreate it empty.
    const realLstat = realFsPromises.lstat;
    let hits = 0;
    vi.mocked(lstat).mockImplementation((async (path: string) => {
      const stats = (await realLstat(path)) as Stats;
      if (path.endsWith(created.identity.name) && ++hits === 2) {
        await rename(root.configuredRoot, `${root.configuredRoot}-old`);
        await mkdir(root.configuredRoot, { mode: 0o700 });
      }
      return stats;
    }) as unknown as typeof lstat);
    try {
      await expect(
        inspectConversationDirectoryIdentity(root, 'swapme'),
      ).rejects.toMatchObject({ scope: 'root', reason: 'identity_changed' });
    } finally {
      vi.mocked(lstat).mockRestore();
    }
  });

  it('refuses to prove identity on a filesystem that reports no inode', async () => {
    // FAT/exFAT and some SMB mounts report ino 0 for every entry, which would
    // make every directory compare equal and let a swap pass the anti-swap
    // checks unnoticed. An unverifiable inode must read as a changed identity.
    // The pinned root carries inode 0 too, so a plain `===` comparison would
    // match and this only fails on the verifiability guard itself.
    const { root } = await tempRoot();
    const inodelessRoot = { ...root, inode: 0 };
    const realLstat = realFsPromises.lstat;
    vi.mocked(lstat).mockImplementation((async (path: string) => {
      const stats = (await realLstat(path)) as Stats;
      return {
        ...stats,
        ino: 0,
        isDirectory: () => stats.isDirectory(),
        isSymbolicLink: () => stats.isSymbolicLink(),
      } as Stats;
    }) as unknown as typeof lstat);
    try {
      await expect(
        revalidateConversationRootIdentity(inodelessRoot),
      ).rejects.toMatchObject({ scope: 'root', reason: 'identity_changed' });
    } finally {
      vi.mocked(lstat).mockRestore();
    }
  });
});
