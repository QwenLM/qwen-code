/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleListing,
  readFirstRecord,
  readSessionTitle,
  listSessions,
  MAX_LIST_SESSIONS,
  type SessionEntry,
} from './sessionList.js';

const ID = (n: number) => String(n).padStart(32, '0');

describe('assembleListing (pure)', () => {
  it('builds the reverse forks[] index for a root + children', () => {
    const entries: SessionEntry[] = [
      { sessionId: ID(1), parentSessionId: null },
      { sessionId: ID(2), parentSessionId: ID(1) },
      { sessionId: ID(3), parentSessionId: ID(1) },
    ];
    expect(assembleListing(entries)).toEqual([
      { sessionId: ID(1), forks: [ID(2), ID(3)] },
      { sessionId: ID(2), parentSessionId: ID(1), forks: [] },
      { sessionId: ID(3), parentSessionId: ID(1), forks: [] },
    ]);
  });

  it('orphan child: keeps parentSessionId, no fabricated parent node, in no forks[]', () => {
    const entries: SessionEntry[] = [
      { sessionId: ID(2), parentSessionId: ID(9) }, // parent ID(9) absent
    ];
    const out = assembleListing(entries);
    expect(out).toEqual([
      { sessionId: ID(2), parentSessionId: ID(9), forks: [] },
    ]);
    // The missing parent is never materialized as a node.
    expect(out.some((s) => s.sessionId === ID(9))).toBe(false);
  });

  it('orders forks[] and the node list deterministically', () => {
    // Children supplied out of order -> forks[] and sessions[] both sorted.
    const entries: SessionEntry[] = [
      { sessionId: ID(5), parentSessionId: ID(1) },
      { sessionId: ID(1), parentSessionId: null },
      { sessionId: ID(2), parentSessionId: ID(1) },
    ];
    const out = assembleListing(entries);
    expect(out.map((s) => s.sessionId)).toEqual([ID(1), ID(2), ID(5)]);
    expect(out[0].forks).toEqual([ID(2), ID(5)]);
  });

  it('treats a self-referential forkedFrom as a root and never indexes it', () => {
    const entries: SessionEntry[] = [
      { sessionId: ID(1), parentSessionId: ID(1) },
    ];
    expect(assembleListing(entries)).toEqual([{ sessionId: ID(1), forks: [] }]);
  });
});

describe('readFirstRecord', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-first-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses a single record with no trailing newline', async () => {
    await writeFile(join(dir, `${ID(1)}.jsonl`), JSON.stringify({ a: 1 }));
    expect(await readFirstRecord(dir, ID(1))).toEqual({ a: 1 });
  });

  it('returns only the first line of a multi-line transcript', async () => {
    const body =
      JSON.stringify({ n: 1 }) + '\n' + JSON.stringify({ n: 2 }) + '\n';
    await writeFile(join(dir, `${ID(1)}.jsonl`), body);
    expect(await readFirstRecord(dir, ID(1))).toEqual({ n: 1 });
  });

  it('decodes a multibyte char split across the read boundary', async () => {
    // A 3-byte char (✓ = e2 9c 93) is positioned so a 12-byte per-read window
    // slices it in half. The JSON prefix `{"v":"` is 6 bytes; with a 5-char
    // lead the ✓ lands at bytes 11-13, straddling the boundary at byte 12, so
    // its bytes genuinely span two reads -> exercises decode-once on concat.
    const value = `${'x'.repeat(5)}✓${'x'.repeat(10)}`;
    await writeFile(
      join(dir, `${ID(1)}.jsonl`),
      JSON.stringify({ v: value }) + '\n',
    );
    const rec = await readFirstRecord(dir, ID(1), { chunkSize: 12 });
    expect(rec).toEqual({ v: value });
    expect((rec as { v: string }).v).toContain('✓');
  });

  it('returns null for a missing file (ENOENT)', async () => {
    expect(await readFirstRecord(dir, ID(7))).toBeNull();
  });

  it('returns null when the first line exceeds maxBytes (truncated prefix)', async () => {
    const huge = JSON.stringify({ big: 'z'.repeat(5000) }) + '\n';
    await writeFile(join(dir, `${ID(1)}.jsonl`), huge);
    // Cap below the first line length -> truncated prefix fails JSON.parse.
    expect(await readFirstRecord(dir, ID(1), { maxBytes: 64 })).toBeNull();
  });

  it('returns null for an empty file', async () => {
    await writeFile(join(dir, `${ID(1)}.jsonl`), '');
    expect(await readFirstRecord(dir, ID(1))).toBeNull();
  });
});

describe('listSessions', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-list-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(id: string, parent?: string): Promise<void> {
    const rec: Record<string, unknown> = { sessionId: id, type: 'user' };
    if (parent) rec['forkedFrom'] = { sessionId: parent, messageUuid: 'm0' };
    await writeFile(join(dir, `${id}.jsonl`), JSON.stringify(rec) + '\n');
  }

  it('builds a tree of roots and forks from disk', async () => {
    await write(ID(1)); // root
    await write(ID(2), ID(1)); // fork of 1
    await write(ID(3)); // another root
    const { sessions, truncated } = await listSessions(dir);
    expect(truncated).toBe(false);
    expect(sessions).toEqual([
      { sessionId: ID(1), forks: [ID(2)] },
      { sessionId: ID(2), parentSessionId: ID(1), forks: [] },
      { sessionId: ID(3), forks: [] },
    ]);
  });

  it('skips non-.jsonl and syntactically invalid filenames', async () => {
    await write(ID(1));
    await writeFile(join(dir, 'notes.txt'), 'ignore me');
    await writeFile(join(dir, 'bad-id.jsonl'), '{}\n'); // fails id regex
    const { sessions } = await listSessions(dir);
    expect(sessions.map((s) => s.sessionId)).toEqual([ID(1)]);
  });

  it('returns an empty listing for a missing chats dir', async () => {
    expect(await listSessions(join(dir, 'nope'))).toEqual({
      sessions: [],
      truncated: false,
    });
  });

  it('caps the scan and reports truncated', async () => {
    for (let i = 1; i <= 5; i++) await write(ID(i));
    const { sessions, truncated } = await listSessions(dir, { max: 3 });
    expect(truncated).toBe(true);
    // Lexical order -> the first three ids win, deterministically.
    expect(sessions.map((s) => s.sessionId)).toEqual([ID(1), ID(2), ID(3)]);
  });

  it('exposes a positive default cap', () => {
    expect(MAX_LIST_SESSIONS).toBeGreaterThan(0);
  });
});

describe('readSessionTitle', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-title-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const titleRec = (t: string) =>
    JSON.stringify({
      type: 'system',
      subtype: 'custom_title',
      systemPayload: { customTitle: t, titleSource: 'manual' },
      sessionId: 's',
    });
  const msgRec = (i: number) =>
    JSON.stringify({ type: 'user', sessionId: 's', uuid: 'm' + i });

  async function writeLines(id: string, lines: string[]): Promise<void> {
    await writeFile(join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
  }

  it('reads a custom_title record at EOF', async () => {
    await writeLines(ID(1), [
      msgRec(0),
      msgRec(1),
      titleRec('Fix the login bug'),
    ]);
    expect(await readSessionTitle(dir, ID(1))).toBe('Fix the login bug');
  });

  it('returns the MOST RECENT title when several exist', async () => {
    await writeLines(ID(1), [
      titleRec('old name'),
      msgRec(0),
      titleRec('new name'),
    ]);
    expect(await readSessionTitle(dir, ID(1))).toBe('new name');
  });

  it('reads a title that is the only (first) record of a short file', async () => {
    await writeLines(ID(1), [titleRec('just a header')]);
    expect(await readSessionTitle(dir, ID(1))).toBe('just a header');
  });

  it('returns null when there is no custom_title record', async () => {
    await writeLines(ID(1), [msgRec(0), msgRec(1)]);
    expect(await readSessionTitle(dir, ID(1))).toBeNull();
  });

  it('returns null for a missing file', async () => {
    expect(await readSessionTitle(dir, ID(9))).toBeNull();
  });

  it('finds a title inside the tail window and misses one outside it', async () => {
    // Title at the START, then padding so the title sits OUTSIDE a tiny tail
    // window → null (the documented >maxBytes-only-at-start limit). The exact
    // same shape with a title at EOF IS found.
    const pad = Array.from({ length: 50 }, (_, i) => msgRec(i));
    await writeLines(ID(1), [titleRec('early only'), ...pad]);
    expect(await readSessionTitle(dir, ID(1), { maxBytes: 200 })).toBeNull();

    await writeLines(ID(2), [...pad, titleRec('at the end')]);
    expect(await readSessionTitle(dir, ID(2), { maxBytes: 200 })).toBe(
      'at the end',
    );
  });
});

describe('listSessions titles (cycle 85)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-list-title-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('threads a custom_title onto the right item; untitled sessions have no title key', async () => {
    await writeFile(
      join(dir, `${ID(1)}.jsonl`),
      JSON.stringify({ sessionId: ID(1), type: 'user' }) +
        '\n' +
        JSON.stringify({
          type: 'system',
          subtype: 'custom_title',
          systemPayload: { customTitle: 'Named one' },
          sessionId: ID(1),
        }) +
        '\n',
    );
    await writeFile(
      join(dir, `${ID(2)}.jsonl`),
      JSON.stringify({ sessionId: ID(2), type: 'user' }) + '\n',
    );
    const { sessions } = await listSessions(dir);
    expect(sessions).toEqual([
      { sessionId: ID(1), title: 'Named one', forks: [] },
      { sessionId: ID(2), forks: [] },
    ]);
  });
});
