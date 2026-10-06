/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { managedToolDigest } from '../../tools/managed-tool-protocol.js';
import type { ManagedSession } from '../managed-session-assembly.js';
import type { LocalManagedSessionResourceStore } from '../managed-session-resources.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from '../managed-session-records.js';
import { scanManagedSessionJournal } from '../managed-session-storage.js';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function csiSessionSnapshot(
  session: ManagedSession,
  resources: LocalManagedSessionResourceStore,
  transcriptPath: string,
) {
  const key = session.authority.sessionHeader.sessionKey;
  const records = (await fs.readFile(transcriptPath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const batches = [records.slice(0, 2)];
  let pending = [];
  for (const record of records.slice(2)) {
    pending.push(record);
    if (record.subtype === 'managed_session_commit_v1') {
      batches.push(pending);
      pending = [];
    }
  }
  const stored = new Map<
    string,
    {
      ref: ManagedSessionDurableRef;
      bytesBase64: string;
      referencedRevisions: number[];
    }
  >();
  let epoch = 0;
  let latest: string | null = null;
  const transactions = [];
  for (const [index, batch] of batches.entries()) {
    const bytes = Buffer.from(
      batch.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const marker = index === 0 ? null : batch.at(-1)!.managedSession;
    for (const record of batch) {
      if (record.managedSession?.kind === 'activation.changed')
        epoch = record.managedSession.payload.epoch;
      if (record.managedSession?.kind === 'checkpoint.committed')
        latest = record.managedSession.payload.stateRef.resourceId;
    }
    transactions.push({
      journalRevision: index + 1,
      recordEncoding: 'identity',
      recordBytesBase64: bytes.toString('base64'),
      byteLength: bytes.length,
      recordDigest: sha(bytes),
      activationEpoch: epoch,
      transactionId: marker?.transactionId ?? `session.create:${key.sessionId}`,
      operation: marker?.operation ?? 'session.create',
      commandId: marker?.commandId ?? `session.create:${key.sessionId}`,
      contentDigest: marker?.contentDigest ?? sha(bytes),
      firstSequence: marker?.firstSequence ?? 0,
      lastSequence: marker?.lastSequence ?? 0,
      eventCount: marker?.eventCount ?? 0,
      eventsDigest: marker?.eventsDigest ?? null,
      previousCommitDigest: marker?.previousCommitDigest ?? null,
      commitDigest: marker ? managedToolDigest(marker) : null,
      latestCheckpointResourceId: batch.some(
        (record) => record.managedSession?.kind === 'checkpoint.committed',
      )
        ? latest
        : null,
    });
    const pending: unknown[] = [...batch];
    const seen = new Set<string>();
    while (pending.length) {
      const value = pending.pop();
      if (Array.isArray(value)) {
        pending.push(...value);
        continue;
      }
      if (value === null || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      if (Object.hasOwn(row, 'resourceId') && Object.hasOwn(row, 'digest')) {
        const ref = assertManagedSessionDurableRef(
          row as ManagedSessionJsonValue,
          'test ref',
        );
        if (seen.has(ref.resourceId)) continue;
        seen.add(ref.resourceId);
        const bytes = await resources.read(ref);
        const entry = stored.get(ref.resourceId) ?? {
          ref,
          bytesBase64: bytes.toString('base64'),
          referencedRevisions: [],
        };
        entry.referencedRevisions.push(index + 1);
        stored.set(ref.resourceId, entry);
        if (ref.kind === 'managed-checkpoint')
          pending.push(JSON.parse(bytes.toString('utf8')));
      } else pending.push(...Object.values(row));
    }
  }
  const scan = scanManagedSessionJournal(
    Buffer.concat(
      batches.map((batch) =>
        Buffer.from(
          batch.map((record) => JSON.stringify(record)).join('\n') + '\n',
        ),
      ),
    ),
    key,
  );
  return {
    format: 'qwen-csi-session-checkpoint-snapshot/1',
    sessionKey: key,
    originalCSI: { bindingId: 'java-binding', runtimeGeneration: '19' },
    head: {
      state: 'ACTIVE',
      storageVersion: 1,
      writerGeneration: 1,
      journalRevision: transactions.length,
      committedSequence: scan.committed,
      lastCommitDigest: scan.lastMarkerDigest,
      activationEpoch: epoch,
      latestCheckpointResourceId: latest,
      compactedThroughRevision: 0,
      recoveryStatus: 'READY',
      recoveryDetailCode: null,
    },
    transactions,
    resources: [...stored.values()],
  };
}
