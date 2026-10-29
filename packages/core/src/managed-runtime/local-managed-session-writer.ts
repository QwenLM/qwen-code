/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
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
import {
  LocalManagedSessionResourceStore,
  MANAGED_SESSION_RESOURCE_LIMITS,
} from './managed-session-resources.js';
import {
  FileManagedSessionHistory,
  type ManagedHistoryMap,
} from './managed-session-history.js';
import {
  scanManagedSessionJournalStream,
  type ManagedSessionJournalSummary,
} from './managed-session-storage.js';
import {
  LOCAL_MANAGED_JOURNAL_FORMAT,
  LOCAL_MANAGED_SNAPSHOT_BASE,
  LOCAL_MANAGED_SNAPSHOT_FORMAT,
  LOCAL_MANAGED_SNAPSHOT_KIND,
  LOCAL_MANAGED_SNAPSHOT_PAGE_BYTES,
  LOCAL_MANAGED_SNAPSHOT_PAGE_KIND,
  localJournalObject,
  localJournalPhysicalPrefix,
  parseLocalJournalBase,
  readLocalJournalHeader,
  readLocalJournalControlPrefix,
  scanLocalManagedJournal,
  LocalManagedResourceCensus,
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
    header = readLocalJournalHeader(options.transcriptPath);
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
  let history: FileManagedSessionHistory | undefined;
  try {
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: options.runtimeBaseDir,
      sessionKey: expectedSessionKey,
    });
    const preflight = await lease.withTranscriptStream(
      async (chunks, physicalProof) => {
        const control = await readLocalJournalControlPrefix(chunks);
        const header = sourceHeader(control.bytes);
        if (
          header &&
          (header.sessionKey.sessionId !== options.sessionId ||
            !managedSessionKeysEqual(header.sessionKey, expectedSessionKey))
        )
          throw new ManagedSessionRecordError(
            'Local snapshot source has a different Session.',
          );
        if (
          !header ||
          parseLocalJournalBase(control.bytes, header.sessionKey)
        ) {
          for await (const _chunk of control.rest) {
            /* verify the frozen source */
          }
          return undefined;
        }
        history = await FileManagedSessionHistory.create(
          path.join(options.runtimeBaseDir, 'managed-history'),
        );
        const pages = history.map<LocalSnapshotPagePlan>('resource-pending');
        const census = new LocalManagedResourceCensus(history, (ref) =>
          resources.read(ref),
        );
        let pageCount = 0;
        let pageOffset = 0;
        let pageBytes = 0;
        let pageHasCommit = false;
        let pageHash = createHash('sha256');
        const controlParts: Buffer[] = [];
        let physicalPrefix: Buffer | undefined;
        let titleRef: ManagedSessionDurableRef | null = null;
        let sourceRef: ManagedSessionDurableRef | null = null;
        const finishPage = async () => {
          if (!pageBytes || !pageHasCommit)
            throw new ManagedSessionRecordError(
              'Local snapshot page has no complete transaction.',
            );
          const digest = pageHash.digest('hex');
          await pages.set(`page:${pageCount++}`, {
            offset: pageOffset,
            ref: {
              kind: LOCAL_MANAGED_SNAPSHOT_PAGE_KIND,
              schemaVersion: 1,
              resourceId: digest,
              digest,
              byteLength: pageBytes,
            },
          });
          pageOffset += pageBytes;
          pageBytes = 0;
          pageHasCommit = false;
          pageHash = createHash('sha256');
        };
        const original = async function* () {
          yield control.bytes;
          yield* control.rest;
        };
        const summary = await scanManagedSessionJournalStream(
          original(),
          header.sessionKey,
          async (batch) => {
            if (batch.uncommitted > 0) return;
            if (
              pageBytes + batch.sourceBytes.byteLength >
              LOCAL_MANAGED_SNAPSHOT_PAGE_BYTES
            )
              await finishPage();
            if (
              batch.sourceBytes.byteLength > LOCAL_MANAGED_SNAPSHOT_PAGE_BYTES
            )
              throw new ManagedSessionRecordError(
                'Local snapshot transaction exceeds its page budget.',
              );
            pageBytes += batch.sourceBytes.byteLength;
            pageHash.update(batch.sourceBytes);
            pageHasCommit ||= batch.transactions.size > 0;
            if (!physicalPrefix) {
              controlParts.push(batch.sourceBytes);
              if (batch.header) {
                physicalPrefix = localJournalPhysicalPrefix(
                  Buffer.concat(controlParts),
                  batch.header,
                );
                controlParts.length = 0;
                await census.verify([
                  header.definitionRef,
                  header.rootSnapshotRef,
                  ...(header.baseTranscriptProof
                    ? [header.baseTranscriptProof]
                    : []),
                ]);
              }
            }
            for (const event of batch.events) {
              await census.verify(managedSessionEventRefs(event));
              if (event.kind === 'domain.committed') {
                if (event.payload['domain'] === 'session_metadata')
                  titleRef = event.payload[
                    'recordRef'
                  ] as unknown as ManagedSessionDurableRef;
                if (event.payload['domain'] === 'session_source')
                  sourceRef = event.payload[
                    'recordRef'
                  ] as unknown as ManagedSessionDurableRef;
              }
            }
          },
        );
        if (
          summary.committed !== proof.last_commit_sequence ||
          (summary.lastMarkerDigest ?? '0'.repeat(64)) !==
            proof.committed_prefix_hash
        ) {
          const { ManagedSessionConflictError } = await import(
            './managed-session-authority.js'
          );
          throw new ManagedSessionConflictError(
            'Local snapshot source does not match the sealed writer proof.',
          );
        }
        if (summary.uncommitted > 0 || summary.committed === 0)
          return undefined;
        if (summary.committedBytes !== physicalProof.byteLength)
          throw new ManagedSessionRecordError(
            'Local snapshot source is not a complete committed prefix.',
          );
        await finishPage();
        return {
          header,
          summary,
          physicalPrefix: physicalPrefix!,
          pages,
          census,
          pageCount,
          sha256: physicalProof.sha256,
          byteLength: physicalProof.byteLength,
          titleRef,
          sourceRef,
        };
      },
    );
    if (!preflight) return false;
    let manifestBytes = 0;
    for await (const piece of localManifestPieces(preflight)) {
      manifestBytes += Buffer.byteLength(piece);
      if (manifestBytes > MANAGED_SESSION_RESOURCE_LIMITS.maxResourceBytes)
        return false;
    }
    await lease.withTranscriptStream(async (chunks, physicalProof) => {
      if (
        physicalProof.sha256 !== preflight.sha256 ||
        physicalProof.byteLength !== preflight.byteLength
      )
        throw new ManagedSessionRecordError(
          'Local snapshot source changed after preflight.',
        );
      let pageIndex = 0;
      let pageBytes = 0;
      let parts: Buffer[] = [];
      await scanManagedSessionJournalStream(
        chunks,
        preflight.header.sessionKey,
        async (batch) => {
          const plan = await preflight.pages.get(`page:${pageIndex}`);
          if (!plan || batch.sourceOffset !== plan.offset + pageBytes)
            throw new ManagedSessionRecordError(
              'Local snapshot page plan changed.',
            );
          parts.push(batch.sourceBytes);
          pageBytes += batch.sourceBytes.byteLength;
          if (pageBytes > plan.ref.byteLength)
            throw new ManagedSessionRecordError(
              'Local snapshot page boundary changed.',
            );
          if (pageBytes === plan.ref.byteLength) {
            const bytes = Buffer.concat(parts, pageBytes);
            if (
              createHash('sha256').update(bytes).digest('hex') !==
              plan.ref.digest
            )
              throw new ManagedSessionRecordError(
                'Local snapshot page digest changed.',
              );
            await resources.publishJournalSnapshot(
              LOCAL_MANAGED_SNAPSHOT_PAGE_KIND,
              bytes,
            );
            parts = [];
            pageBytes = 0;
            pageIndex++;
          }
        },
      );
      if (pageIndex !== preflight.pageCount || pageBytes !== 0)
        throw new ManagedSessionRecordError(
          'Local snapshot page plan is incomplete.',
        );
    });
    const manifestBuffer = Buffer.alloc(manifestBytes);
    let manifestOffset = 0;
    for await (const piece of localManifestPieces(preflight))
      manifestOffset += manifestBuffer.write(piece, manifestOffset, 'utf8');
    const manifestRef = await resources.publishJournalSnapshot(
      LOCAL_MANAGED_SNAPSHOT_KIND,
      manifestBuffer,
    );
    const physicalPrefix = preflight.physicalPrefix;
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
        sessionKey: preflight.header.sessionKey,
        manifest: manifestRef,
      },
    };
    const sessionKey = preflight.header.sessionKey;
    await lease.replaceManagedTranscript(
      `${physicalPrefix.toString('utf8')}${JSON.stringify(base)}\n`,
      preflight.sha256,
      async () => {
        const restored = await scanLocalManagedJournal(
          { ...options, sessionKey },
          async () => {},
        );
        if (
          restored.committed !== preflight.summary.committed ||
          restored.lastMarkerDigest !== preflight.summary.lastMarkerDigest ||
          restored.lastRecordUuid !== preflight.summary.lastRecordUuid
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
  } finally {
    await history?.close();
  }
}

interface LocalSnapshotPagePlan {
  readonly offset: number;
  readonly ref: ManagedSessionDurableRef;
}

async function* localManifestPieces(source: {
  readonly header: ReturnType<typeof parseManagedSessionHeader>;
  readonly summary: ManagedSessionJournalSummary;
  readonly pages: ManagedHistoryMap<LocalSnapshotPagePlan>;
  readonly census: LocalManagedResourceCensus;
  readonly pageCount: number;
  readonly sha256: string;
  readonly byteLength: number;
  readonly titleRef: ManagedSessionDurableRef | null;
  readonly sourceRef: ManagedSessionDurableRef | null;
}): AsyncGenerator<string> {
  yield `{"format":${JSON.stringify(LOCAL_MANAGED_SNAPSHOT_FORMAT)},"sessionKey":${JSON.stringify(source.header.sessionKey)},"pages":[`;
  for (let index = 0; index < source.pageCount; index++) {
    const plan = await source.pages.get(`page:${index}`);
    if (!plan)
      throw new ManagedSessionRecordError(
        'Local snapshot page census is incomplete.',
      );
    yield `${index ? ',' : ''}${JSON.stringify(plan.ref)}`;
  }
  yield `],"byteLength":${source.byteLength},"digest":${JSON.stringify(source.sha256)},"committedSequence":${source.summary.committed},"lastCommitDigest":${JSON.stringify(source.summary.lastMarkerDigest)},"lastRecordUuid":${JSON.stringify(source.summary.lastRecordUuid)},"resources":[`;
  let first = true;
  for await (const ref of source.census.values()) {
    yield `${first ? '' : ','}${JSON.stringify(ref)}`;
    first = false;
  }
  yield `],"titleRef":${JSON.stringify(source.titleRef)},"sourceRef":${JSON.stringify(source.sourceRef)}}`;
}
