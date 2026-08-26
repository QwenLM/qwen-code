/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseCallerSuppliedSessionId } from '../../config/session-id.js';
import {
  getConversationDirectoryName,
  isSameConversationPath,
  type ConversationRootIdentity,
} from '../../utils/conversation-directory-identity.js';
import { getConversationRuntimeOwnerPath } from './conversation-runtime-ownership.js';

const JOURNAL_DIRECTORY = 'deletions';
const MAX_RECORD_BYTES = 8 * 1024;
const STORAGE_SESSION_ID_PATTERN = /^[0-9a-fA-F-]{32,36}$/;
const JOURNAL_FILE_PATTERN =
  /^delete-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(prepared|staged)\.json$/;

export interface StandaloneDeletionRootIdentity {
  canonicalPath: string;
  device: number;
  inode: number;
  inodeVerifiable: boolean;
}

export type StandaloneDeletionDirectory =
  | { kind: 'absent' }
  | {
      kind: 'present';
      normalName: string;
      stagedName: string;
      device: number;
      inode: number;
      inodeVerifiable: boolean;
    };

export interface StandaloneDeletionRecordV1 {
  version: 1;
  phase: 'prepared' | 'staged';
  sessionId: string;
  storageSessionId: string;
  transcriptLocation: 'active' | 'archived';
  root: StandaloneDeletionRootIdentity;
  directory: StandaloneDeletionDirectory;
}

export interface StandaloneDeletionJournalEntry {
  prepared: StandaloneDeletionRecordV1;
  staged?: StandaloneDeletionRecordV1;
}

export type StandaloneDeletionJournalErrorReason = 'conflict' | 'compromised';

export class StandaloneDeletionJournalError extends Error {
  override readonly name = 'StandaloneDeletionJournalError';

  constructor(readonly reason: StandaloneDeletionJournalErrorReason) {
    super(`Standalone deletion journal is ${reason}.`);
  }
}

interface DirectoryIdentity {
  device: number;
  inode: number;
  inodeVerifiable: boolean;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function parseSessionId(value: string): string {
  const parsed = parseCallerSuppliedSessionId(value);
  if (parsed.kind !== 'valid') {
    throw new StandaloneDeletionJournalError('compromised');
  }
  return parsed.sessionId;
}

function hasVerifiableInode(inode: number): boolean {
  return inode !== 0;
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inodeVerifiable === right.inodeVerifiable &&
    (!left.inodeVerifiable || left.inode === right.inode)
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentityNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseIdentity(
  value: unknown,
  pathField: boolean,
): StandaloneDeletionRootIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isIdentityNumber(value['device']) ||
    !isIdentityNumber(value['inode']) ||
    typeof value['inodeVerifiable'] !== 'boolean' ||
    (value['inodeVerifiable'] ? value['inode'] === 0 : value['inode'] !== 0)
  ) {
    return undefined;
  }
  if (
    pathField &&
    (typeof value['canonicalPath'] !== 'string' ||
      value['canonicalPath'].length === 0 ||
      value['canonicalPath'].length > 4096 ||
      !path.isAbsolute(value['canonicalPath']))
  ) {
    return undefined;
  }
  return {
    canonicalPath: pathField ? (value['canonicalPath'] as string) : '',
    device: value['device'],
    inode: value['inode'],
    inodeVerifiable: value['inodeVerifiable'],
  };
}

function parseRecord(
  value: unknown,
  expectedSessionId: string,
  expectedPhase: 'prepared' | 'staged',
  currentRoot: ConversationRootIdentity,
): StandaloneDeletionRecordV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'directory',
      'phase',
      'root',
      'sessionId',
      'storageSessionId',
      'transcriptLocation',
      'version',
    ]) ||
    value['version'] !== 1 ||
    value['phase'] !== expectedPhase ||
    value['sessionId'] !== expectedSessionId ||
    typeof value['storageSessionId'] !== 'string' ||
    !STORAGE_SESSION_ID_PATTERN.test(value['storageSessionId']) ||
    value['storageSessionId'].toLowerCase() !== expectedSessionId ||
    (value['transcriptLocation'] !== 'active' &&
      value['transcriptLocation'] !== 'archived')
  ) {
    throw new StandaloneDeletionJournalError('compromised');
  }

  const root = parseIdentity(value['root'], true);
  if (
    !root ||
    !isRecord(value['root']) ||
    !exactKeys(value['root'], [
      'canonicalPath',
      'device',
      'inode',
      'inodeVerifiable',
    ]) ||
    !isSameConversationPath(root.canonicalPath, currentRoot.canonicalRoot) ||
    root.device !== currentRoot.device ||
    root.inodeVerifiable !== currentRoot.inodeVerifiable ||
    (root.inodeVerifiable && root.inode !== currentRoot.inode)
  ) {
    throw new StandaloneDeletionJournalError('compromised');
  }

  const rawDirectory = value['directory'];
  let directory: StandaloneDeletionDirectory;
  if (
    isRecord(rawDirectory) &&
    exactKeys(rawDirectory, ['kind']) &&
    rawDirectory['kind'] === 'absent'
  ) {
    directory = { kind: 'absent' };
  } else {
    const identity = parseIdentity(rawDirectory, false);
    const normalName = getConversationDirectoryName(expectedSessionId);
    if (
      !identity ||
      !isRecord(rawDirectory) ||
      !exactKeys(rawDirectory, [
        'device',
        'inode',
        'inodeVerifiable',
        'kind',
        'normalName',
        'stagedName',
      ]) ||
      rawDirectory['kind'] !== 'present' ||
      rawDirectory['normalName'] !== normalName ||
      rawDirectory['stagedName'] !== `${normalName}.deleting`
    ) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    directory = {
      kind: 'present',
      normalName,
      stagedName: `${normalName}.deleting`,
      device: identity.device,
      inode: identity.inode,
      inodeVerifiable: identity.inodeVerifiable,
    };
  }

  return {
    version: 1,
    phase: expectedPhase,
    sessionId: expectedSessionId,
    storageSessionId: value['storageSessionId'],
    transcriptLocation: value['transcriptLocation'],
    root,
    directory,
  };
}

function sameImmutableRecord(
  prepared: StandaloneDeletionRecordV1,
  staged: StandaloneDeletionRecordV1,
): boolean {
  return (
    JSON.stringify({ ...prepared, phase: 'staged' }) === JSON.stringify(staged)
  );
}

export class StandaloneDeletionJournal {
  private readonly ownerDirectory: string;
  private readonly journalDirectory: string;

  constructor(stableBaseDir: string) {
    if (!path.isAbsolute(stableBaseDir)) {
      throw new TypeError('Standalone deletion journal base must be absolute.');
    }
    this.ownerDirectory = path.dirname(
      getConversationRuntimeOwnerPath(stableBaseDir),
    );
    this.journalDirectory = path.join(this.ownerDirectory, JOURNAL_DIRECTORY);
  }

  async hasRecord(rawSessionId: string): Promise<boolean> {
    const sessionId = parseSessionId(rawSessionId);
    return (
      (await this.pathExists(this.recordPath(sessionId, 'prepared'))) ||
      (await this.pathExists(this.recordPath(sessionId, 'staged')))
    );
  }

  async listSessionIds(limit = 32): Promise<string[]> {
    const identity = await this.inspectJournalDirectory();
    if (!identity) return [];
    let names: string[];
    try {
      names = await fs.readdir(this.journalDirectory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    await this.assertDirectoryIdentity(this.journalDirectory, identity);
    const ids = new Set<string>();
    for (const name of names) {
      const match = JOURNAL_FILE_PATTERN.exec(name);
      if (match?.[1]) ids.add(match[1]);
    }
    return [...ids].sort().slice(0, Math.max(0, limit));
  }

  async read(
    rawSessionId: string,
    currentRoot: ConversationRootIdentity,
  ): Promise<StandaloneDeletionJournalEntry | undefined> {
    const sessionId = parseSessionId(rawSessionId);
    const prepared = await this.readPhase(sessionId, 'prepared', currentRoot);
    const staged = await this.readPhase(sessionId, 'staged', currentRoot);
    if (!prepared && !staged) return undefined;
    if (!prepared || (staged && !sameImmutableRecord(prepared, staged))) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    return { prepared, ...(staged ? { staged } : {}) };
  }

  async writePrepared(
    record: StandaloneDeletionRecordV1,
    currentRoot: ConversationRootIdentity,
  ): Promise<void> {
    const validated = parseRecord(
      record,
      parseSessionId(record.sessionId),
      'prepared',
      currentRoot,
    );
    if (await this.hasRecord(validated.sessionId)) {
      throw new StandaloneDeletionJournalError('conflict');
    }
    await this.writePhase(validated);
  }

  async writeStaged(
    record: StandaloneDeletionRecordV1,
    currentRoot: ConversationRootIdentity,
  ): Promise<void> {
    const sessionId = parseSessionId(record.sessionId);
    const validated = parseRecord(record, sessionId, 'staged', currentRoot);
    const existing = await this.read(sessionId, currentRoot);
    if (!existing || existing.staged) {
      throw new StandaloneDeletionJournalError('conflict');
    }
    if (!sameImmutableRecord(existing.prepared, validated)) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    await this.writePhase(validated);
  }

  async clear(
    rawSessionId: string,
    currentRoot: ConversationRootIdentity,
  ): Promise<void> {
    const sessionId = parseSessionId(rawSessionId);
    const existing = await this.read(sessionId, currentRoot);
    if (!existing) return;
    const identity = await this.inspectJournalDirectory();
    if (!identity) throw new StandaloneDeletionJournalError('compromised');
    await this.unlinkIfExists(this.recordPath(sessionId, 'staged'));
    await this.unlinkIfExists(this.recordPath(sessionId, 'prepared'));
    await this.assertDirectoryIdentity(this.journalDirectory, identity);
    await this.syncDirectory();
  }

  private recordPath(sessionId: string, phase: 'prepared' | 'staged'): string {
    return path.join(
      this.journalDirectory,
      `delete-${sessionId}.${phase}.json`,
    );
  }

  private async readPhase(
    sessionId: string,
    phase: 'prepared' | 'staged',
    currentRoot: ConversationRootIdentity,
  ): Promise<StandaloneDeletionRecordV1 | undefined> {
    const filePath = this.recordPath(sessionId, phase);
    let pathStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      pathStat = await fs.lstat(filePath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    this.assertRecordFile(pathStat);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(
        filePath,
        fsConstants.O_RDONLY |
          (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new StandaloneDeletionJournalError('compromised');
      }
      throw error;
    }
    try {
      const handleStat = await handle.stat();
      this.assertRecordFile(handleStat);
      if (
        handleStat.dev !== pathStat.dev ||
        handleStat.ino !== pathStat.ino ||
        handleStat.size !== pathStat.size
      ) {
        throw new StandaloneDeletionJournalError('compromised');
      }
      const serialized = await handle.readFile('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        throw new StandaloneDeletionJournalError('compromised');
      }
      return parseRecord(parsed, sessionId, phase, currentRoot);
    } finally {
      await handle.close();
    }
  }

  private async writePhase(record: StandaloneDeletionRecordV1): Promise<void> {
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    const identity = await this.ensureJournalDirectory();
    const target = this.recordPath(record.sessionId, record.phase);
    await this.assertPathAbsent(target);
    const temporary = path.join(
      this.journalDirectory,
      `.${path.basename(target)}.${randomUUID()}.tmp`,
    );
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(
        temporary,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0)),
        0o600,
      );
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.assertDirectoryIdentity(this.journalDirectory, identity);
      await this.assertPathAbsent(target);
      await fs.rename(temporary, target);
      if (process.platform !== 'win32') await fs.chmod(target, 0o600);
      await this.assertDirectoryIdentity(this.journalDirectory, identity);
      await this.syncDirectory();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new StandaloneDeletionJournalError('conflict');
      }
      throw error;
    }
  }

  private async ensureJournalDirectory(): Promise<DirectoryIdentity> {
    const owner = await this.inspectPrivateDirectory(this.ownerDirectory);
    let created = false;
    try {
      await fs.mkdir(this.journalDirectory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (created && process.platform !== 'win32') {
      await fs.chmod(this.journalDirectory, 0o700);
    }
    await this.assertDirectoryIdentity(this.ownerDirectory, owner);
    return this.inspectPrivateDirectory(this.journalDirectory);
  }

  private async inspectJournalDirectory(): Promise<
    DirectoryIdentity | undefined
  > {
    try {
      return await this.inspectPrivateDirectory(this.journalDirectory);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async inspectPrivateDirectory(
    directory: string,
  ): Promise<DirectoryIdentity> {
    const stat = await fs.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((stat.mode & 0o777) !== 0o700 ||
          (typeof process.getuid === 'function' &&
            stat.uid !== process.getuid())))
    ) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    return {
      device: stat.dev,
      inode: stat.ino,
      inodeVerifiable: hasVerifiableInode(stat.ino),
    };
  }

  private async assertDirectoryIdentity(
    directory: string,
    expected: DirectoryIdentity,
  ): Promise<void> {
    const current = await this.inspectPrivateDirectory(directory);
    if (!sameDirectoryIdentity(current, expected)) {
      throw new StandaloneDeletionJournalError('compromised');
    }
  }

  private assertRecordFile(stat: Awaited<ReturnType<typeof fs.lstat>>): void {
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size <= 0 ||
      stat.size > MAX_RECORD_BYTES ||
      (process.platform !== 'win32' &&
        ((Number(stat.mode) & 0o777) !== 0o600 ||
          (typeof process.getuid === 'function' &&
            stat.uid !== process.getuid())))
    ) {
      throw new StandaloneDeletionJournalError('compromised');
    }
  }

  private async assertPathAbsent(filePath: string): Promise<void> {
    try {
      await fs.lstat(filePath);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    throw new StandaloneDeletionJournalError('conflict');
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.lstat(filePath);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async unlinkIfExists(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async syncDirectory(): Promise<void> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.journalDirectory, fsConstants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !['EACCES', 'EINVAL', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      ) {
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
