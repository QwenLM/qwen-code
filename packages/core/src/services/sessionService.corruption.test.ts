/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for SessionService corruption-recovery paths.
 *
 * Lives in its own file (no module-level `vi.mock`) because both
 * the session readers walk real bytes from disk and need the real
 * `jsonl.parseLineTolerant` to exercise the `}{`-glued recovery path
 * introduced for #3606. The unit-test file (sessionService.test.ts) mocks
 * jsonl-utils wholesale, so corruption shapes can't be exercised there.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionService } from './sessionService.js';
import { Storage } from '../config/storage.js';
import type { ChatRecord } from './chatRecordingService.js';
import type { HistoryGap } from '../utils/conversation-chain.js';
import { SessionTranscriptChangedError } from './session-writer-lease.js';

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

describe('SessionService.renameSession (corruption recovery)', () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const projectRoot = '/tmp/x';

  async function renameWithContent(content: string): Promise<ChatRecord> {
    const storage = new Storage(projectRoot, tmpRoot);
    const chatsDir = path.join(storage.getProjectDir(), 'chats');
    const transcriptPath = path.join(chatsDir, `${sessionId}.jsonl`);
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(transcriptPath, content, 'utf8');
    const service = new SessionService(projectRoot, {
      runtimeBaseDir: tmpRoot,
    });

    await expect(service.renameSession(sessionId, 'recovered')).resolves.toBe(
      true,
    );
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
    return JSON.parse(lines.at(-1)!) as ChatRecord;
  }

  it('anchors after the latest record from a glued physical line', async () => {
    const r1 = JSON.stringify(recordFor('u1', 'user', null));
    const r2 = JSON.stringify(recordFor('u2', 'assistant', 'u1'));

    const title = await renameWithContent(`${r1}${r2}\n`);

    expect(title.parentUuid).toBe('u2');
  });

  it('walks past a malformed tail line', async () => {
    const r1 = JSON.stringify(recordFor('u1', 'user', null));

    const title = await renameWithContent(`${r1}\nnot-json-at-all\n`);

    expect(title.parentUuid).toBe('u1');
  });

  it('uses the top-level uuid of a transcript larger than 64 KiB', async () => {
    const giant = {
      ...recordFor('real-last', 'user', null),
      filler: 'x'.repeat(80 * 1024),
      trojan: { uuid: 'fake-from-payload' },
    };

    const title = await renameWithContent(`${JSON.stringify(giant)}\n`);

    expect(title.parentUuid).toBe('real-last');
  });

  it('refuses to append a title to an unmarked branch', async () => {
    const storage = new Storage(projectRoot, tmpRoot);
    const chatsDir = path.join(storage.getProjectDir(), 'chats');
    const transcriptPath = path.join(chatsDir, `${sessionId}.jsonl`);
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(
      transcriptPath,
      [
        recordFor('root', 'user', null),
        recordFor('branch-a', 'assistant', 'root'),
        recordFor('branch-b', 'assistant', 'root'),
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
      'utf8',
    );
    const service = new SessionService(projectRoot, {
      runtimeBaseDir: tmpRoot,
    });

    await expect(service.renameSession(sessionId, 'unsafe')).rejects.toThrow(
      SessionTranscriptChangedError,
    );
    expect(
      fs.readFileSync(transcriptPath, 'utf8').trim().split('\n'),
    ).toHaveLength(3);
  });
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

  it('rejects an unmarked branch instead of selecting the physical tail', () => {
    const records = [
      recordFor('root', 'user', null),
      recordFor('branch-a', 'assistant', 'root'),
      recordFor('branch-b', 'assistant', 'root'),
    ];

    expect(() => svc.reconstructHistory(records)).toThrow(
      SessionTranscriptChangedError,
    );
  });

  it('accepts the abandoned branch created by a rewind marker', () => {
    const rewind: ChatRecord = {
      ...recordFor('rewind', 'user', 'root'),
      type: 'system',
      subtype: 'rewind',
      message: undefined,
      systemPayload: { truncatedCount: 1 },
    };
    const records = [
      recordFor('root', 'user', null),
      recordFor('abandoned', 'assistant', 'root'),
      rewind,
      recordFor('replacement', 'user', 'rewind'),
    ];

    expect(
      svc.reconstructHistory(records).messages.map((record) => record.uuid),
    ).toEqual(['root', 'rewind', 'replacement']);
  });

  it('accepts repeated rewinds from the same parent', () => {
    const rewind = (uuid: string): ChatRecord => ({
      ...recordFor(uuid, 'user', 'root'),
      type: 'system',
      subtype: 'rewind',
      message: undefined,
      systemPayload: { truncatedCount: 1 },
    });
    const records = [
      recordFor('root', 'user', null),
      recordFor('first-abandoned', 'assistant', 'root'),
      rewind('first-rewind'),
      recordFor('second-abandoned', 'assistant', 'first-rewind'),
      rewind('second-rewind'),
      recordFor('replacement', 'user', 'second-rewind'),
    ];

    expect(
      svc.reconstructHistory(records).messages.map((record) => record.uuid),
    ).toEqual(['root', 'second-rewind', 'replacement']);
  });

  it('ignores sibling title anchors that never became conversation tails', () => {
    const title = (uuid: string): ChatRecord => ({
      ...recordFor(uuid, 'user', 'root'),
      type: 'system',
      subtype: 'custom_title',
      message: undefined,
      systemPayload: { customTitle: uuid },
    });
    const records = [
      recordFor('root', 'user', null),
      title('title-a'),
      title('title-b'),
    ];

    expect(
      svc.reconstructHistory(records).messages.map((record) => record.uuid),
    ).toEqual(['root', 'title-b']);
  });

  it('rejects a divergent branch hidden behind a title anchor', () => {
    const title: ChatRecord = {
      ...recordFor('title', 'user', 'root'),
      type: 'system',
      subtype: 'custom_title',
      message: undefined,
      systemPayload: { customTitle: 'title' },
    };
    const records = [
      recordFor('root', 'user', null),
      recordFor('branch-a', 'assistant', 'root'),
      title,
      recordFor('branch-b', 'user', 'title'),
    ];

    expect(() => svc.reconstructHistory(records)).toThrow(
      SessionTranscriptChangedError,
    );
  });
});
