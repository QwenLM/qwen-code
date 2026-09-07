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

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  openMock.mockImplementation(actual.open);
  return { ...actual, open: openMock };
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

  it('rejects journal directory replacement during phase sync', async () => {
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

  it('retains a same-session fence until clear durability is confirmed', async () => {
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

      await expect(journal.clear(SESSION_ID, root)).resolves.toBeUndefined();
      await expect(journal.hasRecord(SESSION_ID)).resolves.toBe(false);
    } finally {
      openMock.mockImplementation(originalOpen);
    }
  });

  it('requires the journal owner directory to sync before writing a phase', async () => {
    const root = await workspace.getRoot();
    const record = await makeRecord('prepared');
    const ownerStats = await fs.stat(ownerDirectory);
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

  it('rejects journal directory replacement while clearing phases', async () => {
    const root = await workspace.getRoot();
    const prepared = await makeRecord('prepared');
    await journal.writePrepared(prepared, root);
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
