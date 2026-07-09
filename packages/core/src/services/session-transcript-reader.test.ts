/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import type { ChatRecord } from './chatRecordingService.js';
import {
  encodeSessionTranscriptCursor,
  getSessionTranscriptIndexCacheStatsForTest,
  InvalidSessionTranscriptCursorError,
  SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
  resetSessionTranscriptIndexCacheForTest,
  setSessionTranscriptIndexCacheMaxBytesForTest,
  SessionTranscriptSnapshotUnavailableError,
  SessionTranscriptReader,
} from './session-transcript-reader.js';

describe('SessionTranscriptReader', () => {
  let runtimeDir: string;
  let workspaceDir: string;
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-transcript-reader-'),
    );
    workspaceDir = path.join(runtimeDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    Storage.setRuntimeBaseDir(runtimeDir, workspaceDir);
  });

  afterEach(async () => {
    resetSessionTranscriptIndexCacheForTest();
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  async function writeRecords(
    records: ChatRecord[],
    targetSessionId = sessionId,
  ): Promise<string> {
    const chatsDir = path.join(
      new Storage(workspaceDir).getProjectDir(),
      'chats',
    );
    await fs.mkdir(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, `${targetSessionId}.jsonl`);
    await fs.writeFile(
      filePath,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );
    return filePath;
  }

  async function writeRawTranscript(content: string): Promise<string> {
    const chatsDir = path.join(
      new Storage(workspaceDir).getProjectDir(),
      'chats',
    );
    await fs.mkdir(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  function record(
    uuid: string,
    parentUuid: string | null,
    text: string,
    targetSessionId = sessionId,
  ): ChatRecord {
    return {
      uuid,
      parentUuid,
      sessionId: targetSessionId,
      timestamp: `2026-01-01T00:00:0${text.length}.000Z`,
      type: uuid.startsWith('a') ? 'assistant' : 'user',
      cwd: workspaceDir,
      version: '1.0.0',
      message: {
        role: uuid.startsWith('a') ? 'model' : 'user',
        parts: [{ text }],
      },
    };
  }

  function encodeCursor(
    state: Parameters<typeof encodeSessionTranscriptCursor>[0],
  ): string {
    return encodeSessionTranscriptCursor(state, workspaceDir);
  }

  it('pages only the active parentUuid chain and skips abandoned branches', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'old assistant'),
      record('u2-old', 'a1', 'abandoned'),
      record('a2-old', 'u2-old', 'abandoned reply'),
      record('u2-new', 'a1', 'active'),
      record('a2-new', 'u2-new', 'active reply'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 2 });
    expect(first.nextCursorState).toBeDefined();
    const second = await reader.readPage(sessionId, {
      cursor: encodeCursor(first.nextCursorState!),
      limit: 2,
    });

    expect(first.records.map((r) => r.uuid)).toEqual(['u1', 'a1']);
    expect(first.hasMore).toBe(true);
    expect(second.records.map((r) => r.uuid)).toEqual(['u2-new', 'a2-new']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursorState).toBeUndefined();
  });

  it('continues a frozen snapshot after new records are appended', async () => {
    const filePath = await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
      record('u2', 'a1', 'second'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 2 });
    await fs.appendFile(
      filePath,
      JSON.stringify(record('a2', 'u2', 'late append')) + '\n',
      'utf8',
    );

    const second = await reader.readPage(sessionId, {
      cursor: encodeCursor(first.nextCursorState!),
      limit: 2,
    });

    expect(second.records.map((r) => r.uuid)).toEqual(['u2']);
    expect(second.hasMore).toBe(false);
  });

  it('rejects cursors from another session before touching transcript files', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    const otherSessionId = '660e8400-e29b-41d4-a716-446655440000';

    await expect(
      reader.readPage(otherSessionId, {
        cursor: encodeCursor(first.nextCursorState!),
      }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  it('rejects a cursor after the frozen snapshot is truncated', async () => {
    const filePath = await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
      record('u2', 'a1', 'second'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    await fs.truncate(filePath, 1);

    await expect(
      reader.readPage(sessionId, {
        cursor: encodeCursor(first.nextCursorState!),
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('rejects a cursor when the frozen file identity no longer matches', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
      record('u2', 'a1', 'second'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });

    await expect(
      reader.readPage(sessionId, {
        cursor: encodeCursor({
          ...first.nextCursorState!,
          fileIdentity: { dev: 999_999, ino: 999_999 },
        }),
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('rejects cursors whose position is past the active chain', async () => {
    await writeRecords([
      record('u1', null, 'root'),
      record('a1', 'u1', 'assistant'),
      record('u2', 'a1', 'second'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });

    await expect(
      reader.readPage(sessionId, {
        cursor: encodeCursor({
          ...first.nextCursorState!,
          position: 999,
        }),
      }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  it('terminates cyclic parentUuid chains without looping', async () => {
    await writeRecords([
      record('u1', 'a1', 'root'),
      record('a1', 'u1', 'assistant'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const page = await reader.readPage(sessionId, { limit: 10 });

    expect(page.records.map((r) => r.uuid)).toEqual(['u1', 'a1']);
    expect(page.hasMore).toBe(false);
  });

  it('aggregates multiple physical records for the same active uuid', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('u1', null, ' world'),
      record('a1', 'u1', 'reply'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const page = await reader.readPage(sessionId, { limit: 1 });

    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.uuid).toBe('u1');
    expect(page.records[0]?.message?.parts).toEqual([
      { text: 'hello' },
      { text: ' world' },
    ]);
    expect(page.hasMore).toBe(true);
  });

  it('marks missing parentUuid gaps without paging phantom uuids', async () => {
    await writeRecords([
      record('u2', 'missing-a1', 'tail'),
      record('a2', 'u2', 'tail reply'),
    ]);

    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });

    expect(first.records.map((r) => r.uuid)).toEqual(['u2']);
    expect(first.gaps).toEqual([
      { childUuid: 'u2', missingParentUuid: 'missing-a1' },
    ]);
    expect(first.hasMore).toBe(true);

    const second = await reader.readPage(sessionId, {
      cursor: encodeCursor(first.nextCursorState!),
      limit: 1,
    });
    expect(second.records.map((r) => r.uuid)).toEqual(['a2']);
    expect(second.gaps).toEqual([
      { childUuid: 'u2', missingParentUuid: 'missing-a1' },
    ]);
    expect(second.hasMore).toBe(false);
  });

  it('keeps cursors valid after the in-memory key cache is reset', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'reply'),
      record('u2', 'a1', 'next'),
    ]);

    const firstReader = new SessionTranscriptReader(workspaceDir);
    const first = await firstReader.readPage(sessionId, { limit: 1 });
    const cursor = encodeCursor(first.nextCursorState!);

    resetSessionTranscriptIndexCacheForTest();

    const secondReader = new SessionTranscriptReader(workspaceDir);
    const second = await secondReader.readPage(sessionId, {
      cursor,
      limit: 1,
    });

    expect(second.records.map((r) => r.uuid)).toEqual(['a1']);
    expect(second.hasMore).toBe(true);
  });

  it('rejects cursors signed for another workspace', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'reply'),
      record('u2', 'a1', 'next'),
    ]);
    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    const cursor = encodeCursor(first.nextCursorState!);
    const otherWorkspaceDir = path.join(runtimeDir, 'other-workspace');
    await fs.mkdir(otherWorkspaceDir, { recursive: true });
    const otherReader = new SessionTranscriptReader(otherWorkspaceDir);

    await expect(
      otherReader.readPage(sessionId, { cursor }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  it('does not duplicate same-uuid fragments parsed from one glued JSONL line', async () => {
    const first = record('u1', null, 'hello');
    const second = record('u1', null, ' world');
    await writeRawTranscript(
      `${JSON.stringify(first)}${JSON.stringify(second)}\n` +
        `${JSON.stringify(record('a1', 'u1', 'reply'))}\n`,
    );

    const reader = new SessionTranscriptReader(workspaceDir);
    const page = await reader.readPage(sessionId, { limit: 1 });

    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.message?.parts).toEqual([
      { text: 'hello' },
      { text: ' world' },
    ]);
  });

  it('raises snapshot-unavailable when a same-size in-place rewrite reuses a cached segment', async () => {
    const initial = `${JSON.stringify(record('u1', null, 'hello'))}\n`;
    const filePath = await writeRawTranscript(initial);
    const fixed = new Date('2026-02-02T02:02:02.000Z');
    await fs.utimes(filePath, fixed, fixed);
    const reader = new SessionTranscriptReader(workspaceDir);

    await expect(reader.readPage(sessionId)).resolves.toMatchObject({
      records: [expect.objectContaining({ uuid: 'u1' })],
    });

    // Keep the byte length and (forced) mtime so the cached index is reused,
    // but change the uuid so the recorded offset now parses to a different
    // record. The reader must surface 409, not silently drop the record.
    await fs.writeFile(
      filePath,
      initial.replace('"uuid":"u1"', '"uuid":"x1"'),
      'utf8',
    );
    await fs.utimes(filePath, fixed, fixed);

    await expect(reader.readPage(sessionId)).rejects.toBeInstanceOf(
      SessionTranscriptSnapshotUnavailableError,
    );
  });

  it('does not repeatedly copy pending bytes for one large record', async () => {
    const largeRecord = record('u1', null, 'x'.repeat(512 * 1024));
    const filePath = await writeRawTranscript(
      `${JSON.stringify(largeRecord)}\n`,
    );
    const snapshotSize = (await fs.stat(filePath)).size;
    const originalConcat = Buffer.concat;
    let copiedBytes = 0;
    const concatSpy = vi
      .spyOn(Buffer, 'concat')
      .mockImplementation((list, totalLength) => {
        copiedBytes += list.reduce((sum, buffer) => sum + buffer.length, 0);
        return originalConcat(list, totalLength);
      });

    try {
      const reader = new SessionTranscriptReader(workspaceDir);
      const page = await reader.readPage(sessionId);

      expect(page.records.map((r) => r.uuid)).toEqual(['u1']);
      expect(copiedBytes).toBeLessThan(snapshotSize * 2);
    } finally {
      concatSpy.mockRestore();
    }
  });

  it('rejects oversized snapshots before indexing', async () => {
    const filePath = await writeRecords([record('u1', null, 'hello')]);
    await fs.truncate(filePath, SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1);

    const reader = new SessionTranscriptReader(workspaceDir);
    await expect(reader.readPage(sessionId)).rejects.toMatchObject({
      name: 'SessionTranscriptTooLargeError',
      sessionId,
      snapshotSize: SESSION_TRANSCRIPT_MAX_INDEX_BYTES + 1,
      maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
    });
  });

  it('does not evict cached indexes when a new index exceeds the byte budget alone', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'reply'),
    ]);
    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    const warmCache = getSessionTranscriptIndexCacheStatsForTest();
    expect(warmCache.entries).toBe(1);
    setSessionTranscriptIndexCacheMaxBytesForTest(warmCache.byteSize + 1);

    const largeSessionId = '660e8400-e29b-41d4-a716-446655440000';
    const largeRecords: ChatRecord[] = [];
    let parentUuid: string | null = null;
    for (let i = 0; i < 20; i++) {
      const uuid = `large-${i}`;
      largeRecords.push(
        record(uuid, parentUuid, `large transcript ${i}`, largeSessionId),
      );
      parentUuid = uuid;
    }
    await writeRecords(largeRecords, largeSessionId);

    await reader.readPage(largeSessionId, { limit: 1 });
    const afterOversizedRead = getSessionTranscriptIndexCacheStatsForTest();
    expect(afterOversizedRead.entries).toBe(1);
    expect(afterOversizedRead.byteSize).toBe(warmCache.byteSize);

    const second = await reader.readPage(sessionId, {
      cursor: encodeCursor(first.nextCursorState!),
      limit: 1,
    });
    expect(second.records.map((r) => r.uuid)).toEqual(['a1']);
  });

  it('rejects path-like session ids before building a transcript path', async () => {
    const reader = new SessionTranscriptReader(workspaceDir);

    await expect(reader.readPage('../escape')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects tampered cursor snapshots before cache lookup', async () => {
    await writeRecords([
      record('u1', null, 'hello'),
      record('a1', 'u1', 'reply'),
      record('u2', 'a1', 'next'),
    ]);
    const reader = new SessionTranscriptReader(workspaceDir);
    const first = await reader.readPage(sessionId, { limit: 1 });
    const decoded = JSON.parse(
      Buffer.from(encodeCursor(first.nextCursorState!), 'base64url').toString(
        'utf8',
      ),
    ) as Record<string, unknown>;
    const tampered = Buffer.from(
      JSON.stringify({
        ...decoded,
        snapshotSize: 1,
      }),
      'utf8',
    ).toString('base64url');

    await expect(
      reader.readPage(sessionId, { cursor: tampered }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  // Regression: an in-place rewrite that keeps the inode AND byte length must
  // not be masked by the index cache (cache key includes the file mtime).
  it('reflects an in-place same-size rewrite once the mtime advances', async () => {
    const mk = (uuid: string, parentUuid: string | null): ChatRecord => ({
      uuid,
      parentUuid,
      sessionId,
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'user',
      cwd: workspaceDir,
      version: '1.0.0',
      message: { role: 'user', parts: [{ text: 'hello world' }] },
    });
    const filePath = await writeRecords([
      mk('11111111', null),
      mk('22222222', '11111111'),
    ]);
    const reader = new SessionTranscriptReader(workspaceDir);
    expect(
      (await reader.readPage(sessionId, { limit: 100 })).records.map(
        (r) => r.uuid,
      ),
    ).toEqual(['11111111', '22222222']);

    // Same inode, identical byte length (8-char uuids), new content + mtime.
    await fs.writeFile(
      filePath,
      [mk('33333333', null), mk('44444444', '33333333')]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
      'utf8',
    );
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(filePath, later, later);

    expect(
      (await reader.readPage(sessionId, { limit: 100 })).records.map(
        (r) => r.uuid,
      ),
    ).toEqual(['33333333', '44444444']);
  });
});
