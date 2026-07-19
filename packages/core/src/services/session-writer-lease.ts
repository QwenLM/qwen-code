/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';

const LOCK_SCHEMA_VERSION = 1;
const MALFORMED_RETRY_COUNT = 3;
const MALFORMED_RETRY_DELAY_MS = 50;
const ACQUIRE_ATTEMPTS = 8;
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
    birthtimeMs: stat.birthtimeMs,
    ctimeMs: stat.ctimeMs,
    mtimeMs: stat.mtimeMs,
  };
}

function sameFileIdentity(
  left: TranscriptFingerprint,
  right: TranscriptFingerprint,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function sameTranscriptState(
  left: TranscriptState,
  right: TranscriptState,
): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists || !right.exists) return true;
  return (
    left.byteLength === right.byteLength &&
    sameFileIdentity(left.fingerprint, right.fingerprint) &&
    left.fingerprint.ctimeMs === right.fingerprint.ctimeMs &&
    left.fingerprint.mtimeMs === right.fingerprint.mtimeMs
  );
}

async function getTranscriptState(filePath: string): Promise<TranscriptState> {
  let handle: fs.FileHandle | undefined;
  try {
    try {
      handle = await fs.open(filePath, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false, byteLength: 0 };
      }
      throw error;
    }
    const [handleStat, pathStat] = await Promise.all([
      handle.stat(),
      fs.lstat(filePath),
    ]);
    if (
      !handleStat.isFile() ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink()
    ) {
      throw new SessionWriterUnavailableError();
    }
    const handleFingerprint = transcriptFingerprint(handleStat);
    const pathFingerprint = transcriptFingerprint(pathStat);
    if (!sameFileIdentity(handleFingerprint, pathFingerprint)) {
      throw new SessionTranscriptChangedError();
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
    return {
      exists: true,
      byteLength: handleStat.size,
      fingerprint: handleFingerprint,
    };
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
  private released = false;
  private releasePromise: Promise<void> | undefined;

  private constructor(
    private readonly lockPath: string,
    lockRecord: SessionWriterLockRecord,
    options: AcquireSessionWriterLeaseOptions,
  ) {
    this.ownerId = lockRecord.owner_id;
    this.sessionId = options.sessionId;
    this.runtimeBaseDir = options.runtimeBaseDir;
    this.transcriptPath = options.transcriptPath;
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
        const lease = await SessionWriterLease.finishAcquisition(
          lockPath,
          lockRecord,
          normalizedOptions,
        );
        await removeOwnedLock(reclaimPath, lockRecord.owner_id);
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
      lease.expectedTranscriptState = await getTranscriptState(
        options.transcriptPath,
      );
      return lease;
    } catch (error) {
      try {
        await removeOwnedLock(lockPath, lockRecord.owner_id);
      } catch {
        throw new SessionWriterUnavailableError();
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
    if (!record || record.owner_id !== this.ownerId) {
      throw new SessionWriterLostError();
    }
    return record;
  }

  async assertOwnedAndUnchanged(): Promise<void> {
    await this.readOwnedLock();
    if (!this.expectedTranscriptState) {
      throw new SessionWriterUnavailableError();
    }
    const transcriptState = await getTranscriptState(this.transcriptPath);
    if (!sameTranscriptState(transcriptState, this.expectedTranscriptState)) {
      throw new SessionTranscriptChangedError();
    }
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
    const expectedBefore = this.expectedTranscriptState;
    if (!expectedBefore) throw new SessionWriterUnavailableError();
    const nextByteLength = expectedBefore.byteLength + bytes.byteLength;
    let handle: fs.FileHandle | undefined;
    try {
      await fs.mkdir(path.dirname(this.transcriptPath), {
        recursive: true,
        mode: 0o700,
      });
      handle = await fs.open(
        this.transcriptPath,
        expectedBefore.exists ? 'a+' : 'ax+',
        0o600,
      );
      const beforeStat = await handle.stat();
      const beforeState: TranscriptState = {
        exists: true,
        byteLength: beforeStat.size,
        fingerprint: transcriptFingerprint(beforeStat),
      };
      if (
        expectedBefore.exists
          ? !sameTranscriptState(beforeState, expectedBefore)
          : beforeStat.size !== 0
      ) {
        throw new SessionTranscriptChangedError();
      }
      await this.readOwnedLock();
      await handle.writeFile(bytes);
      await handle.sync();
      const afterStat = await handle.stat();
      if (afterStat.size !== nextByteLength) {
        throw new SessionTranscriptChangedError();
      }
      const writtenFingerprint = transcriptFingerprint(afterStat);
      await handle.close();
      handle = undefined;
      const transcriptState = await getTranscriptState(this.transcriptPath);
      if (
        !transcriptState.exists ||
        transcriptState.byteLength !== nextByteLength ||
        !sameFileIdentity(transcriptState.fingerprint, writtenFingerprint)
      ) {
        throw new SessionTranscriptChangedError();
      }
      await this.readOwnedLock();
      this.expectedTranscriptState = transcriptState;
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

  release(): Promise<void> {
    this.releasePromise ??= this.releaseOnce().catch((error: unknown) => {
      if (!this.released) this.releasePromise = undefined;
      throw error;
    });
    return this.releasePromise;
  }

  private async releaseOnce(): Promise<void> {
    if (this.released) return;
    try {
      await removeOwnedLock(this.lockPath, this.ownerId);
      this.released = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.released = true;
        throw new SessionWriterLostError();
      }
      if (error instanceof SessionWriterLostError) {
        this.released = true;
        throw error;
      }
      if (error instanceof SessionWriterError) throw error;
      throw new SessionWriterUnavailableError();
    }
  }
}
