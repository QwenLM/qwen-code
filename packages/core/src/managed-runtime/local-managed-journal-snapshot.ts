/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  ManagedSessionRecordError,
  MANAGED_SESSION_LIMITS,
  managedSessionEventRefs,
  type ManagedSessionDurableRef,
  type ManagedSessionKey,
} from './managed-session-records.js';
import { managedSessionNestedResourceRefs } from './managed-session-resource-references.js';
import { FileManagedSessionHistory } from './managed-session-history.js';
import {
  scanManagedSessionJournal,
  scanManagedSessionJournalStream,
  type ManagedSessionJournalBatch,
  type ManagedSessionJournalScan,
  type ManagedSessionJournalSummary,
} from './managed-session-storage.js';
import {
  readLocalJournalBytes,
  parseLocalJournalBase,
  readLocalJournalManifest,
  readLocalJournalResource,
  localJournalDigest,
  localJournalPhysicalPrefix,
  readLocalJournalControlPrefix,
  readLocalJournalStream,
} from '../utils/local-managed-journal-snapshot.js';
export * from '../utils/local-managed-journal-snapshot.js';

function requireSnapshot(
  condition: boolean,
  detail: string,
): asserts condition {
  if (!condition)
    throw new ManagedSessionRecordError(`Local journal snapshot ${detail}.`);
}

export class LocalManagedResourceCensus {
  private readonly verified;
  private readonly pending;
  private next = 0;
  private end = 0;

  constructor(
    history: FileManagedSessionHistory,
    private readonly read: (ref: ManagedSessionDurableRef) => Promise<Buffer>,
  ) {
    this.verified = history.map<ManagedSessionDurableRef>('resource');
    this.pending = history.map<ManagedSessionDurableRef>('resource-pending');
  }

  async verify(refs: readonly ManagedSessionDurableRef[]): Promise<void> {
    for (const ref of refs) await this.enqueue(ref);
    while (this.next < this.end) {
      const ref = (await this.pending.get(`ref:${this.next++}`))!;
      const previous = await this.verified.get(ref.resourceId);
      if (previous) {
        this.assertSameReference(previous, ref);
        continue;
      }
      await this.verified.set(ref.resourceId, ref);
      for (const child of managedSessionNestedResourceRefs(
        ref,
        await this.read(ref),
      ))
        await this.enqueue(child);
    }
  }

  private async enqueue(ref: ManagedSessionDurableRef): Promise<void> {
    const previous = await this.verified.get(ref.resourceId);
    if (previous) this.assertSameReference(previous, ref);
    else await this.pending.set(`ref:${this.end++}`, ref);
  }

  values(): AsyncGenerator<ManagedSessionDurableRef> {
    return this.verified.values();
  }

  private assertSameReference(
    previous: ManagedSessionDurableRef,
    ref: ManagedSessionDurableRef,
  ): void {
    requireSnapshot(
      previous.kind === ref.kind &&
        previous.schemaVersion === ref.schemaVersion &&
        previous.byteLength === ref.byteLength &&
        previous.digest === ref.digest,
      'resource references conflict',
    );
  }
}

export interface LocalManagedJournalReadOptions {
  readonly transcriptPath: string;
  readonly runtimeBaseDir: string;
  readonly sessionKey: ManagedSessionKey;
  readonly maxBytes?: number;
}

export async function scanLocalManagedJournal(
  options: LocalManagedJournalReadOptions,
  consume: (batch: ManagedSessionJournalBatch) => Promise<void>,
  physicalChunks?: AsyncIterable<Buffer>,
): Promise<ManagedSessionJournalSummary> {
  const { maxBytes, transcriptPath, runtimeBaseDir } = options;
  const sessionKey = { ...options.sessionKey };
  if (maxBytes !== undefined)
    requireSnapshot(
      Number.isSafeInteger(maxBytes) && maxBytes >= 0,
      'byte bound is invalid',
    );
  const physical =
    physicalChunks ?? readLocalJournalStream(transcriptPath, maxBytes);
  let physicalBytes = 0;
  const bounded = async function* () {
    for await (const chunk of physical) {
      const included =
        maxBytes === undefined
          ? chunk
          : chunk.subarray(0, Math.max(0, maxBytes - physicalBytes));
      physicalBytes += included.byteLength;
      if (included.byteLength) yield included;
    }
  };
  const input = bounded();
  let control;
  try {
    control = await readLocalJournalControlPrefix(input);
  } catch (error) {
    await input.return(undefined);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const {
        events: _events,
        transactions: _transactions,
        ...summary
      } = scanManagedSessionJournal(Buffer.alloc(0), sessionKey);
      return summary;
    }
    throw error;
  }
  let history: FileManagedSessionHistory | undefined;
  try {
    const base = parseLocalJournalBase(control.bytes, sessionKey);
    if (!base) {
      const original = async function* () {
        yield control.bytes;
        yield* control.rest;
      };
      return await scanManagedSessionJournalStream(
        original(),
        sessionKey,
        consume,
      );
    }
    const manifest = readLocalJournalManifest(
      runtimeBaseDir,
      sessionKey,
      base.manifest,
    );
    history = await FileManagedSessionHistory.create(
      path.join(runtimeBaseDir, 'managed-history'),
    );
    const census = new LocalManagedResourceCensus(history, async (ref) =>
      readLocalJournalResource(runtimeBaseDir, sessionKey, ref),
    );
    for (const ref of manifest.resources) await census.verify([ref]);
    let prefixDigest = '';
    let prefixBytes = 0;
    let prefixVerified = false;
    let ownershipVerified = false;
    const ownership: Buffer[] = [];
    let ownershipBytes = 0;
    const logical = async function* () {
      const hasher = createHash('sha256');
      for (let index = 0; index < manifest.pages.length; index++) {
        const bytes = readLocalJournalResource(
          runtimeBaseDir,
          sessionKey,
          manifest.pages[index],
        );
        prefixBytes += bytes.byteLength;
        hasher.update(bytes);
        if (index === manifest.pages.length - 1)
          prefixDigest = hasher.digest('hex');
        yield bytes;
      }
      requireSnapshot(
        prefixVerified && ownershipVerified,
        'prefix commit proof differs',
      );
      yield control.bytes.subarray(base.baseEnd);
      yield* control.rest;
    };
    let headerVerified = false;
    const summary = await scanManagedSessionJournalStream(
      logical(),
      sessionKey,
      async (batch) => {
        if (!ownershipVerified) {
          ownership.push(batch.sourceBytes);
          ownershipBytes += batch.sourceBytes.byteLength;
          requireSnapshot(
            ownershipBytes <=
              MANAGED_SESSION_LIMITS.maxEventBytes +
                MANAGED_SESSION_LIMITS.maxHeaderBytes +
                2,
            'ownership prefix exceeds its byte budget',
          );
          if (batch.header) {
            requireSnapshot(
              localJournalPhysicalPrefix(
                Buffer.concat(ownership),
                batch.header,
              ).equals(control.bytes.subarray(0, base.headerEnd)),
              'ownership prefix differs from its source',
            );
            ownership.length = 0;
            ownershipVerified = true;
          }
        }
        if (
          batch.sourceOffset + batch.sourceBytes.byteLength ===
          manifest.byteLength
        ) {
          requireSnapshot(
            prefixBytes === manifest.byteLength &&
              prefixDigest === manifest.digest &&
              batch.uncommitted === 0 &&
              batch.committed === manifest.committedSequence &&
              batch.lastMarkerDigest === manifest.lastCommitDigest &&
              batch.lastRecordUuid === manifest.lastRecordUuid,
            'prefix commit proof differs',
          );
          prefixVerified = true;
        }
        if (batch.header && !headerVerified) {
          await census.verify([
            batch.header.definitionRef,
            batch.header.rootSnapshotRef,
            ...(batch.header.baseTranscriptProof
              ? [batch.header.baseTranscriptProof]
              : []),
          ]);
          headerVerified = true;
        }
        for (const event of batch.events)
          await census.verify(managedSessionEventRefs(event));
        await consume(batch);
      },
    );
    return {
      ...summary,
      headerBytes: base.headerEnd,
      committedBytes:
        base.baseEnd + summary.committedBytes - manifest.byteLength,
      uncommittedBytes:
        physicalBytes -
        (base.baseEnd + summary.committedBytes - manifest.byteLength),
    };
  } finally {
    await input.return(undefined);
    await history?.close();
  }
}

export function readLocalManagedJournal(options: {
  readonly transcriptPath: string;
  readonly runtimeBaseDir: string;
  readonly sessionKey: ManagedSessionKey;
  readonly maxBytes?: number;
}): ManagedSessionJournalScan {
  let bytes: Buffer;
  try {
    bytes = readLocalJournalBytes(options.transcriptPath, options.maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return scanManagedSessionJournal(Buffer.alloc(0), options.sessionKey);
    throw error;
  }
  const base = parseLocalJournalBase(bytes, options.sessionKey);
  if (!base) return scanManagedSessionJournal(bytes, options.sessionKey);
  const manifest = readLocalJournalManifest(
    options.runtimeBaseDir,
    options.sessionKey,
    base.manifest,
  );
  const chunks = manifest.pages.map((ref) =>
    readLocalJournalResource(options.runtimeBaseDir, options.sessionKey, ref),
  );
  const prefix = Buffer.concat(chunks);
  requireSnapshot(
    prefix.length === manifest.byteLength &&
      localJournalDigest(prefix) === manifest.digest,
    'prefix bytes differ',
  );
  const original = scanManagedSessionJournal(prefix, options.sessionKey);
  requireSnapshot(
    original.uncommitted === 0 &&
      original.committedBytes === prefix.length &&
      original.committed === manifest.committedSequence &&
      original.lastMarkerDigest === manifest.lastCommitDigest &&
      original.lastRecordUuid === manifest.lastRecordUuid,
    'prefix commit proof differs',
  );
  requireSnapshot(
    localJournalPhysicalPrefix(prefix, original.header!).equals(
      bytes.subarray(0, base.headerEnd),
    ),
    'ownership prefix differs from its source',
  );
  for (const ref of manifest.resources)
    readLocalJournalResource(options.runtimeBaseDir, options.sessionKey, ref);
  const logical = scanManagedSessionJournal(
    Buffer.concat([prefix, bytes.subarray(base.baseEnd)]),
    options.sessionKey,
  );
  const verified = new Map(
    manifest.resources.map((ref) => [ref.resourceId, ref]),
  );
  const pending = logical.events
    .filter((event) => event.sequence > manifest.committedSequence)
    .flatMap(managedSessionEventRefs);
  while (pending.length) {
    const ref = pending.pop()!;
    const previous = verified.get(ref.resourceId);
    if (previous) {
      requireSnapshot(
        previous.kind === ref.kind &&
          previous.schemaVersion === ref.schemaVersion &&
          previous.byteLength === ref.byteLength &&
          previous.digest === ref.digest,
        'tail resource references conflict',
      );
      continue;
    }
    verified.set(ref.resourceId, ref);
    pending.push(
      ...managedSessionNestedResourceRefs(
        ref,
        readLocalJournalResource(
          options.runtimeBaseDir,
          options.sessionKey,
          ref,
        ),
      ),
    );
  }
  return {
    ...logical,
    headerBytes: base.headerEnd,
    committedBytes: base.baseEnd + logical.committedBytes - prefix.length,
    uncommittedBytes:
      bytes.length - (base.baseEnd + logical.committedBytes - prefix.length),
  };
}
