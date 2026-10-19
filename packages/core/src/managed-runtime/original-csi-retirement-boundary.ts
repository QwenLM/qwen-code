/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import { readOnlyManagedSessionSnapshot } from './http-managed-session-store.js';
import {
  inspectOriginalCsiInventory,
  originalCsiDecodedBytes,
} from './original-csi-inventory.js';
import {
  assertManagedSessionDurableRef,
  managedSessionKeysEqual,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionKey,
} from './managed-session-records.js';

type Snapshot = ReturnType<typeof readOnlyManagedSessionSnapshot>;
type Row = Record<string, unknown>;
export type OriginalCsiRetirementBoundaryObservation =
  | { readonly status: 'unresolved'; readonly reason: string }
  | {
      readonly status: 'observed';
      readonly stage: 'original_native_boundary';
      readonly observationDigest: string;
      readonly inventoryDigest: string;
      readonly sessionKey: ManagedSessionKey;
      readonly activation: {
        readonly activationId: string;
        readonly epoch: number;
        readonly workerId: string;
      };
      readonly boundaryRef: ManagedSessionDurableRef;
      readonly settledHead: Snapshot['head'];
      readonly terminalHead: Snapshot['head'];
    };

function requireFact(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}

function object(value: unknown): Row {
  requireFact(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_boundary_object',
  );
  return value as Row;
}

/** Native history observation only; the coordinator must independently fence and commit its cut. */
export async function inspectOriginalCsiRetirementBoundary(
  value: unknown,
): Promise<OriginalCsiRetirementBoundaryObservation> {
  try {
    const root = object(value);
    requireFact(
      root['format'] === 'qwen-csi-session-retirement-boundary/1' &&
        Object.keys(root).sort().join(',') ===
          'format,settledInventory,terminalSnapshot',
      'boundary_format_not_qualified',
    );
    requireFact(
      Buffer.byteLength(JSON.stringify(root)) <= 48 * 1024 * 1024 &&
        originalCsiDecodedBytes(root) <= 32 * 1024 * 1024,
      'boundary_size_exceeded',
    );
    const inventory = object(root['settledInventory']);
    const observation = await inspectOriginalCsiInventory(inventory);
    requireFact(
      observation.status === 'observed' && observation.blockers.length === 0,
      'boundary_inventory_not_settled',
    );
    const sessions = inventory['runtimeSessions'] as Row[];
    const snapshots = inventory['sessionSnapshots'] as Row[];
    requireFact(
      sessions.length === 1 &&
        snapshots.length === 1 &&
        sessions[0]['sessionState'] === 'READY' &&
        object(inventory['scope'])['isolationClass'] === 'session',
      'boundary_original_session_not_qualified',
    );
    const settledRow = snapshots[0];
    const terminalRow = object(root['terminalSnapshot']);
    const settled = readOnlyManagedSessionSnapshot(settledRow);
    const terminal = readOnlyManagedSessionSnapshot(terminalRow);
    requireFact(
      terminalRow['format'] === 'qwen-csi-session-checkpoint-snapshot/1' &&
        settledRow['format'] === 'qwen-csi-session-checkpoint-snapshot/1' &&
        managedSessionKeysEqual(settled.sessionKey, terminal.sessionKey) &&
        inventory['isolationKey'] === settled.sessionKey.sessionId &&
        sessions[0]['harnessSessionId'] === settled.sessionKey.sessionId &&
        isDeepStrictEqual(terminalRow['originalCSI'], inventory['originalCSI']),
      'boundary_original_identity_conflict',
    );
    const before = await settled.journal.read();
    const after = await terminal.journal.read();
    const original = before.activation;
    requireFact(
      settled.head.state === 'ACTIVE' &&
        original?.phase === 'active' &&
        original.epoch === 1 &&
        settled.head.writerGeneration === 1,
      'boundary_original_activation_not_qualified',
    );
    requireFact(
      terminal.head.journalRevision === settled.head.journalRevision + 1 &&
        terminal.head.committedSequence ===
          settled.head.committedSequence + 1 &&
        Object.entries(settled.head).every(
          ([key, field]) =>
            [
              'state',
              'journalRevision',
              'committedSequence',
              'lastCommitDigest',
            ].includes(key) ||
            field === terminal.head[key as keyof Snapshot['head']],
        ) &&
        (settledRow['transactions'] as unknown[]).every((tx, index) =>
          isDeepStrictEqual(
            tx,
            (terminalRow['transactions'] as unknown[])[index],
          ),
        ),
      'boundary_prefix_conflict',
    );
    const suffix = terminal.transactions.at(-1)!;
    const event = after.events.at(-1);
    requireFact(
      suffix.operation === 'releaseActivation' &&
        suffix.commandId === `${original.activationId}:released` &&
        suffix.contentDigest === before.header!.definitionRef.digest &&
        suffix.eventCount === 1 &&
        suffix.firstSequence === before.committed + 1 &&
        suffix.lastSequence === before.committed + 1 &&
        suffix.previousCommitDigest === before.lastMarkerDigest &&
        after.events.length === before.events.length + 1 &&
        event?.kind === 'activation.changed' &&
        event.sequence === before.committed + 1,
      'boundary_terminal_transaction_conflict',
    );
    const subject = {
      type: 'activation',
      scopeId: original.activationId,
      activationId: original.activationId,
      epoch: original.epoch,
    };
    requireFact(
      event.subject === undefined &&
        Object.keys(event.payload).sort().join(',') ===
          'activationId,boundaryRef,epoch,expiresAt,installRef,leaseDurationMs,phase,subject,workerId' &&
        event.payload['phase'] === 'released' &&
        event.payload['activationId'] === original.activationId &&
        event.payload['epoch'] === original.epoch &&
        event.payload['workerId'] === original.workerId &&
        event.payload['expiresAt'] === original.expiresAt &&
        event.payload['leaseDurationMs'] === null &&
        event.payload['installRef'] === null &&
        isDeepStrictEqual(event.payload['subject'], subject) &&
        before.events
          .filter((e) => e.kind === 'activation.changed')
          .every(
            (e) =>
              e.payload['phase'] === 'active' &&
              e.payload['activationId'] === original.activationId &&
              e.payload['epoch'] === original.epoch &&
              e.payload['workerId'] === original.workerId &&
              isDeepStrictEqual(e.payload['subject'], subject),
          ) &&
        after.activation?.phase === 'released' &&
        after.activation.activationId === original.activationId &&
        after.activation.epoch === original.epoch,
      'boundary_original_activation_conflict',
    );
    const boundaryRef = assertManagedSessionDurableRef(
      event.payload['boundaryRef'],
      'retirement boundary',
    );
    requireFact(
      boundaryRef.kind === 'managed-activation-boundary' &&
        boundaryRef.schemaVersion === 1,
      'boundary_resource_not_qualified',
    );
    const body = parseManagedSessionRecordJson(
      (await terminal.resources.read(boundaryRef)).toString('utf8'),
      16 * 1024,
    );
    requireFact(
      isDeepStrictEqual(body, {
        version: 1,
        activationId: original.activationId,
        epoch: original.epoch,
        committedSequence: before.committed,
        lastRecordUuid: before.lastRecordUuid,
      }),
      'boundary_body_prefix_conflict',
    );
    const oldResources = settledRow['resources'] as Row[];
    const newResources = terminalRow['resources'] as Row[];
    requireFact(
      newResources.length === oldResources.length + 1 &&
        oldResources.every((resource) =>
          newResources.some((row) => isDeepStrictEqual(resource, row)),
        ) &&
        !oldResources.some(
          (row) => object(row['ref'])['resourceId'] === boundaryRef.resourceId,
        ) &&
        newResources.some(
          (row) =>
            isDeepStrictEqual(row['ref'], boundaryRef) &&
            isDeepStrictEqual(row['referencedRevisions'], [
              suffix.journalRevision,
            ]),
        ),
      'boundary_resource_prefix_conflict',
    );
    const pins = {
      inventoryDigest: observation.inventoryDigest,
      sessionKey: settled.sessionKey,
      activation: {
        activationId: original.activationId,
        epoch: original.epoch,
        workerId: original.workerId,
      },
      boundaryRef,
      settledHead: settled.head,
      terminalHead: terminal.head,
    };
    return {
      status: 'observed',
      stage: 'original_native_boundary',
      observationDigest: managedToolDigest(pins),
      ...pins,
    };
  } catch (error) {
    return {
      status: 'unresolved',
      reason:
        error instanceof Error
          ? error.message
          : 'Invalid native retirement boundary.',
    };
  }
}
