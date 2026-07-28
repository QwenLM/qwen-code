/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';

const LOCK_SCHEMA_VERSION = 1;
const MALFORMED_RETRY_COUNT = 3;
const MALFORMED_RETRY_DELAY_MS = 50;
const RELEASE_PRECHECK_ATTEMPTS = 3;
const RELEASE_PRECHECK_RETRY_DELAY_MS = 50;
const ACQUIRE_ATTEMPTS = 8;
const TRANSCRIPT_SNAPSHOT_ATTEMPTS = 3;
const TRANSCRIPT_HASH_BUFFER_BYTES = 1024 * 1024;
const TRANSCRIPT_NO_FOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;
const TRANSCRIPT_NONBLOCK_FLAG = fsConstants.O_NONBLOCK ?? 0;
const TRANSCRIPT_READ_FLAGS =
  fsConstants.O_RDONLY | TRANSCRIPT_NO_FOLLOW_FLAG | TRANSCRIPT_NONBLOCK_FLAG;
const TRANSCRIPT_APPEND_FLAGS =
  fsConstants.O_APPEND |
  fsConstants.O_RDWR |
  TRANSCRIPT_NO_FOLLOW_FLAG |
  TRANSCRIPT_NONBLOCK_FLAG;
const debugLogger = createDebugLogger('SESSION_WRITER_LEASE');

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return `${error.name}: ${error.message}${code ? ` code=${code}` : ''}`;
}

function describeDiagnosticError(error: unknown): string {
  const description = describeError(error);
  return error instanceof Error && error.cause !== undefined
    ? `${description} cause=${describeError(error.cause)}`
    : description;
}

export type SessionWriterProcessKind =
  | 'interactive'
  | 'acp'
  | 'daemon'
  | 'unknown';

export type SessionWriterErrorKind =
  | 'session_writer_conflict'
  | 'session_writer_lost'
  | 'session_transcript_changed'
  | 'session_writer_unavailable';

export abstract class SessionWriterError extends Error {
  abstract readonly rpcCode: number;
  abstract readonly errorKind: SessionWriterErrorKind;
  abstract readonly httpStatus: 409 | 503;
}

export const SESSION_WRITER_RPC_CODES = {
  session_writer_conflict: -32020,
  session_writer_lost: -32021,
  session_transcript_changed: -32022,
  session_writer_unavailable: -32023,
} as const;

export class SessionWriterConflictError extends SessionWriterError {
  override readonly name = 'SessionWriterConflictError';
  readonly rpcCode = SESSION_WRITER_RPC_CODES.session_writer_conflict;
  readonly errorKind = 'session_writer_conflict';
  readonly httpStatus = 409;

  constructor() {
    super('This session is already open in another Qwen process.');
  }
}

export class SessionWriterLostError extends SessionWriterError {
  override readonly name = 'SessionWriterLostError';
  readonly rpcCode = SESSION_WRITER_RPC_CODES.session_writer_lost;
  readonly errorKind = 'session_writer_lost';
  readonly httpStatus = 409;

  constructor() {
    super('Write ownership for this session was lost.');
  }
}

export class SessionTranscriptChangedError extends SessionWriterError {
  override readonly name = 'SessionTranscriptChangedError';
  readonly rpcCode = SESSION_WRITER_RPC_CODES.session_transcript_changed;
  readonly errorKind = 'session_transcript_changed';
  readonly httpStatus = 409;

  constructor() {
    super('The session transcript changed outside its active writer.');
  }
}

export class SessionWriterUnavailableError extends SessionWriterError {
  override readonly name = 'SessionWriterUnavailableError';
  readonly rpcCode = SESSION_WRITER_RPC_CODES.session_writer_unavailable;
  readonly errorKind = 'session_writer_unavailable';
  readonly httpStatus = 503;

  constructor(options?: ErrorOptions) {
    super('Session write ownership could not be verified.', options);
  }
}

interface SessionWriterLockRecord {
  schema_version: number;
  session_id: string;
  owner_id: string;
  pid: number;
  process_start_identity?: string;
  hostname: string;
  process_kind: SessionWriterProcessKind;
  acquired_at: string;
  qwen_version: string | null;
}

export interface AcquireSessionWriterLeaseOptions {
  runtimeBaseDir: string;
  sessionId: string;
  transcriptPath: string;
  processKind?: SessionWriterProcessKind;
  qwenVersion?: string | null;
  reclaimPolicy?: 'local' | 'never';
  onOwnershipAcquired?: (lease: SessionWriterLease) => void;
}

type ExistingLockState =
  | { kind: 'missing' }
  | { kind: 'live' }
  | { kind: 'stale'; record: SessionWriterLockRecord }
  | { kind: 'malformed' };

interface TranscriptFingerprint {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  birthtimeMs: number;
  ctimeMs: number;
  mtimeMs: number;
}

type TranscriptState =
  | { exists: false; byteLength: 0 }
  | {
      exists: true;
      byteLength: number;
      fingerprint: TranscriptFingerprint;
    };

interface TranscriptSnapshot {
  state: TranscriptState;
  hasher: Hash;
  attempts: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function execFileText(
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          encoding: 'utf8',
          timeout: 1_000,
          windowsHide: true,
          ...(env ? { env } : {}),
        },
        (error, stdout) => {
          const value = stdout.trim();
          resolve(error || value.length === 0 ? null : value);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const [stat, bootId] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
        fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      const fields = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/);
      const startTicks = fields[19];
      if (
        !startTicks ||
        !/^\d+$/.test(startTicks) ||
        !/^[0-9a-f-]+$/i.test(bootId.trim())
      ) {
        return null;
      }
      return `linux:${bootId.trim()}:${startTicks}`;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const startedAt = await execFileText(
      '/bin/ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    );
    return startedAt ? `darwin:${startedAt}` : null;
  }
  if (process.platform === 'win32') {
    const startedAt = await execFileText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$targetProcess = Get-Process -Id ${pid} -ErrorAction Stop; $targetProcess.StartTime.ToUniversalTime().Ticks`,
    ]);
    return startedAt && /^\d+$/.test(startedAt) ? `win32:${startedAt}` : null;
  }
  return null;
}

function isLockRecord(value: unknown): value is SessionWriterLockRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const processKind = record['process_kind'];
  return (
    record['schema_version'] === LOCK_SCHEMA_VERSION &&
    typeof record['session_id'] === 'string' &&
    record['session_id'].length > 0 &&
    typeof record['owner_id'] === 'string' &&
    record['owner_id'].length > 0 &&
    Number.isInteger(record['pid']) &&
    (record['pid'] as number) > 0 &&
    (record['process_start_identity'] === undefined ||
      (typeof record['process_start_identity'] === 'string' &&
        record['process_start_identity'].length > 0)) &&
    typeof record['hostname'] === 'string' &&
    record['hostname'].length > 0 &&
    typeof processKind === 'string' &&
    ['interactive', 'acp', 'daemon', 'unknown'].includes(processKind) &&
    typeof record['acquired_at'] === 'string' &&
    Number.isFinite(Date.parse(record['acquired_at'])) &&
    (record['qwen_version'] === null ||
      typeof record['qwen_version'] === 'string')
  );
}

function parseLockRecord(raw: string): SessionWriterLockRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isLockRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function lockStateForRecord(
  record: SessionWriterLockRecord,
): Promise<ExistingLockState> {
  if (record.hostname !== os.hostname()) return { kind: 'live' };
  if (!isProcessAlive(record.pid)) return { kind: 'stale', record };
  if (!record.process_start_identity) return { kind: 'live' };
  const currentStartIdentity = await readProcessStartIdentity(record.pid);
  return currentStartIdentity !== null &&
    currentStartIdentity !== record.process_start_identity
    ? { kind: 'stale', record }
    : { kind: 'live' };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function transcriptFingerprint(stat: Stats): TranscriptFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    nlink: stat.nlink,
    birthtimeMs: stat.birthtimeMs,
    ctimeMs: stat.ctimeMs,
    mtimeMs: stat.mtimeMs,
  };
}

function sameFileIdentity(
  left: TranscriptFingerprint,
  right: TranscriptFingerprint,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSecurityMetadata(
  left: TranscriptFingerprint,
  right: TranscriptFingerprint,
): boolean {
  return (
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

function sameHardTranscriptState(
  left: TranscriptState,
  right: TranscriptState,
): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return (
    left.byteLength === right.byteLength &&
    sameFileIdentity(left.fingerprint, right.fingerprint) &&
    sameFileSecurityMetadata(left.fingerprint, right.fingerprint)
  );
}

function sameTranscriptState(
  left: TranscriptState,
  right: TranscriptState,
): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return (
    sameHardTranscriptState(left, right) &&
    left.fingerprint.birthtimeMs === right.fingerprint.birthtimeMs &&
    left.fingerprint.ctimeMs === right.fingerprint.ctimeMs &&
    left.fingerprint.mtimeMs === right.fingerprint.mtimeMs
  );
}

function transcriptStateFromStat(
  stat: Stats,
): Extract<TranscriptState, { exists: true }> {
  return {
    exists: true,
    byteLength: stat.size,
    fingerprint: transcriptFingerprint(stat),
  };
}

function transcriptStateChangedFields(
  left: TranscriptState,
  right: TranscriptState,
): string[] {
  if (left.exists !== right.exists) return ['exists'];
  if (!left.exists || !right.exists) return [];
  const fields: string[] = [];
  if (left.byteLength !== right.byteLength) fields.push('byteLength');
  const fingerprintFields = [
    'dev',
    'ino',
    'mode',
    'uid',
    'gid',
    'nlink',
    'birthtimeMs',
    'ctimeMs',
    'mtimeMs',
  ] as const;
  for (const field of fingerprintFields) {
    if (left.fingerprint[field] !== right.fingerprint[field]) {
      fields.push(field);
    }
  }
  return fields;
}

function transcriptHashesEqual(left: Hash, right: Hash): boolean {
  return left.copy().digest().equals(right.copy().digest());
}

async function getOpenTranscriptState(
  filePath: string,
  handle: fs.FileHandle,
  invalidPathIsChange: boolean,
): Promise<Extract<TranscriptState, { exists: true }>> {
  let handleStat: Stats;
  try {
    handleStat = await handle.stat();
  } catch (error) {
    if (
      invalidPathIsChange &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      throw new SessionTranscriptChangedError();
    }
    throw error;
  }
  if (!handleStat.isFile()) {
    if (invalidPathIsChange) throw new SessionTranscriptChangedError();
    throw new SessionWriterUnavailableError();
  }
  if (handleStat.size > 0) {
    const lastByte = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(
      lastByte,
      0,
      1,
      handleStat.size - 1,
    );
    if (bytesRead !== 1 || lastByte[0] !== 0x0a) {
      throw new SessionTranscriptChangedError();
    }
  }
  let pathStat: Stats;
  try {
    pathStat = await fs.lstat(filePath);
  } catch (error) {
    if (
      invalidPathIsChange &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      throw new SessionTranscriptChangedError();
    }
    throw error;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    if (invalidPathIsChange) throw new SessionTranscriptChangedError();
    throw new SessionWriterUnavailableError();
  }
  const handleState = transcriptStateFromStat(handleStat);
  const pathState = transcriptStateFromStat(pathStat);
  if (!sameHardTranscriptState(handleState, pathState)) {
    throw new SessionTranscriptChangedError();
  }
  return pathState;
}

async function inspectTranscriptPath(
  filePath: string,
  invalidPathIsChange: boolean,
): Promise<TranscriptState> {
  let stat: Stats;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, byteLength: 0 };
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    if (invalidPathIsChange) throw new SessionTranscriptChangedError();
    throw new SessionWriterUnavailableError();
  }
  return transcriptStateFromStat(stat);
}

async function openTranscriptForRead(
  filePath: string,
  expectedState: TranscriptState | undefined,
): Promise<fs.FileHandle | undefined> {
  const pathState = await inspectTranscriptPath(
    filePath,
    expectedState !== undefined,
  );
  if (expectedState && !sameHardTranscriptState(pathState, expectedState)) {
    throw new SessionTranscriptChangedError();
  }
  if (!pathState.exists) return undefined;

  try {
    return await fs.open(filePath, TRANSCRIPT_READ_FLAGS);
  } catch (error) {
    if (expectedState !== undefined) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ELOOP') {
        throw new SessionTranscriptChangedError();
      }
      const currentState = await inspectTranscriptPath(filePath, true);
      if (!sameHardTranscriptState(currentState, expectedState)) {
        throw new SessionTranscriptChangedError();
      }
    }
    throw error;
  }
}

async function openTranscriptForAppend(
  filePath: string,
  expectedState: TranscriptState,
): Promise<fs.FileHandle> {
  const pathState = await inspectTranscriptPath(filePath, true);
  if (!sameHardTranscriptState(pathState, expectedState)) {
    throw new SessionTranscriptChangedError();
  }

  try {
    const flags = expectedState.exists
      ? TRANSCRIPT_APPEND_FLAGS
      : TRANSCRIPT_APPEND_FLAGS | fsConstants.O_CREAT | fsConstants.O_EXCL;
    return await fs.open(filePath, flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOENT' || code === 'ELOOP') {
      throw new SessionTranscriptChangedError();
    }
    const currentState = await inspectTranscriptPath(filePath, true);
    if (!sameHardTranscriptState(currentState, expectedState)) {
      throw new SessionTranscriptChangedError();
    }
    throw error;
  }
}

async function getTranscriptState(
  filePath: string,
  expectedState: TranscriptState | undefined,
): Promise<TranscriptState> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await openTranscriptForRead(filePath, expectedState);
    if (!handle) return { exists: false, byteLength: 0 };
    return await getOpenTranscriptState(
      filePath,
      handle,
      expectedState !== undefined,
    );
  } catch (error) {
    if (error instanceof SessionWriterError) throw error;
    throw new SessionWriterUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function captureOpenTranscriptSnapshot(
  filePath: string,
  handle: fs.FileHandle,
  expectedState: TranscriptState | undefined,
  shouldAbort: () => boolean,
): Promise<TranscriptSnapshot> {
  let buffer: Buffer | undefined;
  for (let attempt = 1; attempt <= TRANSCRIPT_SNAPSHOT_ATTEMPTS; attempt++) {
    if (shouldAbort()) throw new SessionWriterLostError();
    const beforeState = await getOpenTranscriptState(
      filePath,
      handle,
      expectedState !== undefined,
    );
    if (expectedState && !sameHardTranscriptState(beforeState, expectedState)) {
      throw new SessionTranscriptChangedError();
    }

    buffer ??= Buffer.allocUnsafe(
      Math.min(TRANSCRIPT_HASH_BUFFER_BYTES, beforeState.byteLength),
    );
    const hasher = createHash('sha256');
    let position = 0;
    while (position < beforeState.byteLength) {
      if (shouldAbort()) throw new SessionWriterLostError();
      const length = Math.min(
        buffer.byteLength,
        beforeState.byteLength - position,
      );
      let chunkBytesRead = 0;
      while (chunkBytesRead < length) {
        if (shouldAbort()) throw new SessionWriterLostError();
        const { bytesRead } = await handle.read(
          buffer,
          chunkBytesRead,
          length - chunkBytesRead,
          position + chunkBytesRead,
        );
        if (bytesRead === 0) throw new SessionTranscriptChangedError();
        chunkBytesRead += bytesRead;
      }
      hasher.update(buffer.subarray(0, chunkBytesRead));
      position += chunkBytesRead;
    }

    if (shouldAbort()) throw new SessionWriterLostError();
    const afterState = await getOpenTranscriptState(
      filePath,
      handle,
      expectedState !== undefined,
    );
    if (!sameHardTranscriptState(beforeState, afterState)) {
      throw new SessionTranscriptChangedError();
    }
    if (sameTranscriptState(beforeState, afterState)) {
      return { state: afterState, hasher, attempts: attempt };
    }
    debugLogger.debug(
      `Session transcript snapshot retry attempt=${attempt} ` +
        `changedFields=${transcriptStateChangedFields(beforeState, afterState).join(',')}`,
    );
  }
  throw new SessionWriterUnavailableError({
    cause: new Error('Session transcript metadata did not stabilize'),
  });
}

async function captureTranscriptSnapshot(
  filePath: string,
  expectedState: TranscriptState | undefined,
  shouldAbort: () => boolean,
): Promise<TranscriptSnapshot> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await openTranscriptForRead(filePath, expectedState);
    if (!handle) {
      const missingState: TranscriptState = { exists: false, byteLength: 0 };
      if (
        expectedState &&
        !sameHardTranscriptState(missingState, expectedState)
      ) {
        throw new SessionTranscriptChangedError();
      }
      return {
        state: missingState,
        hasher: createHash('sha256'),
        attempts: 1,
      };
    }
    return await captureOpenTranscriptSnapshot(
      filePath,
      handle,
      expectedState,
      shouldAbort,
    );
  } catch (error) {
    if (error instanceof SessionWriterError) throw error;
    throw new SessionWriterUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function restoreMovedLock(
  movedPath: string,
  lockPath: string,
): Promise<void> {
  try {
    await fs.link(movedPath, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      await fs.unlink(movedPath).catch(() => {});
      return;
    }
    throw new SessionWriterUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
  await fs.unlink(movedPath).catch(() => {});
}

async function installLockRecord(
  lockPath: string,
  record: SessionWriterLockRecord,
): Promise<boolean> {
  const temporaryPath = `${lockPath}.${record.owner_id}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(record), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(temporaryPath, lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } catch (error) {
    if (error instanceof SessionWriterError) throw error;
    throw new SessionWriterUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function acquireReclaimGuard(
  lockPath: string,
  staleOwnerId: string,
  record: SessionWriterLockRecord,
  inspect: (
    lockPath: string,
    expectedSessionId: string,
  ) => Promise<ExistingLockState>,
): Promise<string> {
  const basePath = `${lockPath}.reclaim.${encodeURIComponent(staleOwnerId)}`;
  let guardPath = basePath;
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    if (await installLockRecord(guardPath, record)) return guardPath;
    const state = await inspect(guardPath, record.session_id);
    if (state.kind === 'missing') continue;
    if (state.kind === 'live') throw new SessionWriterUnavailableError();
    if (state.kind === 'malformed') {
      throw new SessionWriterUnavailableError();
    }
    guardPath = `${basePath}.${encodeURIComponent(state.record.owner_id)}`;
  }
  throw new SessionWriterUnavailableError();
}

async function removeOwnedLock(
  lockPath: string,
  ownerId: string,
): Promise<void> {
  const record = parseLockRecord(await fs.readFile(lockPath, 'utf8'));
  if (!record || record.owner_id !== ownerId) {
    throw new SessionWriterLostError();
  }
  await fs.unlink(lockPath);
}

export function getSessionWriterLockPath(
  runtimeBaseDir: string,
  sessionId: string,
): string {
  return path.join(
    runtimeBaseDir,
    'tmp',
    'session-writer-locks',
    `${encodeURIComponent(sessionId)}.lock`,
  );
}

export class SessionWriterLease {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly runtimeBaseDir: string;
  readonly transcriptPath: string;
  private expectedTranscriptState: TranscriptState | undefined;
  private expectedTranscriptHasher: Hash | undefined;
  private released = false;
  private releasePromise: Promise<void> | undefined;
  private readonly lockRecordRaw: string;
  private readonly retiredPath: string;

  private constructor(
    private readonly lockPath: string,
    lockRecord: SessionWriterLockRecord,
    options: AcquireSessionWriterLeaseOptions,
  ) {
    this.ownerId = lockRecord.owner_id;
    this.sessionId = options.sessionId;
    this.runtimeBaseDir = options.runtimeBaseDir;
    this.transcriptPath = options.transcriptPath;
    this.lockRecordRaw = JSON.stringify(lockRecord);
    this.retiredPath = `${lockPath}.released.${encodeURIComponent(this.ownerId)}`;
  }

  get transcriptExistedAtAcquire(): boolean {
    if (!this.expectedTranscriptState) {
      throw new SessionWriterUnavailableError();
    }
    return this.expectedTranscriptState.exists;
  }

  static async acquire(
    options: AcquireSessionWriterLeaseOptions,
  ): Promise<SessionWriterLease> {
    try {
      return await SessionWriterLease.acquireInternal(options);
    } catch (error) {
      const lockPath = getSessionWriterLockPath(
        path.resolve(options.runtimeBaseDir),
        options.sessionId,
      );
      const errorKind =
        error instanceof SessionWriterError ? error.errorKind : 'unknown';
      debugLogger.debug(
        `Session writer lease acquisition failed stage=acquire errorKind=${errorKind} ` +
          `lockPath=${JSON.stringify(lockPath)} ` +
          `transcriptPath=${JSON.stringify(path.resolve(options.transcriptPath))} ` +
          `error=${describeDiagnosticError(error)}`,
      );
      throw error;
    }
  }

  private static async acquireInternal(
    options: AcquireSessionWriterLeaseOptions,
  ): Promise<SessionWriterLease> {
    const normalizedOptions = {
      ...options,
      runtimeBaseDir: path.resolve(options.runtimeBaseDir),
      transcriptPath: path.resolve(options.transcriptPath),
    };
    const lockPath = getSessionWriterLockPath(
      normalizedOptions.runtimeBaseDir,
      normalizedOptions.sessionId,
    );
    const lockDir = path.dirname(lockPath);
    try {
      await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
      const lockDirStat = await fs.lstat(lockDir);
      if (!lockDirStat.isDirectory() || lockDirStat.isSymbolicLink()) {
        throw new SessionWriterUnavailableError({
          cause: new Error(
            'Session writer lock directory is not a regular directory',
          ),
        });
      }
    } catch (error) {
      if (error instanceof SessionWriterError) throw error;
      throw new SessionWriterUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }

    const processStartIdentity = await readProcessStartIdentity(process.pid);
    const lockRecord: SessionWriterLockRecord = {
      schema_version: LOCK_SCHEMA_VERSION,
      session_id: normalizedOptions.sessionId,
      owner_id: randomUUID(),
      pid: process.pid,
      ...(processStartIdentity
        ? { process_start_identity: processStartIdentity }
        : {}),
      hostname: os.hostname(),
      process_kind: normalizedOptions.processKind ?? 'unknown',
      acquired_at: new Date().toISOString(),
      qwen_version: normalizedOptions.qwenVersion ?? null,
    };

    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
      if (await installLockRecord(lockPath, lockRecord)) {
        return SessionWriterLease.finishAcquisition(
          lockPath,
          lockRecord,
          normalizedOptions,
        );
      }

      const state = await SessionWriterLease.inspectExistingLock(
        lockPath,
        normalizedOptions.sessionId,
      );
      if (state.kind === 'missing') continue;
      if (state.kind === 'live') throw new SessionWriterConflictError();
      if (state.kind === 'malformed') {
        throw new SessionWriterUnavailableError({
          cause: new Error('Existing session writer lock is malformed'),
        });
      }
      if (normalizedOptions.reclaimPolicy === 'never') {
        throw new SessionWriterConflictError();
      }

      const staleOwnerId = state.record.owner_id;
      const reclaimPath = await acquireReclaimGuard(
        lockPath,
        staleOwnerId,
        lockRecord,
        (candidatePath, sessionId) =>
          SessionWriterLease.inspectExistingLock(candidatePath, sessionId),
      );
      let primaryInstalled = false;
      let staleMoved = false;
      const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
      try {
        const currentState = await SessionWriterLease.inspectExistingLock(
          lockPath,
          normalizedOptions.sessionId,
        );
        if (
          currentState.kind !== 'stale' ||
          currentState.record.owner_id !== staleOwnerId
        ) {
          throw currentState.kind === 'live'
            ? new SessionWriterConflictError()
            : new SessionWriterUnavailableError();
        }
        await fs.rename(lockPath, stalePath);
        staleMoved = true;
        const movedState = await SessionWriterLease.inspectExistingLock(
          stalePath,
          normalizedOptions.sessionId,
        );
        if (
          movedState.kind !== 'stale' ||
          movedState.record.owner_id !== staleOwnerId
        ) {
          await restoreMovedLock(stalePath, lockPath);
          staleMoved = false;
          throw movedState.kind === 'live'
            ? new SessionWriterConflictError()
            : new SessionWriterUnavailableError();
        }
        await fs.unlink(stalePath);
        staleMoved = false;
        if (!(await installLockRecord(lockPath, lockRecord))) {
          throw new SessionWriterUnavailableError();
        }
        primaryInstalled = true;
        const finishingLease = SessionWriterLease.finishAcquisition(
          lockPath,
          lockRecord,
          normalizedOptions,
        );
        // finishAcquisition now owns exact-record cleanup for this primary lock.
        primaryInstalled = false;
        const lease = await finishingLease;
        await removeOwnedLock(reclaimPath, lockRecord.owner_id).catch(() => {});
        return lease;
      } catch (error) {
        if (staleMoved) {
          await restoreMovedLock(stalePath, lockPath).catch(() => {});
        }
        if (primaryInstalled) {
          await removeOwnedLock(lockPath, lockRecord.owner_id).catch(() => {});
        }
        await removeOwnedLock(reclaimPath, lockRecord.owner_id).catch(() => {});
        if (error instanceof SessionWriterError) throw error;
        throw new SessionWriterUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
    }

    throw new SessionWriterUnavailableError();
  }

  private static async finishAcquisition(
    lockPath: string,
    lockRecord: SessionWriterLockRecord,
    options: AcquireSessionWriterLeaseOptions,
  ): Promise<SessionWriterLease> {
    const lease = new SessionWriterLease(lockPath, lockRecord, options);
    try {
      options.onOwnershipAcquired?.(lease);
      const snapshot = await captureTranscriptSnapshot(
        options.transcriptPath,
        undefined,
        () => lease.released,
      );
      await lease.readOwnedLock();
      lease.expectedTranscriptState = snapshot.state;
      lease.expectedTranscriptHasher = snapshot.hasher;
      return lease;
    } catch (error) {
      try {
        await lease.release();
      } catch (releaseError) {
        throw new SessionWriterUnavailableError({
          cause: new AggregateError(
            [error, releaseError],
            'Session writer acquisition cleanup failed',
          ),
        });
      }
      throw error;
    }
  }

  private static async inspectExistingLock(
    lockPath: string,
    expectedSessionId: string,
  ): Promise<ExistingLockState> {
    for (let attempt = 0; attempt < MALFORMED_RETRY_COUNT; attempt++) {
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { kind: 'missing' };
        }
        throw new SessionWriterUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SessionWriterUnavailableError({
          cause: new Error('Session writer lock is not a regular file'),
        });
      }

      let raw: string;
      try {
        raw = await fs.readFile(lockPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { kind: 'missing' };
        }
        throw new SessionWriterUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      const record = parseLockRecord(raw);
      if (record) {
        if (record.session_id !== expectedSessionId) {
          throw new SessionWriterUnavailableError({
            cause: new Error('Session writer lock belongs to another session'),
          });
        }
        return lockStateForRecord(record);
      }
      if (attempt + 1 < MALFORMED_RETRY_COUNT) {
        await delay(MALFORMED_RETRY_DELAY_MS);
      }
    }
    return { kind: 'malformed' };
  }

  private async readOwnedLock(): Promise<SessionWriterLockRecord> {
    if (this.released) throw new SessionWriterLostError();
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SessionWriterLostError();
      }
      throw new SessionWriterUnavailableError();
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SessionWriterLostError();
    }
    let raw: string;
    try {
      raw = await fs.readFile(this.lockPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SessionWriterLostError();
      }
      throw new SessionWriterUnavailableError();
    }
    const record = parseLockRecord(raw);
    if (
      !record ||
      record.owner_id !== this.ownerId ||
      raw !== this.lockRecordRaw
    ) {
      throw new SessionWriterLostError();
    }
    return record;
  }

  async assertOwnedAndUnchanged(): Promise<void> {
    await this.readOwnedLock();
    const expectedState = this.expectedTranscriptState;
    if (!expectedState || !this.expectedTranscriptHasher) {
      throw new SessionWriterUnavailableError();
    }
    const transcriptState = await getTranscriptState(
      this.transcriptPath,
      expectedState,
    );
    if (sameTranscriptState(transcriptState, expectedState)) {
      debugLogger.debug('Session transcript verified path=fast');
      return;
    }
    if (!sameHardTranscriptState(transcriptState, expectedState)) {
      debugLogger.debug(
        `Session transcript hard state changed changedFields=${transcriptStateChangedFields(expectedState, transcriptState).join(',')}`,
      );
      throw new SessionTranscriptChangedError();
    }
    await this.reconcileTranscriptMetadata(transcriptState);
  }

  async appendJsonLine(value: unknown): Promise<void> {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      throw new SessionWriterUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (serialized === undefined) throw new SessionWriterUnavailableError();
    const bytes = Buffer.from(`${serialized}\n`, 'utf8');
    await this.assertOwnedAndUnchanged();
    let expectedBefore = this.expectedTranscriptState;
    if (!expectedBefore || !this.expectedTranscriptHasher) {
      throw new SessionWriterUnavailableError();
    }
    let handle: fs.FileHandle | undefined;
    try {
      await fs.mkdir(path.dirname(this.transcriptPath), {
        recursive: true,
        mode: 0o700,
      });
      handle = await openTranscriptForAppend(
        this.transcriptPath,
        expectedBefore,
      );
      let beforeState = await getOpenTranscriptState(
        this.transcriptPath,
        handle,
        true,
      );
      if (expectedBefore.exists) {
        if (!sameTranscriptState(beforeState, expectedBefore)) {
          if (!sameHardTranscriptState(beforeState, expectedBefore)) {
            throw new SessionTranscriptChangedError();
          }
          await this.reconcileTranscriptMetadata(beforeState, handle);
          expectedBefore = this.expectedTranscriptState;
          if (!expectedBefore?.exists) {
            throw new SessionWriterUnavailableError();
          }
          beforeState = expectedBefore;
        }
      } else if (beforeState.byteLength !== 0) {
        throw new SessionTranscriptChangedError();
      }
      const expectedHasher = this.expectedTranscriptHasher;
      if (!expectedHasher) throw new SessionWriterUnavailableError();
      const candidateHasher = expectedHasher.copy();
      candidateHasher.update(bytes);
      const nextByteLength = expectedBefore.byteLength + bytes.byteLength;
      await this.readOwnedLock();
      await handle.writeFile(bytes);
      await handle.sync();
      const afterStat = await handle.stat();
      const afterState = transcriptStateFromStat(afterStat);
      if (
        afterState.byteLength !== nextByteLength ||
        !sameFileIdentity(afterState.fingerprint, beforeState.fingerprint) ||
        !sameFileSecurityMetadata(
          afterState.fingerprint,
          beforeState.fingerprint,
        )
      ) {
        throw new SessionTranscriptChangedError();
      }
      await handle.close();
      handle = undefined;
      const transcriptState = await getTranscriptState(
        this.transcriptPath,
        afterState,
      );
      if (
        !transcriptState.exists ||
        transcriptState.byteLength !== nextByteLength ||
        !sameFileIdentity(
          transcriptState.fingerprint,
          afterState.fingerprint,
        ) ||
        !sameFileSecurityMetadata(
          transcriptState.fingerprint,
          afterState.fingerprint,
        )
      ) {
        throw new SessionTranscriptChangedError();
      }
      let committedState: TranscriptState = transcriptState;
      let committedHasher = candidateHasher;
      let appendReconciliation:
        | {
            changedFields: string[];
            attempts: number;
            startedAt: number;
          }
        | undefined;
      if (!sameTranscriptState(transcriptState, afterState)) {
        const changedFields = transcriptStateChangedFields(
          afterState,
          transcriptState,
        );
        const startedAt = Date.now();
        await this.readOwnedLock();
        const snapshot = await captureTranscriptSnapshot(
          this.transcriptPath,
          afterState,
          () => this.released,
        );
        if (!transcriptHashesEqual(snapshot.hasher, candidateHasher)) {
          debugLogger.debug(
            `Session transcript content changed after append metadata signal ` +
              `path=slow changedFields=${changedFields.join(',')} ` +
              `attempts=${snapshot.attempts} durationMs=${Date.now() - startedAt}`,
          );
          throw new SessionTranscriptChangedError();
        }
        committedState = snapshot.state;
        committedHasher = snapshot.hasher;
        appendReconciliation = {
          changedFields,
          attempts: snapshot.attempts,
          startedAt,
        };
      }
      await this.readOwnedLock();
      this.expectedTranscriptHasher = committedHasher;
      this.expectedTranscriptState = committedState;
      if (appendReconciliation) {
        debugLogger.debug(
          `Session transcript append metadata reconciled path=slow ` +
            `changedFields=${appendReconciliation.changedFields.join(',')} ` +
            `attempts=${appendReconciliation.attempts} ` +
            `durationMs=${Date.now() - appendReconciliation.startedAt}`,
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOENT') {
        throw new SessionTranscriptChangedError();
      }
      if (error instanceof SessionWriterError) throw error;
      throw new SessionWriterUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private async reconcileTranscriptMetadata(
    observedState: TranscriptState,
    handle?: fs.FileHandle,
  ): Promise<void> {
    const expectedState = this.expectedTranscriptState;
    const expectedHasher = this.expectedTranscriptHasher;
    if (
      !expectedState ||
      !expectedHasher ||
      !sameHardTranscriptState(observedState, expectedState)
    ) {
      throw new SessionTranscriptChangedError();
    }

    const changedFields = transcriptStateChangedFields(
      expectedState,
      observedState,
    );
    const startedAt = Date.now();
    await this.readOwnedLock();
    const snapshot = handle
      ? await captureOpenTranscriptSnapshot(
          this.transcriptPath,
          handle,
          expectedState,
          () => this.released,
        )
      : await captureTranscriptSnapshot(
          this.transcriptPath,
          expectedState,
          () => this.released,
        );
    if (!transcriptHashesEqual(snapshot.hasher, expectedHasher)) {
      debugLogger.debug(
        `Session transcript content changed after metadata signal ` +
          `path=slow changedFields=${changedFields.join(',')} ` +
          `attempts=${snapshot.attempts} durationMs=${Date.now() - startedAt}`,
      );
      throw new SessionTranscriptChangedError();
    }
    await this.readOwnedLock();
    this.expectedTranscriptHasher = snapshot.hasher;
    this.expectedTranscriptState = snapshot.state;
    debugLogger.debug(
      `Session transcript metadata reconciled path=slow ` +
        `changedFields=${changedFields.join(',')} attempts=${snapshot.attempts} ` +
        `durationMs=${Date.now() - startedAt}`,
    );
  }

  release(): Promise<void> {
    this.releasePromise ??= this.releaseOnce();
    return this.releasePromise;
  }

  get isReleased(): boolean {
    return this.released;
  }

  private async releaseOnce(): Promise<void> {
    if (this.released) return;
    await this.readOwnedLockForRelease();
    try {
      await fs.rename(this.lockPath, this.retiredPath);
      this.released = true;
      await fs.unlink(this.retiredPath).catch((error) => {
        debugLogger.debug(
          `Session writer retired lock cleanup failed path=${JSON.stringify(this.retiredPath)} ` +
            `error=${describeDiagnosticError(error)}`,
        );
      });
    } catch (error) {
      const [primaryState, retiredState] = await Promise.all([
        this.inspectReleasePath(this.lockPath),
        this.inspectReleasePath(this.retiredPath),
      ]);
      if (primaryState === 'missing' || primaryState === 'other') {
        this.released = true;
        if (retiredState === 'owned') {
          await fs.unlink(this.retiredPath).catch(() => {});
          throw new SessionWriterUnavailableError({
            cause: error instanceof Error ? error : undefined,
          });
        }
        throw new SessionWriterLostError();
      }
      if (error instanceof SessionWriterError) throw error;
      throw new SessionWriterUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  private async readOwnedLockForRelease(): Promise<void> {
    for (let attempt = 0; attempt < RELEASE_PRECHECK_ATTEMPTS; attempt++) {
      try {
        await this.readOwnedLock();
        return;
      } catch (error) {
        if (
          !(error instanceof SessionWriterUnavailableError) ||
          attempt + 1 === RELEASE_PRECHECK_ATTEMPTS
        ) {
          throw error;
        }
      }
      await delay(RELEASE_PRECHECK_RETRY_DELAY_MS);
    }
  }

  private async inspectReleasePath(
    candidatePath: string,
  ): Promise<'owned' | 'missing' | 'other' | 'unknown'> {
    try {
      const stat = await fs.lstat(candidatePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return 'other';
      const raw = await fs.readFile(candidatePath, 'utf8');
      return raw === this.lockRecordRaw ? 'owned' : 'other';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'missing'
        : 'unknown';
    }
  }
}
