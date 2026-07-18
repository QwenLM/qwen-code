/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { readRuntimeStatus } from '../utils/runtimeStatus.js';
import { recordSessionWriterEvent } from '../telemetry/metrics.js';

const LOCK_SCHEMA_VERSION = 1;
const MALFORMED_RETRY_COUNT = 3;
const MALFORMED_RETRY_DELAY_MS = 50;
const MALFORMED_GRACE_MS = 5_000;

export type SessionWriterProcessKind =
  | 'interactive'
  | 'acp'
  | 'daemon'
  | 'maintenance'
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

export class SessionWriterConflictError extends SessionWriterError {
  override readonly name = 'SessionWriterConflictError';
  readonly rpcCode = -32012;
  readonly errorKind = 'session_writer_conflict';
  readonly httpStatus = 409;

  constructor() {
    super('This session is already open in another Qwen process.');
    recordSessionWriterEvent('conflict');
  }
}

export class SessionWriterLostError extends SessionWriterError {
  override readonly name = 'SessionWriterLostError';
  readonly rpcCode = -32013;
  readonly errorKind = 'session_writer_lost';
  readonly httpStatus = 409;

  constructor() {
    super('Write ownership for this session was lost.');
    recordSessionWriterEvent('writer_lost');
  }
}

export class SessionTranscriptChangedError extends SessionWriterError {
  override readonly name = 'SessionTranscriptChangedError';
  readonly rpcCode = -32014;
  readonly errorKind = 'session_transcript_changed';
  readonly httpStatus = 409;

  constructor() {
    super('The session transcript changed outside its active writer.');
    recordSessionWriterEvent('transcript_changed');
  }
}

export class SessionWriterUnavailableError extends SessionWriterError {
  override readonly name = 'SessionWriterUnavailableError';
  readonly rpcCode = -32015;
  readonly errorKind = 'session_writer_unavailable';
  readonly httpStatus = 503;

  constructor() {
    super('Session write ownership could not be verified.');
  }
}

interface SessionWriterLockRecord {
  schema_version: number;
  session_id: string;
  owner_id: string;
  pid: number;
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
}

type ExistingLockState =
  | { kind: 'missing' }
  | { kind: 'live' }
  | { kind: 'stale' }
  | { kind: 'malformed'; mtimeMs: number };

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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
    typeof record['hostname'] === 'string' &&
    record['hostname'].length > 0 &&
    typeof processKind === 'string' &&
    ['interactive', 'acp', 'daemon', 'maintenance', 'unknown'].includes(
      processKind,
    ) &&
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

function lockStateForRecord(
  record: SessionWriterLockRecord,
): ExistingLockState {
  if (record.hostname !== os.hostname()) return { kind: 'live' };
  return isProcessAlive(record.pid) ? { kind: 'live' } : { kind: 'stale' };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function getTranscriptState(
  filePath: string,
): Promise<{ exists: boolean; byteLength: number }> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SessionWriterUnavailableError();
    }
    return { exists: true, byteLength: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, byteLength: 0 };
    }
    if (error instanceof SessionWriterError) throw error;
    throw new SessionWriterUnavailableError();
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

    let raw: string;
    try {
      raw = await fs.readFile(movedPath, 'utf8');
      await fs.writeFile(lockPath, raw, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch (restoreError) {
      if ((restoreError as NodeJS.ErrnoException).code === 'EEXIST') {
        await fs.unlink(movedPath).catch(() => {});
        return;
      }
      throw new SessionWriterUnavailableError();
    }
  }
  await fs.unlink(movedPath).catch(() => {});
}

async function hasMatchingLiveRuntime(
  runtimeBaseDir: string,
  sessionId: string,
): Promise<boolean> {
  const projectsDir = path.join(runtimeBaseDir, 'projects');
  let projects: Dirent[];
  try {
    projects = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new SessionWriterUnavailableError();
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const statusPath = path.join(
      projectsDir,
      project.name,
      'chats',
      `${sessionId}.runtime.json`,
    );
    try {
      const stat = await fs.lstat(statusPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SessionWriterUnavailableError();
      }
      await fs.readFile(statusPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (error instanceof SessionWriterError) throw error;
      throw new SessionWriterUnavailableError();
    }
    const status = await readRuntimeStatus(statusPath);
    if (
      status?.sessionId === sessionId &&
      status.active &&
      (status.hostname !== os.hostname() || isProcessAlive(status.pid))
    ) {
      return true;
    }
  }
  return false;
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
  readonly transcriptExistedAtAcquire: boolean;
  private transcriptPathValue: string;
  private expectedByteLengthValue: number;
  private expectedTranscriptExistsValue: boolean;
  private released = false;

  private constructor(
    private readonly lockPath: string,
    lockRecord: SessionWriterLockRecord,
    options: AcquireSessionWriterLeaseOptions,
    expectedByteLength: number,
    transcriptExistedAtAcquire: boolean,
  ) {
    this.ownerId = lockRecord.owner_id;
    this.sessionId = options.sessionId;
    this.runtimeBaseDir = options.runtimeBaseDir;
    this.transcriptExistedAtAcquire = transcriptExistedAtAcquire;
    this.transcriptPathValue = path.resolve(options.transcriptPath);
    this.expectedByteLengthValue = expectedByteLength;
    this.expectedTranscriptExistsValue = transcriptExistedAtAcquire;
  }

  get transcriptPath(): string {
    return this.transcriptPathValue;
  }

  get expectedByteLength(): number {
    return this.expectedByteLengthValue;
  }

  static async acquire(
    options: AcquireSessionWriterLeaseOptions,
  ): Promise<SessionWriterLease> {
    const runtimeBaseDir = path.resolve(options.runtimeBaseDir);
    const normalizedOptions = {
      ...options,
      runtimeBaseDir,
      transcriptPath: path.resolve(options.transcriptPath),
    };
    const lockPath = getSessionWriterLockPath(
      runtimeBaseDir,
      options.sessionId,
    );
    const lockDir = path.dirname(lockPath);
    try {
      await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    } catch {
      throw new SessionWriterUnavailableError();
    }

    let lockDirStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      lockDirStat = await fs.lstat(lockDir);
    } catch {
      throw new SessionWriterUnavailableError();
    }
    if (!lockDirStat.isDirectory() || lockDirStat.isSymbolicLink()) {
      throw new SessionWriterUnavailableError();
    }

    const lockRecord: SessionWriterLockRecord = {
      schema_version: LOCK_SCHEMA_VERSION,
      session_id: options.sessionId,
      owner_id: randomUUID(),
      pid: process.pid,
      hostname: os.hostname(),
      process_kind: options.processKind ?? 'unknown',
      acquired_at: new Date().toISOString(),
      qwen_version: options.qwenVersion ?? null,
    };

    for (let attempt = 0; attempt < 8; attempt++) {
      let createdLock = false;
      try {
        await fs.writeFile(lockPath, JSON.stringify(lockRecord), {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        createdLock = true;
        const transcriptState = await getTranscriptState(
          normalizedOptions.transcriptPath,
        );
        return new SessionWriterLease(
          lockPath,
          lockRecord,
          normalizedOptions,
          transcriptState.byteLength,
          transcriptState.exists,
        );
      } catch (error) {
        if (createdLock) {
          try {
            const current = parseLockRecord(
              await fs.readFile(lockPath, 'utf8'),
            );
            if (current?.owner_id === lockRecord.owner_id) {
              await fs.unlink(lockPath);
            }
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw new SessionWriterUnavailableError();
            }
          }
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          if (error instanceof SessionWriterError) throw error;
          throw new SessionWriterUnavailableError();
        }
      }

      const state = await SessionWriterLease.inspectExistingLock(
        lockPath,
        options.sessionId,
      );
      if (state.kind === 'missing') continue;
      if (state.kind === 'live') throw new SessionWriterConflictError();
      if (state.kind === 'malformed') {
        if (Date.now() - state.mtimeMs < MALFORMED_GRACE_MS) {
          throw new SessionWriterConflictError();
        }
        if (await hasMatchingLiveRuntime(runtimeBaseDir, options.sessionId)) {
          throw new SessionWriterConflictError();
        }
      }

      const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
      try {
        await fs.rename(lockPath, stalePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new SessionWriterUnavailableError();
      }

      const movedState = await SessionWriterLease.inspectExistingLock(
        stalePath,
        options.sessionId,
      );
      const movedIsReclaimable =
        movedState.kind === 'stale' ||
        (movedState.kind === 'malformed' &&
          Date.now() - movedState.mtimeMs >= MALFORMED_GRACE_MS &&
          !(await hasMatchingLiveRuntime(runtimeBaseDir, options.sessionId)));
      if (!movedIsReclaimable) {
        await restoreMovedLock(stalePath, lockPath);
        if (movedState.kind === 'missing') {
          throw new SessionWriterUnavailableError();
        }
        throw new SessionWriterConflictError();
      }
      await fs.unlink(stalePath).catch(() => {});
      recordSessionWriterEvent('stale_reclaim');
    }

    throw new SessionWriterUnavailableError();
  }

  private static async inspectExistingLock(
    lockPath: string,
    expectedSessionId: string,
  ): Promise<ExistingLockState> {
    let mtimeMs = 0;
    for (let attempt = 0; attempt < MALFORMED_RETRY_COUNT; attempt++) {
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { kind: 'missing' };
        }
        throw new SessionWriterUnavailableError();
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SessionWriterUnavailableError();
      }
      mtimeMs = stat.mtimeMs;

      let raw: string;
      try {
        raw = await fs.readFile(lockPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { kind: 'missing' };
        }
        throw new SessionWriterUnavailableError();
      }
      const record = parseLockRecord(raw);
      if (record) {
        if (record.session_id !== expectedSessionId) {
          throw new SessionWriterUnavailableError();
        }
        return lockStateForRecord(record);
      }
      if (attempt + 1 < MALFORMED_RETRY_COUNT) {
        await delay(MALFORMED_RETRY_DELAY_MS);
      }
    }
    return { kind: 'malformed', mtimeMs };
  }

  private async readOwnedLock(): Promise<SessionWriterLockRecord> {
    if (this.released) throw new SessionWriterLostError();
    try {
      const stat = await fs.lstat(this.lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SessionWriterLostError();
      }
      const record = parseLockRecord(await fs.readFile(this.lockPath, 'utf8'));
      if (!record || record.owner_id !== this.ownerId) {
        throw new SessionWriterLostError();
      }
      return record;
    } catch (error) {
      if (error instanceof SessionWriterError) throw error;
      throw new SessionWriterLostError();
    }
  }

  async assertOwnedAndUnchanged(): Promise<void> {
    await this.readOwnedLock();
    const transcriptState = await getTranscriptState(this.transcriptPathValue);
    if (transcriptState.exists !== this.expectedTranscriptExistsValue) {
      throw new SessionTranscriptChangedError();
    }
    if (transcriptState.byteLength !== this.expectedByteLengthValue) {
      throw new SessionTranscriptChangedError();
    }
  }

  async appendJsonLine(value: unknown): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    await this.assertOwnedAndUnchanged();
    try {
      await fs.mkdir(path.dirname(this.transcriptPathValue), {
        recursive: true,
      });
      await fs.appendFile(this.transcriptPathValue, bytes, {
        flag: 'a',
        flush: true,
        mode: 0o600,
      });
      this.expectedByteLengthValue += bytes.byteLength;
      this.expectedTranscriptExistsValue = true;
    } catch (error) {
      if (error instanceof SessionWriterError) throw error;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async readStableTranscript(): Promise<Buffer> {
    await this.assertOwnedAndUnchanged();
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.transcriptPathValue);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        this.expectedByteLengthValue === 0
      ) {
        bytes = Buffer.alloc(0);
      } else {
        throw error;
      }
    }
    if (bytes.byteLength !== this.expectedByteLengthValue) {
      throw new SessionTranscriptChangedError();
    }
    await this.assertOwnedAndUnchanged();
    return bytes;
  }

  async writeNewTranscript(lines: readonly unknown[]): Promise<void> {
    await this.assertOwnedAndUnchanged();
    if (this.expectedByteLengthValue !== 0) {
      throw new SessionTranscriptChangedError();
    }
    const bytes = Buffer.from(
      lines.map((line) => JSON.stringify(line)).join('\n') +
        (lines.length > 0 ? '\n' : ''),
      'utf8',
    );
    const transcriptDir = path.dirname(this.transcriptPathValue);
    await fs.mkdir(transcriptDir, { recursive: true });
    const temporaryPath = path.join(
      transcriptDir,
      `.${path.basename(this.transcriptPathValue)}.${this.ownerId}.tmp`,
    );
    let handle: fs.FileHandle | undefined;
    let failure: unknown;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      if (bytes.byteLength > 0) await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.assertOwnedAndUnchanged();
      await fs.link(temporaryPath, this.transcriptPathValue);
      this.expectedByteLengthValue = bytes.byteLength;
      this.expectedTranscriptExistsValue = true;
    } catch (error) {
      failure =
        (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? new SessionTranscriptChangedError()
          : error;
    } finally {
      try {
        await handle?.close();
      } catch (error) {
        failure ??= error;
      }
    }
    await fs.unlink(temporaryPath).catch(() => {});
    if (failure !== undefined) {
      throw failure;
    }
  }

  async rebindTranscriptPath(transcriptPath: string): Promise<void> {
    await this.readOwnedLock();
    const normalizedPath = path.resolve(transcriptPath);
    const transcriptState = await getTranscriptState(normalizedPath);
    if (transcriptState.exists !== this.expectedTranscriptExistsValue) {
      throw new SessionTranscriptChangedError();
    }
    if (transcriptState.byteLength !== this.expectedByteLengthValue) {
      throw new SessionTranscriptChangedError();
    }
    this.transcriptPathValue = normalizedPath;
  }

  async release(): Promise<void> {
    if (this.released) return;
    try {
      const stat = await fs.lstat(this.lockPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SessionWriterUnavailableError();
      }
      const record = parseLockRecord(await fs.readFile(this.lockPath, 'utf8'));
      if (!record) throw new SessionWriterUnavailableError();
      if (record.owner_id !== this.ownerId) {
        this.released = true;
        throw new SessionWriterLostError();
      }
      await fs.unlink(this.lockPath);
      this.released = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.released = true;
        throw new SessionWriterLostError();
      }
      if (error instanceof SessionWriterError) throw error;
      throw new SessionWriterUnavailableError();
    }
  }
}
