/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConversationDirectoryName } from '../../utils/conversation-directory-identity.js';
import { ConversationWorkspace } from './conversation-workspace.js';
import {
  StandaloneDeletionJournal,
  StandaloneDeletionJournalError,
  type StandaloneDeletionRecordV1,
} from './standalone-deletion-journal.js';

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
    directory: StandaloneDeletionRecordV1['directory'] = { kind: 'absent' },
  ): Promise<StandaloneDeletionRecordV1> => {
    const root = await workspace.getRoot();
    return {
      version: 1,
      phase,
      sessionId: SESSION_ID,
      storageSessionId: SESSION_ID.toUpperCase(),
      transcriptLocation: 'active',
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
    const second: StandaloneDeletionRecordV1 = {
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
