/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { TranscriptCommitObserver } from './commit-observer.js';
import type { TranscriptEntry } from '../entry/transcript-entry.js';
import { encodeTranscriptEntry } from '../codec/transcript-entry-codec.js';
import type { AppendChannelOptions } from './append-channel-options.js';
import type { TranscriptFileSystem } from './append-channel-file-system.js';
import { nodeTranscriptFileSystem } from './append-channel-file-system.js';
import { runLogger } from '../../../utils/runLogger.js';

interface AppendRequest {
  records: PendingRecord[];
  remainingRecords: number;
  settled: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface PendingRecord {
  bytes: Buffer;
  entry: TranscriptEntry;
  request: AppendRequest;
}

const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Owns the ordered append queue for exactly one canonical transcript path.
 *
 * Mirrors the legacy `AppendChannel`: it buffers entries, batches physical
 * writes, ensures trailing newlines, and poisons itself on the first I/O
 * failure. The channel contains no session, parent-chain or deduplication
 * logic — that lives in the domain writer.
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
  private state: 'open' | 'closing' | 'failed' | 'closed' = 'open';
  private failure: unknown;
  private closePromise: Promise<void> | undefined;

  constructor(options: AppendChannelOptions) {
    this.filePath = options.filePath;
    this.flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.fileSystem = options.fileSystem ?? nodeTranscriptFileSystem;
    this.commitObserver = options.commitObserver;
    if (this.maxBatchBytes <= 0) {
      throw new RangeError('maxBatchBytes must be greater than zero');
    }
  }

  append(entries: readonly TranscriptEntry[]): Promise<void> {
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

  async createExclusive(entries: readonly TranscriptEntry[]): Promise<void> {
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
    }, () => false);
    await operation;
    this.state = 'closed';
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

    const operation = this.enqueueFileOperation(async () => {
      await this.prepareForAppend();
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        if (!chunk) {
          continue;
        }
        try {
          await this.fileSystem.appendFile(
            this.filePath,
            Buffer.concat(chunk.map((record) => record.bytes)),
            { mode: 0o600 },
          );
          await this.notifyCommitted(chunk.map((record) => record.entry));
          acknowledgeRecords(chunk);
        } catch (error) {
          rejectRecords(chunks.slice(index).flat(), error);
          throw error;
        }
      }
    });
    void operation.catch((error: unknown) => {
      rejectRequests(requests, error);
    });
    this.lastScheduledOperation = operation;
  }

  private async prepareForAppend(): Promise<void> {
    if (this.prepared) {
      return;
    }
    await this.fileSystem.mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    const handle = await this.fileSystem.open(this.filePath, 'a+', 0o600);
    try {
      const stat = await handle.stat();
      if (stat.size > 0) {
        const tail = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(tail, 0, 1, stat.size - 1);
        if (bytesRead === 1 && tail[0] !== 0x0a) {
          await handle.write(Buffer.from('\n'), 0, 1, null);
        }
      }
    } finally {
      await handle.close();
    }
    this.prepared = true;
  }

  private async notifyCommitted(
    entries: readonly TranscriptEntry[],
  ): Promise<void> {
    if (!this.commitObserver) {
      return;
    }
    try {
      await this.commitObserver(this.filePath, entries);
    } catch (error) {
      // Post-commit observers must not poison the channel; the entries are
      // already durable. This mirrors the legacy AppendChannel behaviour.
      runLogger.warn(
        `[Transcript] post-commit observer failed for ${this.filePath}`,
        error,
      );
    }
  }

  private barrierInternal(): Promise<void> {
    this.cancelDrainTimer();
    this.schedulePendingRequests();
    return this.lastScheduledOperation;
  }

  private assertUsable(): void {
    if (this.state === 'failed') {
      throw this.failure;
    }
    if (this.state === 'closed') {
      throw new Error('AppendChannel is closed');
    }
  }

  private assertWritable(): void {
    this.assertUsable();
    if (this.state === 'closing') {
      throw new Error('AppendChannel is closing');
    }
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

function rejectRecords(
  records: readonly PendingRecord[],
  error: unknown,
): void {
  const requests = new Set(records.map((record) => record.request));
  rejectRequests([...requests], error);
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
