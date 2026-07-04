/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
  rebuildSessionArtifactSnapshot,
  remapSessionArtifactPayloadForFork,
  stableSessionArtifactId,
  type PersistedSessionArtifact,
  type SessionArtifactEventRecordPayload,
  type SessionArtifactSnapshotRecordPayload,
} from './session-artifact-persistence.js';

function artifact(
  sessionId: string,
  url: string,
  overrides: Partial<PersistedSessionArtifact> = {},
): PersistedSessionArtifact {
  const now = '2026-07-04T00:00:00.000Z';
  return {
    id: stableSessionArtifactId(sessionId, `url:${url}`),
    kind: 'link',
    storage: 'external_url',
    source: 'client',
    status: 'available',
    title: 'Report',
    url,
    retention: 'restorable',
    clientRetained: true,
    createdAt: now,
    updatedAt: now,
    persistedAt: now,
    ...overrides,
  };
}

function event(payload: SessionArtifactEventRecordPayload): {
  type: 'system';
  subtype: 'session_artifact_event';
  systemPayload: SessionArtifactEventRecordPayload;
} {
  return {
    type: 'system',
    subtype: 'session_artifact_event',
    systemPayload: payload,
  };
}

describe('session artifact persistence records', () => {
  it('rebuilds durable artifacts and explicit tombstones from event records', () => {
    const first = artifact('s1', 'https://example.com/first');
    const second = artifact('s1', 'https://example.com/second');

    const snapshot = rebuildSessionArtifactSnapshot([
      event({
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 's1',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [
          { action: 'created', artifactId: first.id, artifact: first },
          {
            action: 'created',
            artifactId: second.id,
            artifact: { ...second, retention: 'ephemeral' },
          },
        ],
      }),
      event({
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 's1',
        sequence: 2,
        recordedAt: '2026-07-04T00:00:01.000Z',
        changes: [
          {
            action: 'removed',
            artifactId: first.id,
            artifact: first,
            reason: 'explicit',
          },
        ],
      }),
    ]);

    expect(snapshot).toMatchObject({
      v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
      sessionId: 's1',
      sequence: 2,
      artifacts: [],
      tombstonedIds: [first.id],
      stickyEphemeralIds: [],
      warnings: [],
    });
  });

  it('lets snapshot records replace earlier event state', () => {
    const first = artifact('s1', 'https://example.com/first');
    const second = artifact('s1', 'https://example.com/second');

    const snapshot = rebuildSessionArtifactSnapshot([
      event({
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 's1',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [{ action: 'created', artifactId: first.id, artifact: first }],
      }),
      {
        type: 'system',
        subtype: 'session_artifact_snapshot',
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: 's1',
          sequence: 3,
          recordedAt: '2026-07-04T00:00:02.000Z',
          artifacts: [second],
          tombstonedIds: [first.id],
          stickyEphemeralIds: [],
        },
      },
    ]);

    expect(snapshot?.artifacts).toEqual([second]);
    expect(snapshot?.tombstonedIds).toEqual([first.id]);
    expect(snapshot?.sequence).toBe(3);
  });

  it('drops malformed content refs during restore normalization', () => {
    const pinned = artifact('s1', 'https://example.com/pinned', {
      retention: 'pinned',
      contentRef: {
        kind: 'managed_copy',
        contentId: '../../escape',
        sha256: 'a'.repeat(64),
        sizeBytes: 12,
        createdAt: '2026-07-04T00:00:00.000Z',
      },
    });

    const snapshot = rebuildSessionArtifactSnapshot([
      event({
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 's1',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [
          { action: 'created', artifactId: pinned.id, artifact: pinned },
        ],
      }),
    ]);

    expect(snapshot?.artifacts[0]).not.toHaveProperty('contentRef');
  });

  it('remaps forked payloads to the new session without carrying pinned content', () => {
    const source = artifact('source-session', 'https://example.com/report', {
      retention: 'pinned',
      contentRef: {
        kind: 'managed_copy',
        contentId: 'content-1',
        sha256: 'a'.repeat(64),
        sizeBytes: 12,
        createdAt: '2026-07-04T00:00:00.000Z',
      },
      expiresAt: '2026-08-01T00:00:00.000Z',
    });

    const remapped = remapSessionArtifactPayloadForFork(
      {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 'source-session',
        sequence: 5,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [
          { action: 'updated', artifactId: source.id, artifact: source },
        ],
      },
      'source-session',
      'forked-session',
    ) as SessionArtifactEventRecordPayload;

    const forked = remapped.changes[0]?.artifact;
    expect(remapped.sessionId).toBe('forked-session');
    expect(forked).toMatchObject({
      id: stableSessionArtifactId(
        'forked-session',
        'url:https://example.com/report',
      ),
      retention: 'restorable',
      restoreState: 'restored',
      persistenceWarning: 'metadata_only_restore',
    });
    expect(forked).not.toHaveProperty('contentRef');
    expect(forked).not.toHaveProperty('expiresAt');
  });

  it('remaps forked snapshot payloads and clears inherited tombstone state', () => {
    const source = artifact('source-session', 'https://example.com/snapshot', {
      retention: 'pinned',
      contentRef: {
        kind: 'managed_copy',
        contentId: 'content-1',
        sha256: 'a'.repeat(64),
        sizeBytes: 12,
        createdAt: '2026-07-04T00:00:00.000Z',
      },
      expiresAt: '2026-08-01T00:00:00.000Z',
    });

    const remapped = remapSessionArtifactPayloadForFork(
      {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 'source-session',
        sequence: 7,
        recordedAt: '2026-07-04T00:00:00.000Z',
        artifacts: [source],
        tombstonedIds: ['deleted-in-source'],
        stickyEphemeralIds: ['ephemeral-in-source'],
      },
      'source-session',
      'forked-session',
    ) as SessionArtifactSnapshotRecordPayload;

    expect(remapped.sessionId).toBe('forked-session');
    expect(remapped.tombstonedIds).toBeUndefined();
    expect(remapped.stickyEphemeralIds).toBeUndefined();
    expect(remapped.artifacts[0]).toMatchObject({
      id: stableSessionArtifactId(
        'forked-session',
        'url:https://example.com/snapshot',
      ),
      retention: 'restorable',
      restoreState: 'restored',
      persistenceWarning: 'metadata_only_restore',
    });
    expect(remapped.artifacts[0]).not.toHaveProperty('contentRef');
    expect(remapped.artifacts[0]).not.toHaveProperty('expiresAt');
  });
});
