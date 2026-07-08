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
import { SessionTranscriptReader } from './session-transcript-reader.js';

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
    const second = await reader.readPage(sessionId, {
      cursor: first.nextCursor,
      limit: 2,
    });

    expect(first.records.map((r) => r.uuid)).toEqual(['u1', 'a1']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();
    expect(second.records.map((r) => r.uuid)).toEqual(['u2-new', 'a2-new']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
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
      cursor: first.nextCursor,
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
});
