/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for SessionService.listSessions cursor pagination — in particular
 * the equal-mtime tie-break that keeps page turns lossless. Real-filesystem
 * based (same rationale as sessionService.search.test.ts): the bug only
 * manifests through real stat mtimes flowing through the paginated scan.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeSessionListCursor,
  encodeSessionListCursor,
  InvalidSessionListCursorError,
  SessionService,
  type SessionListCursor,
} from './sessionService.js';
import type { ChatRecord } from './chatRecordingService.js';

let tmpRoot: string;
let runtimeBaseDir: string;
let cwd: string;
let service: SessionService;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-svc-pagination-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  // The tie-break cap test leaves 10k files behind; Windows deletion is slow.
}, 120_000);

beforeEach(() => {
  runtimeBaseDir = fs.mkdtempSync(path.join(tmpRoot, 'runtime-'));
  cwd = path.join(runtimeBaseDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  service = new SessionService(cwd, { runtimeBaseDir });
});

/** Sequential ids that sort the same way under `localeCompare`. */
function sessionIdAt(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function sessionFilePath(sessionId: string): string {
  type Privates = {
    getSessionFilePath: (id: string, state: 'active' | 'archived') => string;
  };
  const filePath = (service as unknown as Privates).getSessionFilePath(
    sessionId,
    'active',
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}

function writeSession(sessionId: string, mtimeMs: number): void {
  const record: ChatRecord = {
    parentUuid: null,
    sessionId,
    timestamp: new Date(mtimeMs).toISOString(),
    type: 'user',
    cwd,
    version: 'test',
    uuid: `uuid-${sessionId}`,
    message: { role: 'user', parts: [{ text: `prompt for ${sessionId}` }] },
  };
  const filePath = sessionFilePath(sessionId);
  fs.writeFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
  // Numeric utimes form keeps fractional milliseconds (Date would truncate),
  // matching the fractional mtimeMs statSync reports on real filesystems.
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
}

/** Follows cursors until exhaustion, returning every session id in order. */
async function drainAll(size: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: number | SessionListCursor | undefined;
  do {
    const page = await service.listSessions({
      size,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    ids.push(...page.items.map((item) => item.sessionId));
    cursor = page.nextCursor;
    if (!page.hasMore) {
      expect(page.nextCursor).toBeUndefined();
    }
  } while (cursor !== undefined);
  return ids;
}

describe('listSessions pagination with equal mtimes', () => {
  it('returns every session exactly once when all files share one mtime', async () => {
    const total = 25;
    // Fractional: statSync reports sub-ms mtimes on real filesystems, and the
    // composite filter's exact-equality half must match them bit-for-bit.
    const shared = new Date('2026-08-17T00:00:00.000Z').getTime() + 0.467;
    for (let i = 0; i < total; i++) {
      writeSession(sessionIdAt(i), shared);
    }

    const ids = await drainAll(10);

    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(ids).toEqual(
      Array.from({ length: total }, (_, i) => sessionIdAt(i)),
    );
  });

  it('does not skip or duplicate when a page boundary splits an mtime tie group', async () => {
    const shared = new Date('2026-08-17T00:00:00.000Z').getTime() + 0.467;
    const older = shared - 1;
    for (let i = 0; i < 5; i++) {
      writeSession(sessionIdAt(i), shared);
    }
    writeSession(sessionIdAt(5), older);
    writeSession(sessionIdAt(6), older);

    const ids = await drainAll(3);

    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    // mtime desc, then name asc: the five shared-mtime files in id order,
    // then the two older ones in id order.
    expect(ids).toEqual(Array.from({ length: 7 }, (_, i) => sessionIdAt(i)));
  });

  it('keeps legacy numeric cursor semantics: strictly earlier mtimes only', async () => {
    const base = new Date('2026-08-17T00:00:00.000Z').getTime();
    writeSession(sessionIdAt(0), base);
    writeSession(sessionIdAt(1), base - 1000);
    writeSession(sessionIdAt(2), base - 2000);

    const page = await service.listSessions({ cursor: base - 1000 });

    expect(page.items.map((item) => item.sessionId)).toEqual([sessionIdAt(2)]);
    expect(page.hasMore).toBe(false);
  });

  it('upgrades a legacy numeric input cursor to the composite form on the way out', async () => {
    // The documented wire guarantee: a bare-mtime cursor is accepted on
    // input, but any nextCursor the response carries is the composite form,
    // never a numeric echo of the input.
    const base = new Date('2026-08-17T00:00:00.000Z').getTime();
    writeSession(sessionIdAt(0), base);
    writeSession(sessionIdAt(1), base - 1000);
    writeSession(sessionIdAt(2), base - 2000);
    writeSession(sessionIdAt(3), base - 3000);

    const page = await service.listSessions({ size: 2, cursor: base });

    // The legacy strict-mtime rule selects the strictly older sessions...
    expect(page.items.map((item) => item.sessionId)).toEqual([
      sessionIdAt(1),
      sessionIdAt(2),
    ]);
    expect(page.hasMore).toBe(true);
    // ...but the emitted cursor names the page boundary exactly, in the
    // composite form.
    expect(page.nextCursor).toEqual({
      mtime: base - 2000,
      sessionId: sessionIdAt(2),
    });

    // And it pages on losslessly to the end of the list.
    const rest = await service.listSessions({
      size: 2,
      cursor: page.nextCursor,
    });
    expect(rest.items.map((item) => item.sessionId)).toEqual([sessionIdAt(3)]);
    expect(rest.hasMore).toBe(false);
  });

  it('accepts the composite cursor it hands out, with no manual decoding', async () => {
    const shared = new Date('2026-08-17T00:00:00.000Z').getTime();
    for (let i = 0; i < 4; i++) {
      writeSession(sessionIdAt(i), shared);
    }

    const first = await service.listSessions({ size: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual({
      mtime: shared,
      sessionId: sessionIdAt(1),
    });

    const second = await service.listSessions({
      size: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.sessionId)).toEqual([
      sessionIdAt(2),
      sessionIdAt(3),
    ]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  it('orders an mtime tie group by file name regardless of creation order', async () => {
    const shared = new Date('2026-08-17T00:00:00.000Z').getTime() + 0.467;
    // Descending creation order on purpose: the ordering must come from the
    // sort, never from readdir order.
    for (const i of [4, 3, 2, 1, 0]) {
      writeSession(sessionIdAt(i), shared);
    }

    expect(await drainAll(1)).toEqual(
      Array.from({ length: 5 }, (_, i) => sessionIdAt(i)),
    );
  });

  it('advances the cursor past skipped files, so a scan behind a skipped block stays lossless', async () => {
    // Layout (one shared mtime, file-name order): own A, then
    // MAX_FILES_TO_PROCESS content-empty files (skipped after processing),
    // then own B. Page 1 returns A. Page 2 hits the files-processed cap
    // inside the skipped block: its cursor must name the last *processed*
    // (skipped) file, not the last pushed item (A), or page 3 would
    // re-filter the same block, emit the same cursor, and never reach B.
    const shared = new Date('2026-08-17T00:00:00.000Z').getTime();
    const ownA = sessionIdAt(0);
    const ownB = sessionIdAt(10_001);
    writeSession(ownA, shared);
    writeSession(ownB, shared);
    const skippedCount = 10_000; // MAX_FILES_TO_PROCESS
    for (let i = 1; i <= skippedCount; i++) {
      const filePath = sessionFilePath(sessionIdAt(i));
      fs.writeFileSync(filePath, '', 'utf8');
      fs.utimesSync(filePath, shared / 1000, shared / 1000);
    }

    const page1 = await service.listSessions({ size: 1 });
    expect(page1.items.map((item) => item.sessionId)).toEqual([ownA]);

    const page2 = await service.listSessions({
      size: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toEqual([]);
    expect(page2.hasMore).toBe(true);
    // The cursor sits on the last processed file, which is a skipped one.
    expect(page2.nextCursor).toEqual({
      mtime: shared,
      sessionId: sessionIdAt(skippedCount),
    });

    const page3 = await service.listSessions({
      size: 1,
      cursor: page2.nextCursor,
    });
    expect(page3.items.map((item) => item.sessionId)).toEqual([ownB]);
    expect(page3.hasMore).toBe(false);
  }, 60_000);
});

describe('session-list cursor codec', () => {
  const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

  it('round-trips a composite cursor, preserving fractional mtimes', () => {
    const cursor = { mtime: 1755_000_000_000.125, sessionId: SESSION_ID };
    const encoded = encodeSessionListCursor(cursor);
    expect(encoded).toBe(
      '1755000000000.125:550e8400-e29b-41d4-a716-446655440000',
    );
    expect(decodeSessionListCursor(encoded)).toEqual(cursor);
  });

  it.each([0, -1000, -2_147_483_648_000])(
    'round-trips an encoder-producible non-positive mtime: %d',
    (mtime) => {
      const cursor = { mtime, sessionId: SESSION_ID };
      expect(decodeSessionListCursor(encodeSessionListCursor(cursor))).toEqual(
        cursor,
      );
    },
  );

  it('decodes a legacy bare-mtime cursor to a number', () => {
    expect(decodeSessionListCursor('1755000000000')).toBe(1755000000000);
    expect(encodeSessionListCursor(1755000000000)).toBe('1755000000000');
  });

  it('returns undefined for an empty cursor', () => {
    expect(decodeSessionListCursor('')).toBeUndefined();
  });

  it.each([
    'not-a-cursor',
    '1755000000000:not-a-session-id',
    '1755000000000:',
    ':550e8400-e29b-41d4-a716-446655440000',
    'NaN:550e8400-e29b-41d4-a716-446655440000',
    '9007199254740992:550e8400-e29b-41d4-a716-446655440000',
    '-9007199254740992:550e8400-e29b-41d4-a716-446655440000',
    '-5',
    '99999999999999999999',
  ])('rejects malformed cursor %j', (raw) => {
    expect(() => decodeSessionListCursor(raw)).toThrow(
      InvalidSessionListCursorError,
    );
  });
});
