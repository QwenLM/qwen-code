/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseCallerSuppliedSessionId } from '../../config/session-id.js';
import {
  getConversationDirectoryName,
  isSameConversationPath,
  type ConversationRootIdentity,
} from '../../utils/conversation-directory-identity.js';

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

// The journal's internal identity pair. These are IN-MEMORY only (cached in
// `directoryIdentities` and carried by open durable-directory handles) —
// never serialised into a record — so they keep the filesystem's ids as
// bigints: exact end to end on volumes whose 64-bit file ids exceed the JS
// safe-integer range (NTFS), where a number-backed `Stats` would round two
// distinct directories into one identity and the swap checks below would
// compare a private replacement tree EQUAL to the real one (#11848).
// `inodeVerifiable` is `ino !== 0n` — with exact ids the only unverifiable
// case left is a volume reporting no id at all (FAT/exFAT/SMB-style).
interface DirectoryIdentity {
  device: bigint;
  inode: bigint;
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

// Verifiability is the bigint non-zero rule: with `{ bigint: true }` stats
// the filesystem's id is exact, so only a volume reporting no id at all
// (`ino === 0` — FAT/exFAT/SMB-style) is unverifiable. On such a volume the
// comparator above degrades to device-only, so ANY two same-device journal
// directories compare equal — an accepted fail-open, since refusing there
// would make the journal unusable on those volumes altogether.
//
// The rule is restated here rather than called, and both alternatives are
// deliberate (this restatement is listed in the ledger at the cli
// predicate's declaration site, utils/conversation-directory-identity.ts):
// - core's `hasVerifiableInode` (packages/core/src/utils/file-identity.ts)
//   states the same non-zero rule and accepts `number | bigint`, but this
//   module is loaded from the serve entry and keeps core out of its import
//   graph — the bundle-closure trade-off serve/managed-scratch-workspace.ts
//   records for that very predicate;
// - the cli's number-typed predicate of the same name is a DIFFERENT rule
//   (`Number.isSafeInteger(ino) && ino > 0`). Applying it to the exact
//   bigint ids this module now stats would report every >2^53 NTFS id
//   unverifiable and re-open #11848.
function directoryIdentityOf(stat: BigIntStats): DirectoryIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    inodeVerifiable: stat.ino !== 0n,
  };
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
  private readonly stateDirectory: string;
  private readonly journalDirectory: string;
  private readonly directoryIdentities = new Map<string, DirectoryIdentity>();
  private canonicalBaseDir?: string;
  private readonly pendingClears = new Map<string, PendingJournalClear>();

  constructor(private readonly stableBaseDir: string) {
    if (!path.isAbsolute(stableBaseDir)) {
      throw new TypeError('Standalone deletion journal base must be absolute.');
    }
    this.stateDirectory = path.join(stableBaseDir, 'conversations');
    this.journalDirectory = path.join(this.stateDirectory, JOURNAL_DIRECTORY);
  }

  async hasRecord(rawSessionId: string): Promise<boolean> {
    const sessionId = parseSessionId(rawSessionId);
    const identity = await this.inspectJournalDirectory();
    if (this.pendingClears.has(sessionId)) return true;
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
    const identity = await this.inspectJournalDirectory();
    const pending = this.pendingClears.get(sessionId);
    if (pending) {
      return this.validatePendingEntry(pending.entry, currentRoot);
    }
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
    await this.inspectJournalDirectory();
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
    await this.ensureStateDirectory(this.stableBaseDir, false);
    const owner = await this.ensureStateDirectory(this.stateDirectory, true);
    const ownerHandle = await this.openDurableDirectory(
      this.stateDirectory,
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
    return (await this.inspectJournalDirectory())!;
  }

  private async ensureStateDirectory(
    directory: string,
    requirePrivate: boolean,
  ): Promise<DirectoryIdentity> {
    try {
      return await this.inspectPrivateDirectory(directory, requirePrivate);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new StandaloneDeletionJournalError('compromised');
    const before = await this.ensureStateDirectory(parent, false);
    let created = false;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (created && process.platform !== 'win32')
      await fs.chmod(directory, 0o700);
    const after = await this.inspectPrivateDirectory(parent, false);
    if (!sameDirectoryIdentity(before, after)) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    const handle = await fs.open(parent, fsConstants.O_RDONLY);
    try {
      if (process.platform !== 'win32') await handle.sync();
    } finally {
      await handle.close();
    }
    return this.inspectPrivateDirectory(directory, requirePrivate);
  }

  private async inspectStateParent(): Promise<void> {
    await this.inspectPrivateDirectory(this.stableBaseDir, false);
    const canonical = await fs.realpath(this.stableBaseDir);
    if (
      this.canonicalBaseDir !== undefined &&
      this.canonicalBaseDir !== canonical
    ) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    this.canonicalBaseDir = canonical;
    await this.inspectPrivateDirectory(this.stateDirectory);
  }

  private async inspectJournalDirectory(): Promise<
    DirectoryIdentity | undefined
  > {
    try {
      await this.inspectStateParent();
      return await this.inspectPrivateDirectory(this.journalDirectory);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private async inspectPrivateDirectory(
    directory: string,
    requirePrivate = true,
  ): Promise<DirectoryIdentity> {
    // `{ bigint: true }`: the swap checks keyed off this identity must see
    // a 64-bit NTFS file id exactly — a number-backed `Stats` rounds it,
    // `hasVerifiableInode` then reports false on both sides of a comparison,
    // and a complete private replacement of the journal tree compares EQUAL
    // to the original (#11848).
    let stat: BigIntStats;
    try {
      stat = await fs.lstat(directory, { bigint: true });
    } catch (error) {
      if (isMissing(error) && this.directoryIdentities.has(directory)) {
        throw new StandaloneDeletionJournalError('compromised');
      }
      throw error;
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((requirePrivate && (stat.mode & 0o777n) !== 0o700n) ||
          (typeof process.getuid === 'function' &&
            stat.uid !== BigInt(process.getuid()))))
    ) {
      throw new StandaloneDeletionJournalError('compromised');
    }
    const identity = directoryIdentityOf(stat);
    if (
      directory === this.stableBaseDir ||
      directory === this.stateDirectory ||
      directory === this.journalDirectory
    ) {
      const expected = this.directoryIdentities.get(directory);
      if (expected && !sameDirectoryIdentity(identity, expected)) {
        throw new StandaloneDeletionJournalError('compromised');
      }
      this.directoryIdentities.set(directory, identity);
    }
    return identity;
  }

  private async assertDirectoryIdentity(
    directory: string,
    expected: DirectoryIdentity,
  ): Promise<void> {
    await this.inspectStateParent();
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
      const opened = await handle.stat({ bigint: true });
      const openedIdentity = directoryIdentityOf(opened);
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
    const opened = await directory.handle.stat({ bigint: true });
    const openedIdentity = directoryIdentityOf(opened);
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
