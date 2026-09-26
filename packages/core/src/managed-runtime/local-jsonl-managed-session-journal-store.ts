/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import {
  ManagedSessionRecordError,
  MANAGED_SESSION_FORMAT_VERSION,
} from './managed-session-records.js';
import {
  emptyManagedSessionJournalScan,
  scanManagedSessionJournal,
  type ManagedSessionCommitProof,
  type ManagedSessionJournalHandle,
  type ManagedSessionJournalScan,
  type ManagedSessionJournalStore,
} from './managed-session-storage.js';
import type { ManagedSessionKey } from './managed-session-records.js';

interface LocalJsonlManagedSessionJournalStoreOptions {
  readonly runtimeBaseDir: string;
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly lease?: SessionWriterLease;
}

/** Local-file implementation retained for standalone CLI and development. */
export class LocalJsonlManagedSessionJournalStore
  implements ManagedSessionJournalStore
{
  constructor(
    private readonly options: LocalJsonlManagedSessionJournalStoreOptions,
  ) {}

  async open(request: {
    readonly sessionKey: ManagedSessionKey;
  }): Promise<LocalJsonlManagedSessionJournalHandle> {
    const adopted = this.options.lease !== undefined;
    const lease =
      this.options.lease ??
      (await SessionWriterLease.acquire({
        runtimeBaseDir: this.options.runtimeBaseDir,
        sessionId: this.options.sessionId,
        transcriptPath: this.options.transcriptPath,
        takeoverPolicy: 'certified',
        // A Managed writer pins its log format into the lock: baseline
        // binaries refuse the unknown schema, which is the write barrier
        // that keeps this log off legacy writers.
        lockSchema: {
          schemaVersion: 3,
          formatVersion: MANAGED_SESSION_FORMAT_VERSION,
        },
      }));
    return new LocalJsonlManagedSessionJournalHandle(
      lease,
      request.sessionKey,
      !adopted,
    );
  }

  static fromLease(
    lease: SessionWriterLease,
    sessionKey: ManagedSessionKey,
  ): LocalJsonlManagedSessionJournalHandle {
    return new LocalJsonlManagedSessionJournalHandle(lease, sessionKey, false);
  }

  static async read(
    transcriptPath: string,
    sessionKey: ManagedSessionKey,
    maxBytes?: number,
  ): Promise<ManagedSessionJournalScan> {
    try {
      const bytes = await readFile(transcriptPath);
      return scanManagedSessionJournal(bytes, sessionKey, maxBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyManagedSessionJournalScan();
      }
      throw error;
    }
  }
}

export class LocalJsonlManagedSessionJournalHandle
  implements ManagedSessionJournalHandle
{
  constructor(
    private readonly lease: SessionWriterLease,
    readonly sessionKey: ManagedSessionKey,
    private readonly ownsLease: boolean,
  ) {}

  read(
    options: {
      readonly maxBytes?: number;
    } = {},
  ): Promise<ManagedSessionJournalScan> {
    return LocalJsonlManagedSessionJournalStore.read(
      this.lease.transcriptPath,
      this.sessionKey,
      options.maxBytes,
    );
  }

  async appendTransaction(records: readonly unknown[]): Promise<void> {
    for (const record of records) {
      await this.lease.appendJsonLine(record);
    }
  }

  seal(commit: ManagedSessionCommitProof): Promise<void> {
    return this.lease.sealForHandoff({
      last_commit_sequence: commit.lastCommitSequence,
      committed_prefix_hash: commit.committedPrefixHash,
    });
  }

  get takeoverCommitProof(): ManagedSessionCommitProof | undefined {
    const proof = this.lease.takeoverCommitProof;
    if (proof === undefined) return undefined;
    return {
      lastCommitSequence: proof.last_commit_sequence,
      committedPrefixHash: proof.committed_prefix_hash,
    };
  }

  async abort(): Promise<void> {
    if (this.ownsLease) {
      await this.lease.release();
    }
  }

  async recoverUncommittedTail(): Promise<{
    discardedBytes: number;
    diagnosticPath: string;
  }> {
    const scan = await this.read();
    if (scan.uncommitted === 0) {
      throw new ManagedSessionRecordError(
        'session log has no uncommitted tail to discard.',
      );
    }
    const retain = Math.max(scan.committedBytes, scan.headerBytes);
    if (retain === 0) {
      throw new ManagedSessionRecordError(
        'session log has no committed prefix to retain.',
      );
    }
    const bytes = await readFile(this.lease.transcriptPath);
    if (bytes.byteLength <= retain) {
      throw new ManagedSessionRecordError(
        'session log changed while preparing tail recovery.',
      );
    }
    const discarded = bytes.subarray(retain);
    const diagnosticPath = `${this.lease.transcriptPath}.uncommitted-tail`;
    const pendingPath = `${diagnosticPath}.pending`;
    await writeFile(pendingPath, discarded, { mode: 0o600 });
    try {
      await this.lease.truncateTo(retain);
    } catch (cause) {
      await unlink(pendingPath).catch(() => undefined);
      throw cause;
    }
    await rename(pendingPath, diagnosticPath);
    return { discardedBytes: discarded.byteLength, diagnosticPath };
  }
}
