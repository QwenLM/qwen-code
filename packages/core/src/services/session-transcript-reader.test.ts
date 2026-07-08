/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../config/storage.js';
import type { ChatRecord } from './chatRecordingService.js';
import {
  encodeSessionTranscriptCursor,
  InvalidSessionTranscriptCursorError,
  SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
  resetSessionTranscriptIndexCacheForTest,
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

  async function writeRecords(records: ChatRecord[]): Promise<string> {
    const chatsDir = path.join(
      new Storage(workspaceDir).getProjectDir(),
      'chats',
    );
    await fs.mkdir(chatsDir, { recursive: true });
    const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
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
  ): ChatRecord {
    return {
      uuid,
      parentUuid,
      sessionId,
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
});
