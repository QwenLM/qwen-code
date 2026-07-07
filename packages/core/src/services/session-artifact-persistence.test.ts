/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
  normalizeEventPayload,
  normalizeSnapshotPayload,
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

  it('clears sticky ephemeral ids when rebuild sees an eviction tombstone', () => {
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
          {
            action: 'removed',
            artifactId: pinned.id,
            artifact: pinned,
            reason: 'unpin_to_ephemeral',
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
            artifactId: pinned.id,
            artifact: pinned,
            reason: 'eviction',
          },
        ],
      }),
    ]);

    expect(snapshot).toMatchObject({
      sequence: 2,
      artifacts: [],
      tombstonedIds: [],
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

  it('warns when oversized metadata is stripped during restore', () => {
    const restored = rebuildSessionArtifactSnapshot([
      event({
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 's1',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [
          {
            action: 'created',
            artifactId: 'oversized-metadata',
            artifact: artifact('s1', 'https://example.com/metadata', {
              metadata: { blob: 'x'.repeat(5000) },
            }),
          },
        ],
      }),
    ]);

    expect(restored?.warnings).toEqual([
      `skipped oversized metadata for artifact ${stableSessionArtifactId(
        's1',
        'url:https://example.com/metadata',
      )}`,
    ]);
    expect(restored?.artifacts[0]).not.toHaveProperty('metadata');
  });

  it('filters prototype metadata keys during restore normalization', () => {
    const restored = rebuildSessionArtifactSnapshot([
      event({
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 's1',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [
          {
            action: 'created',
            artifactId: 'prototype-metadata',
            artifact: artifact('s1', 'https://example.com/prototype', {
              metadata: JSON.parse(
                '{"__proto__":null,"constructor":"blocked","prototype":"blocked","safe":"ok"}',
              ) as Record<string, string | number | boolean | null>,
            }),
          },
        ],
      }),
    ]);
    const metadata = restored?.artifacts[0]?.metadata;

    expect(metadata).toEqual({ safe: 'ok' });
    expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(metadata, '__proto__')).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(metadata, 'constructor')).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(metadata, 'prototype')).toBe(
      false,
    );
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

  it('ignores legacy persisted client ids during restore normalization', () => {
    const restored = {
      ...artifact('s1', 'https://example.com/client-owned'),
      clientId: 'client-a',
    } as PersistedSessionArtifact & { clientId: string };

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

  it('preserves near-limit user metadata with workspace hash metadata', () => {
    const metadata = {
      payload: 'x'.repeat(4096),
      'qwen.workspace.sha256': 'a'.repeat(64),
      'qwen.workspace.mtimeMs': 123,
    };
    while (
      Buffer.byteLength(JSON.stringify({ payload: metadata.payload }), 'utf8') >
      4096
    ) {
      metadata.payload = metadata.payload.slice(0, -1);
    }
    const restored = artifact('s1', 'https://example.com/workspace-budget', {
      storage: 'workspace',
      workspacePath: 'budget.txt',
      url: undefined,
      sizeBytes: 6,
      metadata,
    });

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

    expect(snapshot?.artifacts[0]?.metadata).toMatchObject(metadata);
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

  it('remaps forked tombstone changes that omit artifact metadata', () => {
    const source = artifact('source-session', 'https://example.com/deleted');

    const remapped = remapSessionArtifactPayloadForFork(
      {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 'source-session',
        sequence: 7,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [
          { action: 'created', artifactId: source.id, artifact: source },
          {
            action: 'removed',
            artifactId: source.id,
            reason: 'explicit',
          },
        ],
      },
      'source-session',
      'forked-session',
    ) as SessionArtifactEventRecordPayload;

    const forkedId = stableSessionArtifactId(
      'forked-session',
      'url:https://example.com/deleted',
    );
    expect(remapped.changes).toMatchObject([
      {
        action: 'created',
        artifactId: forkedId,
        artifact: { id: forkedId },
      },
      {
        action: 'removed',
        artifactId: forkedId,
        reason: 'explicit',
      },
    ]);
  });

  it('reuses remapped ids across separate forked event payloads', () => {
    const source = artifact(
      'source-session',
      'https://example.com/deleted-later',
    );
    const remappedIds = new Map<string, string>();
    const forkedId = stableSessionArtifactId(
      'forked-session',
      'url:https://example.com/deleted-later',
    );

    remapSessionArtifactPayloadForFork(
      {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 'source-session',
        sequence: 7,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes: [
          { action: 'created', artifactId: source.id, artifact: source },
        ],
      },
      'source-session',
      'forked-session',
      remappedIds,
    );
    const remappedRemove = remapSessionArtifactPayloadForFork(
      {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 'source-session',
        sequence: 8,
        recordedAt: '2026-07-04T00:00:01.000Z',
        changes: [
          {
            action: 'removed',
            artifactId: source.id,
            reason: 'explicit',
          },
        ],
      },
      'source-session',
      'forked-session',
      remappedIds,
    ) as SessionArtifactEventRecordPayload;

    expect(remappedRemove.changes).toEqual([
      {
        action: 'removed',
        artifactId: forkedId,
        reason: 'explicit',
      },
    ]);
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

  it('normalizes inbound snapshot payloads with bounded artifacts and sticky ids', () => {
    const warnings: string[] = [];
    const artifacts = Array.from({ length: 501 }, (_, index) =>
      artifact('session-A', `https://example.com/${index}`),
    );
    const snapshot = normalizeSnapshotPayload(
      {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 'session-A',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        artifacts,
        stickyEphemeralIds: Array.from(
          { length: 501 },
          (_, index) => `sticky-${index}`,
        ),
      },
      warnings,
    );

    expect(snapshot?.artifacts).toHaveLength(500);
    expect(snapshot?.stickyEphemeralIds).toHaveLength(500);
    expect(snapshot?.stickyEphemeralIds?.[0]).toBe('sticky-1');
    expect(warnings).toContain('snapshot artifact list truncated to 500');
  });

  it('normalizes inbound event payloads with bounded changes', () => {
    const warnings: string[] = [];
    const changes = Array.from({ length: 501 }, (_, index) => {
      const item = artifact('session-A', `https://example.com/event-${index}`);
      return {
        action: 'created' as const,
        artifactId: item.id,
        artifact: item,
      };
    });

    const normalized = normalizeEventPayload(
      {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 'session-A',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        changes,
      },
      warnings,
    );

    expect(normalized?.changes).toHaveLength(500);
    expect(warnings).toContain('event change list truncated to 500');
  });

  it('drops overlong persisted string array items', () => {
    const snapshot = normalizeSnapshotPayload(
      {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 'session-A',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        artifacts: [],
        tombstonedIds: ['deleted', 'x'.repeat(201)],
        stickyEphemeralIds: ['sticky', 'y'.repeat(201)],
      },
      [],
    );

    expect(snapshot?.tombstonedIds).toEqual(['deleted']);
    expect(snapshot?.stickyEphemeralIds).toEqual(['sticky']);
  });

  it('drops unsafe persisted metadata and overlong string fields', () => {
    const warnings: string[] = [];
    const normalized = normalizeSnapshotPayload(
      {
        v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
        sessionId: 'session-A',
        sequence: 1,
        recordedAt: '2026-07-04T00:00:00.000Z',
        artifacts: [
          {
            ...artifact('session-A', 'https://example.com/metadata'),
            title: 'x'.repeat(201),
          },
          {
            ...artifact('session-A', 'https://example.com/metadata-2'),
            metadata: {
              'qwen.workspace.sha256': 'not-a-sha',
              'qwen.workspace.mtimeMs': '123',
              keep: true,
            },
          },
        ],
      },
      warnings,
    );

    expect(normalized?.artifacts).toHaveLength(1);
    expect(normalized?.artifacts[0]?.metadata).toEqual({ keep: true });
    expect(warnings).toContain('skipped artifact without id/title');
  });
});
