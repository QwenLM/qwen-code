/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isTranscriptArtifactRecord } from '../utils/transcript-records.js';

export const SESSION_ARTIFACT_PERSISTENCE_VERSION = 2 as const;
const CONTENT_ID_PATTERN = /^[0-9a-f]{64}-[0-9a-f]{16}$/;
export const WORKSPACE_CONTENT_SHA256_METADATA_KEY = 'qwen.workspace.sha256';
export const WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY = 'qwen.workspace.mtimeMs';
const MAX_PERSISTED_ARTIFACTS = 500;
const MAX_PERSISTED_EVENT_CHANGES = 800;
const MAX_PERSISTED_IDS = 500;
const MAX_PERSISTED_MARKER_ARTIFACTS = MAX_PERSISTED_IDS * 2;
const MAX_PERSISTED_ID_CHARS = 200;
const MAX_PERSISTED_TITLE_CHARS = 200;
const MAX_PERSISTED_DESCRIPTION_CHARS = 1000;
const MAX_PERSISTED_PATH_CHARS = 500;
const MAX_PERSISTED_URL_CHARS = 2048;
const MAX_PERSISTED_MIME_CHARS = 120;
const MAX_PERSISTED_FIELD_CHARS = 200;
const MAX_PERSISTED_TIMESTAMP_CHARS = 64;
const SECRET_TOKEN_VALUE_PATTERN =
  /(?:^|\s)(?:bearer\s+\S{8,}|sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_/-]{12,}|[a-f0-9]{40,}|[A-Za-z0-9+/]{48,}={0,2})(?:$|\s)/i;

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
  markerArtifacts?: PersistedSessionArtifact[];
}

export interface RebuiltSessionArtifactSnapshot {
  v: typeof SESSION_ARTIFACT_PERSISTENCE_VERSION;
  sessionId: string;
  sequence: number;
  artifacts: PersistedSessionArtifact[];
  tombstonedIds: string[];
  stickyEphemeralIds: string[];
  markerArtifacts?: PersistedSessionArtifact[];
  warnings: string[];
}

export interface SessionArtifactChatRecordLike {
  type?: unknown;
  subtype?: unknown;
  sessionId?: unknown;
  systemPayload?: unknown;
}

export function isSessionArtifactRecord(
  record: SessionArtifactChatRecordLike,
): boolean {
  return isTranscriptArtifactRecord(record);
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
  const markerArtifacts = new Map<string, PersistedSessionArtifact>();
  const warnings: string[] = [];
  let sequence = 0;
  let lastSnapshotSequence = 0;
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
      lastSnapshotSequence = payload.sequence;
      artifacts.clear();
      tombstonedIds.clear();
      stickyEphemeralIds.clear();
      markerArtifacts.clear();
      for (const id of payload.tombstonedIds ?? []) tombstonedIds.add(id);
      for (const id of payload.stickyEphemeralIds ?? []) {
        stickyEphemeralIds.add(id);
      }
      const markerIds = new Set([...tombstonedIds, ...stickyEphemeralIds]);
      for (const artifact of payload.markerArtifacts ?? []) {
        if (markerIds.has(artifact.id)) {
          markerArtifacts.set(artifact.id, artifact);
        }
      }
      for (const artifact of payload.artifacts) {
        if (artifact.retention === 'ephemeral') continue;
        artifacts.set(artifact.id, artifact);
        markerArtifacts.delete(artifact.id);
      }
      continue;
    }

    const payload = normalizeEventPayload(record.systemPayload, warnings);
    if (!payload) continue;
    sawRecord = true;
    sessionId = payload.sessionId;
    if (payload.sequence <= lastSnapshotSequence) {
      warnings.push(
        `skipped stale event sequence ${payload.sequence} at or before snapshot sequence ${lastSnapshotSequence}`,
      );
      continue;
    }
    sequence = Math.max(sequence, payload.sequence);
    for (const change of payload.changes) {
      if (change.action === 'removed') {
        artifacts.delete(change.artifactId);
        if (change.reason === 'explicit') {
          tombstonedIds.add(change.artifactId);
          stickyEphemeralIds.delete(change.artifactId);
          if (change.artifact) {
            markerArtifacts.set(change.artifactId, change.artifact);
          }
        }
        if (change.reason === 'eviction') {
          stickyEphemeralIds.delete(change.artifactId);
          markerArtifacts.delete(change.artifactId);
        }
        if (change.reason === 'unpin_to_ephemeral') {
          stickyEphemeralIds.add(change.artifactId);
          if (change.artifact) {
            markerArtifacts.set(change.artifactId, change.artifact);
          }
        }
        continue;
      }
      if (!change.artifact || change.artifact.retention === 'ephemeral') {
        continue;
      }
      artifacts.set(change.artifact.id, change.artifact);
      tombstonedIds.delete(change.artifact.id);
      stickyEphemeralIds.delete(change.artifact.id);
      markerArtifacts.delete(change.artifact.id);
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
    ...(markerArtifacts.size > 0
      ? { markerArtifacts: Array.from(markerArtifacts.values()) }
      : {}),
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
    const {
      markerArtifacts: snapshotMarkerArtifacts,
      ...snapshotWithoutMarkers
    } = snapshot;
    const artifacts: PersistedSessionArtifact[] = [];
    for (const artifact of snapshot.artifacts) {
      const remapped = remapForkSafeSessionArtifactForFork(
        artifact,
        sourceSessionId,
        newSessionId,
      );
      if (!remapped) {
        seedForkArtifactIdRemap(artifact, newSessionId, remappedArtifactIds);
        continue;
      }
      remappedArtifactIds.set(artifact.id, remapped.id);
      artifacts.push(remapped);
    }
    const markerIds = new Set([
      ...(snapshot.tombstonedIds ?? []),
      ...(snapshot.stickyEphemeralIds ?? []),
    ]);
    const markerArtifacts = (snapshotMarkerArtifacts ?? [])
      .filter((artifact) => markerIds.has(artifact.id))
      .map((artifact) => {
        const remapped = remapForkSafeSessionArtifactForFork(
          artifact,
          sourceSessionId,
          newSessionId,
        );
        if (!remapped) {
          seedForkArtifactIdRemap(artifact, newSessionId, remappedArtifactIds);
          return undefined;
        }
        remappedArtifactIds.set(artifact.id, remapped.id);
        return remapped;
      })
      .filter((artifact) => artifact !== undefined);
    return {
      ...snapshotWithoutMarkers,
      sessionId: newSessionId,
      artifacts,
      ...(markerArtifacts.length > 0 ? { markerArtifacts } : {}),
      tombstonedIds: (snapshot.tombstonedIds ?? []).map((artifactId) =>
        remapArtifactIdForFork(
          artifactId,
          sourceSessionId,
          newSessionId,
          remappedArtifactIds,
        ),
      ),
      stickyEphemeralIds: (snapshot.stickyEphemeralIds ?? []).map(
        (artifactId) =>
          remapArtifactIdForFork(
            artifactId,
            sourceSessionId,
            newSessionId,
            remappedArtifactIds,
          ),
      ),
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
          const artifact = remapForkSafeSessionArtifactForFork(
            change.artifact,
            sourceSessionId,
            newSessionId,
          );
          if (!artifact) {
            if (change.action !== 'removed') return undefined;
            seedForkArtifactIdRemap(
              change.artifact,
              newSessionId,
              remappedArtifactIds,
            );
            const { artifact: _unsafeArtifact, ...changeWithoutArtifact } =
              change;
            return {
              ...changeWithoutArtifact,
              artifactId: remapArtifactIdForFork(
                change.artifactId,
                sourceSessionId,
                newSessionId,
                remappedArtifactIds,
              ),
            };
          }
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
            artifactId: remapArtifactIdForFork(
              change.artifactId,
              sourceSessionId,
              newSessionId,
              remappedArtifactIds,
            ),
          };
        }
        return {
          ...change,
          artifactId: remapArtifactIdForFork(
            change.artifactId,
            sourceSessionId,
            newSessionId,
            remappedArtifactIds,
          ),
        };
      })
      .filter((change) => change !== undefined),
  } satisfies SessionArtifactEventRecordPayload;
}

function remapForkSafeSessionArtifactForFork(
  artifact: PersistedSessionArtifact,
  sourceSessionId: string,
  newSessionId: string,
): PersistedSessionArtifact | undefined {
  if (!isForkSafeArtifact(artifact)) return undefined;
  return remapSessionArtifactForFork(artifact, sourceSessionId, newSessionId);
}

function seedForkArtifactIdRemap(
  artifact: PersistedSessionArtifact,
  newSessionId: string,
  remappedArtifactIds: Map<string, string>,
): void {
  const identityKey = forkSafeSessionArtifactIdentityKey(artifact);
  if (!identityKey) return;
  remappedArtifactIds.set(
    artifact.id,
    stableSessionArtifactId(newSessionId, identityKey),
  );
}

function forkSafeSessionArtifactIdentityKey(
  artifact: Pick<
    PersistedSessionArtifact,
    'workspacePath' | 'managedId' | 'url'
  >,
): string | undefined {
  if (artifact.workspacePath) return `workspace:${artifact.workspacePath}`;
  if (artifact.managedId) return `managed:${artifact.managedId}`;
  if (artifact.url && !hasRestoreUnsafeUrl(artifact.url)) {
    return `url:${artifact.url}`;
  }
  return undefined;
}

function remapArtifactIdForFork(
  artifactId: string,
  sourceSessionId: string,
  newSessionId: string,
  remappedArtifactIds: ReadonlyMap<string, string>,
): string {
  return (
    remappedArtifactIds.get(artifactId) ??
    stableSessionArtifactId(
      newSessionId,
      `fork:${sourceSessionId}:${artifactId}`,
    )
  );
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
  delete next.clientId;
  return next;
}

function isForkSafeArtifact(artifact: PersistedSessionArtifact): boolean {
  if (artifact.metadata && hasRestoreUnsafeMetadata(artifact.metadata)) {
    return false;
  }
  if (artifact.url && hasRestoreUnsafeUrl(artifact.url)) {
    return false;
  }
  return true;
}

function hasRestoreUnsafeMetadata(
  metadata: Record<string, string | number | boolean | null>,
): boolean {
  for (const [key, value] of Object.entries(metadata)) {
    if (!key || isSecretLikeText(key)) {
      return true;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return true;
    }
    if (
      typeof value === 'string' &&
      !isReservedWorkspaceMetadataKey(key) &&
      isSecretLikeMetadataValue(value)
    ) {
      return true;
    }
  }
  return false;
}

function hasRestoreUnsafeUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return true;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return true;
  }
  if (parsed.username || parsed.password) {
    return true;
  }
  for (const [key, urlValue] of parsed.searchParams) {
    if (isSecretLikeText(key) || isSecretLikeUrlValue(urlValue)) {
      return true;
    }
  }
  for (const segment of parsed.pathname.split('/').filter(Boolean)) {
    let decodedSegment = segment;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      // Keep scanning the raw segment if URL parsing accepted malformed escape.
    }
    if (isSecretLikeUrlValue(decodedSegment)) {
      return true;
    }
  }
  const fragment = parsed.hash.slice(1);
  return hasSecretLikeUrlFragment(fragment);
}

function hasSecretLikeUrlFragment(fragment: string): boolean {
  if (!fragment) return false;
  const candidates = new Set([fragment]);
  try {
    candidates.add(decodeURIComponent(fragment));
  } catch {
    // Keep scanning the raw fragment if URL parsing accepted malformed escape.
  }
  for (const candidate of candidates) {
    if (isSecretLikeText(candidate) || isSecretLikeUrlValue(candidate)) {
      return true;
    }
    for (const [key, value] of new URLSearchParams(candidate)) {
      if (isSecretLikeText(key) || isSecretLikeUrlValue(value)) {
        return true;
      }
    }
  }
  return false;
}

function isSecretLikeText(value: string): boolean {
  const normalized = value.replace(/([a-z])([A-Z])/g, '$1-$2');
  return /(?:^|[-_.])(token|secret|password|passwd|pwd|cookie|authorization|credential|signature|sig|api[-_]?key|access[-_]?key)(?:$|[-_.=&#])/i.test(
    normalized,
  );
}

function isSecretLikeUrlValue(value: string): boolean {
  return SECRET_TOKEN_VALUE_PATTERN.test(value.trim());
}

function isSecretLikeMetadataValue(value: string): boolean {
  return /^(?:bearer\s+\S{8,}|sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_/-]{12,})$/i.test(
    value.trim(),
  );
}

export function normalizeSnapshotPayload(
  value: unknown,
  warnings: string[],
): SessionArtifactSnapshotRecordPayload | undefined {
  if (!isRecord(value)) {
    warnings.push('skipped malformed snapshot record');
    return undefined;
  }
  if (value['v'] !== SESSION_ARTIFACT_PERSISTENCE_VERSION) {
    warnings.push(
      `skipped v${String(value['v'])} snapshot record (expected v${SESSION_ARTIFACT_PERSISTENCE_VERSION})`,
    );
    return undefined;
  }
  if (!Array.isArray(value['artifacts'])) {
    warnings.push('skipped snapshot record without artifacts array');
    return undefined;
  }
  const sessionId = getString(value, 'sessionId');
  if (!sessionId) {
    warnings.push('skipped snapshot record without sessionId');
    return undefined;
  }
  const rawArtifacts = value['artifacts'];
  if (rawArtifacts.length > MAX_PERSISTED_ARTIFACTS) {
    warnings.push(
      `snapshot artifact list truncated to ${MAX_PERSISTED_ARTIFACTS}`,
    );
  }
  const rawMarkerArtifacts = Array.isArray(value['markerArtifacts'])
    ? value['markerArtifacts']
    : [];
  if (rawMarkerArtifacts.length > MAX_PERSISTED_MARKER_ARTIFACTS) {
    warnings.push(
      `snapshot marker artifact list truncated to ${MAX_PERSISTED_MARKER_ARTIFACTS}`,
    );
  }
  const artifacts = rawArtifacts
    .slice(0, MAX_PERSISTED_ARTIFACTS)
    .map((artifact) => normalizePersistedArtifact(artifact, warnings))
    .filter((artifact) => artifact !== undefined);
  const markerArtifacts = rawMarkerArtifacts
    .slice(0, MAX_PERSISTED_MARKER_ARTIFACTS)
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
    ...(markerArtifacts.length > 0 ? { markerArtifacts } : {}),
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
    warnings.push('skipped malformed event record');
    return undefined;
  }
  if (value['v'] !== SESSION_ARTIFACT_PERSISTENCE_VERSION) {
    warnings.push(
      `skipped v${String(value['v'])} event record (expected v${SESSION_ARTIFACT_PERSISTENCE_VERSION})`,
    );
    return undefined;
  }
  if (!Array.isArray(value['changes'])) {
    warnings.push('skipped event record without changes array');
    return undefined;
  }
  const sessionId = getString(value, 'sessionId', MAX_PERSISTED_ID_CHARS);
  if (!sessionId) {
    warnings.push('skipped event record without sessionId');
    return undefined;
  }
  const rawChanges = value['changes'];
  if (rawChanges.length > MAX_PERSISTED_EVENT_CHANGES) {
    warnings.push(
      `event change list truncated to ${MAX_PERSISTED_EVENT_CHANGES}`,
    );
  }
  return {
    v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
    sessionId,
    sequence: getNonNegativeInteger(value, 'sequence') ?? 0,
    recordedAt:
      getString(value, 'recordedAt', MAX_PERSISTED_TIMESTAMP_CHARS) ??
      new Date(0).toISOString(),
    changes: rawChanges
      .slice(0, MAX_PERSISTED_EVENT_CHANGES)
      .map((change) => normalizePersistedChange(change, warnings))
      .filter((change) => change !== undefined),
  };
}

function normalizePersistedChange(
  value: unknown,
  warnings: string[],
): SessionArtifactPersistedChange | undefined {
  if (!isRecord(value)) {
    warnings.push('skipped malformed artifact change');
    return undefined;
  }
  const action = value['action'];
  if (action !== 'created' && action !== 'updated' && action !== 'removed') {
    warnings.push('skipped artifact change with invalid action');
    return undefined;
  }
  const artifact = normalizePersistedArtifact(value['artifact'], warnings);
  const artifactId =
    getString(value, 'artifactId', MAX_PERSISTED_ID_CHARS) ?? artifact?.id;
  if (!artifactId) {
    warnings.push('skipped artifact change without artifactId');
    return undefined;
  }
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
    if (hasControlCharacter(key) || hasUnsafeDisplayPayload(key)) continue;
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
      if (
        typeof item === 'string' &&
        (hasControlCharacter(item) || hasUnsafeDisplayPayload(item))
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

export function isPrototypeMetadataKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

export function isReservedWorkspaceMetadataKey(key: string): boolean {
  return (
    key === WORKSPACE_CONTENT_SHA256_METADATA_KEY ||
    key === WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY
  );
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x200b && code <= 0x200f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function hasUnsafeDisplayPayload(value: string): boolean {
  return (
    /<\s*\/?[a-z!]|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);|javascript\s*:|data\s*:\s*(?:text\/(?:html|javascript)|application\/javascript|image\/svg\+xml)/i.test(
      value,
    ) || /(?:^|[\s"'`<])on[a-z][a-z0-9-]*\s*=/i.test(value)
  );
}

export function metadataBudgetBytes(
  metadata: Record<string, string | number | boolean | null>,
  budget: 'user' | 'persisted' = 'persisted',
): number {
  if (budget === 'user') {
    return Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  }
  const userMetadata = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key, value]) => !isWorkspaceContentMetadataEntry(key, value),
    ),
  );
  return Buffer.byteLength(JSON.stringify(userMetadata), 'utf8');
}

export function isWorkspaceContentMetadataEntry(
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
  maxLength = MAX_PERSISTED_ID_CHARS,
): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter(
      (item): item is string =>
        typeof item === 'string' && item.length <= maxLength,
    )
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
