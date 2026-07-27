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
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertExactLiveConversationRoot,
  getLiveConversationRootPath,
  LiveConversationWorkspace,
  revalidateLiveConversationRoot,
} from './conversation-workspace.js';

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
    const workspace = new LiveConversationWorkspace({ homeDir: home });
    const expected = join(home, 'Documents', 'Qwen Code', 'Conversations');

    expect(workspace.rootPath).toBe(expected);
    expect(getLiveConversationRootPath(home)).toBe(expected);
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
    const symlinkRoot = getLiveConversationRootPath(symlinkHome);
    await mkdir(join(symlinkHome, 'Documents', 'Qwen Code'), {
      recursive: true,
    });
    const target = join(symlinkHome, 'target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, symlinkRoot);
    const symlinkWorkspace = new LiveConversationWorkspace({
      homeDir: symlinkHome,
    });
    await expect(symlinkWorkspace.getRoot()).rejects.toThrow(/non-symlink/);
    await rm(symlinkRoot);
    expect((await symlinkWorkspace.getRoot()).configuredRoot).toBe(symlinkRoot);

    const fileHome = await tempHome();
    const fileRoot = getLiveConversationRootPath(fileHome);
    await mkdir(join(fileHome, 'Documents', 'Qwen Code'), { recursive: true });
    await writeFile(fileRoot, 'not a directory');
    await expect(
      new LiveConversationWorkspace({ homeDir: fileHome }).getRoot(),
    ).rejects.toThrow(/non-symlink/);

    const permissiveHome = await tempHome();
    const permissiveRoot = getLiveConversationRootPath(permissiveHome);
    await mkdir(permissiveRoot, { recursive: true, mode: 0o700 });
    await chmod(permissiveRoot, 0o755);
    await expect(
      new LiveConversationWorkspace({ homeDir: permissiveHome }).getRoot(),
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
        new LiveConversationWorkspace({ homeDir: ownerHome }).getRoot(),
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
    const workspace = new LiveConversationWorkspace({ homeDir: home });
    const identity = await workspace.getRoot();

    expect(await workspace.revalidate()).toBe(identity);
    expect(await revalidateLiveConversationRoot(identity)).toBe(identity);

    await rename(identity.configuredRoot, `${identity.configuredRoot}-old`);
    await mkdir(identity.configuredRoot, { mode: 0o700 });

    await expect(workspace.revalidate()).rejects.toThrow(/identity changed/);
  });

  it('accepts only the exact configured or canonical root identity', async () => {
    const home = await tempHome();
    const workspace = new LiveConversationWorkspace({ homeDir: home });
    const identity = await workspace.getRoot();
    const child = join(identity.canonicalRoot, 'child');
    await mkdir(child, { mode: 0o700 });

    expect(await workspace.assertExactRoot(identity.configuredRoot)).toBe(
      identity,
    );
    expect(
      await assertExactLiveConversationRoot(identity, identity.canonicalRoot),
    ).toBe(identity);
    await expect(workspace.assertExactRoot(child)).rejects.toThrow(/exact/);

    const alias = join(home, 'conversation-alias');
    await symlink(identity.canonicalRoot, alias);
    await expect(workspace.assertExactRoot(alias)).rejects.toThrow(/exact/);
  });

  it('materializes one private direct child per conversation session', async () => {
    const home = await tempHome();
    const workspace = new LiveConversationWorkspace({ homeDir: home });

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
    const workspace = new LiveConversationWorkspace({ homeDir: home });
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
    const workspace = new LiveConversationWorkspace({ homeDir: home });
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

  it('atomically recycles a non-empty conversation into private internal trash', async () => {
    const home = await tempHome();
    const workspace = new LiveConversationWorkspace({ homeDir: home });
    const source = await workspace.materializeConversationDirectory('kept');
    await mkdir(join(source, 'nested'), { mode: 0o700 });
    await writeFile(join(source, 'nested', 'result.txt'), 'preserved');

    const recycled = await workspace.recycleConversationDirectory('kept');

    expect(recycled).toBeDefined();
    await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(dirname(recycled!)).toBe(join(workspace.rootPath, '.trash'));
    expect(
      await readFile(join(recycled!, 'nested', 'result.txt'), 'utf8'),
    ).toBe('preserved');
    expect(recycled).toMatch(/conversation-[a-f0-9]{64}-[a-f0-9]{64}$/);
    if (process.platform !== 'win32') {
      expect((await lstat(dirname(recycled!))).mode & 0o777).toBe(0o700);
    }
  });

  it('treats a concurrently recycled or missing conversation as a no-op', async () => {
    const home = await tempHome();
    const workspace = new LiveConversationWorkspace({ homeDir: home });
    await workspace.materializeConversationDirectory('concurrent');

    const results = await Promise.all([
      workspace.recycleConversationDirectory('concurrent'),
      workspace.recycleConversationDirectory('concurrent'),
    ]);

    expect(results.filter((value) => value !== undefined)).toHaveLength(1);
    expect(results.filter((value) => value === undefined)).toHaveLength(1);
    await expect(
      workspace.recycleConversationDirectory('never-created'),
    ).resolves.toBeUndefined();
    expect(await readdir(join(workspace.rootPath, '.trash'))).toHaveLength(1);
  });

  it('fails closed for replaced source or trash symlinks', async () => {
    const sourceHome = await tempHome();
    const sourceWorkspace = new LiveConversationWorkspace({
      homeDir: sourceHome,
    });
    const source =
      await sourceWorkspace.materializeConversationDirectory('source-link');
    const sourceOutside = join(sourceHome, 'source-outside');
    await mkdir(sourceOutside, { mode: 0o700 });
    await rm(source, { recursive: true });
    await symlink(sourceOutside, source);
    await expect(
      sourceWorkspace.recycleConversationDirectory('source-link'),
    ).rejects.toThrow(/non-symlink/);

    const trashHome = await tempHome();
    const trashWorkspace = new LiveConversationWorkspace({
      homeDir: trashHome,
    });
    const trashSource =
      await trashWorkspace.materializeConversationDirectory('trash-link');
    const trashOutside = join(trashHome, 'trash-outside');
    await mkdir(trashOutside, { mode: 0o700 });
    await symlink(trashOutside, join(trashWorkspace.rootPath, '.trash'));
    await expect(
      trashWorkspace.recycleConversationDirectory('trash-link'),
    ).rejects.toThrow(/non-symlink/);
    expect((await lstat(trashSource)).isDirectory()).toBe(true);
  });

  it('rejects permissive source and trash directory modes', async () => {
    if (process.platform === 'win32') return;

    const sourceHome = await tempHome();
    const sourceWorkspace = new LiveConversationWorkspace({
      homeDir: sourceHome,
    });
    const source =
      await sourceWorkspace.materializeConversationDirectory('source-mode');
    await chmod(source, 0o755);
    await expect(
      sourceWorkspace.recycleConversationDirectory('source-mode'),
    ).rejects.toThrow(/only to its owner/);

    const trashHome = await tempHome();
    const trashWorkspace = new LiveConversationWorkspace({
      homeDir: trashHome,
    });
    const trashSource =
      await trashWorkspace.materializeConversationDirectory('trash-mode');
    const trash = join(trashWorkspace.rootPath, '.trash');
    await mkdir(trash, { mode: 0o700 });
    await chmod(trash, 0o755);
    await expect(
      trashWorkspace.recycleConversationDirectory('trash-mode'),
    ).rejects.toThrow(/only to its owner/);
    expect((await lstat(trashSource)).isDirectory()).toBe(true);
  });
});
