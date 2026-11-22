/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { SessionWriterLease } from '../services/session-writer-lease.js';
import {
  acquireLocalManagedSessionWriter,
  prepareLocalManagedSessionWriter,
} from './local-managed-session-writer.js';
import { readLocalManagedJournal } from './local-managed-journal-snapshot.js';
import { ManagedSessionRecordError } from './managed-session-records.js';
import {
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
  readonly requireNew?: boolean;
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
      (await acquireLocalManagedSessionWriter({
        runtimeBaseDir: this.options.runtimeBaseDir,
        sessionId: this.options.sessionId,
        transcriptPath: this.options.transcriptPath,
      }));
    return new LocalJsonlManagedSessionJournalHandle(
      lease,
      request.sessionKey,
      !adopted,
      this.options.requireNew !== true,
    );
  }

  static fromLease(
    lease: SessionWriterLease,
    sessionKey: ManagedSessionKey,
  ): LocalJsonlManagedSessionJournalHandle {
    return new LocalJsonlManagedSessionJournalHandle(lease, sessionKey, false);
  }

  static async read(options: {
    readonly transcriptPath: string;
    readonly runtimeBaseDir: string;
    readonly sessionKey: ManagedSessionKey;
    readonly maxBytes?: number;
  }): Promise<ManagedSessionJournalScan> {
    return readLocalManagedJournal(options);
  }
}

export class LocalJsonlManagedSessionJournalHandle
  implements ManagedSessionJournalHandle
{
  constructor(
    private readonly lease: SessionWriterLease,
    readonly sessionKey: ManagedSessionKey,
    private readonly ownsLease: boolean,
    private readonly prepareOnRead = true,
  ) {}

  private preparation: Promise<boolean> | undefined;

  async read(
    options: {
      readonly maxBytes?: number;
    } = {},
  ): Promise<ManagedSessionJournalScan> {
    if (this.prepareOnRead) {
      // This handle already owns the writer; static inspection never prepares.
      this.preparation ??= prepareLocalManagedSessionWriter(
        this.lease,
        this.sessionKey,
      );
      await this.preparation;
    }
    return LocalJsonlManagedSessionJournalStore.read({
      transcriptPath: this.lease.transcriptPath,
      runtimeBaseDir: this.lease.runtimeBaseDir,
      sessionKey: this.sessionKey,
      ...options,
    });
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

  get writerSealed(): boolean {
    return this.lease.isReleased;
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
    if (!this.ownsLease) return;
    if ((this.lease.managedJournalFormatVersion ?? 0) >= 2) {
      // Retain the format barrier so an older writer cannot acquire the Session.
      const proof = this.lease.takeoverCommitProof;
      if (proof) await this.lease.sealForHandoff(proof);
      return;
    }
    await this.lease.release();
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
