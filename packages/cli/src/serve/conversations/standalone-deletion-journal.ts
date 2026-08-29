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
  hasVerifiableInode,
  isSameConversationPath,
  normalizedInode,
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

export interface StandaloneDeletionTranscriptParentIdentity {
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

interface StandaloneDeletionRecordBase {
  phase: 'prepared' | 'staged';
  sessionId: string;
  storageSessionId: string;
  transcriptLocation: 'active' | 'archived';
  root: StandaloneDeletionRootIdentity;
  directory: StandaloneDeletionDirectory;
}

export interface StandaloneDeletionRecordV1
  extends StandaloneDeletionRecordBase {
  version: 1;
}

export interface StandaloneDeletionRecordV2
  extends StandaloneDeletionRecordBase {
  version: 2;
  transcriptParent: StandaloneDeletionTranscriptParentIdentity;
}

export type StandaloneDeletionRecord =
  | StandaloneDeletionRecordV1
  | StandaloneDeletionRecordV2;

export interface StandaloneDeletionJournalEntry {
  prepared: StandaloneDeletionRecord;
  staged?: StandaloneDeletionRecord;
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

interface DurableDirectory {
  path: string;
  identity: DirectoryIdentity;
  handle: fs.FileHandle;
}

interface PendingJournalClear {
  entry: StandaloneDeletionJournalEntry;
  directory: DurableDirectory;
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
): StandaloneDeletionRecord {
  const version = isRecord(value) ? value['version'] : undefined;
  if (
    !isRecord(value) ||
    (version !== 1 && version !== 2) ||
    !exactKeys(value, [
      'directory',
      'phase',
      'root',
      'sessionId',
      'storageSessionId',
      'transcriptLocation',
      ...(version === 2 ? ['transcriptParent'] : []),
      'version',
    ]) ||
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

  const transcriptParent =
    version === 2 ? parseIdentity(value['transcriptParent'], false) : undefined;
  if (version === 2) {
    if (
      !transcriptParent ||
      !isRecord(value['transcriptParent']) ||
      !exactKeys(value['transcriptParent'], [
        'device',
        'inode',
        'inodeVerifiable',
      ])
    ) {
      throw new StandaloneDeletionJournalError('compromised');
    }
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

  const base = {
    phase: expectedPhase,
    sessionId: expectedSessionId,
    storageSessionId: value['storageSessionId'],
    transcriptLocation: value['transcriptLocation'] as 'active' | 'archived',
    root,
    directory,
  };
  if (version === 1) return { version: 1, ...base };
  return {
    version: 2,
    ...base,
    transcriptParent: {
      device: transcriptParent!.device,
      inode: transcriptParent!.inode,
      inodeVerifiable: transcriptParent!.inodeVerifiable,
    },
  };
}

function sameImmutableRecord(
  prepared: StandaloneDeletionRecord,
  staged: StandaloneDeletionRecord,
): boolean {
  return (
    JSON.stringify({ ...prepared, phase: 'staged' }) === JSON.stringify(staged)
  );
}

export class StandaloneDeletionJournal {
  private readonly ownerDirectory: string;
  private readonly journalDirectory: string;
  private readonly pendingClears = new Map<string, PendingJournalClear>();

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
    if (this.pendingClears.has(sessionId)) return true;
    const identity = await this.inspectJournalDirectory();
    if (!identity) return false;
    const exists =
      (await this.pathExists(this.recordPath(sessionId, 'prepared'))) ||
      (await this.pathExists(this.recordPath(sessionId, 'staged')));
    await this.assertDirectoryIdentity(this.journalDirectory, identity);
    return exists;
  }

  async listSessionIds(limit = 32): Promise<string[]> {
    const ids = new Set(this.pendingClears.keys());
    const identity = await this.inspectJournalDirectory();
    if (!identity) {
      return [...ids].sort().slice(0, Math.max(0, limit));
    }
    let names: string[];
    try {
      names = await fs.readdir(this.journalDirectory);
    } catch (error) {
      if (isMissing(error)) {
        return [...ids].sort().slice(0, Math.max(0, limit));
      }
      throw error;
    }
    await this.assertDirectoryIdentity(this.journalDirectory, identity);
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
    const pending = this.pendingClears.get(sessionId);
    if (pending) {
      return this.validatePendingEntry(pending.entry, currentRoot);
    }
    const identity = await this.inspectJournalDirectory();
    if (!identity) return undefined;
    const prepared = await this.readPhase(sessionId, 'prepared', currentRoot);
    const staged = await this.readPhase(sessionId, 'staged', currentRoot);
    await this.assertDirectoryIdentity(this.journalDirectory, identity);
    if (!prepared && !staged) return undefined;
    if (!prepared || (staged && !sameImmutableRecord(prepared, staged))) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    return { prepared, ...(staged ? { staged } : {}) };
  }

  async writePrepared(
    record: StandaloneDeletionRecordV2,
    currentRoot: ConversationRootIdentity,
  ): Promise<void> {
    const validated = parseRecord(
      record,
      parseSessionId(record.sessionId),
      'prepared',
      currentRoot,
    );
    if (validated.version !== 2) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    if (await this.hasRecord(validated.sessionId)) {
      throw new StandaloneDeletionJournalError('conflict');
    }
    await this.writePhase(validated);
  }

  async writeStaged(
    record: StandaloneDeletionRecordV2,
    currentRoot: ConversationRootIdentity,
  ): Promise<void> {
    const sessionId = parseSessionId(record.sessionId);
    const validated = parseRecord(record, sessionId, 'staged', currentRoot);
    if (validated.version !== 2) {
      throw new StandaloneDeletionJournalError('compromised');
    }
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
    const pending = this.pendingClears.get(sessionId);
    if (pending) {
      this.validatePendingEntry(pending.entry, currentRoot);
      await this.syncDurableDirectory(pending.directory);
      this.pendingClears.delete(sessionId);
      await pending.directory.handle.close().catch(() => undefined);
      return;
    }
    const existing = await this.read(sessionId, currentRoot);
    if (!existing) return;
    const identity = await this.inspectJournalDirectory();
    if (!identity) throw new StandaloneDeletionJournalError('compromised');
    const directory = await this.openDurableDirectory(
      this.journalDirectory,
      identity,
    );
    let unlinksComplete = false;
    let retained = false;
    try {
      await this.assertDirectoryIdentity(this.journalDirectory, identity);
      await this.unlinkIfExists(this.recordPath(sessionId, 'staged'));
      await this.unlinkIfExists(this.recordPath(sessionId, 'prepared'));
      unlinksComplete = true;
      await this.syncDurableDirectory(directory);
    } catch (error) {
      if (unlinksComplete) {
        this.pendingClears.set(sessionId, { entry: existing, directory });
        retained = true;
      }
      throw error;
    } finally {
      if (!retained) {
        await directory.handle.close().catch(() => undefined);
      }
    }
  }

  private validatePendingEntry(
    entry: StandaloneDeletionJournalEntry,
    currentRoot: ConversationRootIdentity,
  ): StandaloneDeletionJournalEntry {
    const sessionId = entry.prepared.sessionId;
    const prepared = parseRecord(
      entry.prepared,
      sessionId,
      'prepared',
      currentRoot,
    );
    const staged = entry.staged
      ? parseRecord(entry.staged, sessionId, 'staged', currentRoot)
      : undefined;
    if (staged && !sameImmutableRecord(prepared, staged)) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    return { prepared, ...(staged ? { staged } : {}) };
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
  ): Promise<StandaloneDeletionRecord | undefined> {
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

  private async writePhase(record: StandaloneDeletionRecordV2): Promise<void> {
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
    const directory = await this.openDurableDirectory(
      this.journalDirectory,
      identity,
    );
    let handle: fs.FileHandle | undefined;
    try {
      await this.assertDirectoryIdentity(this.journalDirectory, identity);
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
      await this.syncDurableDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new StandaloneDeletionJournalError('conflict');
      }
      throw error;
    } finally {
      await directory.handle.close().catch(() => undefined);
    }
  }

  private async ensureJournalDirectory(): Promise<DirectoryIdentity> {
    const owner = await this.inspectPrivateDirectory(this.ownerDirectory);
    const ownerHandle = await this.openDurableDirectory(
      this.ownerDirectory,
      owner,
    );
    try {
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
      await this.syncDurableDirectory(ownerHandle);
    } finally {
      await ownerHandle.handle.close().catch(() => undefined);
    }
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
      inode: normalizedInode(stat.ino),
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

  private async openDurableDirectory(
    directory: string,
    expected: DirectoryIdentity,
  ): Promise<DurableDirectory> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(
        directory,
        fsConstants.O_RDONLY |
          (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0)),
      );
      const opened = await handle.stat();
      const openedIdentity = {
        device: opened.dev,
        inode: normalizedInode(opened.ino),
        inodeVerifiable: hasVerifiableInode(opened.ino),
      };
      if (
        !opened.isDirectory() ||
        !sameDirectoryIdentity(openedIdentity, expected)
      ) {
        throw new StandaloneDeletionJournalError('compromised');
      }
      await this.assertDirectoryIdentity(directory, expected);
      return { path: directory, identity: expected, handle };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new StandaloneDeletionJournalError('compromised');
      }
      throw error;
    }
  }

  private async syncDurableDirectory(
    directory: DurableDirectory,
  ): Promise<void> {
    const opened = await directory.handle.stat();
    const openedIdentity = {
      device: opened.dev,
      inode: normalizedInode(opened.ino),
      inodeVerifiable: hasVerifiableInode(opened.ino),
    };
    if (
      !opened.isDirectory() ||
      !sameDirectoryIdentity(openedIdentity, directory.identity)
    ) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    try {
      await directory.handle.sync();
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !['EACCES', 'EINVAL', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      ) {
        throw error;
      }
    }
    await this.assertDirectoryIdentity(directory.path, directory.identity);
  }
}
