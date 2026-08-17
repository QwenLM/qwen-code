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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertExactConversationRoot,
  ConversationWorkspace,
  getConversationRootPath,
  revalidateConversationRoot,
} from './conversation-workspace.js';
import { ConversationDirectoryIdentityError } from '../../utils/conversation-directory-identity.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(
    join(realpathSync.native(tmpdir()), 'qwen-live-home-'),
  );
  cleanup.push(home);
  return home;
}

describe('Live conversation workspace root', () => {
  it('lazily creates the injected default root with a private canonical identity', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const expected = join(home, 'Documents', 'Qwen Code', 'Conversations');

    expect(workspace.rootPath).toBe(expected);
    expect(getConversationRootPath(home)).toBe(expected);
    await expect(lstat(expected)).rejects.toMatchObject({ code: 'ENOENT' });

    const [first, second] = await Promise.all([
      workspace.getRoot(),
      workspace.getRoot(),
    ]);

    expect(first).toBe(second);
    expect(first.configuredRoot).toBe(expected);
    expect(first.canonicalRoot).toBe(realpathSync.native(expected));
    const stats = await lstat(expected);
    expect(stats.isDirectory()).toBe(true);
    expect(first).toMatchObject({ device: stats.dev, inode: stats.ino });
    if (process.platform !== 'win32') {
      expect(stats.mode & 0o077).toBe(0);
    }
  });

  it('rejects symlink, non-directory, permissive, and foreign-owned roots', async () => {
    if (process.platform === 'win32') return;

    const symlinkHome = await tempHome();
    const symlinkRoot = getConversationRootPath(symlinkHome);
    await mkdir(join(symlinkHome, 'Documents', 'Qwen Code'), {
      recursive: true,
    });
    const target = join(symlinkHome, 'target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, symlinkRoot);
    const symlinkWorkspace = new ConversationWorkspace({
      homeDir: symlinkHome,
    });
    await expect(symlinkWorkspace.getRoot()).rejects.toThrow(/non-symlink/);
    await rm(symlinkRoot);
    expect((await symlinkWorkspace.getRoot()).configuredRoot).toBe(symlinkRoot);

    const fileHome = await tempHome();
    const fileRoot = getConversationRootPath(fileHome);
    await mkdir(join(fileHome, 'Documents', 'Qwen Code'), { recursive: true });
    await writeFile(fileRoot, 'not a directory');
    await expect(
      new ConversationWorkspace({ homeDir: fileHome }).getRoot(),
    ).rejects.toThrow(/non-symlink/);

    const permissiveHome = await tempHome();
    const permissiveRoot = getConversationRootPath(permissiveHome);
    await mkdir(permissiveRoot, { recursive: true, mode: 0o700 });
    await chmod(permissiveRoot, 0o755);
    await expect(
      new ConversationWorkspace({ homeDir: permissiveHome }).getRoot(),
    ).rejects.toThrow(/only to its owner/);

    const ownerHome = await tempHome();
    const getuid = process.getuid;
    if (!getuid) return;
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'getuid',
    );
    Object.defineProperty(process, 'getuid', {
      configurable: true,
      value: () => getuid() + 1,
    });
    try {
      await expect(
        new ConversationWorkspace({ homeDir: ownerHome }).getRoot(),
      ).rejects.toThrow(/owned by the daemon user/);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(process, 'getuid', originalDescriptor);
      } else {
        Reflect.deleteProperty(process, 'getuid');
      }
    }
  });

  it('revalidates both canonical identity and the configured path', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const identity = await workspace.getRoot();

    expect(await workspace.revalidate()).toBe(identity);
    expect(await revalidateConversationRoot(identity)).toBe(identity);

    await rename(identity.configuredRoot, `${identity.configuredRoot}-old`);
    await mkdir(identity.configuredRoot, { mode: 0o700 });

    await expect(workspace.revalidate()).rejects.toThrow(/identity changed/);
  });

  it('preserves Live filesystem errors while standalone keeps root scope', async () => {
    const liveHome = await tempHome();
    const liveWorkspace = new ConversationWorkspace({ homeDir: liveHome });
    const liveRoot = await liveWorkspace.getRoot();
    await rm(liveRoot.configuredRoot, { recursive: true });
    await expect(liveWorkspace.revalidate()).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const standaloneHome = await tempHome();
    const standaloneWorkspace = new ConversationWorkspace({
      homeDir: standaloneHome,
    });
    const standaloneRoot = await standaloneWorkspace.getRoot();
    await rename(
      standaloneRoot.configuredRoot,
      `${standaloneRoot.configuredRoot}-old`,
    );
    await mkdir(standaloneRoot.configuredRoot, { mode: 0o700 });
    await expect(
      standaloneWorkspace.inspectStandaloneDirectory('standalone'),
    ).rejects.toMatchObject({
      name: 'ConversationDirectoryIdentityError',
      scope: 'root',
      reason: 'identity_changed',
    });
  });

  it('accepts only the exact configured or canonical root identity', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const identity = await workspace.getRoot();
    const child = join(identity.canonicalRoot, 'child');
    await mkdir(child, { mode: 0o700 });

    expect(await workspace.assertExactRoot(identity.configuredRoot)).toBe(
      identity,
    );
    expect(
      await assertExactConversationRoot(identity, identity.canonicalRoot),
    ).toBe(identity);
    await expect(workspace.assertExactRoot(child)).rejects.toThrow(/exact/);

    const alias = join(home, 'conversation-alias');
    await symlink(identity.canonicalRoot, alias);
    await expect(workspace.assertExactRoot(alias)).rejects.toThrow(/exact/);
  });

  it('materializes one private direct child per conversation session', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });

    const first = await workspace.materializeConversationDirectory('first');
    const same = await workspace.materializeConversationDirectory('first');
    const second = await workspace.materializeConversationDirectory('second');
    const root = await workspace.getRoot();

    expect(same).toBe(first);
    expect(second).not.toBe(first);
    expect(dirname(first)).toBe(root.canonicalRoot);
    expect(dirname(second)).toBe(root.canonicalRoot);
    if (process.platform !== 'win32') {
      expect((await lstat(first)).mode & 0o777).toBe(0o700);
      expect((await lstat(second)).mode & 0o777).toBe(0o700);
    }
  });

  it('rejects a replaced conversation child symlink', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const child = await workspace.materializeConversationDirectory('replace');
    const outside = join(home, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await rm(child, { recursive: true });
    await symlink(outside, child);

    await expect(
      workspace.materializeConversationDirectory('replace'),
    ).rejects.toThrow(/non-symlink/);
  });

  it('discards only an empty expected conversation child', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const empty = await workspace.materializeConversationDirectory('empty');
    const occupied =
      await workspace.materializeConversationDirectory('occupied');
    await writeFile(join(occupied, 'keep.txt'), 'keep');

    await expect(
      workspace.discardEmptyConversationDirectory('empty'),
    ).resolves.toBe(true);
    await expect(lstat(empty)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      workspace.discardEmptyConversationDirectory('empty'),
    ).resolves.toBe(false);
    await expect(
      workspace.discardEmptyConversationDirectory('occupied'),
    ).resolves.toBe(false);
    expect((await lstat(occupied)).isDirectory()).toBe(true);
  });

  it('prepares only a new or reusable empty standalone child', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });

    const created = await workspace.prepareStandaloneDirectory('standalone');
    const reused = await workspace.prepareStandaloneDirectory('standalone');
    expect(created.created).toBe(true);
    expect(reused.created).toBe(false);
    expect(reused.identity).toEqual(created.identity);

    await writeFile(join(created.identity.canonicalPath, 'keep.txt'), 'keep');
    await expect(
      workspace.prepareStandaloneDirectory('standalone'),
    ).rejects.toMatchObject({
      name: 'ConversationDirectoryIdentityError',
      scope: 'child',
      reason: 'not_empty',
    });
    expect((await lstat(created.identity.canonicalPath)).isDirectory()).toBe(
      true,
    );
  });

  it('sanitizes standalone child filesystem errors', async () => {
    if (process.platform === 'win32') return;
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const prepared = await workspace.prepareStandaloneDirectory('standalone');
    await chmod(prepared.identity.canonicalPath, 0o000);
    try {
      const error = await workspace
        .prepareStandaloneDirectory('standalone')
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        name: 'ConversationDirectoryIdentityError',
        scope: 'child',
        reason: 'io_error',
      });
      expect((error as Error).message).not.toContain(
        prepared.identity.canonicalPath,
      );
      expect(JSON.stringify(error)).not.toContain(
        prepared.identity.canonicalPath,
      );
    } finally {
      await chmod(prepared.identity.canonicalPath, 0o700);
    }
  });

  it('inspects, recreates, and rejects replaced standalone child identities', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });

    await expect(
      workspace.inspectStandaloneDirectory('standalone'),
    ).resolves.toEqual({ status: 'missing' });
    const recreated = await workspace.ensureStandaloneDirectory('standalone');
    expect(recreated.status).toBe('recreated');
    if (recreated.status !== 'recreated') throw new Error('expected recreate');

    await expect(
      workspace.inspectStandaloneDirectory('standalone', recreated.identity),
    ).resolves.toMatchObject({ status: 'ready' });

    await rm(recreated.identity.canonicalPath, { recursive: true });
    await mkdir(recreated.identity.canonicalPath, { mode: 0o700 });
    const compromised = await workspace.inspectStandaloneDirectory(
      'standalone',
      recreated.identity,
    );
    expect(compromised.status).toBe('compromised');
    if (compromised.status !== 'compromised') {
      throw new Error('expected compromised');
    }
    expect(compromised.error).toBeInstanceOf(
      ConversationDirectoryIdentityError,
    );
    expect(compromised.error.reason).toBe('unexpected_identity');
  });
});
