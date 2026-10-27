/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ManagedSessionRecordError,
  managedSessionEventRefs,
  type ManagedSessionKey,
} from './managed-session-records.js';
import { managedSessionNestedResourceRefs } from './managed-session-resource-references.js';
import {
  scanManagedSessionJournal,
  type ManagedSessionJournalScan,
} from './managed-session-storage.js';
import {
  readLocalJournalBytes,
  parseLocalJournalBase,
  readLocalJournalManifest,
  readLocalJournalResource,
  localJournalDigest,
  localJournalPhysicalPrefix,
} from '../utils/local-managed-journal-snapshot.js';
export * from '../utils/local-managed-journal-snapshot.js';

function requireSnapshot(
  condition: boolean,
  detail: string,
): asserts condition {
  if (!condition)
    throw new ManagedSessionRecordError(`Local journal snapshot ${detail}.`);
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
