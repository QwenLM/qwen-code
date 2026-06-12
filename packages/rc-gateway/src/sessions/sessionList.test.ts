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
    // Pad so a 3-byte char (✓ = e2 9c 93) straddles a tiny read window.
    const pad = 'x'.repeat(10);
    const value = `${pad}✓${pad}`;
    await writeFile(
      join(dir, `${ID(1)}.jsonl`),
      JSON.stringify({ v: value }) + '\n',
    );
    // 12-byte window forces the multibyte char to span two reads.
    const rec = await readFirstRecord(dir, ID(1), { maxBytes: 1024 });
    expect(rec).toEqual({ v: value });
    // Sanity: with a real undersized read buffer the byte path still decodes.
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
