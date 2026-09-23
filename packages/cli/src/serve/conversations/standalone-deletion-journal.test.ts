/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConversationDirectoryName } from '../../utils/conversation-directory-identity.js';
import { ConversationWorkspace } from './conversation-workspace.js';
import {
  StandaloneDeletionJournal,
  StandaloneDeletionJournalError,
  type StandaloneDeletionRecordV2,
} from './standalone-deletion-journal.js';

const { openMock, bigInodeVolume } = vi.hoisted(() => ({
  openMock: vi.fn(),
  // Lets a test pose as a volume whose 64-bit file ids exceed the JS
  // safe-integer range (NTFS): while enabled, every lstat and every
  // directory-handle stat reports the real inode lifted above 2^60, in
  // whichever representation the caller asked for. The lift preserves
  // distinctness, so a physically replaced tree still reports a different
  // id; the number form rounds into the unsafe range, which is the
  // pre-#11848 failure shape.
  bigInodeVolume: { enabled: false },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const poseStats = (
    stats: { ino: number | bigint },
    bigint: boolean,
  ): void => {
    if (!bigInodeVolume.enabled) return;
    stats.ino = bigint
      ? 2n ** 60n + BigInt(stats.ino)
      : Number(2n ** 60n + BigInt(stats.ino));
  };
  openMock.mockImplementation(
    async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const stat = handle.stat.bind(handle);
      // Forward the stat options through, as the statSync mocks in
      // no-follow-open.test.ts and session-writer-lease.test.ts do: the
      // journal stats directory handles with `{ bigint: true }`, and a
      // wrapper that dropped the options bag would silently un-ask the
      // exact id the fix relies on.
      handle.stat = (async (options?: { bigint?: boolean }) => {
        const bigint = options?.bigint === true;
        const stats = await (bigint ? stat({ bigint: true }) : stat());
        poseStats(stats as { ino: number | bigint }, bigint);
        return stats;
      }) as typeof handle.stat;
      return handle;
    },
  );
  const lstat = (async (filePath: PathLike, options?: { bigint?: boolean }) => {
    const bigint = options?.bigint === true;
    const stats = await (bigint
      ? actual.lstat(filePath, { bigint: true })
      : actual.lstat(filePath));
    poseStats(stats as { ino: number | bigint }, bigint);
    return stats;
  }) as typeof actual.lstat;
  return { ...actual, open: openMock, lstat };
});

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('StandaloneDeletionJournal', () => {
  let homeDir: string;
  let stableBaseDir: string;
  let ownerDirectory: string;
  let workspace: ConversationWorkspace;
  let journal: StandaloneDeletionJournal;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(tmpdir(), 'qwen-deletion-journal-'));
    stableBaseDir = path.join(homeDir, '.qwen');
    ownerDirectory = path.join(stableBaseDir, 'conversations');
    await fs.mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await fs.chmod(ownerDirectory, 0o700);
    }
    workspace = new ConversationWorkspace({ homeDir });
    journal = new StandaloneDeletionJournal(stableBaseDir);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  const journalPath = (phase: 'prepared' | 'staged') =>
    path.join(
      ownerDirectory,
      'deletions',
      `delete-${SESSION_ID}.${phase}.json`,
    );

  const makeRecord = async (
    phase: 'prepared' | 'staged',
    directory: StandaloneDeletionRecordV2['directory'] = { kind: 'absent' },
  ): Promise<StandaloneDeletionRecordV2> => {
    const root = await workspace.getRoot();
    return {
      version: 2,
      phase,
      sessionId: SESSION_ID,
      storageSessionId: SESSION_ID.toUpperCase(),
      transcriptLocation: 'active',
      transcriptParent: {
        device: 11,
        inode: 12,
        inodeVerifiable: true,
      },
      root: {
        canonicalPath: root.canonicalRoot,
        device: root.device,
        inode: root.inode,
        inodeVerifiable: root.inodeVerifiable,
      },
      directory,
    };
  };

  it('writes and reads an owner-only prepared record', async () => {
    const root = await workspace.getRoot();
    const record = await makeRecord('prepared');

    await journal.writePrepared(record, root);

    await expect(journal.read(SESSION_ID, root)).resolves.toEqual({
      prepared: record,
    });
    await expect(journal.hasRecord(SESSION_ID)).resolves.toBe(true);
    if (process.platform !== 'win32') {
      expect((await fs.stat(journalPath('prepared'))).mode & 0o777).toBe(0o600);
      expect(
        (await fs.stat(path.dirname(journalPath('prepared')))).mode & 0o777,
      ).toBe(0o700);
    }
  });

  it('bootstraps its state parent without an owner and accepts a historical 0755 base', async () => {
    await fs.rmdir(ownerDirectory);
    if (process.platform !== 'win32') await fs.chmod(stableBaseDir, 0o755);
    const root = await workspace.getRoot();
    await expect(journal.listSessionIds()).resolves.toEqual([]);
    await journal.writePrepared(await makeRecord('prepared'), root);
    await expect(
      fs.lstat(path.join(ownerDirectory, 'runtime-owner.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(journal.hasRecord(SESSION_ID)).resolves.toBe(true);
    if (process.platform !== 'win32') {
      expect((await fs.stat(stableBaseDir)).mode & 0o777).toBe(0o755);
      expect((await fs.stat(ownerDirectory)).mode & 0o777).toBe(0o700);
    }
  });

  it('rejects a vanished previously observed state directory without recreating it', async () => {
    const root = await workspace.getRoot();
    const record = await makeRecord('prepared');
    await journal.writePrepared(record, root);
    await journal.clear(SESSION_ID, root);
    await fs.rmdir(path.join(ownerDirectory, 'deletions'));
    await fs.rmdir(ownerDirectory);

    for (const operation of [
      () => journal.hasRecord(SESSION_ID),
      () => journal.listSessionIds(),
      () => journal.read(SESSION_ID, root),
      () => journal.clear(SESSION_ID, root),
      () => journal.writePrepared(record, root),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        reason: 'compromised',
      });
      await expect(fs.lstat(ownerDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  // The regression witness for #11848, now running on every platform. It
  // was gated off on win32 because the gate's red was witnessing a real
  // production gap, not a portability artifact: `sameDirectoryIdentity`
  // compared EQUAL for a complete private replacement of the journal tree
  // when `inodeVerifiable` was false on both sides, so on NTFS the swap
  // detection was inert and `hasRecord` answered `false` over an
  // attacker-created empty tree instead of rejecting with `reason:
  // 'compromised'` (measured on two independent Windows self-hosted arms at
  // the base of #11787: `25 tests | 5 failed`, `promise resolved "false"
  // instead of rejecting`). The root cause was `fs.lstat(directory)` in
  // `standalone-deletion-journal.ts` asking for a number-backed `Stats`,
  // which rounds a 64-bit NTFS file index; the `{ bigint: true }`
  // conversion keeps the id exact, and is what let the win32 gate come off.
  it.each(['base', 'state'] as const)(
    'rejects a complete private replacement %s tree on every operation',
    async (parent) => {
      const root = await workspace.getRoot();
      const record = await makeRecord('prepared');
      await journal.writePrepared(record, root);
      const directory = parent === 'base' ? stableBaseDir : ownerDirectory;
      const saved = `${directory}.saved`;
      const original = await fs.lstat(directory, { bigint: true });
      const originalRecord = await fs.readFile(journalPath('prepared'), 'utf8');
      await fs.rename(directory, saved);
      await fs.mkdir(path.join(ownerDirectory, 'deletions'), {
        recursive: true,
        mode: 0o700,
      });
      for (const candidate of [
        stableBaseDir,
        ownerDirectory,
        path.join(ownerDirectory, 'deletions'),
      ]) {
        const stat = await fs.lstat(candidate);
        expect(stat.isDirectory()).toBe(true);
        expect(stat.isSymbolicLink()).toBe(false);
        if (process.platform !== 'win32') {
          expect(stat.mode & 0o777).toBe(0o700);
          expect(stat.uid).toBe(process.getuid?.());
        }
      }
      expect((await fs.lstat(directory, { bigint: true })).ino).not.toBe(
        original.ino,
      );
      for (const operation of [
        () => journal.hasRecord(SESSION_ID),
        () => journal.listSessionIds(),
        () => journal.read(SESSION_ID, root),
        () => journal.clear(SESSION_ID, root),
        () => journal.writePrepared(record, root),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          reason: 'compromised',
        });
      }
      const savedOwnerDirectory =
        parent === 'base' ? path.join(saved, 'conversations') : saved;
      await expect(
        fs.readFile(
          path.join(
            savedOwnerDirectory,
            'deletions',
            path.basename(journalPath('prepared')),
          ),
          'utf8',
        ),
      ).resolves.toBe(originalRecord);
      await expect(
        fs.readdir(path.join(ownerDirectory, 'deletions')),
      ).resolves.toEqual([]);
    },
  );

  it.each(['base', 'state'] as const)(
    'rejects a private replacement %s tree on a volume with 64-bit file ids',
    async (parent) => {
      // The #11848 acceptance shape, platform-independent by construction:
      // every stat reports its real inode lifted above 2^60, as an NTFS
      // volume would. With number-backed stats both sides of the comparison
      // round into the unsafe range, `inodeVerifiable` turns false on both,
      // and `sameDirectoryIdentity` compares EQUAL for the replacement — the
      // fail-open the win32 arms measured. With bigint stats the ids stay
      // exact and the swap is detected on every operation.
      const root = await workspace.getRoot();
      const record = await makeRecord('prepared');
      bigInodeVolume.enabled = true;
      try {
        await journal.writePrepared(record, root);
        const directory = parent === 'base' ? stableBaseDir : ownerDirectory;
        const saved = `${directory}.saved`;
        await fs.rename(directory, saved);
        await fs.mkdir(path.join(ownerDirectory, 'deletions'), {
          recursive: true,
          mode: 0o700,
        });
        for (const operation of [
          () => journal.hasRecord(SESSION_ID),
          () => journal.listSessionIds(),
          () => journal.read(SESSION_ID, root),
          () => journal.clear(SESSION_ID, root),
          () => journal.writePrepared(record, root),
        ]) {
          await expect(operation()).rejects.toMatchObject({
            reason: 'compromised',
          });
        }
      } finally {
        bigInodeVolume.enabled = false;
      }
    },
  );

  it.each(['base', 'state'] as const)(
    'rejects a replaced %s parent on every operation',
    async (parent) => {
      const root = await workspace.getRoot();
      const record = await makeRecord('prepared');
      await journal.writePrepared(record, root);
      const directory = parent === 'base' ? stableBaseDir : ownerDirectory;
      await fs.rename(directory, `${directory}.saved`);
      await fs.mkdir(directory, { mode: 0o700 });
      for (const operation of [
        () => journal.hasRecord(SESSION_ID),
        () => journal.listSessionIds(),
        () => journal.read(SESSION_ID, root),
        () => journal.clear(SESSION_ID, root),
        () => journal.writePrepared(record, root),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          reason: 'compromised',
        });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects an ancestor redirect even when the state inode is unchanged',
    async () => {
      const root = await workspace.getRoot();
      const parent = path.join(homeDir, 'journal-parent');
      const redirectedJournal = new StandaloneDeletionJournal(
        path.join(parent, '.qwen'),
      );
      await redirectedJournal.writePrepared(await makeRecord('prepared'), root);
      await fs.rename(parent, `${parent}.saved`);
      await fs.symlink(`${parent}.saved`, parent);
      await expect(
        redirectedJournal.read(SESSION_ID, root),
      ).rejects.toMatchObject({ reason: 'compromised' });
    },
  );

  it('reads the exact legacy V1 record without inventing parent proof', async () => {
    const root = await workspace.getRoot();
    const current = await makeRecord('prepared');
    const { transcriptParent: _transcriptParent, ...legacyFields } = current;
    const legacy = { ...legacyFields, version: 1 as const };
    const journalDirectory = path.dirname(journalPath('prepared'));
    await fs.mkdir(journalDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await fs.chmod(journalDirectory, 0o700);
    }
    await fs.writeFile(journalPath('prepared'), JSON.stringify(legacy), {
      mode: 0o600,
    });

    await expect(journal.read(SESSION_ID, root)).resolves.toEqual({
      prepared: legacy,
    });
  });

  it('rejects journal directory replacement during phase sync', async (ctx) => {
    if (process.platform === 'win32') {
      ctx.skip();
      return;
    }
    const root = await workspace.getRoot();
    const record = await makeRecord('prepared');
    const journalDirectory = path.dirname(journalPath('prepared'));
    const originalDirectory = `${journalDirectory}.original`;
    const originalOpen = openMock.getMockImplementation();
    if (!originalOpen) throw new Error('expected fs.open implementation');
    let replaced = false;
    openMock.mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === journalDirectory) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (!replaced) {
            replaced = true;
            await fs.rename(journalDirectory, originalDirectory);
            await fs.mkdir(journalDirectory, { mode: 0o700 });
          }
          await sync();
        };
      }
      return handle;
    });

    try {
      await expect(journal.writePrepared(record, root)).rejects.toMatchObject({
        reason: 'compromised',
      });
      await expect(
        fs.stat(
          path.join(originalDirectory, path.basename(journalPath('prepared'))),
        ),
      ).resolves.toBeDefined();
      await expect(fs.lstat(journalPath('prepared'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      openMock.mockImplementation(originalOpen);
      await fs.rmdir(journalDirectory);
      await fs.rename(originalDirectory, journalDirectory);
      await journal.clear(SESSION_ID, root);
    }
  });

  it('retains a same-session fence until clear durability is confirmed', async (ctx) => {
    if (process.platform === 'win32') {
      ctx.skip();
      return;
    }
    const root = await workspace.getRoot();
    const prepared = await makeRecord('prepared');
    await journal.writePrepared(prepared, root);
    const journalDirectory = path.dirname(journalPath('prepared'));
    const originalOpen = openMock.getMockImplementation();
    if (!originalOpen) throw new Error('expected fs.open implementation');
    let failSync = true;
    openMock.mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === journalDirectory) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (failSync) {
            failSync = false;
            throw Object.assign(new Error('directory sync failed'), {
              code: 'EIO',
            });
          }
          await sync();
        };
      }
      return handle;
    });

    try {
      await expect(journal.clear(SESSION_ID, root)).rejects.toMatchObject({
        code: 'EIO',
      });
      await expect(journal.hasRecord(SESSION_ID)).resolves.toBe(true);
      await expect(journal.read(SESSION_ID, root)).resolves.toEqual({
        prepared,
      });
      await expect(journal.writePrepared(prepared, root)).rejects.toMatchObject(
        { reason: 'conflict' },
      );

      await fs.rename(ownerDirectory, `${ownerDirectory}.saved`);
      await fs.mkdir(ownerDirectory, { mode: 0o700 });
      await expect(journal.hasRecord(SESSION_ID)).rejects.toMatchObject({
        reason: 'compromised',
      });
      await expect(journal.read(SESSION_ID, root)).rejects.toMatchObject({
        reason: 'compromised',
      });
      await expect(journal.clear(SESSION_ID, root)).rejects.toMatchObject({
        reason: 'compromised',
      });
      await fs.rmdir(ownerDirectory);
      await fs.rename(`${ownerDirectory}.saved`, ownerDirectory);

      await expect(journal.clear(SESSION_ID, root)).resolves.toBeUndefined();
      await expect(journal.hasRecord(SESSION_ID)).resolves.toBe(false);
    } finally {
      openMock.mockImplementation(originalOpen);
    }
  });

  it('requires the journal owner directory to sync before writing a phase', async () => {
    const root = await workspace.getRoot();
    const record = await makeRecord('prepared');
    // The journal stats the open handle with `{ bigint: true }` (the #11848
    // conversion), so the fake handle must answer in kind — a number-backed
    // `Stats` would miscompare against the bigint identity and reject as
    // 'compromised' before the sync failure under test ever fires.
    const ownerStats = await fs.stat(ownerDirectory, { bigint: true });
    const syncError = Object.assign(new Error('owner sync failed'), {
      code: 'EIO',
    });
    openMock.mockImplementationOnce(async (filePath: PathLike) => {
      expect(filePath.toString()).toBe(ownerDirectory);
      return {
        stat: async () => ownerStats,
        sync: async () => Promise.reject(syncError),
        close: async () => undefined,
      } as unknown as fs.FileHandle;
    });

    await expect(journal.writePrepared(record, root)).rejects.toBe(syncError);
    await expect(fs.lstat(journalPath('prepared'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not hide Windows journal owner open failures', async () => {
    const root = await workspace.getRoot();
    const record = await makeRecord('prepared');
    const openError = Object.assign(new Error('owner open failed'), {
      code: 'EACCES',
    });
    const platform = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    openMock.mockRejectedValueOnce(openError);

    try {
      await expect(journal.writePrepared(record, root)).rejects.toBe(openError);
      await expect(fs.lstat(journalPath('prepared'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      platform.mockRestore();
    }
  });

  it('writes matching immutable phases and clears staged before prepared', async () => {
    const root = await workspace.getRoot();
    const prepared = await makeRecord('prepared');
    const staged = { ...prepared, phase: 'staged' as const };
    await journal.writePrepared(prepared, root);
    await journal.writeStaged(staged, root);

    await expect(journal.read(SESSION_ID, root)).resolves.toEqual({
      prepared,
      staged,
    });
    await expect(journal.listSessionIds()).resolves.toEqual([SESSION_ID]);

    await journal.clear(SESSION_ID, root);

    await expect(journal.read(SESSION_ID, root)).resolves.toBeUndefined();
  });

  it('rejects journal directory replacement while clearing phases', async (ctx) => {
    const root = await workspace.getRoot();
    const prepared = await makeRecord('prepared');
    await journal.writePrepared(prepared, root);
    const journalDirectory = path.dirname(journalPath('prepared'));
    const journalStats = await fs.lstat(journalDirectory, { bigint: true });
    if (journalStats.ino === 0n) {
      ctx.skip();
      return;
    }
    const originalDirectory = `${journalDirectory}.original`;
    const originalOpen = openMock.getMockImplementation();
    if (!originalOpen) throw new Error('expected fs.open implementation');
    let replaced = false;
    openMock.mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === journalDirectory) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (!replaced) {
            replaced = true;
            await fs.rename(journalDirectory, originalDirectory);
            await fs.mkdir(journalDirectory, { mode: 0o700 });
          }
          await sync();
        };
      }
      return handle;
    });

    try {
      await expect(journal.clear(SESSION_ID, root)).rejects.toMatchObject({
        reason: 'compromised',
      });
      await expect(
        fs.lstat(
          path.join(originalDirectory, path.basename(journalPath('prepared'))),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      openMock.mockImplementation(originalOpen);
    }
  });

  it('refuses to overwrite an immutable prepared phase', async () => {
    const root = await workspace.getRoot();
    const record = await makeRecord('prepared');
    await journal.writePrepared(record, root);

    await expect(journal.writePrepared(record, root)).rejects.toMatchObject({
      reason: 'conflict',
    });
  });

  it('rejects a staged phase whose immutable fields differ', async () => {
    const root = await workspace.getRoot();
    const prepared = await makeRecord('prepared');
    await journal.writePrepared(prepared, root);

    await expect(
      journal.writeStaged(
        { ...prepared, phase: 'staged', transcriptLocation: 'archived' },
        root,
      ),
    ).rejects.toMatchObject({ reason: 'compromised' });
    await expect(fs.lstat(journalPath('staged'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a staged record without its prepared authorization', async () => {
    const root = await workspace.getRoot();
    const staged = await makeRecord('staged');
    await fs.mkdir(path.dirname(journalPath('staged')), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(journalPath('staged'), JSON.stringify(staged), {
      mode: 0o600,
    });

    await expect(journal.read(SESSION_ID, root)).rejects.toBeInstanceOf(
      StandaloneDeletionJournalError,
    );
  });

  it('rejects extra record keys and retains fail-closed presence', async () => {
    const root = await workspace.getRoot();
    const record = { ...(await makeRecord('prepared')), extra: true };
    await fs.mkdir(path.dirname(journalPath('prepared')), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(journalPath('prepared'), JSON.stringify(record), {
      mode: 0o600,
    });

    await expect(journal.hasRecord(SESSION_ID)).resolves.toBe(true);
    await expect(journal.read(SESSION_ID, root)).rejects.toMatchObject({
      reason: 'compromised',
    });
  });

  it('fails closed when the journal directory loses its private identity', async () => {
    if (process.platform === 'win32') return;
    const root = await workspace.getRoot();
    await journal.writePrepared(await makeRecord('prepared'), root);
    await fs.chmod(path.dirname(journalPath('prepared')), 0o755);

    await expect(journal.hasRecord(SESSION_ID)).rejects.toMatchObject({
      reason: 'compromised',
    });
    await expect(journal.read(SESSION_ID, root)).rejects.toMatchObject({
      reason: 'compromised',
    });
  });

  it('rejects a record tied to another root identity', async () => {
    const root = await workspace.getRoot();
    const record = await makeRecord('prepared');
    await journal.writePrepared(record, root);

    await expect(
      journal.read(SESSION_ID, { ...root, device: root.device + 1 }),
    ).rejects.toMatchObject({ reason: 'compromised' });
  });

  it('rejects a symlinked record', async () => {
    if (process.platform === 'win32') return;
    const root = await workspace.getRoot();
    const record = await makeRecord('prepared');
    const target = path.join(homeDir, 'foreign.json');
    await fs.writeFile(target, JSON.stringify(record), { mode: 0o600 });
    await fs.mkdir(path.dirname(journalPath('prepared')), {
      recursive: true,
      mode: 0o700,
    });
    await fs.symlink(target, journalPath('prepared'));

    await expect(journal.read(SESSION_ID, root)).rejects.toMatchObject({
      reason: 'compromised',
    });
  });

  it('lists only canonical phase files in sorted bounded order', async () => {
    const root = await workspace.getRoot();
    const secondId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const first = await makeRecord('prepared');
    const second: StandaloneDeletionRecordV2 = {
      ...first,
      sessionId: secondId,
      storageSessionId: secondId,
    };
    await journal.writePrepared(first, root);
    await journal.writePrepared(second, root);
    await fs.writeFile(
      path.join(path.dirname(journalPath('prepared')), '.unfinished.tmp'),
      'ignored',
    );

    await expect(journal.listSessionIds(1)).resolves.toEqual([SESSION_ID]);
  });

  it('rejects invalid caller ids before deriving a path', async () => {
    await expect(journal.hasRecord('../escape')).rejects.toMatchObject({
      reason: 'compromised',
    });
  });

  it('validates deterministic names for present directories', async () => {
    const root = await workspace.getRoot();
    const normalName = getConversationDirectoryName(SESSION_ID);
    const record = await makeRecord('prepared', {
      kind: 'present',
      normalName,
      stagedName: `${normalName}.deleting`,
      device: 1,
      inode: 2,
      inodeVerifiable: true,
    });

    await journal.writePrepared(record, root);

    await expect(journal.read(SESSION_ID, root)).resolves.toEqual({
      prepared: record,
    });
  });
});
