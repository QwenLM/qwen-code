/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
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
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationDirectoryIdentityError,
  createConversationRootIdentity,
  getConversationDirectoryName,
  inspectConversationDirectoryIdentity,
  materializeConversationDirectoryIdentity,
  revalidateConversationRootIdentity,
} from './conversation-directory-identity.js';

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
    await rm(original.identity.canonicalPath, { recursive: true });
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
});
