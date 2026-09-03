/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { realpathSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertExactConversationRoot,
  ConversationWorkspace,
  getConversationRootPath,
  revalidateConversationRoot,
} from './conversation-workspace.js';
import { ConversationDirectoryIdentityError } from '../../utils/conversation-directory-identity.js';

const plantOnExpectedInspect = vi.hoisted(() => ({ armed: false }));
const enoentOnInspect = vi.hoisted(() => ({ armed: false }));

vi.mock(
  '../../utils/conversation-directory-identity.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../utils/conversation-directory-identity.js')
      >();
    return {
      ...actual,
      inspectConversationDirectoryIdentity: async (
        ...args: Parameters<typeof actual.inspectConversationDirectoryIdentity>
      ) => {
        if (enoentOnInspect.armed) {
          enoentOnInspect.armed = false;
          throw new actual.ConversationDirectoryIdentityError(
            'root',
            'io_error',
            Object.assign(new Error('root vanished'), { code: 'ENOENT' }),
          );
        }
        const identity = await actual.inspectConversationDirectoryIdentity(
          ...args,
        );
        // Arms only on the final re-inspection (the sole caller passing
        // `expected`): plants an entry into the child before the caller's
        // emptiness snapshot, so a stale readdir ordering is observable.
        if (plantOnExpectedInspect.armed && args[2] !== undefined && identity) {
          plantOnExpectedInspect.armed = false;
          await writeFile(join(identity.canonicalPath, 'planted.txt'), 'x');
        }
        return identity;
      },
    };
  },
);

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
    expect(first).toMatchObject({
      device: stats.dev,
      inode: Number.isSafeInteger(stats.ino) && stats.ino > 0 ? stats.ino : 0,
    });
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

  it('treats a root that vanishes mid-inspection as already discarded', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    await workspace.materializeConversationDirectory('empty-racy');

    enoentOnInspect.armed = true;
    try {
      await expect(
        workspace.discardEmptyConversationDirectory('empty-racy'),
      ).resolves.toBe(false);
    } finally {
      enoentOnInspect.armed = false;
    }
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

  it('rejects as not_empty when an entry appears during the final identity re-inspection', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });

    // The interposed inspect plants an entry after the identity verdict but
    // before the caller's readdir; only a post-inspect entries snapshot can
    // see it — the pre-inspect ordering resolves as empty here.
    plantOnExpectedInspect.armed = true;
    try {
      await expect(
        workspace.prepareStandaloneDirectory('standalone'),
      ).rejects.toMatchObject({
        name: 'ConversationDirectoryIdentityError',
        scope: 'child',
        reason: 'not_empty',
      });
    } finally {
      plantOnExpectedInspect.armed = false;
    }
  });

  it('sanitizes standalone child filesystem errors', async () => {
    if (process.platform === 'win32') return;
    // Root bypasses the 0o000 chmod below via CAP_DAC_OVERRIDE, so the
    // EACCES guard this test provokes never fires (e.g. CI in a container).
    if (process.getuid && process.getuid() === 0) return;
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

  it('inspects, creates, and rejects replaced standalone child identities', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });

    await expect(
      workspace.inspectStandaloneDirectory('standalone'),
    ).resolves.toEqual({ status: 'missing' });
    const created = await workspace.ensureStandaloneDirectory('standalone');
    expect(created.status).toBe('created');
    if (created.status !== 'created') throw new Error('expected creation');
    if (created.identity.inode === 0) return;

    await expect(
      workspace.inspectStandaloneDirectory('standalone', created.identity),
    ).resolves.toMatchObject({ status: 'ready' });

    // Keep the original inode alive under a sibling name so the replacement
    // cannot reuse it (ext4/overlayfs recycle freed inodes immediately).
    const preserved = `${created.identity.canonicalPath}.preserved`;
    await rename(created.identity.canonicalPath, preserved);
    await mkdir(created.identity.canonicalPath, { mode: 0o700 });
    const compromised = await workspace.inspectStandaloneDirectory(
      'standalone',
      created.identity,
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

  it('reports recreated only when a known identity vanished', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const prepared = await workspace.prepareStandaloneDirectory('standalone');
    // Keep the original inode alive under a sibling name so the replacement
    // cannot reuse it and accidentally satisfy the expected identity.
    await rename(
      prepared.identity.canonicalPath,
      `${prepared.identity.canonicalPath}.preserved`,
    );

    const ensured = await workspace.ensureStandaloneDirectory(
      'standalone',
      prepared.identity,
    );
    expect(ensured.status).toBe('recreated');
    if (ensured.status !== 'recreated') throw new Error('expected recreate');
    expect(ensured.identity.canonicalPath).toBe(
      prepared.identity.canonicalPath,
    );
    if (prepared.identity.inode !== 0) {
      expect(ensured.identity.inode).not.toBe(prepared.identity.inode);
    }
  });

  it('returns the raced inspection when a concurrent creator wins the ensure race', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const prepared = await workspace.prepareStandaloneDirectory('standalone');

    const inspect = vi.spyOn(workspace, 'inspectStandaloneDirectory');
    inspect.mockResolvedValueOnce({ status: 'missing' });

    const ensured = await workspace.ensureStandaloneDirectory(
      'standalone',
      prepared.identity,
    );
    expect(ensured).toMatchObject({
      status: 'ready',
      identity: prepared.identity,
    });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('reports compromised when the raced ensure inspection still finds nothing', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const prepared = await workspace.prepareStandaloneDirectory('standalone');

    vi.spyOn(workspace, 'inspectStandaloneDirectory').mockResolvedValue({
      status: 'missing',
    });

    const ensured = await workspace.ensureStandaloneDirectory(
      'standalone',
      prepared.identity,
    );
    expect(ensured.status).toBe('compromised');
    if (ensured.status !== 'compromised') {
      throw new Error('expected compromised');
    }
    expect(ensured.error).toBeInstanceOf(ConversationDirectoryIdentityError);
    expect(ensured.error.reason).toBe('identity_changed');
  });

  it('propagates a raced compromised inspection verbatim from the ensure race', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const prepared = await workspace.prepareStandaloneDirectory('standalone');

    const racedError = new ConversationDirectoryIdentityError(
      'child',
      'unexpected_identity',
    );
    const inspect = vi.spyOn(workspace, 'inspectStandaloneDirectory');
    inspect
      .mockResolvedValueOnce({ status: 'missing' })
      .mockResolvedValueOnce({ status: 'compromised', error: racedError });

    const ensured = await workspace.ensureStandaloneDirectory(
      'standalone',
      prepared.identity,
    );
    expect(ensured.status).toBe('compromised');
    if (ensured.status !== 'compromised') {
      throw new Error('expected compromised');
    }
    // A narrowed `raced.status === 'ready'` pass-through would instead
    // surface a fresh identity_changed here; the raced reason must survive.
    expect(ensured.error).toBe(racedError);
  });

  it('re-inspects a raced standalone directory even without an expected identity', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const prepared = await workspace.prepareStandaloneDirectory('standalone');

    const inspect = vi.spyOn(workspace, 'inspectStandaloneDirectory');
    inspect.mockResolvedValueOnce({ status: 'missing' });

    const ensured = await workspace.ensureStandaloneDirectory('standalone');
    expect(ensured).toMatchObject({
      status: 'ready',
      identity: prepared.identity,
    });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('propagates a raced compromised verdict when no identity is expected', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    await workspace.prepareStandaloneDirectory('standalone');

    const racedError = new ConversationDirectoryIdentityError(
      'child',
      'wrong_mode',
    );
    const inspect = vi.spyOn(workspace, 'inspectStandaloneDirectory');
    inspect
      .mockResolvedValueOnce({ status: 'missing' })
      .mockResolvedValueOnce({ status: 'compromised', error: racedError });

    const ensured = await workspace.ensureStandaloneDirectory('standalone');
    expect(ensured.status).toBe('compromised');
    if (ensured.status !== 'compromised') {
      throw new Error('expected compromised');
    }
    expect(ensured.error).toBe(racedError);
  });

  it('stages and restores the exact standalone directory identity', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const prepared = await workspace.prepareStandaloneDirectory('standalone');
    await writeFile(
      join(prepared.identity.canonicalPath, 'transient.txt'),
      'keep during staging',
    );

    const staged = await workspace.stageStandaloneDirectory(
      'standalone',
      prepared.identity,
    );

    expect(staged.name).toBe(`${prepared.identity.name}.deleting`);
    expect(staged.canonicalPath).toBe(
      `${prepared.identity.canonicalPath}.deleting`,
    );
    expect(staged).toMatchObject({
      storageSessionId: prepared.identity.storageSessionId,
      device: prepared.identity.device,
      inode: prepared.identity.inode,
    });
    await expect(
      workspace.inspectStandaloneDeletionPaths('standalone', prepared.identity),
    ).resolves.toMatchObject({ status: 'staged' });

    const restored = await workspace.restoreStagedStandaloneDirectory(
      'standalone',
      prepared.identity,
    );
    expect(restored).toMatchObject({
      name: prepared.identity.name,
      canonicalPath: prepared.identity.canonicalPath,
      device: prepared.identity.device,
      inode: prepared.identity.inode,
    });
    await expect(
      lstat(join(restored.canonicalPath, 'transient.txt')),
    ).resolves.toMatchObject({ size: 19 });
  });

  it('reconstructs only internally consistent deletion expectations', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const prepared = await workspace.prepareStandaloneDirectory('standalone');

    await expect(
      workspace.createStandaloneDeletionExpectation('standalone', {
        device: prepared.identity.device,
        inode: prepared.identity.inode,
        inodeVerifiable: prepared.identity.inode !== 0,
      }),
    ).resolves.toEqual(prepared.identity);
    await expect(
      workspace.createStandaloneDeletionExpectation('standalone', {
        device: prepared.identity.device,
        inode: 0,
        inodeVerifiable: true,
      }),
    ).rejects.toMatchObject({
      name: 'ConversationDirectoryIdentityError',
      reason: 'unexpected_identity',
    });
  });

  it('removes only a matching staged standalone directory', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const prepared = await workspace.prepareStandaloneDirectory('standalone');
    await mkdir(join(prepared.identity.canonicalPath, 'nested'), {
      mode: 0o700,
    });
    await writeFile(
      join(prepared.identity.canonicalPath, 'nested', 'remove.txt'),
      'remove',
    );
    const staged = await workspace.stageStandaloneDirectory(
      'standalone',
      prepared.identity,
    );

    await workspace.removeStagedStandaloneDirectory(
      'standalone',
      prepared.identity,
    );

    await expect(lstat(staged.canonicalPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (await lstat((await workspace.getRoot()).canonicalRoot)).isDirectory(),
    ).toBe(true);
  });

  it('surfaces root directory sync failures', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const root = await workspace.getRoot();
    const probe = await open(root.canonicalRoot, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      sync(): Promise<void>;
    };
    await probe.close();
    const syncError = Object.assign(new Error('root sync failed'), {
      code: 'EIO',
    });
    vi.spyOn(prototype, 'sync').mockRejectedValueOnce(syncError);

    await expect(workspace.confirmStandaloneRootDurability(root)).rejects.toBe(
      syncError,
    );
  });

  it('rejects a root whose inode verifiability changed', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const root = await workspace.getRoot();
    const changedRoot = root.inodeVerifiable
      ? { ...root, inode: 0, inodeVerifiable: false }
      : { ...root, inode: 1, inodeVerifiable: true };

    await expect(
      workspace.confirmStandaloneRootDurability(changedRoot),
    ).rejects.toBeInstanceOf(ConversationDirectoryIdentityError);
  });

  it('does not treat root inspection failures as unsupported Windows sync', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const root = await workspace.getRoot();
    const probe = await open(root.canonicalRoot, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      stat(): ReturnType<typeof probe.stat>;
    };
    await probe.close();
    const statError = Object.assign(new Error('root stat failed'), {
      code: 'EACCES',
    });
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(prototype, 'stat').mockRejectedValueOnce(statError);

    await expect(workspace.confirmStandaloneRootDurability(root)).rejects.toBe(
      statError,
    );
  });

  it('fails closed when both normal and staged deletion paths exist', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const prepared = await workspace.prepareStandaloneDirectory('standalone');
    await mkdir(`${prepared.identity.canonicalPath}.deleting`, { mode: 0o700 });

    const inspected = await workspace.inspectStandaloneDeletionPaths(
      'standalone',
      prepared.identity,
    );

    expect(inspected.status).toBe('compromised');
    if (inspected.status !== 'compromised') {
      throw new Error('expected compromised');
    }
    expect(inspected.error.reason).toBe('unexpected_identity');
  });

  it('rejects a replacement directory during deletion staging', async () => {
    const home = await tempHome();
    const workspace = new ConversationWorkspace({ homeDir: home });
    const prepared = await workspace.prepareStandaloneDirectory('standalone');
    await rename(
      prepared.identity.canonicalPath,
      `${prepared.identity.canonicalPath}.preserved`,
    );
    await mkdir(prepared.identity.canonicalPath, { mode: 0o700 });

    await expect(
      workspace.stageStandaloneDirectory('standalone', prepared.identity),
    ).rejects.toMatchObject({
      name: 'ConversationDirectoryIdentityError',
      reason: 'unexpected_identity',
    });
  });
});
