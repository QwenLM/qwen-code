/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

export const SESSION_ARTIFACT_PERSISTENCE_VERSION = 2 as const;
const CONTENT_ID_PATTERN = /^[0-9a-f]{64}-[0-9a-f]{16}$/;
const WORKSPACE_CONTENT_SHA256_METADATA_KEY = 'qwen.workspace.sha256';
const WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY = 'qwen.workspace.mtimeMs';
const MAX_PERSISTED_ARTIFACTS = 500;
const MAX_PERSISTED_IDS = 500;
const MAX_PERSISTED_ID_CHARS = 200;
const MAX_PERSISTED_TITLE_CHARS = 200;
const MAX_PERSISTED_DESCRIPTION_CHARS = 1000;
const MAX_PERSISTED_PATH_CHARS = 500;
const MAX_PERSISTED_URL_CHARS = 2048;
const MAX_PERSISTED_MIME_CHARS = 120;
const MAX_PERSISTED_FIELD_CHARS = 200;
const MAX_PERSISTED_TIMESTAMP_CHARS = 64;

export type SessionArtifactRetention = 'ephemeral' | 'restorable' | 'pinned';

export type SessionArtifactRestoreState =
  | 'live'
  | 'restored'
  | 'unverified'
  | 'blocked';

export type SessionArtifactPersistenceWarning =
  | 'persistence_unavailable'
  | 'metadata_only_restore'
  | 'restore_validation_failed'
  | 'sticky_override_active';

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

export type PersistedSessionArtifactStatus =
  | 'available'
  | 'missing'
  | 'changed';

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
          stickyEphemeralIds.delete(change.artifactId);
        }
        if (change.reason === 'eviction') {
          stickyEphemeralIds.delete(change.artifactId);
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
  remappedArtifactIds = new Map<string, string>(),
): unknown {
  const snapshot = normalizeSnapshotPayload(payload, []);
  if (snapshot) {
    const artifacts = snapshot.artifacts.map((artifact) => {
      const remapped = remapSessionArtifactForFork(
        artifact,
        sourceSessionId,
        newSessionId,
      );
      remappedArtifactIds.set(artifact.id, remapped.id);
      return remapped;
    });
    return {
      ...snapshot,
      sessionId: newSessionId,
      artifacts,
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
          remappedArtifactIds.set(change.artifactId, artifact.id);
          return {
            ...change,
            artifactId: artifact.id,
            artifact,
          };
        }
        if (change.action === 'removed') {
          return {
            ...change,
            artifactId:
              remappedArtifactIds.get(change.artifactId) ??
              stableSessionArtifactId(
                newSessionId,
                `fork:${sourceSessionId}:${change.artifactId}`,
              ),
          };
        }
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
  };
  delete next.contentRef;
  delete next.expiresAt;
  return next;
}

export function normalizeSnapshotPayload(
  value: unknown,
  warnings: string[],
): SessionArtifactSnapshotRecordPayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value['v'] !== SESSION_ARTIFACT_PERSISTENCE_VERSION) {
    warnings.push(
      `skipped v${String(value['v'])} snapshot record (expected v${SESSION_ARTIFACT_PERSISTENCE_VERSION})`,
    );
    return undefined;
  }
  if (!Array.isArray(value['artifacts'])) return undefined;
  const sessionId = getString(value, 'sessionId');
  if (!sessionId) return undefined;
  const rawArtifacts = value['artifacts'];
  if (rawArtifacts.length > MAX_PERSISTED_ARTIFACTS) {
    warnings.push(
      `snapshot artifact list truncated to ${MAX_PERSISTED_ARTIFACTS}`,
    );
  }
  const artifacts = rawArtifacts
    .slice(0, MAX_PERSISTED_ARTIFACTS)
    .map((artifact) => normalizePersistedArtifact(artifact, warnings))
    .filter((artifact) => artifact !== undefined);
  return {
    v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
    sessionId,
    sequence: getNonNegativeInteger(value, 'sequence') ?? 0,
    recordedAt:
      getString(value, 'recordedAt', MAX_PERSISTED_TIMESTAMP_CHARS) ??
      new Date(0).toISOString(),
    artifacts,
    tombstonedIds: getStringArray(value, 'tombstonedIds', MAX_PERSISTED_IDS),
    stickyEphemeralIds: getStringArray(
      value,
      'stickyEphemeralIds',
      MAX_PERSISTED_IDS,
    ),
  };
}

export function normalizeEventPayload(
  value: unknown,
  warnings: string[],
): SessionArtifactEventRecordPayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value['v'] !== SESSION_ARTIFACT_PERSISTENCE_VERSION) {
    warnings.push(
      `skipped v${String(value['v'])} event record (expected v${SESSION_ARTIFACT_PERSISTENCE_VERSION})`,
    );
    return undefined;
  }
  if (!Array.isArray(value['changes'])) return undefined;
  const sessionId = getString(value, 'sessionId', MAX_PERSISTED_ID_CHARS);
  if (!sessionId) return undefined;
  return {
    v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
    sessionId,
    sequence: getNonNegativeInteger(value, 'sequence') ?? 0,
    recordedAt:
      getString(value, 'recordedAt', MAX_PERSISTED_TIMESTAMP_CHARS) ??
      new Date(0).toISOString(),
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
  const artifactId =
    getString(value, 'artifactId', MAX_PERSISTED_ID_CHARS) ?? artifact?.id;
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
  const id = getString(value, 'id', MAX_PERSISTED_ID_CHARS);
  const title = getString(value, 'title', MAX_PERSISTED_TITLE_CHARS);
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
      'changed',
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

  const metadata = normalizeMetadata(value['metadata'], warnings, id);
  const description = getString(
    value,
    'description',
    MAX_PERSISTED_DESCRIPTION_CHARS,
  );
  const workspacePath = getString(
    value,
    'workspacePath',
    MAX_PERSISTED_PATH_CHARS,
  );
  const managedId = getString(value, 'managedId', MAX_PERSISTED_FIELD_CHARS);
  const url = getString(value, 'url', MAX_PERSISTED_URL_CHARS);
  const mimeType = getString(value, 'mimeType', MAX_PERSISTED_MIME_CHARS);
  const sizeBytes = getNonNegativeInteger(value, 'sizeBytes');
  const persistedAt = getString(
    value,
    'persistedAt',
    MAX_PERSISTED_TIMESTAMP_CHARS,
  );
  const expiresAt = getString(
    value,
    'expiresAt',
    MAX_PERSISTED_TIMESTAMP_CHARS,
  );
  const contentRef = normalizeContentRef(value['contentRef']);
  const toolCallId = getString(value, 'toolCallId', MAX_PERSISTED_FIELD_CHARS);
  const toolName = getString(value, 'toolName', MAX_PERSISTED_FIELD_CHARS);
  const hookEventName = getString(
    value,
    'hookEventName',
    MAX_PERSISTED_FIELD_CHARS,
  );
  const clientId = getString(value, 'clientId', MAX_PERSISTED_FIELD_CHARS);
  return {
    id,
    kind,
    storage,
    source,
    status,
    title,
    ...(description ? { description } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    ...(managedId ? { managedId } : {}),
    ...(url ? { url } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(metadata ? { metadata } : {}),
    retention,
    clientRetained: value['clientRetained'] === true,
    createdAt:
      getString(value, 'createdAt', MAX_PERSISTED_TIMESTAMP_CHARS) ??
      new Date(0).toISOString(),
    updatedAt:
      getString(value, 'updatedAt', MAX_PERSISTED_TIMESTAMP_CHARS) ??
      new Date(0).toISOString(),
    ...(persistedAt ? { persistedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(contentRef ? { contentRef } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(hookEventName ? { hookEventName } : {}),
    ...(clientId ? { clientId } : {}),
  };
}

function normalizeContentRef(
  value: unknown,
): SessionArtifactContentRef | undefined {
  if (!isRecord(value) || value['kind'] !== 'managed_copy') return undefined;
  const contentId = getString(value, 'contentId', MAX_PERSISTED_FIELD_CHARS);
  const sha256 = getString(value, 'sha256', 64);
  const sizeBytes = getNonNegativeInteger(value, 'sizeBytes');
  const createdAt = getString(
    value,
    'createdAt',
    MAX_PERSISTED_TIMESTAMP_CHARS,
  );
  if (
    !contentId ||
    !CONTENT_ID_PATTERN.test(contentId) ||
    !sha256 ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    sizeBytes === undefined ||
    !createdAt
  ) {
    return undefined;
  }
  return { kind: 'managed_copy', contentId, sha256, sizeBytes, createdAt };
}

function normalizeMetadata(
  value: unknown,
  warnings: string[],
  artifactId: string,
): Record<string, string | number | boolean | null> | undefined {
  if (!isRecord(value)) return undefined;
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isPrototypeMetadataKey(key)) continue;
    if (key.length > 120) continue;
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      if (
        isReservedWorkspaceMetadataKey(key) &&
        !isWorkspaceContentMetadataEntry(key, item)
      ) {
        continue;
      }
      normalized[key] = item;
    }
  }
  if (Object.keys(normalized).length === 0) return undefined;
  if (metadataBudgetBytes(normalized) > 4096) {
    warnings.push(`skipped oversized metadata for artifact ${artifactId}`);
    return undefined;
  }
  return normalized;
}

function isPrototypeMetadataKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function isReservedWorkspaceMetadataKey(key: string): boolean {
  return (
    key === WORKSPACE_CONTENT_SHA256_METADATA_KEY ||
    key === WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY
  );
}

function metadataBudgetBytes(
  metadata: Record<string, string | number | boolean | null>,
): number {
  const userMetadata = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key, value]) => !isWorkspaceContentMetadataEntry(key, value),
    ),
  );
  return Buffer.byteLength(JSON.stringify(userMetadata), 'utf8');
}

function isWorkspaceContentMetadataEntry(
  key: string,
  value: string | number | boolean | null,
): boolean {
  if (key === WORKSPACE_CONTENT_SHA256_METADATA_KEY) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  }
  if (key === WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY) {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return false;
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
  maxLength = MAX_PERSISTED_FIELD_CHARS,
): string | undefined {
  const value = record[key];
  if (typeof value !== 'string' || value.length > maxLength) {
    return undefined;
  }
  return value;
}

function getStringArray(
  record: Record<string, unknown>,
  key: string,
  maxItems = MAX_PERSISTED_IDS,
): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .slice(-maxItems);
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
