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
import type { RemoveSessionOptions } from './sessionService.js';
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

const R1 = JSON.stringify(recordFor('u1', 'user', null));
const R2 = JSON.stringify(recordFor('u2', 'assistant', 'u1'));

/** One JSONL line: a user record for `uuid` with `fields` overriding its keys. */
const recordLine = (fields: Record<string, unknown>, uuid = 'u1') =>
  `${JSON.stringify({ ...recordFor(uuid, 'user', null), ...fields })}\n`;
const owned = (sessionId: string, cwd: string, uuid = 'u1') =>
  recordLine({ sessionId, cwd }, uuid);

const read = (file: string) => fs.readFileSync(file, 'utf8');

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
  // Private: the cast tests the unit directly, skipping the public
  // `countSessionMessages(sessionId)` SESSION_FILE_PATTERN and
  // project-scoping checks, which these tests are not about.
  type Privates = {
    countSessionMessagesFromPath: (filePath: string) => Promise<number>;
  };
  let svc: Privates;

  beforeEach(() => {
    svc = new SessionService('/tmp/x') as unknown as Privates;
  });

  it('counts both records of a `}{`-glued physical line', async () => {
    // The exact #3606 shape: the writer was interrupted between
    // `JSON.stringify` and the trailing `\n`.
    const r3 = JSON.stringify(recordFor('u3', 'user', 'u2'));
    const file = writeJsonl('glued.jsonl', `${R1}${R2}\n${r3}\n`);

    expect(await svc.countSessionMessagesFromPath(file)).toBe(3);
  });

  it('does not zero out the count when a line is valid JSON but not an object', async () => {
    // Regression guard: without the object filter after the
    // parseLineTolerant refactor, `null.type` throws to the outer catch and
    // zeroes the whole count (old `JSON.parse + catch { continue }` skipped it).
    const file = writeJsonl('scalar-line.jsonl', `${R1}\nnull\n${R2}\n`);

    expect(await svc.countSessionMessagesFromPath(file)).toBe(2);
  });

  it('deduplicates uuids across recovered fragments', async () => {
    // A uuid re-emitted during recovery still counts as one message.
    const file = writeJsonl('dup.jsonl', `${R1}${R1}\n`);

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

  // A record larger than TAIL_READ_SIZE (64 KiB) whose payload nests a
  // balanced `{"uuid":"fake-from-payload"}`. The filler is ~80k zeros
  // (~160 KB) with no quote characters, so the parser's inString state stays
  // aligned when entering mid-fragment and the trojan is reachable.
  const giantLine = (uuid: string) =>
    `{"uuid":"${uuid}","filler":[${new Array(80000).fill(0).join(',')}],` +
    `"trojan":{"uuid":"fake-from-payload"}}`;

  it('returns the latest record uuid from a `}{`-glued tail line', () => {
    // renameSession passes this uuid as the synthetic title record's
    // parentUuid; dropping the glued tail (old behaviour) points it at an
    // earlier record and reconstructHistory truncates the chain on resume.
    const file = writeJsonl('glued-tail.jsonl', `${R1}${R2}\n`);

    expect(svc.readLastRecordUuid(file)).toBe('u2');
  });

  it('walks past a malformed tail line and returns the previous valid uuid', () => {
    const file = writeJsonl('garbage-tail.jsonl', `${R1}\nnot-json-at-all\n`);

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
    // The tail buffer starts mid-record. Without the boundary guard,
    // _recoverObjectsFromLine walks the fragment from depth 0, finds the
    // inner uuid object and surfaces "fake" as the last top-level uuid;
    // renameSession would anchor custom_title.parentUuid at payload data and
    // reconstructHistory would truncate the chain on resume.
    const file = writeJsonl('big-tail.jsonl', `${giantLine('real-last')}\n`);

    // "real-last" lies before the tail window and cannot be recovered; the
    // critical assertion is the absence of the false positive.
    expect(svc.readLastRecordUuid(file)).not.toBe('fake-from-payload');
  });

  it('returns the final complete record uuid when a giant partial precedes it in the tail', () => {
    // Positive twin of the test above, which would still pass if every line
    // in the window were skipped and `null` returned: the partial first
    // segment is discarded, the complete record after the in-window `\n` is
    // recovered.
    const finalRecord = JSON.stringify(recordFor('actual-last', 'user', null));
    const file = writeJsonl(
      'big-tail-then-final.jsonl',
      `${giantLine('too-early-to-see')}\n${finalRecord}\n`,
    );

    expect(svc.readLastRecordUuid(file)).toBe('actual-last');
  });

  it('returns the only record when the tail window starts exactly on a newline boundary', () => {
    // File is `prev\n<final>\n` with `final\n` exactly TAIL_READ_SIZE bytes,
    // so `readStart - 1` lands on the separating `\n` and the first split
    // segment is complete, not partial. An unconditional `lines.shift()`
    // drops the only readable uuid and renameSession writes
    // `custom_title.parentUuid` as `null`, truncating history on resume. The
    // fix peeks the byte before `readStart` to tell the two apart.
    const TAIL_READ_SIZE = 64 * 1024;
    const baseFinal = recordFor('boundary-final', 'user', null);
    const baseFinalLen = Buffer.byteLength(JSON.stringify(baseFinal), 'utf8');
    // Pad with `,"filler":"x...x"`, whose fixed overhead (everything but the
    // x-run) is 12 bytes; the final `- 1` leaves room for the newline.
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
  type State = 'active' | 'archived';
  type Action = 'delete' | 'archive' | 'unarchive';
  type Privates = {
    getSessionFilePath: (id: string, state: State) => string;
    getPrSessionPathForState: (id: string, state: State) => string;
    getPromptLedgerPathForState: (id: string, state: State) => string;
    getWorktreeSessionPathForState: (id: string, state: State) => string;
    sessionBelongsToCurrentProject: (
      sessionId: string,
      cwd: string,
    ) => Promise<boolean>;
    resolveMaintainableSessionSnapshot: (id: string) => Promise<unknown>;
  };
  type Harness = { service: SessionService; sessionId: string };

  /** The transcript slot an action reads from (delete uses the active one). */
  const sourceState = (action: Action): State =>
    action === 'unarchive' ? 'archived' : 'active';

  // Seeds one transcript in `state`; `seed` may be built from the
  // harness's own session id and cwd.
  function createHarness(
    seed: string | ((sessionId: string, cwd: string) => string),
    state: State,
  ) {
    const runtimeBaseDir = fs.mkdtempSync(path.join(tmpRoot, 'lifecycle-'));
    const cwd = path.join(runtimeBaseDir, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const service = new SessionService(cwd, { runtimeBaseDir });
    const sessionId = randomUUID();
    const internals = service as unknown as Privates;
    const paths = {
      active: internals.getSessionFilePath(sessionId, 'active'),
      archived: internals.getSessionFilePath(sessionId, 'archived'),
    };
    const content = typeof seed === 'string' ? seed : seed(sessionId, cwd);
    put(paths[state], content);
    const source = paths[state];
    const other = paths[state === 'active' ? 'archived' : 'active'];
    return {
      service,
      sessionId,
      paths,
      content,
      cwd,
      internals,
      source,
      other,
    };
  }

  function put(file: string, content: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  const foreignDir = () => fs.mkdtempSync(path.join(tmpRoot, 'foreign-'));
  /** A seed whose record claims the session but a fresh foreign cwd. */
  const foreign =
    (extra: Record<string, unknown> = {}) =>
    (sessionId: string) =>
      recordLine({ sessionId, cwd: foreignDir(), ...extra });

  // Makes the next resolveMaintainableSessionSnapshot call run `around` the
  // real one, to race the filesystem against classification.
  function interceptSnapshotOnce(
    service: SessionService,
    around: (resolve: () => Promise<unknown>) => Promise<unknown>,
  ) {
    const internals = service as unknown as Privates;
    const resolveSnapshot =
      internals.resolveMaintainableSessionSnapshot.bind(service);
    vi.spyOn(
      internals,
      'resolveMaintainableSessionSnapshot',
    ).mockImplementationOnce((id) => around(() => resolveSnapshot(id)));
  }

  /** An assertStorageUnchanged hook that swaps `file` for a replacement. */
  const replaceWith = (file: string) => async () => {
    fs.renameSync(file, `${file}.original`);
    fs.writeFileSync(file, 'replacement');
  };

  // delete rejects; archive/unarchive resolve with the failure in errors[0].
  // A string expects that message, a class that instance, an object a match.
  async function expectFails(
    { service, sessionId }: Harness,
    action: Action,
    expected: string | typeof SessionStorageEntryError | { reason: string },
    options?: RemoveSessionOptions,
  ) {
    if (action === 'delete') {
      const removal = service.removeSession(sessionId, options);
      if (typeof expected === 'string')
        await expect(removal).rejects.toThrow(expected);
      else if (typeof expected === 'function')
        await expect(removal).rejects.toBeInstanceOf(expected);
      else await expect(removal).rejects.toMatchObject(expected);
      return;
    }
    const result = await service[`${action}Sessions`]([sessionId], options);
    const error = result.errors[0]?.error;
    if (typeof expected === 'string')
      expect(error?.message).toContain(expected);
    else if (typeof expected === 'function')
      expect(error).toBeInstanceOf(expected);
    else expect(error).toMatchObject(expected);
  }

  // delete resolves `moved`; archive/unarchive list the session under
  // `<action>d` when moved, else under notFound.
  async function expectOutcome(
    { service, sessionId }: Harness,
    action: Action,
    moved: boolean,
  ) {
    if (action === 'delete') {
      await expect(service.removeSession(sessionId)).resolves.toBe(moved);
    } else {
      await expect(
        service[`${action}Sessions`]([sessionId]),
      ).resolves.toMatchObject({
        [moved ? `${action}d` : 'notFound']: [sessionId],
        errors: [],
      });
    }
  }

  // Seeds an owned readable copy in `readable` and a torn copy in the other.
  function seedConflict(readable: State) {
    const damaged: State = readable === 'active' ? 'archived' : 'active';
    const h = createHarness('', 'active');
    const torn = `{"uuid":"torn-${damaged}"`;
    const good = owned(h.sessionId, h.cwd);
    put(h.paths.active, readable === 'active' ? good : torn);
    put(h.paths.archived, readable === 'active' ? torn : good);
    return { ...h, damaged, torn, good };
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

    for (const [action, from] of [
      ['archive', 'active'],
      ['unarchive', 'archived'],
    ] as const) {
      it(`${action}s an owned ${shape.name} transcript without rewriting it`, async () => {
        const { service, sessionId, content, source, other } = createHarness(
          shape.content,
          from,
        );

        const result = await service[`${action}Sessions`]([sessionId]);

        expect(result).toMatchObject({
          [`${action}d`]: [sessionId],
          notFound: [],
          errors: [],
        });
        expect(fs.existsSync(source)).toBe(false);
        expect(read(other)).toBe(content);
      });
    }
  }

  it('maintains an owned legacy child whose parent no longer exists', async () => {
    const orphan = (sessionId: string, cwd: string) =>
      owned(sessionId, cwd) +
      `${JSON.stringify({
        ...recordFor('u2', 'assistant', 'u1'),
        sessionId,
        cwd,
        type: 'system',
        subtype: 'parent_session',
        systemPayload: { parentSessionId: randomUUID() },
      })}\n`;

    for (const action of ['delete', 'archive', 'unarchive'] as const) {
      await expectOutcome(
        createHarness(orphan, sourceState(action)),
        action,
        true,
      );
    }
  });

  it.each([
    ['archive', 'archived'],
    ['unarchive', 'active'],
  ] as const)(
    'preserves default %s conflicts and explicitly keeps the %s copy',
    async (action, kept) => {
      const { service, sessionId, paths } = createHarness('active', 'active');
      put(paths.archived, 'archived');

      const defaultResult = await service[`${action}Sessions`]([sessionId]);
      expect(defaultResult.errors).toHaveLength(1);
      expect(read(paths.active)).toBe('active');
      expect(read(paths.archived)).toBe('archived');

      const repaired = await service[`${action}Sessions`]([sessionId], {
        resolveConflicts: true,
      });
      expect(repaired).toMatchObject({
        [`${action}d`]: [sessionId],
        resolvedConflicts: [sessionId],
        errors: [],
      });
      expect(read(paths[kept])).toBe(kept);
      expect(
        fs.existsSync(paths[kept === 'active' ? 'archived' : 'active']),
      ).toBe(false);
    },
  );

  it.each(['archive', 'unarchive'] as const)(
    'merges pr bindings into the retained copy during %s conflict repair',
    async (action) => {
      const { service, sessionId, paths, cwd, internals } = createHarness(
        owned,
        'active',
      );
      put(paths.archived, owned(sessionId, cwd, 'u2'));
      const [activePr, archivedPr] = (['active', 'archived'] as const).map(
        (state) => internals.getPrSessionPathForState(sessionId, state),
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

  it.each([
    ['archived', 'active', 'archive'],
    ['active', 'archived', 'unarchive'],
  ] as const)(
    'does not overwrite a damaged %s copy when the %s copy is readable',
    async (damaged, readable, action) => {
      const { service, sessionId, paths, torn } = seedConflict(readable);

      const result = await service[`${action}Sessions`]([sessionId]);

      expect(result.errors).toHaveLength(1);
      expect(fs.existsSync(paths[readable])).toBe(true);
      expect(read(paths[damaged])).toBe(torn);
    },
  );

  it.each([
    ['archive', 'archived'],
    ['unarchive', 'active'],
  ] as const)(
    'repairs an %s conflict when only the %s copy is readable',
    async (action, readable) => {
      const { service, sessionId, paths, damaged, good } =
        seedConflict(readable);

      const defaultResult = await service[`${action}Sessions`]([sessionId]);
      expect(defaultResult.errors).toHaveLength(1);

      const repaired = await service[`${action}Sessions`]([sessionId], {
        resolveConflicts: true,
      });
      expect(repaired).toMatchObject({
        [`${action}d`]: [sessionId],
        resolvedConflicts: [sessionId],
        errors: [],
      });
      expect(fs.existsSync(paths[damaged])).toBe(false);
      expect(read(paths[readable])).toBe(good);
    },
  );

  it.each(['archive', 'unarchive'] as const)(
    'reclassifies a conflict that appears during %s validation',
    async (action) => {
      const { service, sessionId, source, content, other } = createHarness(
        owned,
        sourceState(action),
      );
      interceptSnapshotOnce(service, async (resolve) => {
        put(other, 'late conflict');
        return resolve();
      });

      const result = await service[`${action}Sessions`]([sessionId]);

      expect(result.errors).toHaveLength(1);
      expect(read(source)).toBe(content);
      expect(read(other)).toBe('late conflict');
    },
  );

  it.each(['delete', 'unarchive'] as const)(
    'does not %s a readable archived transcript replaced after validation',
    async (action) => {
      const h = createHarness(owned, 'archived');
      const assertStorageUnchanged = replaceWith(h.paths.archived);

      await expectFails(h, action, 'changed outside its active writer', {
        assertStorageUnchanged,
      });

      expect(read(h.paths.archived)).toBe('replacement');
      expect(fs.existsSync(h.paths.active)).toBe(false);
    },
  );

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'does not %s a transcript that disappears and reappears during classification',
    async (action) => {
      const state = action === 'archive' ? 'active' : 'archived';
      const h = createHarness(owned, state);
      interceptSnapshotOnce(h.service, async (resolve) => {
        fs.renameSync(h.source, `${h.source}.original`);
        const snapshot = await resolve();
        fs.writeFileSync(h.source, 'replacement');
        return snapshot;
      });

      await expectOutcome(h, action, false);

      expect(read(h.source)).toBe('replacement');
      expect(read(`${h.source}.original`)).toBe(h.content);
      expect(fs.existsSync(h.other)).toBe(false);
    },
  );

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'does not %s a readable transcript whose record identifies another session',
    async (action) => {
      const h = createHarness(
        (_id, cwd) => recordLine({ sessionId: randomUUID(), cwd }),
        sourceState(action),
      );

      await expectOutcome(h, action, false);

      expect(read(h.source)).toBe(h.content);
      expect(fs.existsSync(h.other)).toBe(false);
    },
  );

  // JSON.stringify drops an `undefined` cwd, which leaves the key missing.
  it.each([
    ['missing cwd', undefined],
    ['non-string cwd', 42],
  ] as const)('fails closed on a record with %s', async (_name, cwdValue) => {
    for (const action of ['delete', 'archive', 'unarchive'] as const) {
      const h = createHarness(
        (sessionId) => recordLine({ sessionId, cwd: cwdValue }),
        sourceState(action),
      );

      await expectFails(h, action, { reason: 'unknown_project' });
      expect(fs.existsSync(h.source)).toBe(true);
      if (action !== 'delete') {
        expect(fs.existsSync(h.other)).toBe(false);
      }
    }
  });

  // JSON.stringify drops an `undefined` sessionId, which leaves the key missing.
  it.each([
    ['missing session id', undefined],
    ['non-string session id', 42],
  ] as const)(
    'fails closed on a foreign record with %s',
    async (_name, sessionIdValue) => {
      const h = createHarness(
        () => recordLine({ sessionId: sessionIdValue, cwd: foreignDir() }),
        'active',
      );

      await expectFails(h, 'delete', { reason: 'unknown_project' });
      expect(read(h.paths.active)).toBe(h.content);
    },
  );

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'fails closed on mixed foreign and local storage during %s',
    async (action) => {
      const h = createHarness(foreign(), 'active');
      const archivedContent = owned(h.sessionId, h.cwd, 'u2');
      put(h.paths.archived, archivedContent);

      await expectFails(h, action, { reason: 'ambiguous_project' });
      expect(read(h.paths.active)).toBe(h.content);
      expect(read(h.paths.archived)).toBe(archivedContent);
    },
  );

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'fails closed when %s sees another session id without cwd ownership',
    async (action) => {
      const h = createHarness(
        () => recordLine({ sessionId: randomUUID(), cwd: undefined }),
        sourceState(action),
      );

      await expectFails(h, action, { reason: 'unknown_project' });
      expect(read(h.source)).toBe(h.content);
    },
  );

  it('maintains an oversized first physical record without buffering the whole file', async () => {
    const h = createHarness('x'.repeat(1024 * 1024 + 1), 'active');
    const { service, sessionId, paths, content } = h;

    await expect(
      service.getMaintainableSessionLocation(sessionId),
    ).resolves.toBe('active');
    await expectOutcome(h, 'archive', true);
    expect(fs.existsSync(paths.active)).toBe(false);
    expect(read(paths.archived)).toBe(content);
  });

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'does not %s a just-over-limit readable transcript from another workspace',
    async (action) => {
      const h = createHarness(
        foreign({ filler: 'x'.repeat(1024 * 1024) }),
        sourceState(action),
      );
      const size = Buffer.byteLength(h.content);
      expect(size).toBeGreaterThan(1024 * 1024);
      expect(size).toBeLessThan(1024 * 1024 + 64 * 1024);

      await expectOutcome(h, action, false);
      expect(read(h.source)).toBe(h.content);
      expect(fs.existsSync(h.other)).toBe(false);
    },
  );

  it('fails closed on a readable transcript whose first record exceeds the bounded read window', async () => {
    const { service, sessionId, paths, content } = createHarness(
      foreign({ filler: 'x'.repeat(2 * 1024 * 1024) }),
      'active',
    );

    await expect(
      service.getMaintainableSessionLocation(sessionId),
    ).rejects.toBeInstanceOf(SessionTranscriptIdentityUnavailableError);
    expect(read(paths.active)).toBe(content);
  });

  // Seeds a transcript plus prompt ledger in the action's source slot.
  function ledgerHarness(action: 'archive' | 'unarchive') {
    const h = createHarness('transcript', sourceState(action));
    const ledger = (p: string) => p.replace(/\.jsonl$/, '.ledger.jsonl');
    fs.writeFileSync(ledger(h.source), '{"promptId":"p1"}\n');
    return {
      ...h,
      sourceLedger: ledger(h.source),
      destinationLedger: ledger(h.other),
    };
  }

  it.each(['archive', 'unarchive'] as const)(
    'finishes the %s ledger move after the generation closes',
    async (action) => {
      const { service, sessionId, sourceLedger, destinationLedger } =
        ledgerHarness(action);
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
      const h = ledgerHarness(action);
      const ownershipLost = new Error('writer ownership lost');

      const result = await h.service[`${action}Sessions`]([h.sessionId], {
        assertCanMutate: vi.fn(),
        assertCleanupOwned: () => {
          throw ownershipLost;
        },
      });

      expect(result.errors[0]?.error).toBe(ownershipLost);
      expect(fs.existsSync(h.source)).toBe(false);
      expect(fs.existsSync(h.other)).toBe(true);
      expect(fs.existsSync(h.sourceLedger)).toBe(true);
      expect(fs.existsSync(h.destinationLedger)).toBe(false);
    },
  );

  it.each(['archive', 'unarchive'] as const)(
    'reconciles stranded %s sidecars on an exact retry',
    async (action) => {
      const from = sourceState(action);
      const to: State = action === 'archive' ? 'archived' : 'active';
      const { service, sessionId, internals } = createHarness(
        action === 'archive' ? '' : '{"uuid":"torn-head"',
        from,
      );
      const [
        sourceWorktree,
        sourcePr,
        sourceLedger,
        destinationWorktree,
        destinationPr,
        destinationLedger,
      ] = [from, to].flatMap((state) => [
        internals.getWorktreeSessionPathForState(sessionId, state),
        internals.getPrSessionPathForState(sessionId, state),
        internals.getPromptLedgerPathForState(sessionId, state),
      ]);
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
      expect(read(destinationLedger)).toContain('"promptId":"p1"');
      expect(assertCanMutate).toHaveBeenCalled();
      expect(assertCleanupOwned).toHaveBeenCalled();
    },
  );

  it('rejects an in-place rewrite during ownership classification', async () => {
    const { service, paths, sessionId, internals } = createHarness(
      owned,
      'active',
    );
    const inode = fs.statSync(paths.active).ino;
    vi.spyOn(internals, 'sessionBelongsToCurrentProject').mockImplementation(
      async () => {
        fs.writeFileSync(paths.active, 'replacement');
        return true;
      },
    );

    await expect(
      service.getMaintainableSessionLocation(sessionId),
    ).rejects.toThrow('changed outside its active writer');
    expect(fs.statSync(paths.active).ino).toBe(inode);
    expect(read(paths.active)).toBe('replacement');
  });

  it.each(['delete', 'archive', 'unarchive'] as const)(
    'does not %s a readable transcript symlink',
    async (action) => {
      const h = createHarness('', sourceState(action));
      const targetPath = `${h.source}.target`;
      const targetContent = owned(h.sessionId, h.cwd);
      fs.unlinkSync(h.source);
      fs.writeFileSync(targetPath, targetContent);
      fs.symlinkSync(targetPath, h.source);

      await expectFails(h, action, SessionStorageEntryError);

      expect(fs.lstatSync(h.source).isSymbolicLink()).toBe(true);
      expect(read(targetPath)).toBe(targetContent);
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
      const state = sourceState(action);
      const h = createHarness('{"uuid":"torn-head"', state);

      await expectFails(h, action, 'changed outside its active writer', {
        assertStorageUnchanged: replaceWith(h.source),
      });

      expect(read(h.source)).toBe('replacement');
      expect(
        fs.existsSync(action === 'archive' ? h.paths.archived : h.paths.active),
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
