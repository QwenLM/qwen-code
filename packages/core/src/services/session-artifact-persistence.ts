/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

export const SESSION_ARTIFACT_PERSISTENCE_VERSION = 2 as const;

export type SessionArtifactRetention = 'ephemeral' | 'restorable' | 'pinned';

export type SessionArtifactRestoreState =
  | 'live'
  | 'restored'
  | 'unverified'
  | 'blocked';

export type SessionArtifactPersistenceWarning =
  | 'persistence_unavailable'
  | 'content_missing'
  | 'content_expired'
  | 'content_hash_mismatch'
  | 'metadata_only_restore'
  | 'restore_validation_failed';

export type PersistedSessionArtifactKind =
  | 'file'
  | 'link'
  | 'html'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'notebook'
  | 'other';

export type PersistedSessionArtifactStorage =
  | 'workspace'
  | 'external_url'
  | 'managed'
  | 'published';

export type PersistedSessionArtifactSource = 'tool' | 'hook' | 'client';

export type PersistedSessionArtifactStatus = 'available' | 'missing';

export interface SessionArtifactContentRef {
  kind: 'managed_copy';
  contentId: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface PersistedSessionArtifact {
  id: string;
  kind: PersistedSessionArtifactKind;
  storage: PersistedSessionArtifactStorage;
  source: PersistedSessionArtifactSource;
  status: PersistedSessionArtifactStatus;
  title: string;
  description?: string;
  workspacePath?: string;
  managedId?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
  metadata?: Record<string, string | number | boolean | null>;
  retention: SessionArtifactRetention;
  clientRetained: boolean;
  createdAt: string;
  updatedAt: string;
  persistedAt?: string;
  expiresAt?: string;
  restoreState?: SessionArtifactRestoreState;
  persistenceWarning?: SessionArtifactPersistenceWarning;
  contentRef?: SessionArtifactContentRef;
  toolCallId?: string;
  toolName?: string;
  hookEventName?: string;
  clientId?: string;
}

export type SessionArtifactPersistedChangeAction =
  | 'created'
  | 'updated'
  | 'removed';

export type SessionArtifactPersistedRemovalReason =
  | 'explicit'
  | 'eviction'
  | 'unpin_to_ephemeral';

export interface SessionArtifactPersistedChange {
  action: SessionArtifactPersistedChangeAction;
  artifactId: string;
  artifact?: PersistedSessionArtifact;
  reason?: SessionArtifactPersistedRemovalReason;
}

export interface SessionArtifactEventRecordPayload {
  v: typeof SESSION_ARTIFACT_PERSISTENCE_VERSION;
  sessionId: string;
  sequence: number;
  recordedAt: string;
  changes: SessionArtifactPersistedChange[];
}

export interface SessionArtifactSnapshotRecordPayload {
  v: typeof SESSION_ARTIFACT_PERSISTENCE_VERSION;
  sessionId: string;
  sequence: number;
  recordedAt: string;
  artifacts: PersistedSessionArtifact[];
  tombstonedIds?: string[];
  stickyEphemeralIds?: string[];
}

export interface RebuiltSessionArtifactSnapshot {
  v: typeof SESSION_ARTIFACT_PERSISTENCE_VERSION;
  sessionId: string;
  sequence: number;
  artifacts: PersistedSessionArtifact[];
  tombstonedIds: string[];
  stickyEphemeralIds: string[];
  warnings: string[];
}

export interface SessionArtifactChatRecordLike {
  type?: unknown;
  subtype?: unknown;
  sessionId?: unknown;
  systemPayload?: unknown;
}

const ARTIFACT_RECORD_SUBTYPES = new Set([
  'session_artifact_event',
  'session_artifact_snapshot',
]);

export function isSessionArtifactRecord(
  record: SessionArtifactChatRecordLike,
): boolean {
  return (
    record.type === 'system' &&
    typeof record.subtype === 'string' &&
    ARTIFACT_RECORD_SUBTYPES.has(record.subtype)
  );
}

export function stableSessionArtifactId(
  sessionId: string,
  identityKey: string,
): string {
  return createHash('sha256')
    .update(`${sessionId}:${identityKey}`)
    .digest('hex')
    .slice(0, 16);
}

export function sessionArtifactIdentityKey(
  artifact: Pick<
    PersistedSessionArtifact,
    'workspacePath' | 'managedId' | 'url'
  >,
): string | undefined {
  if (artifact.workspacePath) return `workspace:${artifact.workspacePath}`;
  if (artifact.managedId) return `managed:${artifact.managedId}`;
  if (artifact.url) return `url:${artifact.url}`;
  return undefined;
}

export function rebuildSessionArtifactSnapshot(
  records: readonly SessionArtifactChatRecordLike[],
  fallbackSessionId?: string,
): RebuiltSessionArtifactSnapshot | undefined {
  const artifacts = new Map<string, PersistedSessionArtifact>();
  const tombstonedIds = new Set<string>();
  const stickyEphemeralIds = new Set<string>();
  const warnings: string[] = [];
  let sequence = 0;
  let sessionId = fallbackSessionId;
  let sawRecord = false;

  for (const record of records) {
    if (!isSessionArtifactRecord(record)) continue;
    if (record.subtype === 'session_artifact_snapshot') {
      const payload = normalizeSnapshotPayload(record.systemPayload, warnings);
      if (!payload) continue;
      sawRecord = true;
      sessionId = payload.sessionId;
      sequence = Math.max(sequence, payload.sequence);
      artifacts.clear();
      tombstonedIds.clear();
      stickyEphemeralIds.clear();
      for (const id of payload.tombstonedIds ?? []) tombstonedIds.add(id);
      for (const id of payload.stickyEphemeralIds ?? []) {
        stickyEphemeralIds.add(id);
      }
      for (const artifact of payload.artifacts) {
        if (artifact.retention === 'ephemeral') continue;
        artifacts.set(artifact.id, artifact);
      }
      continue;
    }

    const payload = normalizeEventPayload(record.systemPayload, warnings);
    if (!payload) continue;
    sawRecord = true;
    sessionId = payload.sessionId;
    sequence = Math.max(sequence, payload.sequence);
    for (const change of payload.changes) {
      if (change.action === 'removed') {
        artifacts.delete(change.artifactId);
        if (change.reason === 'explicit') {
          tombstonedIds.add(change.artifactId);
        }
        if (change.reason === 'unpin_to_ephemeral') {
          stickyEphemeralIds.add(change.artifactId);
        }
        continue;
      }
      if (!change.artifact || change.artifact.retention === 'ephemeral') {
        continue;
      }
      artifacts.set(change.artifact.id, change.artifact);
      tombstonedIds.delete(change.artifact.id);
      stickyEphemeralIds.delete(change.artifact.id);
    }
  }

  if (!sawRecord || !sessionId) {
    return undefined;
  }

  return {
    v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
    sessionId,
    sequence,
    artifacts: Array.from(artifacts.values()),
    tombstonedIds: Array.from(tombstonedIds),
    stickyEphemeralIds: Array.from(stickyEphemeralIds),
    warnings,
  };
}

export function remapSessionArtifactPayloadForFork(
  payload: unknown,
  sourceSessionId: string,
  newSessionId: string,
): unknown {
  const snapshot = normalizeSnapshotPayload(payload, []);
  if (snapshot) {
    return {
      ...snapshot,
      sessionId: newSessionId,
      artifacts: snapshot.artifacts.map((artifact) =>
        remapSessionArtifactForFork(artifact, sourceSessionId, newSessionId),
      ),
      tombstonedIds: undefined,
      stickyEphemeralIds: undefined,
    } satisfies SessionArtifactSnapshotRecordPayload;
  }

  const event = normalizeEventPayload(payload, []);
  if (!event) return payload;
  return {
    ...event,
    sessionId: newSessionId,
    changes: event.changes
      .map((change): SessionArtifactPersistedChange | undefined => {
        if (change.artifact) {
          const artifact = remapSessionArtifactForFork(
            change.artifact,
            sourceSessionId,
            newSessionId,
          );
          return {
            ...change,
            artifactId: artifact.id,
            artifact,
          };
        }
        if (change.action === 'removed') return undefined;
        return change;
      })
      .filter((change) => change !== undefined),
  } satisfies SessionArtifactEventRecordPayload;
}

function remapSessionArtifactForFork(
  artifact: PersistedSessionArtifact,
  sourceSessionId: string,
  newSessionId: string,
): PersistedSessionArtifact {
  const identityKey = sessionArtifactIdentityKey(artifact);
  const id = identityKey
    ? stableSessionArtifactId(newSessionId, identityKey)
    : stableSessionArtifactId(
        newSessionId,
        `fork:${sourceSessionId}:${artifact.id}`,
      );
  const next: PersistedSessionArtifact = {
    ...artifact,
    id,
    retention:
      artifact.retention === 'pinned' ? 'restorable' : artifact.retention,
    restoreState: 'restored',
    persistenceWarning: 'metadata_only_restore',
  };
  delete next.contentRef;
  delete next.expiresAt;
  return next;
}

function normalizeSnapshotPayload(
  value: unknown,
  warnings: string[],
): SessionArtifactSnapshotRecordPayload | undefined {
  if (!isRecord(value) || value['v'] !== SESSION_ARTIFACT_PERSISTENCE_VERSION) {
    return undefined;
  }
  if (!Array.isArray(value['artifacts'])) return undefined;
  const sessionId = getString(value, 'sessionId');
  if (!sessionId) return undefined;
  const artifacts = value['artifacts']
    .map((artifact) => normalizePersistedArtifact(artifact, warnings))
    .filter((artifact) => artifact !== undefined);
  return {
    v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
    sessionId,
    sequence: getNonNegativeInteger(value, 'sequence') ?? 0,
    recordedAt: getString(value, 'recordedAt') ?? new Date(0).toISOString(),
    artifacts,
    tombstonedIds: getStringArray(value, 'tombstonedIds'),
    stickyEphemeralIds: getStringArray(value, 'stickyEphemeralIds'),
  };
}

function normalizeEventPayload(
  value: unknown,
  warnings: string[],
): SessionArtifactEventRecordPayload | undefined {
  if (!isRecord(value) || value['v'] !== SESSION_ARTIFACT_PERSISTENCE_VERSION) {
    return undefined;
  }
  if (!Array.isArray(value['changes'])) return undefined;
  const sessionId = getString(value, 'sessionId');
  if (!sessionId) return undefined;
  return {
    v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
    sessionId,
    sequence: getNonNegativeInteger(value, 'sequence') ?? 0,
    recordedAt: getString(value, 'recordedAt') ?? new Date(0).toISOString(),
    changes: value['changes']
      .map((change) => normalizePersistedChange(change, warnings))
      .filter((change) => change !== undefined),
  };
}

function normalizePersistedChange(
  value: unknown,
  warnings: string[],
): SessionArtifactPersistedChange | undefined {
  if (!isRecord(value)) return undefined;
  const action = value['action'];
  if (action !== 'created' && action !== 'updated' && action !== 'removed') {
    return undefined;
  }
  const artifact = normalizePersistedArtifact(value['artifact'], warnings);
  const artifactId = getString(value, 'artifactId') ?? artifact?.id;
  if (!artifactId) return undefined;
  const reason = value['reason'];
  return {
    action,
    artifactId,
    ...(artifact ? { artifact } : {}),
    ...(reason === 'explicit' ||
    reason === 'eviction' ||
    reason === 'unpin_to_ephemeral'
      ? { reason }
      : {}),
  };
}

function normalizePersistedArtifact(
  value: unknown,
  warnings: string[],
): PersistedSessionArtifact | undefined {
  if (!isRecord(value)) return undefined;
  const id = getString(value, 'id');
  const title = getString(value, 'title');
  if (!id || !title) {
    warnings.push('skipped artifact without id/title');
    return undefined;
  }

  const kind = normalizeLiteral<PersistedSessionArtifactKind>(value['kind'], [
    'file',
    'link',
    'html',
    'image',
    'video',
    'audio',
    'pdf',
    'notebook',
    'other',
  ]);
  const storage = normalizeLiteral<PersistedSessionArtifactStorage>(
    value['storage'],
    ['workspace', 'external_url', 'managed', 'published'],
  );
  const source = normalizeLiteral<PersistedSessionArtifactSource>(
    value['source'],
    ['tool', 'hook', 'client'],
  );
  const status =
    normalizeLiteral<PersistedSessionArtifactStatus>(value['status'], [
      'available',
      'missing',
    ]) ?? 'missing';
  const retention =
    normalizeLiteral<SessionArtifactRetention>(value['retention'], [
      'ephemeral',
      'restorable',
      'pinned',
    ]) ?? 'restorable';
  if (!kind || !storage || !source) {
    warnings.push(`skipped malformed artifact ${id}`);
    return undefined;
  }

  const metadata = normalizeMetadata(value['metadata']);
  return {
    id,
    kind,
    storage,
    source,
    status,
    title,
    ...(getString(value, 'description')
      ? { description: getString(value, 'description') }
      : {}),
    ...(getString(value, 'workspacePath')
      ? { workspacePath: getString(value, 'workspacePath') }
      : {}),
    ...(getString(value, 'managedId')
      ? { managedId: getString(value, 'managedId') }
      : {}),
    ...(getString(value, 'url') ? { url: getString(value, 'url') } : {}),
    ...(getString(value, 'mimeType')
      ? { mimeType: getString(value, 'mimeType') }
      : {}),
    ...(getNonNegativeInteger(value, 'sizeBytes') !== undefined
      ? { sizeBytes: getNonNegativeInteger(value, 'sizeBytes') }
      : {}),
    ...(metadata ? { metadata } : {}),
    retention,
    clientRetained: value['clientRetained'] === true,
    createdAt: getString(value, 'createdAt') ?? new Date(0).toISOString(),
    updatedAt: getString(value, 'updatedAt') ?? new Date(0).toISOString(),
    ...(getString(value, 'persistedAt')
      ? { persistedAt: getString(value, 'persistedAt') }
      : {}),
    ...(getString(value, 'expiresAt')
      ? { expiresAt: getString(value, 'expiresAt') }
      : {}),
    ...(normalizeLiteral<SessionArtifactRestoreState>(value['restoreState'], [
      'live',
      'restored',
      'unverified',
      'blocked',
    ])
      ? {
          restoreState: normalizeLiteral<SessionArtifactRestoreState>(
            value['restoreState'],
            ['live', 'restored', 'unverified', 'blocked'],
          ),
        }
      : {}),
    ...(normalizeLiteral<SessionArtifactPersistenceWarning>(
      value['persistenceWarning'],
      [
        'persistence_unavailable',
        'content_missing',
        'content_expired',
        'content_hash_mismatch',
        'metadata_only_restore',
        'restore_validation_failed',
      ],
    )
      ? {
          persistenceWarning: value[
            'persistenceWarning'
          ] as SessionArtifactPersistenceWarning,
        }
      : {}),
    ...(normalizeContentRef(value['contentRef'])
      ? { contentRef: normalizeContentRef(value['contentRef']) }
      : {}),
    ...(getString(value, 'toolCallId')
      ? { toolCallId: getString(value, 'toolCallId') }
      : {}),
    ...(getString(value, 'toolName')
      ? { toolName: getString(value, 'toolName') }
      : {}),
    ...(getString(value, 'hookEventName')
      ? { hookEventName: getString(value, 'hookEventName') }
      : {}),
    ...(getString(value, 'clientId')
      ? { clientId: getString(value, 'clientId') }
      : {}),
  };
}

function normalizeContentRef(
  value: unknown,
): SessionArtifactContentRef | undefined {
  if (!isRecord(value) || value['kind'] !== 'managed_copy') return undefined;
  const contentId = getString(value, 'contentId');
  const sha256 = getString(value, 'sha256');
  const sizeBytes = getNonNegativeInteger(value, 'sizeBytes');
  const createdAt = getString(value, 'createdAt');
  if (!contentId || !sha256 || sizeBytes === undefined || !createdAt) {
    return undefined;
  }
  return { kind: 'managed_copy', contentId, sha256, sizeBytes, createdAt };
}

function normalizeMetadata(
  value: unknown,
): Record<string, string | number | boolean | null> | undefined {
  if (!isRecord(value)) return undefined;
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      normalized[key] = item;
    }
  }
  if (Object.keys(normalized).length === 0) return undefined;
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 4096) {
    return undefined;
  }
  return normalized;
}

function normalizeLiteral<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T)
    ? (value as T)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === 'string',
  );
  return items.length > 0 ? items : undefined;
}

function getNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
