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

  it('rebuilds sticky ephemeral ids from unpin tombstones', () => {
    const pinned = artifact('s1', 'https://example.com/sticky', {
      retention: 'pinned',
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
      event({
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 's1',
        sequence: 2,
        recordedAt: '2026-07-04T00:00:01.000Z',
        changes: [
          {
            action: 'removed',
            artifactId: pinned.id,
            artifact: pinned,
            reason: 'unpin_to_ephemeral',
          },
        ],
      }),
    ]);

    expect(snapshot).toMatchObject({
      sequence: 2,
      artifacts: [],
      tombstonedIds: [],
      stickyEphemeralIds: [pinned.id],
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

  it('warns when artifact records use an unsupported version', () => {
    const restored = rebuildSessionArtifactSnapshot([
      {
        type: 'system',
        subtype: 'session_artifact_snapshot',
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION + 1,
          sessionId: 's1',
          sequence: 1,
          recordedAt: '2026-07-04T00:00:00.000Z',
          artifacts: [],
          tombstonedIds: [],
          stickyEphemeralIds: [],
        },
      },
      {
        type: 'system',
        subtype: 'session_artifact_event',
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION + 1,
          sessionId: 's1',
          sequence: 2,
          recordedAt: '2026-07-04T00:00:01.000Z',
          changes: [],
        },
      },
      {
        type: 'system',
        subtype: 'session_artifact_snapshot',
        systemPayload: {
          v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
          sessionId: 's1',
          sequence: 3,
          recordedAt: '2026-07-04T00:00:02.000Z',
          artifacts: [],
          tombstonedIds: [],
          stickyEphemeralIds: [],
        },
      },
    ]);

    expect(restored?.warnings).toEqual([
      `skipped v${SESSION_ARTIFACT_PERSISTENCE_VERSION + 1} snapshot record (expected v${SESSION_ARTIFACT_PERSISTENCE_VERSION})`,
      `skipped v${SESSION_ARTIFACT_PERSISTENCE_VERSION + 1} event record (expected v${SESSION_ARTIFACT_PERSISTENCE_VERSION})`,
    ]);
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

  it('drops runtime warning fields during restore normalization', () => {
    const restored = artifact('s1', 'https://example.com/sticky', {
      persistenceWarning: 'sticky_override_active',
    } as Partial<PersistedSessionArtifact>);

    const snapshot = rebuildSessionArtifactSnapshot([
      event({
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 's1',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [
          { action: 'created', artifactId: restored.id, artifact: restored },
        ],
      }),
    ]);

    expect(snapshot?.artifacts[0]).not.toHaveProperty('persistenceWarning');
  });

  it('drops persisted client ids during restore normalization', () => {
    const restored = {
      ...artifact('s1', 'https://example.com/client-owned'),
      clientId: 'client-a',
    } as PersistedSessionArtifact;

    const snapshot = rebuildSessionArtifactSnapshot([
      event({
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 's1',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [
          { action: 'created', artifactId: restored.id, artifact: restored },
        ],
      }),
    ]);

    expect(snapshot?.artifacts[0]).not.toHaveProperty('clientId');
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
    });
    expect(forked).not.toHaveProperty('contentRef');
    expect(forked).not.toHaveProperty('expiresAt');
    expect(forked).not.toHaveProperty('restoreState');
    expect(forked).not.toHaveProperty('persistenceWarning');
  });

  it('remaps forked tombstone changes when artifact metadata is present', () => {
    const source = artifact('source-session', 'https://example.com/deleted');

    const remapped = remapSessionArtifactPayloadForFork(
      {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 'source-session',
        sequence: 6,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [
          {
            action: 'removed',
            artifactId: source.id,
            artifact: source,
            reason: 'unpin_to_ephemeral',
          },
        ],
      },
      'source-session',
      'forked-session',
    ) as SessionArtifactEventRecordPayload;

    expect(remapped.changes).toEqual([
      expect.objectContaining({
        action: 'removed',
        artifactId: stableSessionArtifactId(
          'forked-session',
          'url:https://example.com/deleted',
        ),
        reason: 'unpin_to_ephemeral',
      }),
    ]);
    expect(remapped.changes[0]?.artifact).toMatchObject({
      id: stableSessionArtifactId(
        'forked-session',
        'url:https://example.com/deleted',
      ),
      retention: 'restorable',
    });
    expect(remapped.changes[0]?.artifact).not.toHaveProperty('restoreState');
    expect(remapped.changes[0]?.artifact).not.toHaveProperty(
      'persistenceWarning',
    );
  });

  it('remaps forked snapshot payloads and drops bare tombstone state', () => {
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
    });
    expect(remapped.artifacts[0]).not.toHaveProperty('contentRef');
    expect(remapped.artifacts[0]).not.toHaveProperty('expiresAt');
    expect(remapped.artifacts[0]).not.toHaveProperty('restoreState');
    expect(remapped.artifacts[0]).not.toHaveProperty('persistenceWarning');
  });
});
