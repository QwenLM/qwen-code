/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Entry } from '../../protocol/transcript/entry.js';
import { isNodeError } from '../../utils/errors.js';
import {
  EXECUTION_ENVIRONMENT_ERROR_CODES,
  getExecutionEnvironmentError,
} from '../../utils/fsErrorMessages.js';
import { runLogger } from '../../utils/runLogger.js';
import { encodeTranscriptEntry } from './entry-codec.js';

export interface TranscriptFileSystem {
  mkdir(
    directoryPath: string,
    options: { recursive: true; mode: number },
  ): Promise<unknown>;
  open(
    filePath: string,
    flags: string | number,
    mode?: number,
  ): Promise<FileHandle>;
  appendFile(
    filePath: string,
    data: Uint8Array,
    options: { mode: number; flag?: number },
  ): Promise<void>;
  rm(filePath: string, options: { force: boolean }): Promise<void>;
}

export const nodeTranscriptFileSystem: TranscriptFileSystem = {
  mkdir: (directoryPath, options) => fs.mkdir(directoryPath, options),
  open: (filePath, flags, mode) => fs.open(filePath, flags, mode),
  appendFile: (filePath, data, options) =>
    fs.appendFile(filePath, data, options),
  rm: (filePath, options) => fs.rm(filePath, options),
};

export interface AppendChannelOptions {
  filePath: string;
  flushIntervalMs?: number;
  maxBatchBytes?: number;
  fileSystem?: TranscriptFileSystem;
  commitObserver?: TranscriptCommitObserver;
}

export interface AgentMetadataCommitEntry {
  type: 'agent_metadata';
  agentType: string;
  toolUseId?: string;
  description?: string;
  invocationName?: string;
  teamName?: string;
  isolation?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  color?: string;
}

export type TranscriptCommitEntry = Entry | AgentMetadataCommitEntry;

/** Receives the exact entries covered by one successful physical write. */
export type TranscriptCommitObserver = (
  filePath: string,
  entries: readonly TranscriptCommitEntry[],
) => void | Promise<void>;

interface AppendRequest {
  records: PendingRecord[];
  remainingRecords: number;
  settled: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface PendingRecord {
  bytes: Buffer;
  entry: Entry;
  request: AppendRequest;
}

const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;

/**
 * Owns the ordered append queue for exactly one canonical transcript path.
 * The channel does not contain session, parent-chain or deduplication logic.
 */
export class AppendChannel {
  readonly filePath: string;

  private readonly flushIntervalMs: number;
  private readonly maxBatchBytes: number;
  private readonly fileSystem: TranscriptFileSystem;
  private readonly commitObserver: TranscriptCommitObserver | undefined;
  private pendingRequests: AppendRequest[] = [];
  private drainTimer: NodeJS.Timeout | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private lastScheduledOperation: Promise<void> = Promise.resolve();
  private prepared = false;
  // A failed physical append may have written bytes. Repair this exact boundary
  // before accepting another batch; a failed rollback must never be forgotten.
  private rollback:
    | { size: number; records: readonly PendingRecord[] }
    | undefined;
  private state: 'open' | 'closing' | 'failed' | 'closed' = 'open';
  private failure: unknown;
  private closePromise: Promise<void> | undefined;

  constructor(options: AppendChannelOptions) {
    this.filePath = options.filePath;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.fileSystem = options.fileSystem ?? nodeTranscriptFileSystem;
    this.commitObserver = options.commitObserver;
    if (this.maxBatchBytes <= 0) {
      throw new RangeError('maxBatchBytes must be greater than zero');
    }
  }

  append(entries: readonly Entry[]): Promise<void> {
    if (entries.length === 0) {
      return this.barrier();
    }
    this.assertWritable();

    return new Promise<void>((resolve, reject) => {
      const request: AppendRequest = {
        records: [],
        remainingRecords: entries.length,
        settled: false,
        resolve,
        reject,
      };
      request.records = entries.map((entry) => ({
        bytes: encodeTranscriptEntry(entry).bytes,
        entry,
        request,
      }));
      this.pendingRequests.push(request);
      this.scheduleDrain();
    });
  }

  /** Waits for every append accepted before this call. */
  barrier(): Promise<void> {
    this.assertUsable();
    return this.barrierInternal();
  }

  flush(): Promise<void> {
    return this.barrier();
  }

  /**
   * 将短时最终校验与接管排入追加顺序域；失败不污染已有写入通道。
   * 回调不能再次 barrier 或申请准入。读取须在域外取得名额，并在回调内使用有界读取器。
   */
  withExclusiveRead<T>(callback: () => Promise<T>): Promise<T> {
    this.assertUsable();
    this.cancelDrainTimer();
    this.schedulePendingRequests();
    const priorCompletion = this.lastScheduledOperation;
    return this.enqueueFileOperation(
      async () => {
        // 沿用 barrier 的失败语义，不能越过尚未成功的追加直接接管。
        await priorCompletion;
        return callback();
      },
      () => false,
    );
  }

  async readTail(maxBytes = 64 * 1024): Promise<Buffer> {
    this.assertUsable();
    if (maxBytes <= 0) {
      throw new RangeError('maxBytes must be greater than zero');
    }
    await this.barrierInternal();
    return this.enqueueFileOperation(
      async () => {
        let handle: FileHandle | undefined;
        try {
          handle = await this.fileSystem.open(this.filePath, 'r');
          const stat = await handle.stat();
          const length = Math.min(stat.size, maxBytes);
          if (length === 0) {
            return Buffer.alloc(0);
          }
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            length,
            stat.size - length,
          );
          return buffer.subarray(0, bytesRead);
        } catch (error) {
          if (isNodeError(error) && error.code === 'ENOENT') {
            return Buffer.alloc(0);
          }
          throw error;
        } finally {
          await handle?.close();
        }
      },
      () => false,
    );
  }

  /** Reads the committed transcript within this append order domain. */
  async readAll(): Promise<Buffer> {
    this.assertUsable();
    await this.barrierInternal();
    return this.enqueueFileOperation(
      async () => {
        let handle: FileHandle | undefined;
        try {
          handle = await this.fileSystem.open(this.filePath, 'r');
          const stat = await handle.stat();
          if (stat.size === 0) {
            return Buffer.alloc(0);
          }
          const buffer = Buffer.allocUnsafe(stat.size);
          let bytesRead = 0;
          while (bytesRead < stat.size) {
            const result = await handle.read(
              buffer,
              bytesRead,
              stat.size - bytesRead,
              bytesRead,
            );
            if (result.bytesRead === 0) {
              break;
            }
            bytesRead += result.bytesRead;
          }
          return buffer.subarray(0, bytesRead);
        } catch (error) {
          if (isNodeError(error) && error.code === 'ENOENT') {
            return Buffer.alloc(0);
          }
          throw error;
        } finally {
          await handle?.close();
        }
      },
      () => false,
    );
  }

  async close(): Promise<void> {
    if (this.state === 'closed') {
      return;
    }
    if (this.state === 'closing') {
      return this.closePromise;
    }
    if (this.state === 'failed') {
      throw this.failure;
    }
    this.state = 'closing';
    this.closePromise = (async () => {
      await this.barrierInternal();
      this.state = 'closed';
    })();
    return this.closePromise;
  }

  /** Flushes accepted appends, rejects future appends and removes the file. */
  async deleteFile(): Promise<void> {
    this.assertUsable();
    if (this.state !== 'open') {
      throw new Error(`AppendChannel is ${this.state}`);
    }
    this.state = 'closing';
    await this.barrierInternal();
    const operation = this.enqueueFileOperation(async () => {
      await this.fileSystem.rm(this.filePath, { force: true });
      this.prepared = false;
    });
    await operation;
    this.state = 'closed';
  }

  /** Creates a new transcript without a check-then-create race. */
  async createExclusive(entries: readonly Entry[]): Promise<void> {
    this.assertWritable();
    if (this.pendingRequests.length > 0) {
      throw new Error('Cannot create a transcript while appends are pending');
    }
    const payload = Buffer.concat(
      entries.map((entry) => encodeTranscriptEntry(entry).bytes),
    );
    const operation = this.enqueueFileOperation(async () => {
      await this.fileSystem.mkdir(path.dirname(this.filePath), {
        recursive: true,
        mode: 0o700,
      });
      let created = false;
      let handle: FileHandle | undefined;
      try {
        handle = await this.fileSystem.open(this.filePath, 'wx', 0o600);
        created = true;
        try {
          if (payload.length > 0) {
            await handle.writeFile(payload);
          }
        } finally {
          await handle.close();
          handle = undefined;
        }
        this.prepared = true;
        if (entries.length > 0) {
          await this.notifyCommitted(entries);
        }
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (created) {
          await this.fileSystem.rm(this.filePath, { force: true });
        }
        this.prepared = false;
        throw error;
      }
    }, () => false);
    await operation;
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== undefined) {
      return;
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.schedulePendingRequests();
    }, this.flushIntervalMs);
  }

  private cancelDrainTimer(): void {
    if (this.drainTimer !== undefined) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
  }

  private schedulePendingRequests(): void {
    if (this.pendingRequests.length === 0) {
      return;
    }
    const requests = this.pendingRequests;
    this.pendingRequests = [];
    const records = requests.flatMap((request) => request.records);
    const chunks = partitionRecords(records, this.maxBatchBytes);

    const operation = this.enqueueFileOperation(
      async () => {
        await this.prepareForAppend();
        // 仅在批次开始时重建缺失文件；Windows 回滚需要不带 O_APPEND 的读写句柄。
        const handle = await this.fileSystem.open(
          this.filePath,
          fsConstants.O_RDWR | fsConstants.O_CREAT,
          0o600,
        );
        try {
          await this.rollbackAppend(handle);
          const startSize = (await handle.stat()).size;
          this.rollback = { size: startSize, records };
          try {
            for (const chunk of chunks) {
              await this.fileSystem.appendFile(
                this.filePath,
                Buffer.concat(chunk.map((record) => record.bytes)),
                {
                  mode: 0o600,
                  flag: fsConstants.O_WRONLY | fsConstants.O_APPEND,
                },
              );
            }
          } catch (error) {
            try {
              await this.rollbackAppend(handle);
            } catch (rollbackError) {
              // The next append must retry rollback before writing anything.
              // Preserve the original failure for the user-facing diagnosis.
              runLogger.warn(
                'transcript.append.rollback_failed',
                rollbackError,
              );
            }
            throw error;
          }
        } finally {
          await handle.close();
        }
        this.rollback = undefined;
        // Publish only after the entire batch succeeds. A failed batch has no
        // acknowledged prefix, so callers can retry without duplicate records.
        await this.notifyCommitted(records.map((record) => record.entry));
        acknowledgeRecords(records);
      },
      // 权限恢复或文件占用解除后仍需先回滚原批次，不能重建通道丢弃回滚边界。
      (error) => {
        if (isNodeError(error) && error.code === 'ENOENT') return false;
        const code = getExecutionEnvironmentError(error)?.code;
        return (
          code !== EXECUTION_ENVIRONMENT_ERROR_CODES.storageInsufficient &&
          code !== EXECUTION_ENVIRONMENT_ERROR_CODES.filesystemAccessDenied &&
          code !== EXECUTION_ENVIRONMENT_ERROR_CODES.filesystemBusy
        );
      },
    );
    void operation.catch((error: unknown) => {
      rejectRequests(requests, error);
    });
    this.lastScheduledOperation = operation;
  }

  private async rollbackAppend(handle: FileHandle): Promise<void> {
    const rollback = this.rollback;
    if (!rollback) return;
    const size = (await handle.stat()).size;
    const suffixLength = size - rollback.size;
    const expectedLength = rollback.records.reduce(
      (sum, record) => sum + record.bytes.length,
      0,
    );
    const changed = () =>
      new Error(
        'Transcript changed after a failed append; refusing to discard unrelated data',
      );
    if (suffixLength < 0 || suffixLength > expectedLength) throw changed();
    // The coordinator serializes this process, but another process can still
    // touch the file. Never truncate bytes that are not our attempted append.
    let checked = 0;
    const buffer = Buffer.alloc(Math.min(suffixLength, 64 * 1024));
    for (const record of rollback.records) {
      for (
        let offset = 0;
        offset < record.bytes.length && checked < suffixLength;

      ) {
        const length = Math.min(
          buffer.length,
          record.bytes.length - offset,
          suffixLength - checked,
        );
        const { bytesRead } = await handle.read(
          buffer,
          0,
          length,
          rollback.size + checked,
        );
        if (
          bytesRead !== length ||
          !buffer
            .subarray(0, length)
            .equals(record.bytes.subarray(offset, offset + length))
        ) {
          throw changed();
        }
        offset += length;
        checked += length;
      }
    }
    if ((await handle.stat()).size !== size) throw changed();
    await handle.truncate(rollback.size);
    this.rollback = undefined;
  }

  private enqueueFileOperation<T>(
    operation: () => Promise<T>,
    poisonOnFailure: (error: unknown) => boolean = () => true,
  ): Promise<T> {
    const scheduled = this.operationTail.then(() => {
      if (this.state === 'failed') {
        throw this.failure;
      }
      if (this.state === 'closed') {
        throw new Error('AppendChannel is closed');
      }
      return operation();
    });
    const barrierCompletion = scheduled.then(
      () => undefined,
      (error: unknown) => {
        if (!poisonOnFailure(error)) {
          return;
        }
        this.state = 'failed';
        this.failure = error;
        this.cancelDrainTimer();
        rejectRequests(this.pendingRequests, error);
        this.pendingRequests = [];
        throw error;
      },
    );
    this.operationTail = barrierCompletion.catch(() => undefined);
    this.lastScheduledOperation = barrierCompletion;
    return scheduled;
  }

  private async prepareForAppend(allowRetry = true): Promise<void> {
    if (this.prepared) {
      return;
    }
    let handle: FileHandle;
    try {
      await this.fileSystem.mkdir(path.dirname(this.filePath), {
        recursive: true,
        mode: 0o700,
      });
      // Windows O_APPEND handles lack FILE_WRITE_DATA and cannot truncate an
      // incomplete tail. Open read/write without O_TRUNC to preserve history;
      // only the subsequent batch writes need append semantics.
      handle = await this.fileSystem.open(
        this.filePath,
        fsConstants.O_RDWR | fsConstants.O_CREAT,
        0o600,
      );
    } catch (error) {
      if (allowRetry && isNodeError(error) && error.code === 'ENOENT') {
        return this.prepareForAppend(false);
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (stat.size > 0) {
        const tail = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(tail, 0, 1, stat.size - 1);
        if (bytesRead === 1 && tail[0] !== 0x0a) {
          // A previous process may have stopped in the middle of a JSONL
          // record. Preserve complete records, including legacy ones without
          // LF, but remove an undecodable suffix before appending new data.
          const pieces: Buffer[] = [];
          let offset = stat.size;
          let tailStart = 0;
          while (offset > 0) {
            const length = Math.min(offset, 64 * 1024);
            offset -= length;
            const piece = Buffer.alloc(length);
            const result = await handle.read(piece, 0, length, offset);
            if (result.bytesRead !== length) {
              throw new Error('Transcript changed while preparing its tail');
            }
            const newline = piece.lastIndexOf(0x0a);
            pieces.push(piece.subarray(newline + 1));
            if (newline !== -1) {
              tailStart = offset + newline + 1;
              break;
            }
          }
          const suffix = Buffer.concat(pieces.reverse()).toString('utf8');
          let complete = false;
          try {
            JSON.parse(suffix);
            complete = true;
          } catch {
            // Only the unterminated suffix is eligible for repair.
          }
          if (complete) {
            await handle.write(Buffer.from('\n'), 0, 1, stat.size);
          } else {
            await handle.truncate(tailStart);
            runLogger.warn('transcript.append.discarded_incomplete_tail', {
              bytes: stat.size - tailStart,
            });
          }
        }
      }
    } finally {
      await handle.close();
    }
    this.prepared = true;
  }

  private async notifyCommitted(entries: readonly Entry[]): Promise<void> {
    if (!this.commitObserver) {
      return;
    }
    try {
      await this.commitObserver(this.filePath, entries);
    } catch (error) {
      runLogger.warn(
        `[Transcript] post-commit observer failed for ${this.filePath}`,
        error,
      );
    }
  }

  private assertWritable(): void {
    this.assertUsable();
    if (this.state !== 'open') {
      throw new Error(`AppendChannel is ${this.state}`);
    }
  }

  private assertUsable(): void {
    if (this.state === 'failed') {
      throw this.failure;
    }
    if (this.state === 'closed') {
      throw new Error('AppendChannel is closed');
    }
  }

  private barrierInternal(): Promise<void> {
    this.cancelDrainTimer();
    this.schedulePendingRequests();
    return this.lastScheduledOperation;
  }
}

function partitionRecords(
  records: readonly PendingRecord[],
  maxBatchBytes: number,
): PendingRecord[][] {
  const chunks: PendingRecord[][] = [];
  let chunk: PendingRecord[] = [];
  let chunkBytes = 0;

  for (const record of records) {
    if (chunk.length > 0 && chunkBytes + record.bytes.length > maxBatchBytes) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(record);
    chunkBytes += record.bytes.length;
    if (record.bytes.length > maxBatchBytes) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function acknowledgeRecords(records: readonly PendingRecord[]): void {
  for (const record of records) {
    const request = record.request;
    if (request.settled) {
      continue;
    }
    request.remainingRecords--;
    if (request.remainingRecords === 0) {
      request.settled = true;
      request.resolve();
    }
  }
}

function rejectRequests(
  requests: readonly AppendRequest[],
  error: unknown,
): void {
  for (const request of requests) {
    if (!request.settled) {
      request.settled = true;
      request.reject(error);
    }
  }
}
