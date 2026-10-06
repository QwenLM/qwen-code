/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { managedToolDigest } from '../tools/managed-tool-protocol.js';
import { readOnlyManagedSessionSnapshot } from './http-managed-session-store.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { inspectOriginalFileCheckpointCoverage } from './original-file-checkpoint.js';
import { readOriginalRuntimeCheckpointChain } from './original-runtime-checkpoint.js';

const collections = [
  'runtimeSessions',
  'executions',
  'publications',
  'workerAcks',
  'sessionSnapshots',
  'sessionResourceInventory',
  'sessionResourceReferences',
  'publicationOperations',
  'publicationObjects',
  'publicationSeals',
] as const;

type Row = Record<string, unknown>;
export type OriginalCsiInventoryObservation =
  | { readonly status: 'unresolved'; readonly reason: string }
  | {
      readonly status: 'observed';
      readonly inventoryDigest: string;
      readonly counts: Readonly<Record<string, number>>;
      readonly executions: readonly Row[];
      readonly blockers: ReadonlyArray<{
        readonly member: string;
        readonly reason: string;
      }>;
    };

function requireFact(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
function object(value: unknown): Row {
  requireFact(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_inventory_object',
  );
  return value as Row;
}
function text(value: unknown): string {
  requireFact(
    typeof value === 'string' && value.length > 0 && !value.includes('\0'),
    'invalid_inventory_identity',
  );
  return value;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function decodedBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + decodedBytes(item), 0);
  if (value === null || typeof value !== 'object') return 0;
  return Object.entries(value).reduce(
    (sum, [key, item]) =>
      sum +
      (['recordBytesBase64', 'bytesBase64', 'inlineBytes'].includes(key) &&
      typeof item === 'string'
        ? Buffer.from(item, 'base64').length
        : decodedBytes(item)),
    0,
  );
}

/** An application observation only. Closed admission and finalization are separate authorities. */
export async function inspectOriginalCsiInventory(
  value: unknown,
): Promise<OriginalCsiInventoryObservation> {
  try {
    const root = object(value);
    requireFact(
      root['format'] === 'qwen-csi-retirement-inventory/1',
      'inventory_format_not_qualified',
    );
    requireFact(
      Buffer.byteLength(JSON.stringify(root)) <= 48 * 1024 * 1024,
      'inventory_size_exceeded',
    );
    requireFact(
      decodedBytes(root) <= 32 * 1024 * 1024,
      'inventory_decoded_size_exceeded',
    );
    const csi = object(root['originalCSI']);
    const scope = object(root['scope']);
    const tenant = text(scope['tenantId']);
    const workspace = text(scope['workspaceId']);
    const bindingId = text(csi['bindingId']);
    const generation = text(csi['runtimeGeneration']);
    const rows = new Map<string, Row[]>();
    for (const name of collections) {
      const values = root[name];
      requireFact(
        Array.isArray(values) && values.length <= 4096,
        'inventory_collection_missing_or_exceeded',
      );
      rows.set(name, values.map(object));
    }
    const blockers: Array<{ member: string; reason: string }> = [];
    const block = (member: string, reason: string) =>
      blockers.push({ member, reason });
    const key = (row: Row) => {
      requireFact(
        row['tenantId'] === tenant && row['workspaceId'] === workspace,
        'inventory_session_scope_conflict',
      );
      return text(row['sessionId']);
    };
    const unique = (values: Row[], field: string) => {
      const result = new Map<string, Row>();
      for (const row of values) {
        const id = text(row[field]);
        requireFact(!result.has(id), 'inventory_member_repeated');
        result.set(id, row);
      }
      return result;
    };
    const sessions = unique(rows.get('runtimeSessions')!, 'runtimeSessionId');
    const executions = unique(rows.get('executions')!, 'executionCallId');
    const snapshots = new Map<string, Row>();
    const expectedSessions = new Set<string>();
    if (root['isolationKey'] !== null)
      expectedSessions.add(text(root['isolationKey']));
    for (const [id, session] of sessions) {
      requireFact(
        session['bindingId'] === bindingId &&
          session['runtimeGeneration'] === generation,
        'inventory_runtime_session_conflict',
      );
      expectedSessions.add(text(session['harnessSessionId']));
      for (const [field, value] of Object.entries(scope))
        requireFact(
          session[field] === value,
          'inventory_runtime_scope_conflict',
        );
      if (!['READY', 'RELEASED'].includes(String(session['sessionState'])))
        block(id, 'runtime_session_not_settled');
    }
    for (const row of executions.values())
      expectedSessions.add(text(row['harnessSessionId']));
    const publications = new Map<string, Row>();
    for (const publication of rows.get('publications')!) {
      const binding = object(publication['binding']);
      const sessionId = key(object(binding['sessionKey']));
      expectedSessions.add(sessionId);
      const publicationKey = `${text(publication['scopeKey'])}:${text(publication['publicationId'])}`;
      requireFact(
        !publications.has(publicationKey),
        'inventory_publication_repeated',
      );
      publications.set(publicationKey, publication);
      const execution = executions.get(text(binding['executionCallId']));
      if (
        !execution ||
        execution['harnessSessionId'] !== sessionId ||
        binding['runtimeBindingId'] !== bindingId ||
        binding['bindingGeneration'] !== generation
      )
        block(publicationKey, 'orphan_or_conflicting_publication');
      block(
        publicationKey,
        'publication_lifecycle_not_qualified_for_file_profile',
      );
    }
    for (const ack of rows.get('workerAcks')!) {
      const id = text(ack['executionCallId']);
      const original = object(object(ack['evidence'])['original']);
      const sessionId = key(object(original['sessionKey']));
      expectedSessions.add(sessionId);
      const publicationKey = `${sha(JSON.stringify([tenant, workspace, sessionId]))}:${text(original['publicationId'])}`;
      if (!executions.has(id) || !publications.has(publicationKey))
        block(id, 'orphan_worker_ack');
      block(id, 'publication_ack_not_qualified_for_file_profile');
    }
    for (const row of rows.get('sessionSnapshots')!) {
      const id = key(object(row['sessionKey']));
      requireFact(
        !snapshots.has(id) && expectedSessions.has(id),
        'inventory_session_membership_conflict',
      );
      snapshots.set(id, row);
      if (row['status'] === 'unresolved') {
        block(id, 'session_snapshot_unavailable');
        continue;
      }
      requireFact(
        isDeepStrictEqual(row['originalCSI'], csi),
        'inventory_original_csi_conflict',
      );
      const snapshot = readOnlyManagedSessionSnapshot(row);
      const authority = await LocalManagedSessionAuthority.open({
        journal: snapshot.journal,
        sessionKey: snapshot.sessionKey,
        resources: snapshot.resources,
        cwd: '.',
        version: 'readonly-csi-inventory',
      });
      const events = authority.eventsInSequenceRange(
        1,
        authority.committedSequence,
      );
      for (const event of events) {
        if (event.kind === 'tool.intent' || event.kind === 'tool.receipt') {
          const executionId = text(event.payload['executionCallId']);
          if (executions.get(executionId)?.['harnessSessionId'] !== id)
            block(executionId, 'orphan_native_tool_work');
        }
        if (
          event.kind === 'domain.committed' &&
          event.payload['domain'] !== 'file_history'
        )
          block(id, 'unsupported_native_lifecycle');
      }
      if (
        ![...executions.values()].some(
          (execution) => execution['harnessSessionId'] === id,
        )
      ) {
        const { current } = await readOriginalRuntimeCheckpointChain(
          snapshot,
          authority,
        );
        if (
          authority.currentActivation?.epoch !== 1 ||
          current.continuation.phase !== 'before_model' ||
          current.tools !== null ||
          current.runtime !== null ||
          current.approval !== null ||
          current.continuation.pendingEventIds.length !== 0 ||
          events.some(
            (event) =>
              !['activation.changed', 'checkpoint.committed'].includes(
                event.kind,
              ),
          )
        )
          block(id, 'empty_session_not_qualified');
      }
    }
    requireFact(
      snapshots.size === expectedSessions.size && snapshots.size > 0,
      'inventory_session_membership_incomplete',
    );
    const observations: Row[] = [];
    for (const [id, execution] of executions) {
      const session = sessions.get(text(execution['runtimeSessionId']));
      requireFact(
        execution['bindingId'] === bindingId &&
          execution['runtimeGeneration'] === generation &&
          session?.['harnessSessionId'] === execution['harnessSessionId'],
        'inventory_execution_join_conflict',
      );
      const state = text(execution['state']);
      requireFact(
        [
          'PREPARED',
          'DISPATCHING',
          'EXECUTING',
          'CANCEL_REQUESTED',
          'SETTLED',
          'UNKNOWN',
          'ABANDONED',
        ].includes(state),
        'inventory_execution_state_not_qualified',
      );
      if (state !== 'SETTLED') {
        const reason =
          state === 'UNKNOWN' || state === 'ABANDONED'
            ? 'execution_uncertain'
            : 'execution_not_settled';
        block(id, reason);
        observations.push({
          executionCallId: id,
          state,
          status: 'unresolved',
          reason,
        });
        continue;
      }
      const observation = await inspectOriginalFileCheckpointCoverage({
        ...snapshots.get(text(execution['harnessSessionId'])),
        originalExecution: execution,
      });
      observations.push({ ...observation, executionCallId: id, state });
      if (observation.status === 'unresolved') block(id, observation.reason);
    }
    for (const name of [
      'publicationOperations',
      'publicationObjects',
      'publicationSeals',
    ]) {
      for (const row of rows.get(name)!) {
        const publicationKey = `${text(row['scopeKey'])}:${text(row['publicationId'])}`;
        if (!publications.has(publicationKey))
          block(publicationKey, 'orphan_publication_child');
      }
    }
    const resources = new Set<string>();
    for (const row of rows.get('sessionResourceInventory')!) {
      const id = key(row);
      const resourceId = text(row['resourceId']);
      const native = snapshots.get(id)?.['resources'];
      const resource = Array.isArray(native)
        ? native.find(
            (resource) =>
              object(object(resource)['ref'])['resourceId'] === resourceId,
          )
        : undefined;
      const ref =
        resource === undefined ? undefined : object(object(resource)['ref']);
      const resourceKey = `${id}:${resourceId}`;
      requireFact(!resources.has(resourceKey), 'inventory_resource_repeated');
      resources.add(resourceKey);
      if (
        ref === undefined ||
        row['sessionScopeKey'] !== sha(`${tenant}\0${id}`) ||
        row['kind'] !== ref['kind'] ||
        row['schemaVersion'] !== String(ref['schemaVersion']) ||
        row['byteLength'] !== String(ref['byteLength']) ||
        row['sha256'] !== ref['digest'] ||
        row['state'] !== 'REFERENCED' ||
        row['storageKind'] !== 'MYSQL_INLINE' ||
        ![false, '0'].includes(row['externalObject'] as boolean | string)
      )
        block(resourceKey, 'resource_not_qualified');
    }
    const references = new Set<string>();
    for (const row of rows.get('sessionResourceReferences')!) {
      const id = key(row);
      const resourceId = text(row['resourceId']);
      const revision = text(row['journalRevision']);
      const referenceKey = `${id}:${resourceId}:${revision}`;
      requireFact(
        !references.has(referenceKey),
        'inventory_reference_repeated',
      );
      references.add(referenceKey);
      const native = snapshots.get(id)?.['resources'];
      const resource = Array.isArray(native)
        ? native.find(
            (resource) =>
              object(object(resource)['ref'])['resourceId'] === resourceId,
          )
        : undefined;
      if (
        !resources.has(`${id}:${resourceId}`) ||
        row['sessionScopeKey'] !== sha(`${tenant}\0${id}`) ||
        resource === undefined ||
        !(object(resource)['referencedRevisions'] as number[]).some(
          (value) => String(value) === revision,
        )
      )
        block(id, 'orphan_resource_reference');
    }
    for (const [id, snapshot] of snapshots) {
      if (!Array.isArray(snapshot['resources'])) continue;
      for (const resource of snapshot['resources']) {
        const row = object(resource);
        const resourceId = text(object(row['ref'])['resourceId']);
        if (!resources.has(`${id}:${resourceId}`))
          block(id, 'inventory_resource_missing');
        for (const revision of row['referencedRevisions'] as number[])
          if (!references.has(`${id}:${resourceId}:${revision}`))
            block(id, 'inventory_reference_missing');
      }
    }
    return {
      status: 'observed',
      inventoryDigest: managedToolDigest(root),
      counts: Object.fromEntries(
        [...rows].map(([name, values]) => [name, values.length]),
      ),
      executions: observations,
      blockers,
    };
  } catch (error) {
    return {
      status: 'unresolved',
      reason: error instanceof Error ? error.message : 'Invalid CSI inventory.',
    };
  }
}
