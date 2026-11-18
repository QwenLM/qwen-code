/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs, {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // The orphaned second user breaks the history chain: the active
    // branch is just user-2, so the preceding event's parent user-1 is
    // off it and only the orphan event (parented to the active leaf
    // user-2) is selected — the rebuild sees 1 of 3, with no warning
    // (verified against selectActiveSideArtifactRecordUuids). A complete
    // PARSE is not an authoritative read — gaps.length alone refuses the
    // seed, which must leave the correct sidecar alone.
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

  it('does not seed an artifact-only transcript that no restore path can open', async () => {
    // A transcript with only artifact events reconstructs no message at
    // all: loadSession returns undefined and the projection is undefined,
    // so no cold open delivers these artifacts. A count here would
    // advertise a set the opened session can never show (review round-5
    // R5-1); the honest state is no sidecar. Metadata-bearing side-records
    // transcripts (the production shape) reconstruct their creation
    // records and are seeded — see the session_source cases.
    const a = persistedArtifact('https://example.com/side-only-a');
    const b = persistedArtifact('https://example.com/side-only-b');
    writeTranscript([{ ...artifactEventRecord([a, b]), parentUuid: null }]);

    const loaded = await service.loadSession(SESSION_ID);

    expect(loaded).toBeUndefined();
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
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

  it('does not seed through the projection when no projection can be built', async () => {
    // The daemon/ACP funnel reads via readRestoreProjection and never
    // calls loadSession. A missing projection means the index builder
    // found no conversation record at all — nothing downstream carries an
    // artifactSnapshot for it, so the seed must not write a count, and the
    // auxiliary read must not even run (review round-5 R5-1).
    const readSpy = vi.spyOn(
      service as unknown as {
        readAllRecords: (
          filePath: string,
          onIncompleteRead?: () => void,
        ) => Promise<ChatRecord[]>;
      },
      'readAllRecords',
    );
    const a = persistedArtifact('https://example.com/projection-a');
    const b = persistedArtifact('https://example.com/projection-b');
    writeTranscript([{ ...artifactEventRecord([a, b]), parentUuid: null }]);

    const projection = await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });

    expect(projection).toBeUndefined();
    expect(readSpy).not.toHaveBeenCalled();
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
    readSpy.mockRestore();
  });

  it('seeds a side-records-only session carrying the creation-time session_source record', async () => {
    // Every daemon/Web Shell session persists session_source at creation,
    // before any prompt — the shape gate must admit it (review round-2
    // arm A: the real production shape, not a hand-built artifact-only one).
    const a = persistedArtifact('https://example.com/source-a');
    const b = persistedArtifact('https://example.com/source-b');
    const sourceRecord: ChatRecord = {
      uuid: 'source-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.000Z',
      type: 'system',
      subtype: 'session_source',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        sourceType: 'web_shell',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([
      sourceRecord,
      { ...artifactEventRecord([a, b]), parentUuid: 'source-1' },
    ]);

    const projection = await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });

    expect(projection?.runtime.apiHistory.length).toBe(0);
    // Count and delivery share one source: the sidecar must equal the
    // artifact set this projection actually carries (review round-6 R6-1).
    expect(projection?.runtime.artifactSnapshot?.artifacts.length).toBe(2);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  it('seeds a session_source-bearing side-records transcript through loadSession too', async () => {
    const a = persistedArtifact('https://example.com/source-load');
    const sourceRecord: ChatRecord = {
      uuid: 'source-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.000Z',
      type: 'system',
      subtype: 'session_source',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        sourceType: 'web_shell',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([
      sourceRecord,
      { ...artifactEventRecord([a]), parentUuid: null },
    ]);

    const loaded = await service.loadSession(SESSION_ID);

    expect(loaded).toBeDefined();
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('seeds a side-records transcript carrying the creation-time session_model record', async () => {
    // Web Shell create+attach awaits setModel before the first prompt,
    // which persists a system/session_model record — the shape gate must
    // admit every creation-time metadata record, not an enumerated few
    // (review round-3 arm A: [session_source, session_model, events]).
    const a = persistedArtifact('https://example.com/model-a');
    const b = persistedArtifact('https://example.com/model-b');
    const sourceRecord: ChatRecord = {
      uuid: 'source-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.000Z',
      type: 'system',
      subtype: 'session_source',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        sourceType: 'web_shell',
      } as unknown as ChatRecord['systemPayload'],
    };
    const modelRecord: ChatRecord = {
      uuid: 'model-1',
      parentUuid: 'source-1',
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.500Z',
      type: 'system',
      subtype: 'session_model',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        modelId: 'fake-model',
        authType: 'openai',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([
      sourceRecord,
      modelRecord,
      { ...artifactEventRecord([a, b]), parentUuid: 'model-1' },
    ]);

    const projection = await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });

    expect(projection?.runtime.apiHistory.length).toBe(0);
    // Count and delivery share one source (review round-6 R6-1).
    expect(projection?.runtime.artifactSnapshot?.artifacts.length).toBe(2);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  it('seeds a session_model-bearing side-records transcript through loadSession too', async () => {
    const a = persistedArtifact('https://example.com/model-load-a');
    const b = persistedArtifact('https://example.com/model-load-b');
    const sourceRecord: ChatRecord = {
      uuid: 'source-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.000Z',
      type: 'system',
      subtype: 'session_source',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        sourceType: 'web_shell',
      } as unknown as ChatRecord['systemPayload'],
    };
    const modelRecord: ChatRecord = {
      uuid: 'model-1',
      parentUuid: 'source-1',
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.500Z',
      type: 'system',
      subtype: 'session_model',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        modelId: 'fake-model',
        authType: 'openai',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([
      sourceRecord,
      modelRecord,
      { ...artifactEventRecord([a, b]), parentUuid: null },
    ]);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  // Mirrors the service's MAX_TRANSCRIPT_READ_BYTES (not exported).
  const MAX_TRANSCRIPT_READ_BYTES = 64 * 1024 * 1024;

  const titleRecord = (title: string): ChatRecord => ({
    uuid: 'title-1',
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: '2026-11-17T00:00:00.000Z',
    type: 'system',
    subtype: 'custom_title',
    cwd: root,
    version: '1.0.0',
    systemPayload: { title } as unknown as ChatRecord['systemPayload'],
  });

  const writeTranscriptOfSize = (targetBytes: number, rest: ChatRecord[]) => {
    const base = [titleRecord(''), ...rest]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const pad = targetBytes - Buffer.byteLength(base) - 1;
    writeTranscript([titleRecord('x'.repeat(pad)), ...rest]);
  };

  it('does not seed a count the projection does not deliver', async () => {
    // The recorder writes custom_title / re-anchored session_source with
    // updateActiveTail=false, so an event parented to the non-tail metadata
    // is outside the projection's active-segment selection: a whole-
    // transcript rebuild counts it, the projection delivers nothing. The
    // sidecar must match the delivery, not the rebuild (review round-6
    // R6-1).
    const a = persistedArtifact('https://example.com/nontail-a');
    const b = persistedArtifact('https://example.com/nontail-b');
    const sourceRecord: ChatRecord = {
      uuid: 'source-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.000Z',
      type: 'system',
      subtype: 'session_source',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        sourceType: 'web_shell',
      } as unknown as ChatRecord['systemPayload'],
    };
    const title: ChatRecord = {
      uuid: 'title-1',
      parentUuid: 'source-1',
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.500Z',
      type: 'system',
      subtype: 'custom_title',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        title: 'Non-tail',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([
      sourceRecord,
      title,
      { ...artifactEventRecord([a, b]), parentUuid: 'source-1' },
    ]);

    const projection = await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });

    expect(projection?.runtime.apiHistory.length).toBe(0);
    expect(projection?.runtime.artifactSnapshot).toBeUndefined();
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();

    // An existing stale count heals to the delivery (zero), it is not
    // left advertising artifacts the cold open cannot show.
    writeSessionArtifactSummarySidecar(sidecarPath, 2);
    await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      0,
    );
  });

  it('refreshes a stale sidecar to the projection delivery, counting the restorable set', async () => {
    // The daemon funnel refreshes an existing sidecar on open (review
    // round-6 deferred pin), and counts the restorable subset of the
    // delivery: a non-snapshot published file locator is delivered in the
    // snapshot but not restorable, so it must not inflate the count.
    const a = persistedArtifact('https://example.com/refresh-a');
    const b = persistedArtifact('https://example.com/refresh-b');
    const locator: PersistedSessionArtifact = {
      ...persistedArtifact('file:///tmp/legacy/refresh.pdf'),
      storage: 'published',
    };
    const sourceRecord: ChatRecord = {
      uuid: 'source-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.000Z',
      type: 'system',
      subtype: 'session_source',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        sourceType: 'web_shell',
      } as unknown as ChatRecord['systemPayload'],
    };
    const modelRecord: ChatRecord = {
      uuid: 'model-1',
      parentUuid: 'source-1',
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.500Z',
      type: 'system',
      subtype: 'session_model',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        modelId: 'fake-model',
        authType: 'openai',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([
      sourceRecord,
      modelRecord,
      { ...artifactEventRecord([a, b, locator]), parentUuid: 'model-1' },
    ]);
    writeSessionArtifactSummarySidecar(sidecarPath, 5);

    const projection = await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });

    expect(projection?.runtime.artifactSnapshot?.artifacts.length).toBe(3);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  it('skips the load seed above the transcript size cap for a conversation-less transcript', async () => {
    const a = persistedArtifact('https://example.com/cap-load-over');
    writeTranscriptOfSize(MAX_TRANSCRIPT_READ_BYTES + 1, [
      { ...artifactEventRecord([a]), parentUuid: null },
    ]);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
  });

  it('seeds through loadSession at exactly the transcript size cap', async () => {
    const a = persistedArtifact('https://example.com/cap-load-at');
    writeTranscriptOfSize(MAX_TRANSCRIPT_READ_BYTES, [
      { ...artifactEventRecord([a]), parentUuid: null },
    ]);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('keeps the conversation load seed uncapped above the transcript size cap', async () => {
    // The cap governs the conversation-less auxiliary seed only; a
    // conversation transcript's read is the load itself, and the restore
    // payload's embedded snapshot must not depend on the sidecar cap.
    const a = persistedArtifact('https://example.com/cap-conversation');
    const bigUser: ChatRecord = {
      ...userRecord(),
      message: {
        role: 'user',
        parts: [{ text: 'x'.repeat(MAX_TRANSCRIPT_READ_BYTES) }],
      },
    };
    writeTranscript([bigUser, artifactEventRecord([a])]);

    const loaded = await service.loadSession(SESSION_ID);

    expect(loaded?.artifactSnapshot?.artifacts).toHaveLength(1);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('skips the load seed when the size probe fails', async () => {
    // Metadata-bearing shape so the load funnel enters the helper (a pure
    // artifact-only transcript is refused by the empty-message gate and
    // would mask the size-probe skip). The projection funnel no longer
    // stats or reads — it counts its own delivery.
    const originalStat = fs.promises.stat.bind(fs.promises);
    // Fail only the helper's size probe (the first transcript stat); the
    // load's later mtime stat must still succeed, so the stub delegates
    // after the first call.
    let transcriptStatCalls = 0;
    const statSpy = vi
      .spyOn(fs.promises, 'stat')
      .mockImplementation(async (filePath, ...rest) => {
        if (filePath === transcriptPath) {
          transcriptStatCalls += 1;
          if (transcriptStatCalls === 1) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
        }
        return originalStat(filePath, ...rest);
      });
    const a = persistedArtifact('https://example.com/stat-fail');
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
        title: 'Stat fail',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([title, { ...artifactEventRecord([a]), parentUuid: null }]);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
    statSpy.mockRestore();
  });

  it('recounts restorable survivors on a session_model-bearing transcript', async () => {
    // The shared shape gate also governs the library mutation guard: a
    // creation-metadata-bearing conversation-less transcript is a legal
    // removal target, not session_transcript_corrupt.
    const a = persistedArtifact('https://example.com/model-lib-a');
    const b = persistedArtifact('https://example.com/model-lib-b');
    const sourceRecord: ChatRecord = {
      uuid: 'source-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.000Z',
      type: 'system',
      subtype: 'session_source',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        sourceType: 'web_shell',
      } as unknown as ChatRecord['systemPayload'],
    };
    const modelRecord: ChatRecord = {
      uuid: 'model-1',
      parentUuid: 'source-1',
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.500Z',
      type: 'system',
      subtype: 'session_model',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        modelId: 'fake-model',
        authType: 'openai',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([
      sourceRecord,
      modelRecord,
      { ...artifactEventRecord([a, b]), parentUuid: null },
    ]);
    writeSessionArtifactSummarySidecar(sidecarPath, 2);

    const removed = await service.removeSessionArtifactsForLibrary(
      SESSION_ID,
      [a.id],
      {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      },
    );

    expect(removed).toEqual([a.id]);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('accepts a generated_ui_state-only journal as a legal removal target', async () => {
    // The property gate widened the library guard's accepted shape: a
    // transcript whose only non-artifact records are non-conversation
    // system subtypes reconstructs no message, and the guard must treat
    // it as side-records-only, not corrupt (review round-5 deferred pin).
    const a = persistedArtifact('https://example.com/uistate-lib-a');
    const b = persistedArtifact('https://example.com/uistate-lib-b');
    const uiState: ChatRecord = {
      uuid: 'ui-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.000Z',
      type: 'system',
      subtype: 'generated_ui_state',
      cwd: root,
      version: '1.0.0',
      systemPayload: {} as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([
      uiState,
      { ...artifactEventRecord([a, b]), parentUuid: null },
    ]);
    writeSessionArtifactSummarySidecar(sidecarPath, 2);

    const removed = await service.removeSessionArtifactsForLibrary(
      SESSION_ID,
      [a.id],
      {
        assertStorageUnchanged: async () => {},
        assertCanMutate: () => {},
      },
    );

    expect(removed).toEqual([a.id]);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('does not heal a correct sidecar from a conversation-less transcript with an unvalidatable record', async () => {
    // readAllRecords returns raw, unvalidated records: a record with an
    // unknown type is dropped only later by the validator, so the raw
    // array is not all-system even though the transcript has no
    // conversation. The load funnel must still route it through the
    // helper's shape gate (refuse) — the uncapped seed would rebuild from
    // an empty active set and heal the correct count to zero, while the
    // projection funnel refuses (review round-4 R4-1).
    const a = persistedArtifact('https://example.com/unvalid-a');
    const b = persistedArtifact('https://example.com/unvalid-b');
    const c = persistedArtifact('https://example.com/unvalid-c');
    const unknownType = {
      uuid: 'bad-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:02.000Z',
      type: 'brand_new_record_type',
      cwd: root,
      version: '1.0.0',
    } as unknown as ChatRecord;
    writeTranscript([
      { ...artifactEventRecord([a, b, c]), parentUuid: null },
      unknownType,
    ]);
    writeSessionArtifactSummarySidecar(sidecarPath, 3);

    await service.loadSession(SESSION_ID);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      3,
    );

    await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      3,
    );
  });

  it('does not heal a correct sidecar when the unvalidatable record has an invalid identity', async () => {
    // Same R4-1 branch with the other validator drop: a non-string uuid.
    const a = persistedArtifact('https://example.com/baduuid-a');
    const invalidIdentity = {
      uuid: 42,
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:02.000Z',
      type: 'user',
      cwd: root,
      version: '1.0.0',
      message: { role: 'user', parts: [{ text: 'x' }] },
    } as unknown as ChatRecord;
    writeTranscript([
      { ...artifactEventRecord([a]), parentUuid: null },
      invalidIdentity,
    ]);
    writeSessionArtifactSummarySidecar(sidecarPath, 1);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      1,
    );
  });

  it('does not heal a correct sidecar when metadata reconstructs a message beside an unvalidatable record', async () => {
    // custom_title/session_source/session_model reconstruct messages, so
    // messages.length is not "has a conversation": with a validator-dropped
    // record alongside, the raw array is not all-system either. Dispatch
    // must key on a real conversation turn; otherwise the uncapped branch
    // rebuilds from an active set that selects nothing and heals 2 to 0
    // (review round-5 R4-1 reopened). The load funnel's shape-gate refusal
    // keeps the last known good count.
    const a = persistedArtifact('https://example.com/title-unvalid-a');
    const b = persistedArtifact('https://example.com/title-unvalid-b');
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
        title: 'Pre-prompt',
      } as unknown as ChatRecord['systemPayload'],
    };
    const unknownType = {
      uuid: 'bad-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:02.000Z',
      type: 'brand_new_record_type',
      cwd: root,
      version: '1.0.0',
    } as unknown as ChatRecord;
    writeTranscript([
      title,
      { ...artifactEventRecord([a, b]), parentUuid: null },
      unknownType,
    ]);
    writeSessionArtifactSummarySidecar(sidecarPath, 2);

    await service.loadSession(SESSION_ID);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );

    // The projection funnel counts its own delivery: the dropped record
    // leaves the event outside the active segment, nothing is delivered,
    // and the stale count heals to zero (round-6 semantics) — while the
    // load funnel's refusal keeps the last known good count.
    await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      0,
    );
  });

  it('refuses the projection seed for an empty transcript with an existing sidecar', async () => {
    // Funnel-level pin: an empty transcript builds no projection, so the
    // defined-projection gate skips the seed and leaves the existing count
    // alone (review round-4 R4-4; the helper's empty-records guard is
    // defense-in-depth for the load funnel).
    writeFileSync(transcriptPath, '', 'utf8');
    writeSessionArtifactSummarySidecar(sidecarPath, 3);

    await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      3,
    );
  });

  it('refuses the projection seed for a foreign-project transcript', async () => {
    // Funnel-level pin: the reader's first-record ownership validation
    // yields no projection for a foreign transcript, so the gate skips the
    // seed (review round-4 R4-4; the helper's ownership guard is
    // defense-in-depth for the load funnel).
    const a = persistedArtifact('https://example.com/foreign-a');
    const foreign = {
      ...artifactEventRecord([a]),
      parentUuid: null,
      cwd: path.join(tmpdir(), 'foreign-project-root'),
    };
    writeTranscript([foreign]);

    await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });

    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
  });

  it('counts the projection delivery when the journal tail is truncated', async () => {
    // The projection funnel counts what its selective read delivers; a
    // truncated last line drops out of the index, and the sidecar heals
    // to the delivered set rather than keeping a stale count.
    const a = persistedArtifact('https://example.com/partial-a');
    const b = persistedArtifact('https://example.com/partial-b');
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
        title: 'Partial',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeFileSync(
      transcriptPath,
      `${JSON.stringify(title)}\n` +
        `${JSON.stringify({ ...artifactEventRecord([a, b]), parentUuid: 'title-1' })}\n` +
        '{"uuid":"trunc","type":"sys',
      'utf8',
    );
    writeSessionArtifactSummarySidecar(sidecarPath, 5);

    const projection = await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });

    expect(projection?.runtime.artifactSnapshot?.artifacts.length).toBe(2);
    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      2,
    );
  });

  it('refuses the load seed from a partial transcript read', async () => {
    // The load funnel threads onIncompleteRead into sourceReadComplete; a
    // truncated last line makes the read non-authoritative, so the seed
    // must refuse and leave the existing sidecar alone (review round-4
    // R4-5, re-anchored to the load funnel after round 6).
    const a = persistedArtifact('https://example.com/partial-load-a');
    const b = persistedArtifact('https://example.com/partial-load-b');
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
        title: 'Partial load',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeFileSync(
      transcriptPath,
      `${JSON.stringify(title)}\n` +
        `${JSON.stringify({ ...artifactEventRecord([a, b]), parentUuid: 'title-1' })}\n` +
        '{"uuid":"trunc","type":"sys',
      'utf8',
    );
    writeSessionArtifactSummarySidecar(sidecarPath, 5);

    await service.loadSession(SESSION_ID);

    expect(readSessionArtifactSummarySidecar(sidecarPath)?.artifactCount).toBe(
      5,
    );
  });

  it('never pays an auxiliary read in the projection funnel', async () => {
    // The projection funnel counts the artifactSnapshot its own selective
    // read already delivers — no full parse on either branch (review
    // round-6 R6-1: count and delivery share one source). A conversation
    // projection is skipped entirely; a side-records projection is counted
    // from its delivery (here the null-parented event is outside the
    // active segment, so nothing is delivered and no sidecar is written).
    const readSpy = vi.spyOn(
      service as unknown as {
        readAllRecords: (
          filePath: string,
          onIncompleteRead?: () => void,
        ) => Promise<ChatRecord[]>;
      },
      'readAllRecords',
    );
    const a = persistedArtifact('https://example.com/spy-a');

    writeTranscript([userRecord(), artifactEventRecord([a])]);
    readSpy.mockClear();
    await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });
    expect(readSpy).not.toHaveBeenCalled();
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();

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
    readSpy.mockClear();
    const projection = await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });
    expect(projection).toBeDefined();
    expect(projection?.runtime.apiHistory.length).toBe(0);
    expect(readSpy).not.toHaveBeenCalled();
    expect(projection?.runtime.artifactSnapshot).toBeUndefined();
    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
    readSpy.mockRestore();
  });

  it('does not seed through the projection for a session with a conversation', async () => {
    // Sessions with a conversation keep the selective read's zero-extra-I/O
    // contract; their count arrives via the loadSession funnel and the
    // recorder, not the projection read.
    const a = persistedArtifact('https://example.com/projection-normal');
    writeTranscript([userRecord(), artifactEventRecord([a])]);

    await service.readRestoreProjection(SESSION_ID, {
      replay: { kind: 'none' },
    });

    expect(readSessionArtifactSummarySidecar(sidecarPath)).toBeUndefined();
  });

  it('seeds the archived sidecar for a metadata-bearing side-records archived session', async () => {
    // The archived funnel shares the dispatch: a creation-time record
    // reconstructs a message, so the capped helper seeds the archived
    // sidecar even though there is no conversation to load. (A pure
    // artifact-only transcript reconstructs nothing and is not seeded —
    // see the R5-1 case.)
    const a = persistedArtifact('https://example.com/archived-side-only');
    const source: ChatRecord = {
      uuid: 'source-1',
      parentUuid: null,
      sessionId: SESSION_ID,
      timestamp: '2026-11-17T00:00:00.000Z',
      type: 'system',
      subtype: 'session_source',
      cwd: root,
      version: '1.0.0',
      systemPayload: {
        sourceType: 'web_shell',
      } as unknown as ChatRecord['systemPayload'],
    };
    writeTranscript([
      source,
      { ...artifactEventRecord([a]), parentUuid: null },
    ]);
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
