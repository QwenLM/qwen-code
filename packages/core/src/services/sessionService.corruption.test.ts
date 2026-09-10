/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for SessionService corruption-recovery paths.
 *
 * Lives in its own file (no module-level `vi.mock`) because both
 * `countSessionMessagesFromPath` and `readLastRecordUuid` walk real bytes
 * from disk via `fs.createReadStream` / `fs.readSync`, and need the real
 * `jsonl.parseLineTolerant` to exercise the `}{`-glued recovery path
 * introduced for #3606. The unit-test file (sessionService.test.ts) mocks
 * jsonl-utils wholesale, so corruption shapes can't be exercised there.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SessionService, SessionStorageEntryError } from './sessionService.js';
import { SessionTranscriptIdentityUnavailableError } from './session-writer-lease.js';
import type { ChatRecord } from './chatRecordingService.js';
import type { HistoryGap } from '../utils/conversation-chain.js';
import { readSessionPrs, writeSessionPrs } from './session-pr-service.js';
import { expectWithinLatencyBudget } from '../test-utils/latency-budget.js';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-svc-corruption-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function recordFor(
  uuid: string,
  type: 'user' | 'assistant',
  parentUuid: string | null,
): ChatRecord {
  return {
    uuid,
    parentUuid,
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: '2024-01-01T00:00:00Z',
    type,
    message: {
      role: type === 'user' ? 'user' : 'model',
      parts: [{ text: 'x' }],
    },
    cwd: '/tmp/x',
    version: '1.0.0',
    gitBranch: 'main',
  };
}

function writeJsonl(name: string, content: string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function createCreationMetadataHarness() {
  const runtimeBaseDir = fs.mkdtempSync(path.join(tmpRoot, 'metadata-'));
  const cwd = path.join(runtimeBaseDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const service = new SessionService(cwd, { runtimeBaseDir });
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  type Privates = {
    getSessionFilePath: (id: string, state: 'active' | 'archived') => string;
  };
  const filePath = (service as unknown as Privates).getSessionFilePath(
    sessionId,
    'active',
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const baseRecord = {
    uuid: 'u1',
    parentUuid: null,
    sessionId,
    timestamp: '2026-08-17T00:00:00.000Z',
    cwd,
    version: 'test',
  };
  const user = {
    ...baseRecord,
    type: 'user',
    message: { role: 'user', parts: [{ text: 'hello' }] },
  };

  return { service, sessionId, filePath, baseRecord, user };
}

describe('SessionService.readCreationMetadataIfReadable', () => {
  it('distinguishes clean legacy metadata from an unreadable transcript head', async () => {
    const { service, filePath, user } = createCreationMetadataHarness();
    fs.writeFileSync(filePath, `${JSON.stringify(user)}\n`, 'utf8');

    await expect(
      service.readCreationMetadataIfReadable(user.sessionId, 'active'),
    ).resolves.toEqual({});

    fs.writeFileSync(
      filePath,
      `${JSON.stringify(user)}\n{"type":"system","subtype":"session_source","systemPayload":{"sourceType":"default","sourceId":"realtime_voice:call-1"}\n`,
      'utf8',
    );

    await expect(
      service.readCreationMetadataIfReadable(user.sessionId, 'active'),
    ).resolves.toBeUndefined();
    await expect(service.readCreationMetadata(user.sessionId)).resolves.toEqual(
      {},
    );
  });

  it('accepts fully recovered glued creation records', async () => {
    const { service, sessionId, filePath, baseRecord, user } =
      createCreationMetadataHarness();
    const source = {
      ...baseRecord,
      uuid: 'u2',
      parentUuid: 'u1',
      type: 'system',
      subtype: 'session_source',
      systemPayload: {
        sourceType: 'default',
        sourceId: 'realtime_voice:call-1',
      },
    };
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(user)}${JSON.stringify(source)}\n`,
      'utf8',
    );

    await expect(
      service.readCreationMetadataIfReadable(sessionId, 'active'),
    ).resolves.toEqual({
      sourceType: 'default',
      sourceId: 'realtime_voice:call-1',
    });
  });
});

describe('SessionService.countSessionMessagesFromPath (corruption recovery)', () => {
  // The method is private; cast is the cheapest way to test the unit
  // without exposing it on the public surface. The public
  // `countSessionMessages(sessionId)` enforces the SESSION_FILE_PATTERN
  // and project-scoping check before delegating here, neither of which
  // is what these corruption-recovery tests are about.
  type Privates = {
    countSessionMessagesFromPath: (filePath: string) => Promise<number>;
  };
  let svc: Privates;

  beforeEach(() => {
    svc = new SessionService('/tmp/x') as unknown as Privates;
  });

  it('counts both records of a `}{`-glued physical line', async () => {
    // The exact #3606 corruption shape: two well-formed objects glued onto
    // one line because the writer was interrupted between `JSON.stringify`
    // and the trailing `\n`.
    const r1 = JSON.stringify(recordFor('u1', 'user', null));
    const r2 = JSON.stringify(recordFor('u2', 'assistant', 'u1'));
    const r3 = JSON.stringify(recordFor('u3', 'user', 'u2'));
    const file = writeJsonl('glued.jsonl', `${r1}${r2}\n${r3}\n`);

    expect(await svc.countSessionMessagesFromPath(file)).toBe(3);
  });

  it('does not zero out the count when a line is valid JSON but not an object', async () => {
    // Old `JSON.parse + catch { continue }` would skip a bare `null` line
    // because `null.type` threw. After the parseLineTolerant refactor, a
    // missing object-filter would propagate that TypeError to the outer
    // catch and zero the whole count — regression guard.
    const r1 = JSON.stringify(recordFor('u1', 'user', null));
    const r2 = JSON.stringify(recordFor('u2', 'assistant', 'u1'));
    const file = writeJsonl('scalar-line.jsonl', `${r1}\nnull\n${r2}\n`);

    expect(await svc.countSessionMessagesFromPath(file)).toBe(2);
  });

  it('deduplicates uuids across recovered fragments', async () => {
    // Same uuid appearing twice (e.g. record was re-emitted during recovery)
    // must still count as one logical message.
    const r1 = JSON.stringify(recordFor('u1', 'user', null));
    const file = writeJsonl('dup.jsonl', `${r1}${r1}\n`);

    expect(await svc.countSessionMessagesFromPath(file)).toBe(1);
  });

  it('returns 0 for a missing file', async () => {
    expect(
      await svc.countSessionMessagesFromPath(path.join(tmpRoot, 'nope.jsonl')),
    ).toBe(0);
  });
});

describe('SessionService.readLastRecordUuid (corruption recovery)', () => {
  type Privates = {
    readLastRecordUuid: (filePath: string) => string | null;
  };
  let svc: Privates;

  beforeEach(() => {
    svc = new SessionService('/tmp/x') as unknown as Privates;
  });

  it('returns the latest record uuid from a `}{`-glued tail line', () => {
    // Critical case: renameSession passes this uuid as the parentUuid of the
    // synthetic title record. If the tail line is glued and we silently drop
    // it (old behaviour), parentUuid points at an earlier record and
    // reconstructHistory truncates the chain on resume.
    const r1 = JSON.stringify(recordFor('u1', 'user', null));
    const r2 = JSON.stringify(recordFor('u2', 'assistant', 'u1'));
    const file = writeJsonl('glued-tail.jsonl', `${r1}${r2}\n`);

    expect(svc.readLastRecordUuid(file)).toBe('u2');
  });

  it('walks past a malformed tail line and returns the previous valid uuid', () => {
    const r1 = JSON.stringify(recordFor('u1', 'user', null));
    const file = writeJsonl('garbage-tail.jsonl', `${r1}\nnot-json-at-all\n`);

    expect(svc.readLastRecordUuid(file)).toBe('u1');
  });

  it('returns null for a file with no recoverable records', () => {
    const file = writeJsonl('no-records.jsonl', 'not-json\nstill-not-json\n');
    expect(svc.readLastRecordUuid(file)).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(svc.readLastRecordUuid(path.join(tmpRoot, 'nope.jsonl'))).toBeNull();
  });

  it('does not extract a uuid from a payload object inside a partial-tail fragment', () => {
    // When the last record exceeds TAIL_READ_SIZE (64 KiB), the tail buffer
    // starts mid-record. Without the boundary guard, _recoverObjectsFromLine
    // walks the partial fragment with depth starting at 0, finds a balanced
    // inner `{ "uuid": "fake" }` object inside the record's payload, and
    // surfaces "fake" as if it were the last top-level uuid. renameSession
    // would then anchor custom_title.parentUuid at payload data and
    // reconstructHistory would truncate the chain on resume.
    //
    // Filler is a long array of zeros (no quote characters) so the parser's
    // inString state stays aligned even when entering mid-fragment, ensuring
    // the trojan is reachable. ~80k entries → ~160 KB, comfortably above
    // TAIL_READ_SIZE.
    const filler = new Array(80000).fill(0).join(',');
    const giantLine =
      `{"uuid":"real-last","filler":[${filler}],` +
      `"trojan":{"uuid":"fake-from-payload"}}`;
    const file = writeJsonl('big-tail.jsonl', `${giantLine}\n`);

    // We cannot recover "real-last" — it lies before the tail window. The
    // critical assertion is the absence of the false-positive recovery: the
    // function must not surface the payload's nested uuid.
    expect(svc.readLastRecordUuid(file)).not.toBe('fake-from-payload');
  });

  it('returns the final complete record uuid when a giant partial precedes it in the tail', () => {
    // Positive twin of the partial-tail test above: after a giant line
    // whose head is past the tail window, append one normal complete
    // record. The partial first segment must be discarded, but the
    // complete record after the in-window `\n` must be recovered. Pins
    // the desired behaviour — the bare-negative assertion above would
    // still pass if the function silently skipped every line in the
    // window and returned `null`.
    const filler = new Array(80000).fill(0).join(',');
    const giantLine =
      `{"uuid":"too-early-to-see","filler":[${filler}],` +
      `"trojan":{"uuid":"fake-from-payload"}}`;
    const finalRecord = JSON.stringify(recordFor('actual-last', 'user', null));
    const file = writeJsonl(
      'big-tail-then-final.jsonl',
      `${giantLine}\n${finalRecord}\n`,
    );

    expect(svc.readLastRecordUuid(file)).toBe('actual-last');
  });

  it('returns the only record when the tail window starts exactly on a newline boundary', () => {
    // Boundary case: file is `prev\n<final>\n` where `final\n` is
    // exactly TAIL_READ_SIZE bytes, so the tail read covers `final\n`
    // and `readStart - 1` lands on the separating `\n`. The first
    // split segment is a complete record — not a partial fragment.
    // An unconditional `lines.shift()` drops the only readable uuid
    // and `renameSession` writes `custom_title.parentUuid` as `null`,
    // truncating history on resume. The fix peeks the byte before
    // `readStart` to distinguish boundary-aligned from mid-line reads.
    const TAIL_READ_SIZE = 64 * 1024;
    // Build `final` so that `final + '\n'` is exactly TAIL_READ_SIZE.
    // `recordFor` produces a stable JSON shape; pad it via an extra
    // `filler` field tuned so the stringified record + 1 (for the
    // trailing newline we'll join with) hits the target length.
    const baseFinal = recordFor('boundary-final', 'user', null);
    const baseFinalLen = Buffer.byteLength(JSON.stringify(baseFinal), 'utf8');
    // The added field looks like `,"filler":"x...x"` — fixed overhead
    // (everything except the x-run) is 12 bytes: ` , " f i l l e r " : " " ` .
    const fillerLen = TAIL_READ_SIZE - 1 - baseFinalLen - 12;
    expect(fillerLen).toBeGreaterThan(0);
    const finalRecord = JSON.stringify({
      ...baseFinal,
      filler: 'x'.repeat(fillerLen),
    });
    expect(Buffer.byteLength(finalRecord + '\n', 'utf8')).toBe(TAIL_READ_SIZE);

    const prevRecord = JSON.stringify(recordFor('older', 'user', null));
    const file = writeJsonl(
      'tail-aligned.jsonl',
      `${prevRecord}\n${finalRecord}\n`,
    );

    expect(svc.readLastRecordUuid(file)).toBe('boundary-final');
  });
});

describe('SessionService lifecycle maintenance', () => {
  type Privates = {
    getSessionFilePath: (id: string, state: 'active' | 'archived') => string;
    getPrSessionPathForState: (
      id: string,
      state: 'active' | 'archived',
    ) => string;
    getPromptLedgerPathForState: (
      id: string,
      state: 'active' | 'archived',
    ) => string;
    getWorktreeSessionPathForState: (
      id: string,
      state: 'active' | 'archived',
    ) => string;
    sessionBelongsToCurrentProject: (
      sessionId: string,
      cwd: string,
    ) => Promise<boolean>;
  };

  function createHarness(content: string, state: 'active' | 'archived') {
    const runtimeBaseDir = fs.mkdtempSync(path.join(tmpRoot, 'lifecycle-'));
    const cwd = path.join(runtimeBaseDir, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const service = new SessionService(cwd, { runtimeBaseDir });
    const sessionId = randomUUID();
    const paths = {
      active: (service as unknown as Privates).getSessionFilePath(
        sessionId,
        'active',
      ),
      archived: (service as unknown as Privates).getSessionFilePath(
        sessionId,
        'archived',
      ),
    };
    fs.mkdirSync(path.dirname(paths[state]), { recursive: true });
    fs.writeFileSync(paths[state], content);
    return { service, sessionId, paths, content, cwd };
  }

  const unreadableShapes = [
    { name: 'empty', content: '' },
    { name: 'damaged', content: '{"uuid":"torn-head"' },
  ];

  for (const shape of unreadableShapes) {
    it(`deletes an owned ${shape.name} transcript`, async () => {
      const { service, sessionId, paths } = createHarness(
        shape.content,
        'active',
      );

      await expect(service.removeSession(sessionId)).resolves.toBe(true);
      expect(fs.existsSync(paths.active)).toBe(false);
    });

    it(`archives an owned ${shape.name} transcript without rewriting it`, async () => {
      const { service, sessionId, paths, content } = createHarness(
        shape.content,
        'active',
      );

      const result = await service.archiveSessions([sessionId]);

      expect(result).toMatchObject({
        archived: [sessionId],
        notFound: [],
        errors: [],
      });
      expect(fs.existsSync(paths.active)).toBe(false);
      expect(fs.readFileSync(paths.archived, 'utf8')).toBe(content);
    });

    it(`unarchives an owned ${shape.name} transcript without rewriting it`, async () => {
      const { service, sessionId, paths, content } = createHarness(
        shape.content,
        'archived',
      );

      const result = await service.unarchiveSessions([sessionId]);

      expect(result).toMatchObject({
        unarchived: [sessionId],
        notFound: [],
        errors: [],
      });
      expect(fs.existsSync(paths.archived)).toBe(false);
      expect(fs.readFileSync(paths.active, 'utf8')).toBe(content);
    });
  }

  it('maintains an owned legacy child whose parent no longer exists', async () => {
    const orphanContent = (sessionId: string, cwd: string) =>
      `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd,
      })}\n${JSON.stringify({
        ...recordFor('u2', 'assistant', 'u1'),
        sessionId,
        cwd,
        type: 'system',
        subtype: 'parent_session',
        systemPayload: { parentSessionId: randomUUID() },
      })}\n`;

    const removal = createHarness('', 'active');
    fs.writeFileSync(
      removal.paths.active,
      orphanContent(removal.sessionId, removal.cwd),
    );
    await expect(
      removal.service.removeSession(removal.sessionId),
    ).resolves.toBe(true);

    const archive = createHarness('', 'active');
    fs.writeFileSync(
      archive.paths.active,
      orphanContent(archive.sessionId, archive.cwd),
    );
    await expect(
      archive.service.archiveSessions([archive.sessionId]),
    ).resolves.toMatchObject({ archived: [archive.sessionId], errors: [] });

    const unarchive = createHarness('', 'archived');
    fs.writeFileSync(
      unarchive.paths.archived,
      orphanContent(unarchive.sessionId, unarchive.cwd),
    );
    await expect(
      unarchive.service.unarchiveSessions([unarchive.sessionId]),
    ).resolves.toMatchObject({
      unarchived: [unarchive.sessionId],
      errors: [],
    });
  });

  it('preserves default archive conflicts and explicitly keeps the archived copy', async () => {
    const { service, sessionId, paths } = createHarness('active', 'active');
    fs.mkdirSync(path.dirname(paths.archived), { recursive: true });
    fs.writeFileSync(paths.archived, 'archived');

    const defaultResult = await service.archiveSessions([sessionId]);
    expect(defaultResult.errors).toHaveLength(1);
    expect(fs.readFileSync(paths.active, 'utf8')).toBe('active');
    expect(fs.readFileSync(paths.archived, 'utf8')).toBe('archived');

    const repaired = await service.archiveSessions([sessionId], {
      resolveConflicts: true,
    });
    expect(repaired).toMatchObject({
      archived: [sessionId],
      resolvedConflicts: [sessionId],
      errors: [],
    });
    expect(fs.existsSync(paths.active)).toBe(false);
    expect(fs.readFileSync(paths.archived, 'utf8')).toBe('archived');
  });

  it.each(['archive', 'unarchive'] as const)(
    'merges pr bindings into the retained copy during %s conflict repair',
    async (action) => {
      const { service, sessionId, paths, cwd } = createHarness('', 'active');
      const activeContent = `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd,
      })}\n`;
      const archivedContent = `${JSON.stringify({
        ...recordFor('u2', 'user', null),
        sessionId,
        cwd,
      })}\n`;
      fs.writeFileSync(paths.active, activeContent);
      fs.mkdirSync(path.dirname(paths.archived), { recursive: true });
      fs.writeFileSync(paths.archived, archivedContent);
      const internals = service as unknown as Privates;
      const activePr = internals.getPrSessionPathForState(sessionId, 'active');
      const archivedPr = internals.getPrSessionPathForState(
        sessionId,
        'archived',
      );
      const activeEntry = {
        number: 1,
        url: 'https://github.com/o/r/pull/1',
        createdAt: '2026-08-20T00:00:00.000Z',
      };
      const archivedEntry = {
        number: 2,
        url: 'https://github.com/o/r/pull/2',
        createdAt: '2026-08-20T01:00:00.000Z',
      };
      await writeSessionPrs(activePr, [activeEntry]);
      await writeSessionPrs(archivedPr, [archivedEntry]);

      const result = await service[`${action}Sessions`]([sessionId], {
        resolveConflicts: true,
      });

      expect(result.errors).toEqual([]);
      const retainedPr = action === 'archive' ? archivedPr : activePr;
      const losingPr = action === 'archive' ? activePr : archivedPr;
      await expect(readSessionPrs(retainedPr)).resolves.toEqual([
        activeEntry,
        archivedEntry,
      ]);
      expect(fs.existsSync(losingPr)).toBe(false);
    },
  );

  it('preserves default unarchive conflicts and explicitly keeps the active copy', async () => {
    const { service, sessionId, paths } = createHarness('active', 'active');
    fs.mkdirSync(path.dirname(paths.archived), { recursive: true });
    fs.writeFileSync(paths.archived, 'archived');

    const defaultResult = await service.unarchiveSessions([sessionId]);
    expect(defaultResult.errors).toHaveLength(1);
    expect(fs.readFileSync(paths.active, 'utf8')).toBe('active');
    expect(fs.readFileSync(paths.archived, 'utf8')).toBe('archived');

    const repaired = await service.unarchiveSessions([sessionId], {
      resolveConflicts: true,
    });
    expect(repaired).toMatchObject({
      unarchived: [sessionId],
      resolvedConflicts: [sessionId],
      errors: [],
    });
    expect(fs.readFileSync(paths.active, 'utf8')).toBe('active');
    expect(fs.existsSync(paths.archived)).toBe(false);
  });

  it('does not overwrite a damaged archived copy when the active copy is readable', async () => {
    const { service, sessionId, paths, cwd } = createHarness('', 'active');
    fs.writeFileSync(
      paths.active,
      `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd,
      })}\n`,
    );
    fs.mkdirSync(path.dirname(paths.archived), { recursive: true });
    fs.writeFileSync(paths.archived, '{"uuid":"torn-archived"');

    const result = await service.archiveSessions([sessionId]);

    expect(result.errors).toHaveLength(1);
    expect(fs.existsSync(paths.active)).toBe(true);
    expect(fs.readFileSync(paths.archived, 'utf8')).toBe(
      '{"uuid":"torn-archived"',
    );
  });

  it('repairs an archive conflict when only the archived copy is readable', async () => {
    const { service, sessionId, paths, cwd } = createHarness(
      '{"uuid":"torn-active"',
      'active',
    );
    const archivedContent = `${JSON.stringify({
      ...recordFor('u1', 'user', null),
      sessionId,
      cwd,
    })}\n`;
    fs.mkdirSync(path.dirname(paths.archived), { recursive: true });
    fs.writeFileSync(paths.archived, archivedContent);

    const defaultResult = await service.archiveSessions([sessionId]);
    expect(defaultResult.errors).toHaveLength(1);

    const repaired = await service.archiveSessions([sessionId], {
      resolveConflicts: true,
    });
    expect(repaired).toMatchObject({
      archived: [sessionId],
      resolvedConflicts: [sessionId],
      errors: [],
    });
    expect(fs.existsSync(paths.active)).toBe(false);
    expect(fs.readFileSync(paths.archived, 'utf8')).toBe(archivedContent);
  });

  it('does not overwrite a damaged active copy when the archived copy is readable', async () => {
    const { service, sessionId, paths, cwd } = createHarness('', 'archived');
    fs.writeFileSync(paths.active, '{"uuid":"torn-active"');
    fs.writeFileSync(
      paths.archived,
      `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd,
      })}\n`,
    );

    const result = await service.unarchiveSessions([sessionId]);

    expect(result.errors).toHaveLength(1);
    expect(fs.readFileSync(paths.active, 'utf8')).toBe('{"uuid":"torn-active"');
    expect(fs.existsSync(paths.archived)).toBe(true);
  });

  it('repairs an unarchive conflict when only the active copy is readable', async () => {
    const { service, sessionId, paths, cwd } = createHarness('', 'active');
    const activeContent = `${JSON.stringify({
      ...recordFor('u1', 'user', null),
      sessionId,
      cwd,
    })}\n`;
    fs.writeFileSync(paths.active, activeContent);
    fs.mkdirSync(path.dirname(paths.archived), { recursive: true });
    fs.writeFileSync(paths.archived, '{"uuid":"torn-archived"');

    const defaultResult = await service.unarchiveSessions([sessionId]);
    expect(defaultResult.errors).toHaveLength(1);

    const repaired = await service.unarchiveSessions([sessionId], {
      resolveConflicts: true,
    });
    expect(repaired).toMatchObject({
      unarchived: [sessionId],
      resolvedConflicts: [sessionId],
      errors: [],
    });
    expect(fs.readFileSync(paths.active, 'utf8')).toBe(activeContent);
    expect(fs.existsSync(paths.archived)).toBe(false);
  });

  it.each(['archive', 'unarchive'] as const)(
    'reclassifies a conflict that appears during %s validation',
    async (action) => {
      const state = action === 'archive' ? 'active' : 'archived';
      const { service, sessionId, paths, cwd } = createHarness('', state);
      const sourcePath = paths[state];
      const sourceContent = `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd,
      })}\n`;
      const targetPath = action === 'archive' ? paths.archived : paths.active;
      const targetContent = 'late conflict';
      fs.writeFileSync(sourcePath, sourceContent);

      const internals = service as unknown as {
        resolveMaintainableSessionSnapshot: (id: string) => Promise<unknown>;
      };
      const resolveSnapshot =
        internals.resolveMaintainableSessionSnapshot.bind(service);
      vi.spyOn(
        internals,
        'resolveMaintainableSessionSnapshot',
      ).mockImplementationOnce(async (id) => {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, targetContent);
        return resolveSnapshot(id);
      });

      const result = await service[`${action}Sessions`]([sessionId]);

      expect(result.errors).toHaveLength(1);
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe(sourceContent);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(targetContent);
    },
  );

  it.each(['delete', 'unarchive'] as const)(
    'does not %s a readable archived transcript replaced after validation',
    async (action) => {
      const { service, sessionId, paths, cwd } = createHarness('', 'archived');
      fs.writeFileSync(
        paths.archived,
        `${JSON.stringify({
          ...recordFor('u1', 'user', null),
          sessionId,
          cwd,
        })}\n`,
      );
      const replacement = 'replacement';
      const assertStorageUnchanged = async () => {
        fs.renameSync(paths.archived, `${paths.archived}.original`);
        fs.writeFileSync(paths.archived, replacement);
      };

      if (action === 'delete') {
        await expect(
          service.removeSession(sessionId, { assertStorageUnchanged }),
        ).rejects.toThrow('changed outside its active writer');
      } else {
        const result = await service.unarchiveSessions([sessionId], {
          assertStorageUnchanged,
        });
        expect(result.errors[0]?.error.message).toContain(
          'changed outside its active writer',
        );
      }

      expect(fs.readFileSync(paths.archived, 'utf8')).toBe(replacement);
      expect(fs.existsSync(paths.active)).toBe(false);
    },
  );

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'does not %s a transcript that disappears and reappears during classification',
    async (action) => {
      const state = action === 'archive' ? 'active' : 'archived';
      const { service, sessionId, paths, cwd } = createHarness('', state);
      const sourcePath = paths[state];
      const originalContent = `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd,
      })}\n`;
      fs.writeFileSync(sourcePath, originalContent);
      const replacement = 'replacement';

      const internals = service as unknown as {
        resolveMaintainableSessionSnapshot: (id: string) => Promise<unknown>;
      };
      const resolveSnapshot =
        internals.resolveMaintainableSessionSnapshot.bind(service);
      vi.spyOn(
        internals,
        'resolveMaintainableSessionSnapshot',
      ).mockImplementationOnce(async (id) => {
        fs.renameSync(sourcePath, `${sourcePath}.original`);
        const snapshot = await resolveSnapshot(id);
        fs.writeFileSync(sourcePath, replacement);
        return snapshot;
      });

      if (action === 'delete') {
        await expect(service.removeSession(sessionId)).resolves.toBe(false);
      } else {
        const result = await service[`${action}Sessions`]([sessionId]);
        expect(result).toMatchObject({
          notFound: [sessionId],
          errors: [],
        });
      }

      expect(fs.readFileSync(sourcePath, 'utf8')).toBe(replacement);
      expect(fs.readFileSync(`${sourcePath}.original`, 'utf8')).toBe(
        originalContent,
      );
      expect(
        fs.existsSync(action === 'archive' ? paths.archived : paths.active),
      ).toBe(false);
    },
  );

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'does not %s a readable transcript whose record identifies another session',
    async (action) => {
      const state = action === 'unarchive' ? 'archived' : 'active';
      const { service, sessionId, paths, cwd } = createHarness('', state);
      const sourcePath = paths[state];
      const content = `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId: randomUUID(),
        cwd,
      })}\n`;
      fs.writeFileSync(sourcePath, content);

      if (action === 'delete') {
        await expect(service.removeSession(sessionId)).resolves.toBe(false);
      } else {
        await expect(
          service[`${action}Sessions`]([sessionId]),
        ).resolves.toMatchObject({
          notFound: [sessionId],
          errors: [],
        });
      }

      expect(fs.readFileSync(sourcePath, 'utf8')).toBe(content);
      expect(
        fs.existsSync(action === 'unarchive' ? paths.active : paths.archived),
      ).toBe(false);
    },
  );

  it.each([
    ['missing cwd', undefined],
    ['non-string cwd', 42],
  ] as const)('fails closed on a record with %s', async (_name, cwdValue) => {
    for (const action of ['delete', 'archive', 'unarchive'] as const) {
      const state = action === 'unarchive' ? 'archived' : 'active';
      const { service, sessionId, paths } = createHarness('', state);
      const sourcePath = paths[state];
      const record = {
        ...recordFor('u1', 'user', null),
        sessionId,
      } as Record<string, unknown>;
      if (cwdValue === undefined) {
        delete record['cwd'];
      } else {
        record['cwd'] = cwdValue;
      }
      fs.writeFileSync(sourcePath, `${JSON.stringify(record)}\n`);

      if (action === 'delete') {
        await expect(service.removeSession(sessionId)).rejects.toMatchObject({
          reason: 'unknown_project',
        });
      } else {
        const result = await service[`${action}Sessions`]([sessionId]);
        expect(result.errors[0]?.error).toMatchObject({
          reason: 'unknown_project',
        });
      }
      expect(fs.existsSync(sourcePath)).toBe(true);
      if (action !== 'delete') {
        expect(
          fs.existsSync(action === 'archive' ? paths.archived : paths.active),
        ).toBe(false);
      }
    }
  });

  it.each([
    ['missing session id', undefined],
    ['non-string session id', 42],
  ] as const)(
    'fails closed on a foreign record with %s',
    async (_name, sessionIdValue) => {
      const { service, sessionId, paths } = createHarness('', 'active');
      const foreignCwd = fs.mkdtempSync(path.join(tmpRoot, 'foreign-'));
      const record = {
        ...recordFor('u1', 'user', null),
        cwd: foreignCwd,
      } as Record<string, unknown>;
      if (sessionIdValue === undefined) {
        delete record['sessionId'];
      } else {
        record['sessionId'] = sessionIdValue;
      }
      const content = `${JSON.stringify(record)}\n`;
      fs.writeFileSync(paths.active, content);

      await expect(service.removeSession(sessionId)).rejects.toMatchObject({
        reason: 'unknown_project',
      });
      expect(fs.readFileSync(paths.active, 'utf8')).toBe(content);
    },
  );

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'fails closed on mixed foreign and local storage during %s',
    async (action) => {
      const { service, sessionId, paths, cwd } = createHarness('', 'active');
      const foreignCwd = fs.mkdtempSync(path.join(tmpRoot, 'foreign-'));
      const activeContent = `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd: foreignCwd,
      })}\n`;
      const archivedContent = `${JSON.stringify({
        ...recordFor('u2', 'user', null),
        sessionId,
        cwd,
      })}\n`;
      fs.writeFileSync(paths.active, activeContent);
      fs.mkdirSync(path.dirname(paths.archived), { recursive: true });
      fs.writeFileSync(paths.archived, archivedContent);

      if (action === 'delete') {
        await expect(service.removeSession(sessionId)).rejects.toMatchObject({
          reason: 'ambiguous_project',
        });
      } else {
        const result = await service[`${action}Sessions`]([sessionId]);
        expect(result.errors[0]?.error).toMatchObject({
          reason: 'ambiguous_project',
        });
      }
      expect(fs.readFileSync(paths.active, 'utf8')).toBe(activeContent);
      expect(fs.readFileSync(paths.archived, 'utf8')).toBe(archivedContent);
    },
  );

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'fails closed when %s sees another session id without cwd ownership',
    async (action) => {
      const state = action === 'unarchive' ? 'archived' : 'active';
      const { service, sessionId, paths } = createHarness('', state);
      const sourcePath = paths[state];
      const record = {
        ...recordFor('u1', 'user', null),
        sessionId: randomUUID(),
      } as Record<string, unknown>;
      delete record['cwd'];
      const content = `${JSON.stringify(record)}\n`;
      fs.writeFileSync(sourcePath, content);

      if (action === 'delete') {
        await expect(service.removeSession(sessionId)).rejects.toMatchObject({
          reason: 'unknown_project',
        });
      } else {
        const result = await service[`${action}Sessions`]([sessionId]);
        expect(result.errors[0]?.error).toMatchObject({
          reason: 'unknown_project',
        });
      }
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe(content);
    },
  );

  it('maintains an oversized first physical record without buffering the whole file', async () => {
    const { service, sessionId, paths } = createHarness('', 'active');
    const content = 'x'.repeat(1024 * 1024 + 1);
    fs.writeFileSync(paths.active, content);

    await expect(
      service.getMaintainableSessionLocation(sessionId),
    ).resolves.toBe('active');
    await expect(service.archiveSessions([sessionId])).resolves.toMatchObject({
      archived: [sessionId],
      errors: [],
    });
    expect(fs.existsSync(paths.active)).toBe(false);
    expect(fs.readFileSync(paths.archived, 'utf8')).toBe(content);
  });

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'does not %s a just-over-limit readable transcript from another workspace',
    async (action) => {
      const state = action === 'unarchive' ? 'archived' : 'active';
      const { service, sessionId, paths } = createHarness('', state);
      const sourcePath = paths[state];
      const foreignCwd = fs.mkdtempSync(path.join(tmpRoot, 'foreign-'));
      const content = `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd: foreignCwd,
        filler: 'x'.repeat(1024 * 1024),
      })}\n`;
      expect(Buffer.byteLength(content)).toBeGreaterThan(1024 * 1024);
      expect(Buffer.byteLength(content)).toBeLessThan(1024 * 1024 + 64 * 1024);
      fs.writeFileSync(sourcePath, content);

      if (action === 'delete') {
        await expect(service.removeSession(sessionId)).resolves.toBe(false);
      } else {
        await expect(
          service[`${action}Sessions`]([sessionId]),
        ).resolves.toMatchObject({ notFound: [sessionId], errors: [] });
      }
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe(content);
      expect(
        fs.existsSync(action === 'unarchive' ? paths.active : paths.archived),
      ).toBe(false);
    },
  );

  it('fails closed on a readable transcript whose first record exceeds the bounded read window', async () => {
    const { service, sessionId, paths } = createHarness('', 'active');
    const foreignCwd = fs.mkdtempSync(path.join(tmpRoot, 'foreign-'));
    const content = `${JSON.stringify({
      ...recordFor('u1', 'user', null),
      sessionId,
      cwd: foreignCwd,
      filler: 'x'.repeat(2 * 1024 * 1024),
    })}\n`;
    fs.writeFileSync(paths.active, content);

    await expect(
      service.getMaintainableSessionLocation(sessionId),
    ).rejects.toBeInstanceOf(SessionTranscriptIdentityUnavailableError);
    expect(fs.readFileSync(paths.active, 'utf8')).toBe(content);
  });

  it.each(['archive', 'unarchive'] as const)(
    'finishes the %s ledger move after the generation closes',
    async (action) => {
      const state = action === 'archive' ? 'active' : 'archived';
      const { service, sessionId, paths } = createHarness('transcript', state);
      const sourcePath = paths[state];
      const destinationPath =
        action === 'archive' ? paths.archived : paths.active;
      const sourceLedger = sourcePath.replace(/\.jsonl$/, '.ledger.jsonl');
      const destinationLedger = destinationPath.replace(
        /\.jsonl$/,
        '.ledger.jsonl',
      );
      fs.writeFileSync(sourceLedger, '{"promptId":"p1"}\n');
      const generationChanged = new Error('generation changed');
      const assertCanMutate = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementation(() => {
          throw generationChanged;
        });
      const assertCleanupOwned = vi.fn();

      const result = await service[`${action}Sessions`]([sessionId], {
        assertCanMutate,
        assertCleanupOwned,
      });

      expect(result.errors).toEqual([]);
      expect(assertCanMutate).toHaveBeenCalledOnce();
      expect(assertCleanupOwned).toHaveBeenCalled();
      expect(fs.existsSync(sourceLedger)).toBe(false);
      expect(fs.existsSync(destinationLedger)).toBe(true);
    },
  );

  it.each(['archive', 'unarchive'] as const)(
    'stops the %s ledger move after cleanup ownership is lost',
    async (action) => {
      const state = action === 'archive' ? 'active' : 'archived';
      const { service, sessionId, paths } = createHarness('transcript', state);
      const sourcePath = paths[state];
      const destinationPath =
        action === 'archive' ? paths.archived : paths.active;
      const sourceLedger = sourcePath.replace(/\.jsonl$/, '.ledger.jsonl');
      const destinationLedger = destinationPath.replace(
        /\.jsonl$/,
        '.ledger.jsonl',
      );
      fs.writeFileSync(sourceLedger, '{"promptId":"p1"}\n');
      const ownershipLost = new Error('writer ownership lost');

      const result = await service[`${action}Sessions`]([sessionId], {
        assertCanMutate: vi.fn(),
        assertCleanupOwned: () => {
          throw ownershipLost;
        },
      });

      expect(result.errors[0]?.error).toBe(ownershipLost);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(destinationPath)).toBe(true);
      expect(fs.existsSync(sourceLedger)).toBe(true);
      expect(fs.existsSync(destinationLedger)).toBe(false);
    },
  );

  it.each(['archive', 'unarchive'] as const)(
    'reconciles stranded %s sidecars on an exact retry',
    async (action) => {
      const sourceState = action === 'archive' ? 'active' : 'archived';
      const destinationState = action === 'archive' ? 'archived' : 'active';
      const { service, sessionId } = createHarness(
        action === 'archive' ? '' : '{"uuid":"torn-head"',
        sourceState,
      );
      const internals = service as unknown as Privates;
      const sourceWorktree = internals.getWorktreeSessionPathForState(
        sessionId,
        sourceState,
      );
      const destinationWorktree = internals.getWorktreeSessionPathForState(
        sessionId,
        destinationState,
      );
      const sourcePr = internals.getPrSessionPathForState(
        sessionId,
        sourceState,
      );
      const destinationPr = internals.getPrSessionPathForState(
        sessionId,
        destinationState,
      );
      const sourceLedger = internals.getPromptLedgerPathForState(
        sessionId,
        sourceState,
      );
      const destinationLedger = internals.getPromptLedgerPathForState(
        sessionId,
        destinationState,
      );
      fs.writeFileSync(sourceWorktree, '{}');
      const pr = {
        number: 123,
        url: 'https://github.com/QwenLM/qwen-code/pull/123',
        createdAt: '2026-08-28T00:00:00.000Z',
      };
      await writeSessionPrs(sourcePr, [pr]);
      fs.writeFileSync(sourceLedger, '{"promptId":"p1"}\n');
      const ownershipLost = new Error('writer ownership lost');

      const first = await service[`${action}Sessions`]([sessionId], {
        assertCleanupOwned: () => {
          throw ownershipLost;
        },
      });
      expect(first.errors[0]?.error).toBe(ownershipLost);

      const assertCanMutate = vi.fn();
      const assertCleanupOwned = vi.fn();
      const retry = await service[`${action}Sessions`]([sessionId], {
        assertCanMutate,
        assertCleanupOwned,
      });

      expect(retry).toMatchObject({
        [action === 'archive' ? 'alreadyArchived' : 'alreadyActive']: [
          sessionId,
        ],
        errors: [],
      });
      expect(fs.existsSync(sourceWorktree)).toBe(false);
      expect(fs.existsSync(destinationWorktree)).toBe(true);
      expect(fs.existsSync(sourcePr)).toBe(false);
      await expect(readSessionPrs(destinationPr)).resolves.toEqual([pr]);
      expect(fs.existsSync(sourceLedger)).toBe(false);
      expect(fs.readFileSync(destinationLedger, 'utf8')).toContain(
        '"promptId":"p1"',
      );
      expect(assertCanMutate).toHaveBeenCalled();
      expect(assertCleanupOwned).toHaveBeenCalled();
    },
  );

  it('rejects an in-place rewrite during ownership classification', async () => {
    const { service, sessionId, paths, cwd } = createHarness('', 'active');
    fs.writeFileSync(
      paths.active,
      `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd,
      })}\n`,
    );
    const inode = fs.statSync(paths.active).ino;
    vi.spyOn(
      service as unknown as Privates,
      'sessionBelongsToCurrentProject',
    ).mockImplementation(async () => {
      fs.writeFileSync(paths.active, 'replacement');
      return true;
    });

    await expect(
      service.getMaintainableSessionLocation(sessionId),
    ).rejects.toThrow('changed outside its active writer');
    expect(fs.statSync(paths.active).ino).toBe(inode);
    expect(fs.readFileSync(paths.active, 'utf8')).toBe('replacement');
  });

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'does not %s a readable transcript symlink',
    async (action) => {
      const state = action === 'unarchive' ? 'archived' : 'active';
      const { service, sessionId, paths, cwd } = createHarness('', state);
      const sourcePath = paths[state];
      const targetPath = `${sourcePath}.target`;
      const targetContent = `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd,
      })}\n`;
      fs.unlinkSync(sourcePath);
      fs.writeFileSync(targetPath, targetContent);
      fs.symlinkSync(targetPath, sourcePath);

      if (action === 'delete') {
        await expect(service.removeSession(sessionId)).rejects.toBeInstanceOf(
          SessionStorageEntryError,
        );
      } else {
        const result = await service[`${action}Sessions`]([sessionId]);
        expect(result.errors[0]?.error).toBeInstanceOf(
          SessionStorageEntryError,
        );
      }

      expect(fs.lstatSync(sourcePath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(targetPath, 'utf8')).toBe(targetContent);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a transcript FIFO without waiting for a writer',
    async () => {
      const { service, sessionId, paths } = createHarness('', 'active');
      fs.unlinkSync(paths.active);
      execFileSync('mkfifo', [paths.active]);
      let writer: number | undefined;
      const unblock = setTimeout(() => {
        writer = fs.openSync(
          paths.active,
          fs.constants.O_WRONLY | (fs.constants.O_NONBLOCK ?? 0),
        );
      }, 500);
      const startedAt = Date.now();

      try {
        await expect(
          service.getMaintainableSessionLocation(sessionId),
        ).rejects.toBeInstanceOf(SessionStorageEntryError);
        expectWithinLatencyBudget(Date.now() - startedAt, 400);
      } finally {
        clearTimeout(unblock);
        if (writer !== undefined) fs.closeSync(writer);
      }
    },
  );

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'does not %s a damaged transcript replaced after validation',
    async (action) => {
      const state = action === 'unarchive' ? 'archived' : 'active';
      const { service, sessionId, paths } = createHarness(
        '{"uuid":"torn-head"',
        state,
      );
      const sourcePath = paths[state];
      const replacement = 'replacement';
      const assertStorageUnchanged = async () => {
        fs.renameSync(sourcePath, `${sourcePath}.original`);
        fs.writeFileSync(sourcePath, replacement);
      };

      if (action === 'delete') {
        await expect(
          service.removeSession(sessionId, { assertStorageUnchanged }),
        ).rejects.toThrow('changed outside its active writer');
      } else {
        const result = await service[`${action}Sessions`]([sessionId], {
          assertStorageUnchanged,
        });
        expect(result.errors[0]?.error.message).toContain(
          'changed outside its active writer',
        );
      }

      expect(fs.readFileSync(sourcePath, 'utf8')).toBe(replacement);
      expect(
        fs.existsSync(action === 'archive' ? paths.archived : paths.active),
      ).toBe(action !== 'archive' && state === 'active');
    },
  );
});

describe('SessionService.reconstructHistory (history-gap detection)', () => {
  // reconstructHistory is private; cast to reach it directly, matching the
  // pattern above. Integration point under test: the sessionService delegate
  // to buildOrderedUuidChain + aggregateRecords, plus the returned gaps.
  type Privates = {
    reconstructHistory: (
      records: ChatRecord[],
      opts?: { leafUuid?: string; detectGaps?: boolean },
    ) => { messages: ChatRecord[]; gaps: HistoryGap[] };
  };
  let svc: Privates;

  beforeEach(() => {
    svc = new SessionService('/tmp/x') as unknown as Privates;
  });

  // Two disconnected islands, the 965867 shape: island A (older) is a clean
  // root chain; island B (newer) begins with a record whose parentUuid points
  // at a record that is not in the file at all.
  const twoIslands: ChatRecord[] = [
    recordFor('a1', 'user', null),
    recordFor('a2', 'assistant', 'a1'),
    recordFor('b1', 'user', 'missing-parent-uuid'),
    recordFor('b2', 'assistant', 'b1'),
  ];

  it('reports the gap but does NOT reconstruct the earlier island (detectGaps on)', () => {
    const { messages, gaps } = svc.reconstructHistory(twoIslands, {
      detectGaps: true,
    });
    // Only the reachable tail island — the earlier island is not stitched back.
    expect(messages.map((m) => m.uuid)).toEqual(['b1', 'b2']);
    expect(gaps).toEqual([
      { childUuid: 'b1', missingParentUuid: 'missing-parent-uuid' },
    ]);
    // The gap child's parentUuid is left as-is (not rewritten to a guess).
    const child = messages.find((m) => m.uuid === 'b1');
    expect(child?.parentUuid).toBe('missing-parent-uuid');
  });

  it('preserves today truncation behavior when detectGaps is off', () => {
    const { messages, gaps } = svc.reconstructHistory(twoIslands);
    expect(messages.map((m) => m.uuid)).toEqual(['b1', 'b2']);
    expect(gaps).toEqual([]);
  });
});
