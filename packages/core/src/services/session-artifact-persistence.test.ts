/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
  getWebPreviewSnapshotId,
  normalizeEventPayload,
  normalizeSnapshotPayload,
  rebuildSessionArtifactSnapshot,
  remapSessionArtifactPayloadForFork,
  stableSessionArtifactId,
  selectActiveSideArtifactRecordUuids,
  type PersistedSessionArtifact,
  type SessionArtifactEventRecordPayload,
  type SessionArtifactPersistedChange,
  type SessionArtifactSnapshotRecordPayload,
} from './session-artifact-persistence.js';

const V = SESSION_ARTIFACT_PERSISTENCE_VERSION;
const T0 = '2026-07-04T00:00:00.000Z';

function artifact(
  sessionId: string,
  url: string,
  overrides: Partial<PersistedSessionArtifact> = {},
): PersistedSessionArtifact {
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
    createdAt: T0,
    updatedAt: T0,
    persistedAt: T0,
    ...overrides,
  };
}

/** An artifact of `source-session` at `https://example.com/<path>`. */
const src = (path: string, overrides?: Partial<PersistedSessionArtifact>) =>
  artifact('source-session', `https://example.com/${path}`, overrides);
/** The id a `src(path)` artifact gets in `forked-session`. */
const forkedId = (path: string) =>
  stableSessionArtifactId('forked-session', `url:https://example.com/${path}`);
/** The fallback forked id for a source id without identity metadata. */
const fallbackId = (sourceId: string) =>
  stableSessionArtifactId('forked-session', `fork:source-session:${sourceId}`);
const managedCopy = (contentId: string) => ({
  kind: 'managed_copy' as const,
  contentId,
  sha256: 'a'.repeat(64),
  sizeBytes: 12,
  createdAt: T0,
});

/** Payload header; `sec` is the second of `recordedAt`. */
const hdr = (sequence: number, sec = 0, sessionId = 's1', v: number = V) => ({
  v,
  sessionId,
  sequence,
  recordedAt: `2026-07-04T00:00:0${sec}.000Z`,
});
const record = (subtype: 'event' | 'snapshot', systemPayload: object) => ({
  type: 'system',
  subtype: `session_artifact_${subtype}`,
  systemPayload,
});
const event = (sequence: number, changes: unknown[], sec = 0) =>
  record('event', { ...hdr(sequence, sec), changes });
const snapshotRecord = (
  sequence: number,
  sec: number,
  artifacts: PersistedSessionArtifact[],
  tombstonedIds: string[] = [],
  v: number = V,
) =>
  record('snapshot', {
    ...hdr(sequence, sec, 's1', v),
    artifacts,
    tombstonedIds,
    stickyEphemeralIds: [],
  });
const created = (a: PersistedSessionArtifact) => ({
  action: 'created' as const,
  artifactId: a.id,
  artifact: a,
});
const removed = (
  a: PersistedSessionArtifact,
  reason: SessionArtifactPersistedChange['reason'],
) => ({ action: 'removed' as const, artifactId: a.id, artifact: a, reason });
/** Rebuilds from one sequence-1 event creating `a`. */
const rebuildCreated = (a: PersistedSessionArtifact, artifactId = a.id) =>
  rebuildSessionArtifactSnapshot([
    event(1, [{ action: 'created', artifactId, artifact: a }]),
  ]);

const forkEvent = (
  sequence: number,
  changes: SessionArtifactPersistedChange[],
  sec = 0,
  remappedIds?: Map<string, string>,
) =>
  remapSessionArtifactPayloadForFork(
    { ...hdr(sequence, sec, 'source-session'), changes },
    'source-session',
    'forked-session',
    remappedIds,
  ) as SessionArtifactEventRecordPayload;
const forkSnapshot = (
  body: Partial<SessionArtifactSnapshotRecordPayload>,
  sequence = 7,
) =>
  remapSessionArtifactPayloadForFork(
    { ...hdr(sequence, 0, 'source-session'), ...body },
    'source-session',
    'forked-session',
  ) as SessionArtifactSnapshotRecordPayload;

describe('source snapshots beside artifact history', () => {
  it.each(['session_sources_snapshot', 'custom_title'])(
    'does not let %s hide a restored artifact snapshot',
    (subtype) => {
      expect(
        selectActiveSideArtifactRecordUuids(
          [
            { uuid: 'turn', parentUuid: null, type: 'user' },
            {
              uuid: 'artifact',
              parentUuid: 'turn',
              type: 'system',
              subtype: 'session_artifact_snapshot',
            },
            { uuid: 'metadata', parentUuid: 'turn', type: 'system', subtype },
          ],
          ['turn'],
        ),
      ).toEqual(['artifact']);
    },
  );
});

describe('session artifact persistence records', () => {
  it('keeps saved webpage versions when forking events and snapshots', () => {
    const uuid = '8c5e8dc7-4d9c-4a52-a703-7391e9b42dad';
    const saved = artifact(
      'source-session',
      `file:///tmp/runtime/artifacts/snapshots/${uuid}/index.html`,
      {
        id: stableSessionArtifactId(
          'source-session',
          `managed:preview-${uuid}`,
        ),
        kind: 'html',
        storage: 'published',
        source: 'tool',
        toolName: 'artifact',
        toolCallId: 'publish-v1',
        managedId: `preview-${uuid}`,
        metadata: {
          artifactType: 'web_preview_snapshot',
          'qwen.published.sha256': 'a'.repeat(64),
        },
      },
    );
    const expected = {
      ...saved,
      id: stableSessionArtifactId('forked-session', `managed:preview-${uuid}`),
    };
    const forkSaved = (a: PersistedSessionArtifact) =>
      forkSnapshot(
        { artifacts: [a], tombstonedIds: [], stickyEphemeralIds: [] },
        1,
      );
    expect(forkEvent(1, [created(saved)]).changes[0]?.artifact).toMatchObject(
      expected,
    );
    expect(forkSaved(saved).artifacts).toEqual([
      expect.objectContaining(expected),
    ]);
    expect(getWebPreviewSnapshotId(saved)).toBe(uuid);

    const invalidOverrides: Array<Partial<PersistedSessionArtifact>> = [
      { source: 'client' },
      { source: 'hook' },
      { toolName: 'record_artifact' },
      { metadata: { artifactType: 'web_preview_snapshot' } },
      { metadata: { ...saved.metadata, 'qwen.published.sha256': 'bad' } },
      { managedId: `preview-${uuid.replace('-4a52-', '-5a52-')}` },
      { url: saved.url?.replace(uuid, '9c5e8dc7-4d9c-4a52-a703-7391e9b42dad') },
      { url: saved.url?.replace('file:///', 'file://remote/') },
      { url: `${saved.url}?q=1` },
      { url: `${saved.url}#fragment` },
      { url: 'file:///tmp/secret.html' },
    ];
    for (const override of invalidOverrides) {
      const invalid = { ...saved, ...override };
      expect(getWebPreviewSnapshotId(invalid)).toBeUndefined();
      expect(forkSaved(invalid).artifacts).toEqual([]);
    }
  });

  it('roundtrips persisted document artifacts', () => {
    const document = artifact('s1', 'https://example.com/unused', {
      kind: 'document',
      storage: 'workspace',
      workspacePath: 'reports/q3.xlsx',
      url: undefined,
    });

    const snapshot = rebuildSessionArtifactSnapshot([
      snapshotRecord(1, 0, [document]),
    ]);

    expect(snapshot?.artifacts).toEqual([
      expect.objectContaining({
        kind: 'document',
        storage: 'workspace',
        workspacePath: 'reports/q3.xlsx',
      }),
    ]);
  });

  it('rebuilds durable artifacts and explicit tombstones from event records', () => {
    const first = artifact('s1', 'https://example.com/first');
    const second = artifact('s1', 'https://example.com/second');

    const snapshot = rebuildSessionArtifactSnapshot([
      event(1, [
        created(first),
        created({ ...second, retention: 'ephemeral' }),
      ]),
      event(2, [removed(first, 'explicit')], 1),
    ]);

    expect(snapshot).toMatchObject({
      v: V,
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
      event(1, [created(pinned)]),
      event(2, [removed(pinned, 'unpin_to_ephemeral')], 1),
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
      event(1, [removed(pinned, 'unpin_to_ephemeral')]),
      event(2, [removed(pinned, 'eviction')], 1),
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
      event(1, [created(first)]),
      snapshotRecord(3, 2, [second], [first.id]),
    ]);

    expect(snapshot?.artifacts).toEqual([second]);
    expect(snapshot?.tombstonedIds).toEqual([first.id]);
    expect(snapshot?.sequence).toBe(3);
  });

  it('skips stale events at or before the latest snapshot sequence', () => {
    const first = artifact('s1', 'https://example.com/first');
    const stale = artifact('s1', 'https://example.com/stale');

    const snapshot = rebuildSessionArtifactSnapshot([
      snapshotRecord(10, 0, [first]),
      event(9, [created(stale)], 1),
    ]);

    expect(snapshot?.artifacts).toEqual([first]);
    expect(snapshot?.warnings).toContain(
      'skipped stale event sequence 9 at or before snapshot sequence 10',
    );
  });

  it('warns when artifact records use an unsupported version', () => {
    const restored = rebuildSessionArtifactSnapshot([
      snapshotRecord(1, 0, [], [], V + 1),
      record('event', { ...hdr(2, 1, 's1', V + 1), changes: [] }),
      snapshotRecord(3, 2, []),
    ]);

    expect(restored?.warnings).toEqual([
      `skipped v${V + 1} snapshot record (expected v${V})`,
      `skipped v${V + 1} event record (expected v${V})`,
    ]);
  });

  it('warns when oversized metadata is stripped during restore', () => {
    const restored = rebuildCreated(
      artifact('s1', 'https://example.com/metadata', {
        metadata: { blob: 'x'.repeat(5000) },
      }),
      'oversized-metadata',
    );

    expect(restored?.warnings).toEqual([
      `skipped oversized metadata for artifact ${stableSessionArtifactId(
        's1',
        'url:https://example.com/metadata',
      )}`,
    ]);
    expect(restored?.artifacts[0]).not.toHaveProperty('metadata');
  });

  it('filters prototype metadata keys during restore normalization', () => {
    const restored = rebuildCreated(
      artifact('s1', 'https://example.com/prototype', {
        metadata: JSON.parse(
          '{"__proto__":null,"constructor":"blocked","prototype":"blocked","safe":"ok"}',
        ) as Record<string, string | number | boolean | null>,
      }),
      'prototype-metadata',
    );
    const metadata = restored?.artifacts[0]?.metadata;
    const hasOwn = (key: string) =>
      Object.prototype.hasOwnProperty.call(metadata, key);

    expect(metadata).toEqual({ safe: 'ok' });
    expect(Object.getPrototypeOf(metadata)).toBe(Object.prototype);
    expect(hasOwn('__proto__')).toBe(false);
    expect(hasOwn('constructor')).toBe(false);
    expect(hasOwn('prototype')).toBe(false);
  });

  it('filters unsafe persisted metadata during restore normalization', () => {
    const restored = rebuildCreated(
      artifact('s1', 'https://example.com/unsafe-metadata', {
        metadata: {
          safe: 'ok',
          '<script>': 'blocked',
          title: 'javascript:alert(1)',
          hidden: 'zero​width',
        },
      }),
      'unsafe-metadata',
    );

    expect(restored?.artifacts[0]?.metadata).toEqual({ safe: 'ok' });
  });

  it('drops malformed content refs during restore normalization', () => {
    const snapshot = rebuildCreated(
      artifact('s1', 'https://example.com/pinned', {
        retention: 'pinned',
        contentRef: managedCopy('../../escape'),
      }),
    );

    expect(snapshot?.artifacts[0]).not.toHaveProperty('contentRef');
  });

  it('drops runtime warning fields during restore normalization', () => {
    const snapshot = rebuildCreated(
      artifact('s1', 'https://example.com/sticky', {
        persistenceWarning: 'sticky_override_active',
      } as Partial<PersistedSessionArtifact>),
    );

    expect(snapshot?.artifacts[0]).not.toHaveProperty('persistenceWarning');
  });

  it('preserves persisted client ids during restore normalization', () => {
    const snapshot = rebuildCreated({
      ...artifact('s1', 'https://example.com/client-owned'),
      clientId: 'client-a',
    } satisfies PersistedSessionArtifact);

    expect(snapshot?.artifacts[0]).toHaveProperty('clientId', 'client-a');
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

    const snapshot = rebuildCreated(
      artifact('s1', 'https://example.com/workspace-budget', {
        storage: 'workspace',
        workspacePath: 'budget.txt',
        url: undefined,
        sizeBytes: 6,
        metadata,
      }),
    );

    expect(snapshot?.artifacts[0]?.metadata).toMatchObject(metadata);
  });

  it('remaps forked payloads to the new session without carrying pinned content', () => {
    const source = src('report', {
      retention: 'pinned',
      contentRef: managedCopy('content-1'),
      expiresAt: '2026-08-01T00:00:00.000Z',
    });

    const remapped = forkEvent(5, [
      { action: 'updated', artifactId: source.id, artifact: source },
    ]);

    const forked = remapped.changes[0]?.artifact;
    expect(remapped.sessionId).toBe('forked-session');
    expect(forked).toMatchObject({
      id: forkedId('report'),
      retention: 'restorable',
    });
    expect(forked).not.toHaveProperty('contentRef');
    expect(forked).not.toHaveProperty('expiresAt');
    expect(forked).not.toHaveProperty('restoreState');
    expect(forked).not.toHaveProperty('persistenceWarning');
    expect(forked).not.toHaveProperty('clientId');
  });

  it('remaps forked tombstone changes when artifact metadata is present', () => {
    const remapped = forkEvent(6, [
      removed(src('deleted'), 'unpin_to_ephemeral'),
    ]);

    expect(remapped.changes).toEqual([
      expect.objectContaining({
        action: 'removed',
        artifactId: forkedId('deleted'),
        reason: 'unpin_to_ephemeral',
      }),
    ]);
    const forked = remapped.changes[0]?.artifact;
    expect(forked).toMatchObject({
      id: forkedId('deleted'),
      retention: 'restorable',
    });
    expect(forked).not.toHaveProperty('restoreState');
    expect(forked).not.toHaveProperty('persistenceWarning');
    expect(forked).not.toHaveProperty('clientId');
  });

  it('drops unsafe forked event artifact payloads but keeps safe identity tombstones', () => {
    const unsafe = src('deleted-unsafe-event', {
      metadata: { apiKey: 'redacted' },
      clientId: 'legacy-owner',
    });

    expect(forkEvent(6, [removed(unsafe, 'explicit')]).changes).toEqual([
      {
        action: 'removed',
        artifactId: forkedId('deleted-unsafe-event'),
        reason: 'explicit',
      },
    ]);
  });

  it('drops forked event artifact payloads with encoded secret fragments', () => {
    const unsafe = src('report#access%5Ftoken=sk-abcdefghijkl');

    expect(forkEvent(6, [created(unsafe)]).changes).toEqual([]);
  });

  it('remaps forked tombstone changes that omit artifact metadata', () => {
    const source = src('deleted');

    const remapped = forkEvent(7, [
      created(source),
      { action: 'removed', artifactId: source.id, reason: 'explicit' },
    ]);

    const id = forkedId('deleted');
    expect(remapped.changes).toMatchObject([
      { action: 'created', artifactId: id, artifact: { id } },
      { action: 'removed', artifactId: id, reason: 'explicit' },
    ]);
  });

  it('remaps forked non-removal changes that omit artifact metadata', () => {
    const sourceId = stableSessionArtifactId(
      'source-session',
      'fork:source-session:metadata-less',
    );

    const remapped = forkEvent(7, [
      { action: 'updated', artifactId: sourceId },
    ]);

    expect(remapped.changes).toEqual([
      { action: 'updated', artifactId: fallbackId(sourceId) },
    ]);
  });

  it('reuses remapped ids across separate forked event payloads', () => {
    const source = src('deleted-later');
    const remappedIds = new Map<string, string>();

    forkEvent(7, [created(source)], 0, remappedIds);
    const remappedRemove = forkEvent(
      8,
      [{ action: 'removed', artifactId: source.id, reason: 'explicit' }],
      1,
      remappedIds,
    );

    expect(remappedRemove.changes).toEqual([
      {
        action: 'removed',
        artifactId: forkedId('deleted-later'),
        reason: 'explicit',
      },
    ]);
  });

  it('remaps forked snapshot payloads and marker state', () => {
    const source = src('snapshot', {
      retention: 'pinned',
      contentRef: managedCopy('content-1'),
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    const deleted = src('deleted-in-source');
    const sticky = src('ephemeral-in-source');

    const remapped = forkSnapshot({
      artifacts: [source],
      tombstonedIds: [source.id, deleted.id],
      stickyEphemeralIds: [source.id, sticky.id],
      markerArtifacts: [deleted, sticky],
    });
    const forkedSourceId = forkedId('snapshot');
    const forkedDeletedId = forkedId('deleted-in-source');
    const forkedStickyId = forkedId('ephemeral-in-source');

    expect(remapped.sessionId).toBe('forked-session');
    expect(remapped.tombstonedIds).toEqual([forkedSourceId, forkedDeletedId]);
    expect(remapped.stickyEphemeralIds).toEqual([
      forkedSourceId,
      forkedStickyId,
    ]);
    expect(remapped.markerArtifacts).toEqual([
      expect.objectContaining({ id: forkedDeletedId }),
      expect.objectContaining({ id: forkedStickyId }),
    ]);
    expect(remapped.artifacts[0]).toMatchObject({
      id: forkedSourceId,
      retention: 'restorable',
    });
    expect(remapped.artifacts[0]).not.toHaveProperty('contentRef');
    expect(remapped.artifacts[0]).not.toHaveProperty('expiresAt');
    expect(remapped.artifacts[0]).not.toHaveProperty('restoreState');
    expect(remapped.artifacts[0]).not.toHaveProperty('persistenceWarning');
  });

  it('drops unsafe snapshot marker artifacts but keeps safe identity tombstones', () => {
    const unsafe = src('deleted-unsafe', { metadata: { apiKey: 'redacted' } });
    const safe = src('deleted-safe', { metadata: { label: 'safe' } });

    const remapped = forkSnapshot({
      artifacts: [],
      tombstonedIds: [unsafe.id, safe.id],
      markerArtifacts: [unsafe, safe],
    });

    expect(remapped.tombstonedIds).toEqual([
      forkedId('deleted-unsafe'),
      forkedId('deleted-safe'),
    ]);
    expect(remapped.markerArtifacts).toEqual([
      expect.objectContaining({
        id: forkedId('deleted-safe'),
        metadata: { label: 'safe' },
      }),
    ]);
  });

  it('falls back for snapshot marker ids without identity metadata', () => {
    const remapped = forkSnapshot({
      artifacts: [],
      tombstonedIds: ['deleted-in-source'],
      stickyEphemeralIds: ['ephemeral-in-source'],
    });

    expect(remapped.tombstonedIds).toEqual([fallbackId('deleted-in-source')]);
    expect(remapped.stickyEphemeralIds).toEqual([
      fallbackId('ephemeral-in-source'),
    ]);
    expect(remapped.markerArtifacts).toBeUndefined();
  });

  it('does not keep unremapped source marker artifacts in forked snapshots', () => {
    const remapped = forkSnapshot({
      artifacts: [],
      tombstonedIds: ['deleted-in-source'],
      stickyEphemeralIds: [],
      markerArtifacts: [src('stale-marker')],
    });

    expect(remapped.markerArtifacts).toBeUndefined();
  });

  it('normalizes inbound snapshot payloads with bounded artifacts and sticky ids', () => {
    const warnings: string[] = [];
    const artifacts = (length: number, prefix = '') =>
      Array.from({ length }, (_, index) =>
        artifact('session-A', `https://example.com/${prefix}${index}`),
      );
    const snapshot = normalizeSnapshotPayload(
      {
        ...hdr(1, 0, 'session-A'),
        artifacts: artifacts(501),
        markerArtifacts: artifacts(1001, 'marker-'),
        stickyEphemeralIds: Array.from(
          { length: 501 },
          (_, index) => `sticky-${index}`,
        ),
      },
      warnings,
    );

    expect(snapshot?.artifacts).toHaveLength(500);
    expect(snapshot?.markerArtifacts).toHaveLength(1000);
    expect(snapshot?.stickyEphemeralIds).toHaveLength(500);
    expect(snapshot?.stickyEphemeralIds?.[0]).toBe('sticky-1');
    expect(warnings).toContain('snapshot artifact list truncated to 500');
    expect(warnings).toContain(
      'snapshot marker artifact list truncated to 1000',
    );
  });

  it('normalizes inbound event payloads with bounded changes', () => {
    const warnings: string[] = [];
    const changes = Array.from({ length: 801 }, (_, index) =>
      created(artifact('session-A', `https://example.com/event-${index}`)),
    );

    const normalized = normalizeEventPayload(
      { ...hdr(1, 0, 'session-A'), changes },
      warnings,
    );

    expect(normalized?.changes).toHaveLength(800);
    expect(warnings).toContain('event change list truncated to 800');
  });

  it('warns when inbound artifact payloads are malformed', () => {
    const warnings: string[] = [];

    expect(normalizeSnapshotPayload({ v: V }, warnings)).toBeUndefined();
    expect(
      normalizeEventPayload(
        { ...hdr(1, 0, 'session-A'), changes: [{ action: 'created' }] },
        warnings,
      )?.changes,
    ).toEqual([]);

    expect(warnings).toContain(
      'skipped snapshot record without artifacts array',
    );
    expect(warnings).toContain('skipped artifact change without artifactId');
  });

  it('drops overlong persisted string array items', () => {
    const snapshot = normalizeSnapshotPayload(
      {
        ...hdr(1, 0, 'session-A'),
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
        ...hdr(1, 0, 'session-A'),
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
              'qwen.workspace.sizeBytes': -1,
              'qwen.published.sha256': 'not-a-sha',
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
