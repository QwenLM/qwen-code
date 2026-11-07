/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Part } from '@google/genai';
import { Storage } from '../config/storage.js';
import type { ChatRecord } from './chatRecordingService.js';
import { SessionHistoryService } from './session-history-service.js';
import {
  InvalidSessionTranscriptCursorError,
  SessionTranscriptReader,
  SessionTranscriptSnapshotUnavailableError,
} from './session-transcript-reader.js';

describe('history snapshot and paging boundaries', () => {
  let runtime: string;
  let workspace: string;
  let transcript: string;
  let sessionId: string;
  let service: SessionHistoryService;
  let reader: SessionTranscriptReader;
  let tail: string | null;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-history-unit-'));
    workspace = path.join(runtime, 'workspace');
    sessionId = randomUUID();
    tail = null;
    const storage = new Storage(workspace, runtime);
    transcript = path.join(
      storage.getProjectDir(),
      'chats',
      `${sessionId}.jsonl`,
    );
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    reader = new SessionTranscriptReader(workspace, undefined, runtime);
    service = new SessionHistoryService(
      () => reader,
      sessionId,
      () => 10000,
    );
  });

  afterEach(async () => {
    await fs.rm(runtime, { recursive: true, force: true });
  });

  async function append(
    type: ChatRecord['type'],
    parts: Part[],
    extra: Partial<ChatRecord> = {},
  ) {
    const record: ChatRecord = {
      uuid: randomUUID(),
      parentUuid: tail,
      sessionId,
      type,
      timestamp: new Date().toISOString(),
      cwd: workspace,
      version: 'test',
      message: { role: type === 'assistant' ? 'model' : 'user', parts },
      ...extra,
    };
    await fs.appendFile(transcript, JSON.stringify(record) + '\n');
    tail = record.uuid;
    return record.uuid;
  }

  it('empty history snapshot stays empty after a user record is appended', async () => {
    await append('system', [], {
      subtype: 'session_sources_snapshot',
      systemPayload: { version: 1, revision: 1, sources: [] },
    });
    const empty = await reader.readContextHistory(sessionId, { offset: 0 });
    expect(empty.records).toEqual([]);
    expect(empty.nextOffset).toBeUndefined();
    expect(empty.gaps).toEqual([]);
    await append('user', [
      { text: 'new user outside the frozen empty snapshot' },
    ]);
    expect((await reader.readContextHistory(sessionId)).records).toHaveLength(
      1,
    );
    const frozen = await reader.readContextHistory(sessionId, {
      snapshot: empty.snapshot,
    });
    expect(frozen.records).toEqual([]);
    expect(frozen.snapshot).toBe(empty.snapshot);
  });

  it('empty transcript rejects missing notes leaf and invalid history offsets', async () => {
    await append('system', [], {
      subtype: 'session_sources_snapshot',
      systemPayload: { version: 1, revision: 1, sources: [] },
    });
    await expect(
      reader.readNotesState(sessionId, 'missing-leaf'),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
    await expect(reader.readNotesState(sessionId)).resolves.toEqual({});
    for (const offset of [1, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        reader.readContextHistory(sessionId, { offset }),
      ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
    }
    await expect(
      reader.readContextHistory(sessionId, { recordId: 'missing-record' }),
    ).rejects.toBeInstanceOf(InvalidSessionTranscriptCursorError);
  });

  it('emits a CJK preview and advances at a 400-token budget', async () => {
    service = new SessionHistoryService(
      () => reader,
      sessionId,
      () => 400,
    );
    await append('user', [{ text: '中'.repeat(5000) }]);
    let page = JSON.parse(await service.query({ action: 'list' }, signal));
    for (let i = 0; i < 2 && page.nextCursor; i++) {
      page = JSON.parse(
        await service.query(
          { action: 'list', cursor: page.nextCursor },
          signal,
        ),
      );
    }
    expect(page.entries).toHaveLength(1);
  });
  it('pages to evidence after an oversized record', async () => {
    await append('user', [{ text: 'before' }]);
    await append('tool_result', [
      {
        functionResponse: {
          name: 'read_file',
          id: 'big',
          response: { output: 'X'.repeat(16 * 1024 * 1024 + 2048) },
        },
      },
    ]);
    await append('user', [{ text: 'AFTER-OVERSIZED-KEY' }]);
    let page = JSON.parse(await service.query({ action: 'list' }, signal));
    const cursor = page.nextCursor;
    const outcomes = [];
    for (let i = 0; i < 2; i++) {
      try {
        page = JSON.parse(
          await service.query({ action: 'list', cursor }, signal),
        );
        outcomes.push(page);
      } catch (error) {
        outcomes.push(String(error));
      }
    }
    expect(JSON.stringify(outcomes)).toContain('AFTER-OVERSIZED-KEY');
  });
  it('omits raw provider video and base64 media bodies', async () => {
    for (const media of [
      { type: 'video', data: 'YWJj'.repeat(1000) },
      { type: 'video_url', video_url: { url: 'YWJj'.repeat(1000) } },
      {
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'YWJj'.repeat(1000),
        },
      },
    ]) {
      const ref = await append('tool_result', [
        {
          functionResponse: {
            name: 'read_file',
            id: randomUUID(),
            response: { media },
          },
        },
      ]);
      const raw = await service.query(
        { action: 'read', ref: ref + ':0' },
        signal,
      );
      expect.soft(raw).not.toContain('YWJjYWJj');
    }
  });
  it('exposes the actual literal search hit after a long prefix', async () => {
    await append('tool_result', [
      {
        functionResponse: {
          name: 'read_file',
          id: 'long',
          response: { output: 'HEADER '.repeat(22000) + 'RECOVERY_KEY=end' },
        },
      },
    ]);
    const page = JSON.parse(
      await service.query({ action: 'search', query: 'RECOVERY_KEY' }, signal),
    );
    expect(page.entries[0].text).toContain('RECOVERY_KEY');
  });
  it('returns empty history for a sources-only transcript', async () => {
    await append('system', [], {
      subtype: 'session_sources_snapshot',
      systemPayload: { version: 1, revision: 1, sources: [] },
    });
    const page = JSON.parse(await service.query({ action: 'list' }, signal));
    expect(page.entries).toEqual([]);
  });
});
