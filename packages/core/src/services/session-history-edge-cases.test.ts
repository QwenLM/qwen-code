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
    await append('user', [{ text: 'FIRST ' + '中'.repeat(5000) }]);
    await append('user', [{ text: 'SECOND ' + '中'.repeat(5000) }]);
    const first = JSON.parse(await service.query({ action: 'list' }, signal));
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({ truncated: true });
    expect(first.entries[0].text).toContain('FIRST');
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = JSON.parse(
      await service.query({ action: 'list', cursor: first.nextCursor }, signal),
    );
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].text).toContain('SECOND');
    expect(second.nextCursor).toBeUndefined();
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
      'data:text/plain;charset=utf-8;base64,' + 'YWJj'.repeat(1000),
      'DATA:image/png;BASE64,' + 'YWJj'.repeat(1000),
      'data:image/svg+xml;charset=utf-8,' + '<svg>YWJjYWJj</svg>',
      { b64_json: 'YWJj'.repeat(1000) },
      { bytesBase64Encoded: 'YWJj'.repeat(1000) },
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
            response: { media, error: 'HTTP_500_EVIDENCE' },
          },
        },
      ]);
      const raw = await service.query(
        { action: 'read', ref: ref + ':0' },
        signal,
      );
      expect.soft(raw).not.toContain('YWJjYWJj');
      expect.soft(raw).toContain('HTTP_500_EVIDENCE');
      expect(JSON.parse(raw).entries[0].truncated).toBeUndefined();
    }
  });
  it('omits a typed media URL in a text part without hiding plain text', async () => {
    const media = await append('user', [
      { text: 'DATA:image/png;charset=utf-8;BASE64,' + 'YWJj'.repeat(1000) },
    ]);
    const text = await append('user', [{ text: 'RECOVERY_KEY_12345' }]);
    expect(
      await service.query({ action: 'read', ref: media + ':0' }, signal),
    ).not.toContain('YWJjYWJj');
    expect(
      await service.query({ action: 'read', ref: text + ':0' }, signal),
    ).toContain('RECOVERY_KEY_12345');
  });

  it.each(['text', 'call', 'response'] as const)(
    'redacts embedded media URIs in %s while retaining surrounding evidence',
    async (kind) => {
      const text =
        'BEFORE ![image](DATA:image/png;BASE64,' +
        'YWJj'.repeat(1000) +
        ') AFTER_ERROR <a href="data:text/plain;charset=utf-8;base64,' +
        'YWJj'.repeat(1000) +
        '">artifact</a> FINAL_EVIDENCE';
      const part: Part =
        kind === 'text'
          ? { text }
          : kind === 'call'
            ? { functionCall: { name: 'read_file', args: { text } } }
            : { functionResponse: { name: 'read_file', response: { text } } };
      const ref = await append(kind === 'response' ? 'tool_result' : 'user', [
        part,
      ]);
      for (const request of [
        { action: 'list' as const },
        { action: 'read' as const, ref: `${ref}:0` },
        { action: 'search' as const, query: 'AFTER_ERROR' },
      ]) {
        const result = await service.query(request, signal);
        expect(result).not.toContain('YWJj');
        expect(result).toContain('[Recorded media omitted]');
        if (request.action !== 'search') expect(result).toContain('BEFORE');
        expect(result).toContain('AFTER_ERROR');
        expect(result).toContain('FINAL_EVIDENCE');
      }
      expect(
        JSON.parse(
          await service.query({ action: 'search', query: 'YWJj' }, signal),
        ).entries,
      ).toEqual([]);
    },
  );

  it('omits ambiguous raw media fields and preserves sibling evidence', async () => {
    const raw =
      'BEFORE data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><svg></svg><text>RAW_MEDIA_CANARY</text></svg> AFTER';
    const ref = await append('tool_result', [
      {
        functionResponse: {
          name: 'read_file',
          response: { raw, error: 'HTTP_500_EVIDENCE' },
        },
      },
    ]);
    const result = await service.query(
      { action: 'read', ref: `${ref}:0` },
      signal,
    );
    expect(result).not.toContain('RAW_MEDIA_CANARY');
    expect(result).not.toContain('<svg');
    expect(result).toContain('[Recorded media omitted]');
    expect(result).toContain('HTTP_500_EVIDENCE');
  });

  it.each(['\n', '\r', '\t'])(
    'omits base64 URL payloads with embedded URL whitespace %j',
    async (separator) => {
      const ref = await append('user', [
        {
          text: `BEFORE data:text/plain;base64,YWJj${separator}YWJjYWJj AFTER_ERROR`,
        },
      ]);
      const result = await service.query(
        { action: 'read', ref: `${ref}:0` },
        signal,
      );
      expect(result).not.toContain('YWJj');
      expect(result).toContain('BEFORE');
      expect(result).toContain('AFTER_ERROR');
    },
  );

  it('keeps large ordinary text containing repeated data prefixes searchable', async () => {
    await append('user', [
      { text: 'data:'.repeat(200000) + ' RECOVERY_PREFIX_KEY' },
    ]);
    const result = await service.query(
      { action: 'search', query: 'RECOVERY_PREFIX_KEY' },
      signal,
    );
    expect(result).toContain('RECOVERY_PREFIX_KEY');
    expect(result).not.toContain('[Recorded media omitted]');
  });

  it('rejects empty cursors and queries supplied to list', async () => {
    await append('user', [{ text: 'ordinary evidence' }]);
    await expect(
      service.query({ action: 'list', cursor: '' }, signal),
    ).rejects.toThrow('History cursor expired');
    await expect(
      service.query({ action: 'list', query: 'missing' }, signal),
    ).rejects.toThrow('Use search');
    expect(
      JSON.parse(await service.query({ action: 'list' }, signal)).entries,
    ).toHaveLength(1);
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
