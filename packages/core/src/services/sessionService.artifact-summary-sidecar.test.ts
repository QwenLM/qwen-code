/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRecord } from './chatRecordingService.js';
import { SessionService } from './sessionService.js';
import {
  stableSessionArtifactId,
  type PersistedSessionArtifact,
} from './session-artifact-persistence.js';
import {
  readSessionArtifactSummarySidecar,
  sessionArtifactSummarySidecarPath,
  writeSessionArtifactSummarySidecar,
} from './session-artifact-summary-sidecar.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

function persistedArtifact(url: string): PersistedSessionArtifact {
  return {
    id: stableSessionArtifactId(SESSION_ID, `url:${url}`),
    kind: 'link',
    storage: 'external_url',
    source: 'client',
    status: 'available',
    title: url,
    url,
    retention: 'restorable',
    clientRetained: true,
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
  };
}

describe('SessionService - artifact summary sidecar', () => {
  let root: string;
  let service: SessionService;
  let transcriptPath: string;
  let sidecarPath: string;
  let archivedSidecarPath: string;

  const userRecord = (): ChatRecord => ({
    uuid: 'user-1',
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: '2026-11-17T00:00:00.000Z',
    type: 'user',
    cwd: root,
    version: '1.0.0',
    message: { role: 'user', parts: [{ text: 'seed prompt' }] },
  });

  const artifactEventRecord = (
    artifacts: PersistedSessionArtifact[],
    sequence = 1,
  ): ChatRecord => ({
    uuid: `artifact-event-${sequence}`,
    parentUuid: 'user-1',
    sessionId: SESSION_ID,
    timestamp: '2026-11-17T00:00:01.000Z',
    type: 'system',
    subtype: 'session_artifact_event',
    cwd: root,
    version: '1.0.0',
    systemPayload: {
      v: 2,
      sessionId: SESSION_ID,
      sequence,
      recordedAt: '2026-11-17T00:00:01.000Z',
      changes: artifacts.map((artifact) => ({
        action: 'created',
        artifactId: artifact.id,
        artifact,
      })),
    },
  });

  const writeTranscript = (records: ChatRecord[]) => {
    writeFileSync(
      transcriptPath,
      `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
      'utf8',
    );
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'qwen-artifact-summary-'));
    service = new SessionService(root, {
      runtimeBaseDir: path.join(root, '.qwen'),
    });
    transcriptPath = service.getSessionTranscriptPath(SESSION_ID);
    mkdirSync(path.dirname(transcriptPath), { recursive: true });
    sidecarPath = sessionArtifactSummarySidecarPath(
      path.dirname(transcriptPath),
      SESSION_ID,
    );
    archivedSidecarPath = sessionArtifactSummarySidecarPath(
      path.join(path.dirname(transcriptPath), 'archive'),
      SESSION_ID,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('seeds the sidecar from the journal on load (legacy session)', async () => {
    writeTranscript([
      userRecord(),
      artifactEventRecord([
        persistedArtifact('https://example.com/seed-a'),
        persistedArtifact('https://example.com/seed-b'),
      ]),
    ]);
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();

    const loaded = await service.loadSession(SESSION_ID);

    expect(loaded?.artifactSnapshot?.artifacts).toHaveLength(2);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  it('does not seed a sidecar for a session without artifacts', async () => {
    writeTranscript([userRecord()]);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
  });

  it('does not rewrite the sidecar when it already carries the count', async () => {
    writeTranscript([
      userRecord(),
      artifactEventRecord([persistedArtifact('https://example.com/seed-a')]),
    ]);
    writeSessionArtifactSummarySidecar(sidecarPath, 1);
    const beforeIno = statSync(sidecarPath).ino;

    await service.loadSession(SESSION_ID);

    // A warm load must add no disk write: the atomic write's temp+rename
    // changes the inode on every write, so an unchanged inode witnesses
    // no write (a millisecond timestamp could collide within one ms).
    expect(statSync(sidecarPath).ino).toBe(beforeIno);
  });

  it('heals a stale positive sidecar to zero when the journal has no artifacts', async () => {
    // A failed best-effort zero write must not leave a phantom count
    // forever: the authoritative load corrects an EXISTING sidecar to zero.
    // No artifact records at all → the rebuild returns undefined; that is
    // still a zero count for healing.
    writeTranscript([userRecord()]);
    writeSessionArtifactSummarySidecar(sidecarPath, 3);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      0,
    );
  });

  it('heals a stale sidecar to zero when every artifact was removed', async () => {
    // The journal still carries artifact records (created then removed),
    // so the rebuild returns a defined empty snapshot — the other zero
    // shape the heal must cover.
    const a = persistedArtifact('https://example.com/heal-a');
    writeTranscript([
      userRecord(),
      artifactEventRecord([a]),
      {
        ...artifactEventRecord([], 2),
        systemPayload: {
          v: 2,
          sessionId: SESSION_ID,
          sequence: 2,
          recordedAt: '2026-11-17T00:00:02.000Z',
          changes: [
            {
              action: 'removed',
              artifactId: a.id,
              artifact: a,
              reason: 'explicit',
            },
          ],
        },
      },
    ]);
    writeSessionArtifactSummarySidecar(sidecarPath, 1);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      0,
    );
  });

  it('does not seed from a partial transcript read', async () => {
    // A non-object JSON line flags the read incomplete (jsonl.read fires
    // onIncompleteRead); the seed must not publish a count rebuilt from a
    // partial transcript.
    writeFileSync(
      transcriptPath,
      `${JSON.stringify(userRecord())}\n${JSON.stringify(
        artifactEventRecord([
          persistedArtifact('https://example.com/seed-a'),
          persistedArtifact('https://example.com/seed-b'),
        ]),
      )}\n42\n`,
      'utf8',
    );

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
  });

  it('refreshes a stale sidecar count on load', async () => {
    writeTranscript([
      userRecord(),
      artifactEventRecord([
        persistedArtifact('https://example.com/seed-a'),
        persistedArtifact('https://example.com/seed-b'),
      ]),
    ]);
    writeSessionArtifactSummarySidecar(sidecarPath, 99);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  it('moves the sidecar through archive and unarchive', async () => {
    writeTranscript([userRecord()]);
    writeSessionArtifactSummarySidecar(sidecarPath, 4);

    const archived = await service.archiveSessions([SESSION_ID]);
    expect(archived.archived).toEqual([SESSION_ID]);
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
    expect(
      readSessionArtifactSummarySidecar(archivedSidecarPath)?.artifactCount,
    ).toBe(4);

    const unarchived = await service.unarchiveSessions([SESSION_ID]);
    expect(unarchived.unarchived).toEqual([SESSION_ID]);
    expect(
      readSessionArtifactSummarySidecar(archivedSidecarPath),
    ).toBeUndefined();
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      4,
    );
  });

  it('drops the sidecar together with the session in both states', async () => {
    writeTranscript([userRecord()]);
    writeSessionArtifactSummarySidecar(sidecarPath, 2);
    mkdirSync(path.dirname(archivedSidecarPath), { recursive: true });
    writeSessionArtifactSummarySidecar(archivedSidecarPath, 7);

    await expect(service.removeSession(SESSION_ID)).resolves.toBe(true);

    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
    expect(
      readSessionArtifactSummarySidecar(archivedSidecarPath),
    ).toBeUndefined();
  });

  it('discards the dropped side count on a conflict archive', async () => {
    // The kept (archived) transcript has a different artifact set; the
    // dropped (active) count must not transfer onto it.
    writeTranscript([userRecord()]);
    writeSessionArtifactSummarySidecar(sidecarPath, 3);
    mkdirSync(path.dirname(archivedSidecarPath), { recursive: true });
    writeFileSync(
      path.join(path.dirname(archivedSidecarPath), `${SESSION_ID}.jsonl`),
      `${JSON.stringify(userRecord())}\n`,
      'utf8',
    );
    writeSessionArtifactSummarySidecar(archivedSidecarPath, 7);

    const result = await service.archiveSessions([SESSION_ID], {
      resolveConflicts: true,
    });

    expect(result.resolvedConflicts).toEqual([SESSION_ID]);
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
    expect(
      readSessionArtifactSummarySidecar(archivedSidecarPath)?.artifactCount,
    ).toBe(7);
  });

  it('discards the dropped side count on a conflict unarchive', async () => {
    // Mirror of the archive conflict: kept active keeps its own count; the
    // dropped archived side's count must not survive.
    writeTranscript([userRecord()]);
    writeSessionArtifactSummarySidecar(sidecarPath, 7);
    mkdirSync(path.dirname(archivedSidecarPath), { recursive: true });
    writeFileSync(
      path.join(path.dirname(archivedSidecarPath), `${SESSION_ID}.jsonl`),
      `${JSON.stringify(userRecord())}\n`,
      'utf8',
    );
    writeSessionArtifactSummarySidecar(archivedSidecarPath, 3);

    const result = await service.unarchiveSessions([SESSION_ID], {
      resolveConflicts: true,
    });

    expect(result.resolvedConflicts).toEqual([SESSION_ID]);
    expect(
      readSessionArtifactSummarySidecar(archivedSidecarPath),
    ).toBeUndefined();
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      7,
    );
  });

  it('does not transfer the dropped count onto a kept side with no sidecar (archive)', async () => {
    // The realistic legacy shape: the kept (archived) transcript predates
    // the sidecar, so it has none. The dropped count must be discarded,
    // not moved onto the kept side; the load-time seed regenerates it.
    writeTranscript([userRecord()]);
    writeSessionArtifactSummarySidecar(sidecarPath, 3);
    mkdirSync(path.dirname(archivedSidecarPath), { recursive: true });
    writeFileSync(
      path.join(path.dirname(archivedSidecarPath), `${SESSION_ID}.jsonl`),
      `${JSON.stringify(userRecord())}\n`,
      'utf8',
    );

    const result = await service.archiveSessions([SESSION_ID], {
      resolveConflicts: true,
    });

    expect(result.resolvedConflicts).toEqual([SESSION_ID]);
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
    expect(
      readSessionArtifactSummarySidecar(archivedSidecarPath),
    ).toBeUndefined();
  });

  it('does not transfer the dropped count onto a kept side with no sidecar (unarchive)', async () => {
    writeTranscript([userRecord()]);
    mkdirSync(path.dirname(archivedSidecarPath), { recursive: true });
    writeFileSync(
      path.join(path.dirname(archivedSidecarPath), `${SESSION_ID}.jsonl`),
      `${JSON.stringify(userRecord())}\n`,
      'utf8',
    );
    writeSessionArtifactSummarySidecar(archivedSidecarPath, 3);

    const result = await service.unarchiveSessions([SESSION_ID], {
      resolveConflicts: true,
    });

    expect(result.resolvedConflicts).toEqual([SESSION_ID]);
    expect(
      readSessionArtifactSummarySidecar(archivedSidecarPath),
    ).toBeUndefined();
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
  });

  it('keeps the sidecar in step with a cold library removal', async () => {
    // Three artifacts with one removed: the expected 2 is the REMAINING
    // count, not the removed batch's size (which a 2/1 fixture cannot
    // distinguish from the subtraction).
    const a = persistedArtifact('https://example.com/lib-a');
    const b = persistedArtifact('https://example.com/lib-b');
    const c = persistedArtifact('https://example.com/lib-c');
    writeTranscript([userRecord(), artifactEventRecord([a, b, c])]);
    writeSessionArtifactSummarySidecar(sidecarPath, 3);

    const removed = await service.removeSessionArtifactForLibrary(
      SESSION_ID,
      a.id,
      {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      },
    );

    expect(removed).toBe(true);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  it('subtracts the whole removed batch on a cold library removal', async () => {
    const a = persistedArtifact('https://example.com/lib-a');
    const b = persistedArtifact('https://example.com/lib-b');
    const c = persistedArtifact('https://example.com/lib-c');
    writeTranscript([userRecord(), artifactEventRecord([a, b, c])]);
    writeSessionArtifactSummarySidecar(sidecarPath, 3);

    const removed = await service.removeSessionArtifactsForLibrary(
      SESSION_ID,
      [a.id, b.id],
      {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      },
    );

    expect(removed).toEqual([a.id, b.id]);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('recounts restorable survivors without non-snapshot published file locators on removal', async () => {
    // The widened shared predicate governs the removal recount too: the
    // published file: locator is not restorable, so removing one of the
    // two restorable links leaves 1, not 2.
    const a = persistedArtifact('https://example.com/rm-keep-a');
    const b = persistedArtifact('https://example.com/rm-keep-b');
    const locator: PersistedSessionArtifact = {
      ...persistedArtifact('file:///tmp/legacy/rm.pdf'),
      storage: 'published',
    };
    writeTranscript([userRecord(), artifactEventRecord([a, b, locator])]);
    writeSessionArtifactSummarySidecar(sidecarPath, 2);

    const removed = await service.removeSessionArtifactsForLibrary(
      SESSION_ID,
      [b.id],
      {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      },
    );

    expect(removed).toEqual([b.id]);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('does not clobber a correct sidecar from a journal with a history gap', async () => {
    // The orphaned second user breaks the history chain and blocks
    // active-branch attribution of the side events, so the rebuild sees
    // no artifacts at all (0 of 3 — verified against
    // selectActiveSideArtifactRecordUuids: the orphan conversation record
    // blocks the preceding event, and the orphan event's parent is not
    // active). A complete PARSE is not an authoritative read — the seed
    // must leave the correct sidecar alone.
    const a = persistedArtifact('https://example.com/gap-a');
    const b = persistedArtifact('https://example.com/gap-b');
    const c = persistedArtifact('https://example.com/gap-c');
    const orphanUser: ChatRecord = {
      uuid: 'user-2',
      parentUuid: 'missing-parent',
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:02.000Z',
      type: 'user',
      cwd: root,
      version: '1.0.0',
      message: { role: 'user', parts: [{ text: 'orphaned prompt' }] },
    };
    const orphanEvent: ChatRecord = {
      ...artifactEventRecord([c], 2),
      uuid: 'artifact-event-orphan',
      parentUuid: 'user-2',
    };
    writeTranscript([
      userRecord(),
      artifactEventRecord([a, b]),
      orphanUser,
      orphanEvent,
    ]);
    writeSessionArtifactSummarySidecar(sidecarPath, 3);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      3,
    );
  });

  it('does not seed from a journal the mutation guard would refuse', async () => {
    // A record-level damage warning (event without a changes array) is
    // one the library removal path treats as non-authoritative; the seed
    // must refuse the same journal instead of publishing its undercount.
    const a = persistedArtifact('https://example.com/warn-a');
    const damaged: ChatRecord = {
      uuid: 'artifact-event-damaged',
      parentUuid: 'user-1',
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:02.000Z',
      type: 'system',
      subtype: 'session_artifact_event',
      cwd: root,
      version: '1.0.0',
      // Deliberately malformed: an event payload without a changes array.
      systemPayload: {
        v: 2,
        sessionId: SESSION_ID,
        sequence: 2,
        recordedAt: '2026-11-17T00:00:02.000Z',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([userRecord(), artifactEventRecord([a]), damaged]);
    writeSessionArtifactSummarySidecar(sidecarPath, 5);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      5,
    );
  });

  it('still seeds when the only warnings are per-artifact skips', async () => {
    // Tolerated warnings (missing id/title) leave the surviving sequence
    // trustworthy: the seed publishes the rebuilt count, not the stale one.
    const a = persistedArtifact('https://example.com/tolerated-a');
    const titleless = { ...persistedArtifact('https://example.com/no-title') };
    delete (titleless as { title?: string }).title;
    writeTranscript([userRecord(), artifactEventRecord([a, titleless])]);
    writeSessionArtifactSummarySidecar(sidecarPath, 7);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('counts restorable survivors on a cold library removal with legacy artifacts', async () => {
    const link = persistedArtifact('https://example.com/removal-link');
    const legacyUrl = 'file:///tmp/legacy-removal/index.html';
    const legacy: PersistedSessionArtifact = {
      id: stableSessionArtifactId(SESSION_ID, `url:${legacyUrl}`),
      kind: 'html',
      storage: 'published',
      source: 'client',
      status: 'available',
      title: 'Legacy published page',
      url: legacyUrl,
      retention: 'restorable',
      clientRetained: true,
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    };
    writeTranscript([userRecord(), artifactEventRecord([link, legacy])]);
    writeSessionArtifactSummarySidecar(sidecarPath, 1);

    const removed = await service.removeSessionArtifactForLibrary(
      SESSION_ID,
      link.id,
      {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      },
    );

    expect(removed).toBe(true);
    // The legacy html is not restorable, so removing the link leaves zero
    // restorable survivors — not raw rebuild (2) minus batch (1).
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      0,
    );
  });

  it('counts restorable survivors, not a decrement by the requested batch', async () => {
    // A stale id in the removal batch must not shrink the count: the
    // survivors are recounted, not subtracted by requestedIds.size.
    const a = persistedArtifact('https://example.com/stale-a');
    const b = persistedArtifact('https://example.com/stale-b');
    const c = persistedArtifact('https://example.com/stale-c');
    writeTranscript([userRecord(), artifactEventRecord([a, b, c])]);
    writeSessionArtifactSummarySidecar(sidecarPath, 3);

    const removed = await service.removeSessionArtifactsForLibrary(
      SESSION_ID,
      [a.id, 'absent-id'],
      {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      },
    );

    expect(removed).toEqual([a.id]);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  it('seeds the restorable set the bridge restores, not the raw rebuild', async () => {
    // A non-html published file: locator without a preview snapshot is
    // refused by the bridge on restore whatever its kind or id; the seed
    // must exclude it too, or the count flips between the seed and the
    // next durable event stamp for the session's life.
    const kept = persistedArtifact('https://example.com/kept-link');
    const dropped: PersistedSessionArtifact = {
      ...persistedArtifact('file:///tmp/legacy/report.pdf'),
      storage: 'published',
    };
    writeTranscript([userRecord(), artifactEventRecord([kept, dropped])]);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('seeds a side-records-only session on load', async () => {
    // Artifacts registered before the first prompt: the transcript holds
    // only side records, so loadSession returns no conversation — but the
    // session is listable and the seed must still run (the same shape the
    // library mutation guard accepts).
    const a = persistedArtifact('https://example.com/side-only-a');
    const b = persistedArtifact('https://example.com/side-only-b');
    writeTranscript([{ ...artifactEventRecord([a, b]), parentUuid: null }]);

    const loaded = await service.loadSession(SESSION_ID);

    expect(loaded).toBeUndefined();
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  it('seeds a side-records-only session that also carries a custom title', async () => {
    const a = persistedArtifact('https://example.com/side-title-a');
    const title: ChatRecord = {
      uuid: 'title-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.000Z',
      type: 'system',
      subtype: 'custom_title',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        title: 'Pre-prompt session',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([title, { ...artifactEventRecord([a]), parentUuid: null }]);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('does not zero-heal a correct sidecar from an all-refused journal', async () => {
    // Every artifact record is refused (forward payload version): the
    // rebuild yields no snapshot, but the damage warnings must still reach
    // the seed gate — "no readable records" is not "no records".
    const a = persistedArtifact('https://example.com/refused-a');
    const unreadable: ChatRecord = {
      uuid: 'artifact-event-v3',
      parentUuid: 'user-1',
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:01.000Z',
      type: 'system',
      subtype: 'session_artifact_event',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        v: 3,
        sessionId: SESSION_ID,
        sequence: 1,
        recordedAt: '2026-11-17T00:00:01.000Z',
        changes: [{ action: 'created', artifactId: a.id, artifact: a }],
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([userRecord(), unreadable]);
    writeSessionArtifactSummarySidecar(sidecarPath, 5);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      5,
    );
  });

  it('refuses a library removal on an all-refused journal', async () => {
    // Same damaged shape as the seed case: the mutation guard must see the
    // threaded warnings even though the rebuild yields no snapshot.
    const a = persistedArtifact('https://example.com/library-refused-a');
    const unreadable: ChatRecord = {
      uuid: 'artifact-event-v3-library',
      parentUuid: 'user-1',
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:01.000Z',
      type: 'system',
      subtype: 'session_artifact_event',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        v: 3,
        sessionId: SESSION_ID,
        sequence: 1,
        recordedAt: '2026-11-17T00:00:01.000Z',
        changes: [{ action: 'created', artifactId: a.id, artifact: a }],
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([userRecord(), unreadable]);
    writeSessionArtifactSummarySidecar(sidecarPath, 5);

    await expect(
      service.removeSessionArtifactsForLibrary(SESSION_ID, [a.id], {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      }),
    ).rejects.toMatchObject({ code: 'session_transcript_corrupt' });
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      5,
    );
  });

  it('does not seed from a journal with a discarded change entry', async () => {
    // 'skipped malformed artifact change' is change-level damage (the
    // artifact the change would create is missing from the rebuild), not
    // a per-artifact skip — the seed must refuse the journal.
    const a = persistedArtifact('https://example.com/change-a');
    const damaged: ChatRecord = {
      uuid: 'artifact-event-damaged-change',
      parentUuid: 'user-1',
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:02.000Z',
      type: 'system',
      subtype: 'session_artifact_event',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        v: 2,
        sessionId: SESSION_ID,
        sequence: 2,
        recordedAt: '2026-11-17T00:00:02.000Z',
        changes: [42],
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([userRecord(), artifactEventRecord([a]), damaged]);
    writeSessionArtifactSummarySidecar(sidecarPath, 5);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      5,
    );
  });

  it('seeds the count a cold open restores, dropping legacy local-published html', async () => {
    const link = persistedArtifact('https://example.com/restore-link');
    const legacyUrl = 'file:///tmp/legacy-published/index.html';
    const legacy: PersistedSessionArtifact = {
      id: stableSessionArtifactId(SESSION_ID, `url:${legacyUrl}`),
      kind: 'html',
      storage: 'published',
      source: 'client',
      status: 'available',
      title: 'Legacy published page',
      url: legacyUrl,
      retention: 'restorable',
      clientRetained: true,
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    };
    const previewId = '8c5e8dc7-4d9c-4a52-a703-7391e9b42dad';
    const preview: PersistedSessionArtifact = {
      id: stableSessionArtifactId(SESSION_ID, `managed:preview-${previewId}`),
      kind: 'html',
      storage: 'published',
      source: 'tool',
      toolName: 'artifact',
      status: 'available',
      title: 'Real preview snapshot',
      managedId: `preview-${previewId}`,
      url: `file:///tmp/project/artifacts/snapshots/${previewId}/index.html`,
      metadata: {
        artifactType: 'web_preview_snapshot',
        'qwen.published.sha256': 'a'.repeat(64),
      },
      retention: 'restorable',
      clientRetained: true,
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    };
    writeTranscript([
      userRecord(),
      artifactEventRecord([link, legacy, preview]),
    ]);

    await service.loadSession(SESSION_ID);

    // The legacy local-published html is dropped on cold restore; the real
    // preview snapshot and the link stay counted.
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  it('seeds the archived sidecar when an archived session is opened', async () => {
    const a = persistedArtifact('https://example.com/archived-seed');
    writeTranscript([userRecord(), artifactEventRecord([a])]);
    const archiveDir = path.join(path.dirname(transcriptPath), 'archive');
    mkdirSync(archiveDir, { recursive: true });
    renameSync(transcriptPath, path.join(archiveDir, `${SESSION_ID}.jsonl`));

    const loaded = await service.loadArchivedSession(SESSION_ID, {
      maxBytes: 10_000_000,
    });

    expect(loaded).toBeDefined();
    expect(
      readSessionArtifactSummarySidecar(archivedSidecarPath)?.artifactCount,
    ).toBe(1);
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
  });

  it('seeds from a session_artifact_snapshot record (the fork path)', async () => {
    // A fork's count comes solely from the seed reading the copied snapshot
    // record — no artifact event is involved.
    const a = persistedArtifact('https://example.com/snapshot-a');
    const b = persistedArtifact('https://example.com/snapshot-b');
    const snapshotRecord: ChatRecord = {
      uuid: 'artifact-snapshot-1',
      parentUuid: 'user-1',
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:01.000Z',
      type: 'system',
      subtype: 'session_artifact_snapshot',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        v: 2,
        sessionId: SESSION_ID,
        sequence: 1,
        recordedAt: '2026-11-17T00:00:01.000Z',
        artifacts: [a, b],
      },
    };
    writeTranscript([userRecord(), snapshotRecord]);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });
});
