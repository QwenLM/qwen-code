/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for SessionService corruption-recovery paths.
 *
 * Lives in its own file (no module-level `vi.mock`) because both
 * `countSessionMessages` and `readLastRecordUuid` walk real bytes from disk
 * via `fs.createReadStream` / `fs.readSync`, and need the real
 * `jsonl.parseLineTolerant` to exercise the `}{`-glued recovery path
 * introduced for #3606. The unit-test file (sessionService.test.ts) mocks
 * jsonl-utils wholesale, so corruption shapes can't be exercised there.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionService } from './sessionService.js';
import type { ChatRecord } from './chatRecordingService.js';

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

describe('SessionService.countSessionMessages (corruption recovery)', () => {
  // The method is private; cast is the cheapest way to test the unit
  // without exposing it on the public surface.
  type Privates = {
    countSessionMessages: (filePath: string) => Promise<number>;
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

    expect(await svc.countSessionMessages(file)).toBe(3);
  });

  it('does not zero out the count when a line is valid JSON but not an object', async () => {
    // Old `JSON.parse + catch { continue }` would skip a bare `null` line
    // because `null.type` threw. After the parseLineTolerant refactor, a
    // missing object-filter would propagate that TypeError to the outer
    // catch and zero the whole count — regression guard.
    const r1 = JSON.stringify(recordFor('u1', 'user', null));
    const r2 = JSON.stringify(recordFor('u2', 'assistant', 'u1'));
    const file = writeJsonl('scalar-line.jsonl', `${r1}\nnull\n${r2}\n`);

    expect(await svc.countSessionMessages(file)).toBe(2);
  });

  it('deduplicates uuids across recovered fragments', async () => {
    // Same uuid appearing twice (e.g. record was re-emitted during recovery)
    // must still count as one logical message.
    const r1 = JSON.stringify(recordFor('u1', 'user', null));
    const file = writeJsonl('dup.jsonl', `${r1}${r1}\n`);

    expect(await svc.countSessionMessages(file)).toBe(1);
  });

  it('returns 0 for a missing file', async () => {
    expect(
      await svc.countSessionMessages(path.join(tmpRoot, 'nope.jsonl')),
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
