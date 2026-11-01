/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  SessionWriterLease,
  type AcquireSessionWriterLeaseOptions,
} from '../services/session-writer-lease.js';
import {
  managedSessionEventRefs,
  managedSessionKeysEqual,
  type ManagedSessionKey,
  ManagedSessionRecordError,
  parseManagedSessionHeader,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { managedSessionNestedResourceRefs } from './managed-session-resource-references.js';
import { scanManagedSessionJournal } from './managed-session-storage.js';
import {
  LOCAL_MANAGED_JOURNAL_FORMAT,
  LOCAL_MANAGED_SNAPSHOT_BASE,
  LOCAL_MANAGED_SNAPSHOT_FORMAT,
  LOCAL_MANAGED_SNAPSHOT_KIND,
  LOCAL_MANAGED_SNAPSHOT_PAGE_BYTES,
  LOCAL_MANAGED_SNAPSHOT_PAGE_KIND,
  localJournalDigest,
  localJournalObject,
  localJournalPhysicalPrefix,
  parseLocalJournalBase,
  readLocalJournalBytes,
  readLocalManagedJournal,
  type LocalManagedJournalManifest,
} from './local-managed-journal-snapshot.js';

function sourceHeader(bytes: Buffer) {
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line) continue;
    const record = localJournalObject(JSON.parse(line));
    if (record['subtype'] === 'managed_session_header_v1') {
      return parseManagedSessionHeader(record['managedSession']);
    }
  }
  return undefined;
}

/** Acquire writer capability; preparation waits for restore admission. */
export async function acquireLocalManagedSessionWriter(
  options: AcquireSessionWriterLeaseOptions,
): Promise<SessionWriterLease> {
  let header;
  try {
    header = sourceHeader(readLocalJournalBytes(options.transcriptPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lease = await SessionWriterLease.acquire({
    ...options,
    takeoverPolicy: 'certified',
    lockSchema: {
      schemaVersion: 3,
      formatVersion:
        header?.minimumReader === 'managed-session/2'
          ? LOCAL_MANAGED_JOURNAL_FORMAT
          : 1,
      resumeFormatVersion: LOCAL_MANAGED_JOURNAL_FORMAT,
    },
  });
  return lease;
}

export async function prepareLocalManagedSessionWriter(
  lease: SessionWriterLease,
  expectedSessionKey: ManagedSessionKey,
): Promise<boolean> {
  const options = {
    runtimeBaseDir: lease.runtimeBaseDir,
    transcriptPath: lease.transcriptPath,
    sessionId: lease.sessionId,
  };
  const proof = lease.takeoverCommitProof;
  if (
    !proof ||
    lease.managedJournalFormatVersion !== LOCAL_MANAGED_JOURNAL_FORMAT
  )
    return false;
  let header;
  try {
    const bytes = Buffer.from(await lease.readTranscript());
    header = sourceHeader(bytes);
    if (!header) return false;
    if (
      header.sessionKey.sessionId !== options.sessionId ||
      !managedSessionKeysEqual(header.sessionKey, expectedSessionKey)
    ) {
      throw new ManagedSessionRecordError(
        'Local snapshot source has a different Session.',
      );
    }
    if (parseLocalJournalBase(bytes, header.sessionKey)) return false;
    const scan = scanManagedSessionJournal(bytes, header.sessionKey);
    if (
      scan.committed !== proof.last_commit_sequence ||
      (scan.lastMarkerDigest ?? '0'.repeat(64)) !== proof.committed_prefix_hash
    ) {
      const { ManagedSessionConflictError } = await import(
        './managed-session-authority.js'
      );
      throw new ManagedSessionConflictError(
        'Local snapshot source does not match the sealed writer proof.',
      );
    }
    if (scan.uncommitted > 0 || scan.committed === 0) return false;
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: options.runtimeBaseDir,
      sessionKey: header.sessionKey,
    });
    const pending = [
      header.definitionRef,
      header.rootSnapshotRef,
      ...(header.baseTranscriptProof ? [header.baseTranscriptProof] : []),
      ...scan.events.flatMap(managedSessionEventRefs),
    ];
    const refs = new Map<string, ManagedSessionDurableRef>();
    while (pending.length) {
      const ref = pending.pop()!;
      const previous = refs.get(ref.resourceId);
      if (previous) {
        if (
          previous.kind !== ref.kind ||
          previous.schemaVersion !== ref.schemaVersion ||
          previous.byteLength !== ref.byteLength ||
          previous.digest !== ref.digest
        ) {
          throw new ManagedSessionRecordError(
            'Local snapshot resource references conflict.',
          );
        }
        continue;
      }
      refs.set(ref.resourceId, ref);
      pending.push(
        ...managedSessionNestedResourceRefs(ref, await resources.read(ref)),
      );
    }
    const pages: ManagedSessionDurableRef[] = [];
    let pageStart = 0;
    let transactionEnd = 0;
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      if (end < 0)
        throw new ManagedSessionRecordError(
          'Local snapshot source has a torn line.',
        );
      const record = localJournalObject(
        JSON.parse(bytes.subarray(offset, end).toString('utf8')),
      );
      if (record['subtype'] === 'managed_session_commit_v1') {
        if (end + 1 - pageStart > LOCAL_MANAGED_SNAPSHOT_PAGE_BYTES) {
          if (transactionEnd === pageStart)
            throw new ManagedSessionRecordError(
              'Local snapshot transaction exceeds its page budget.',
            );
          pages.push(
            await resources.publishJournalSnapshot(
              LOCAL_MANAGED_SNAPSHOT_PAGE_KIND,
              bytes.subarray(pageStart, transactionEnd),
            ),
          );
          pageStart = transactionEnd;
        }
        transactionEnd = end + 1;
        if (transactionEnd - pageStart > LOCAL_MANAGED_SNAPSHOT_PAGE_BYTES)
          throw new ManagedSessionRecordError(
            'Local snapshot transaction exceeds its page budget.',
          );
      }
      offset = end + 1;
    }
    pages.push(
      await resources.publishJournalSnapshot(
        LOCAL_MANAGED_SNAPSHOT_PAGE_KIND,
        bytes.subarray(pageStart),
      ),
    );
    const latestRef = (domain: string) =>
      scan.events.findLast(
        (event) =>
          event.kind === 'domain.committed' &&
          event.payload['domain'] === domain,
      )?.payload['recordRef'] as ManagedSessionDurableRef | undefined;
    const manifest: LocalManagedJournalManifest = {
      format: LOCAL_MANAGED_SNAPSHOT_FORMAT,
      sessionKey: header.sessionKey,
      pages,
      byteLength: bytes.length,
      digest: localJournalDigest(bytes),
      committedSequence: scan.committed,
      lastCommitDigest: scan.lastMarkerDigest!,
      lastRecordUuid: scan.lastRecordUuid!,
      resources: [...refs.values()].sort((a, b) =>
        a.resourceId.localeCompare(b.resourceId),
      ),
      titleRef: latestRef('session_metadata') ?? null,
      sourceRef: latestRef('session_source') ?? null,
    };
    const manifestRef = await resources.publishJournalSnapshot(
      LOCAL_MANAGED_SNAPSHOT_KIND,
      Buffer.from(JSON.stringify(manifest)),
    );
    const physicalPrefix = localJournalPhysicalPrefix(bytes, header);
    const headerRecord = localJournalObject(
      JSON.parse(physicalPrefix.toString('utf8').trimEnd().split('\n').at(-1)!),
    );
    const base = {
      uuid: randomUUID(),
      parentUuid: headerRecord['uuid'],
      type: 'system',
      subtype: LOCAL_MANAGED_SNAPSHOT_BASE,
      sessionId: options.sessionId,
      managedSessionSnapshot: {
        format: LOCAL_MANAGED_SNAPSHOT_FORMAT,
        sessionKey: header.sessionKey,
        manifest: manifestRef,
      },
    };
    const sessionKey = header.sessionKey;
    await lease.replaceManagedTranscript(
      `${physicalPrefix.toString('utf8')}${JSON.stringify(base)}\n`,
      manifest.digest,
      () => {
        const restored = readLocalManagedJournal({ ...options, sessionKey });
        if (
          restored.committed !== scan.committed ||
          restored.lastMarkerDigest !== scan.lastMarkerDigest ||
          restored.lastRecordUuid !== scan.lastRecordUuid ||
          JSON.stringify([...restored.transactions]) !==
            JSON.stringify([...scan.transactions])
        ) {
          throw new ManagedSessionRecordError(
            'Local snapshot replacement changed the logical commit proof.',
          );
        }
      },
    );
    return true;
  } catch (error) {
    // This preserves the barrier; an uncertain physical replacement refuses seal.
    await lease.sealForHandoff(proof).catch(() => undefined);
    throw error;
  }
}
