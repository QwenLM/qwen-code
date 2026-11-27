/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Part } from '@google/genai';
import { Storage } from '../config/storage.js';
import { CompressionStatus } from '../core/turn.js';
import type { ChatRecord } from './chatRecordingService.js';
import { SessionHistoryService } from './session-history-service.js';
import {
  SessionTranscriptReader,
  resetSessionTranscriptIndexCacheForTest,
} from './session-transcript-reader.js';
import {
  applySessionNotesRecord,
  type SessionNotesState,
} from './session-notes-state.js';
import { estimateContextTextTokens } from './tokenEstimation.js';

describe('session history projection', () => {
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
    vi.restoreAllMocks();
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

  it('identifies the start offset of a search preview near the end of an entry', async () => {
    await append('user', [{ text: 'x'.repeat(5000) + 'NEAR_END_MARKER' }]);
    const result = await service.query(
      { action: 'search', query: 'NEAR_END_MARKER' },
      signal,
    );
    const page = JSON.parse(result);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].text).toBe('x'.repeat(40) + 'NEAR_END_MARKER');
    expect(page.entries[0].start).toBe(4960);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });

  it('finds earlier-window evidence while excluding reasoning, internal notes and media bodies', async () => {
    const evidence = await append('tool_result', [
      {
        functionResponse: {
          name: 'read_file',
          id: 'read',
          response: {
            output: 'RECOVERY_KEY=canary',
            inline_data: {
              mime_type: 'image/png',
              data: 'SNAKE_BASE64_CANARY',
            },
            customMedia: { 'MEDIA-TYPE': 'audio/wav', source: 'AUDIO_CANARY' },
            content: [
              { type: 'image', data: 'hidden_base64', mimeType: 'image/png' },
            ],
            encrypted_content: 'private replay',
          },
          parts: [
            { inlineData: { mimeType: 'image/png', data: 'media_base64' } },
          ],
        },
      },
    ]);
    await append('assistant', [
      { thought: true, text: 'private reasoning' },
      { text: 'visible answer', thoughtSignature: 'secret_signature' },
    ]);
    await append('system', [], {
      subtype: 'chat_compression',
      systemPayload: {
        compressedHistory: [],
        info: {
          originalTokenCount: 1000,
          newTokenCount: 100,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      },
    });
    await append('system', [], {
      subtype: 'session_notes',
      systemPayload: {
        version: 1,
        windowId: evidence,
        sourceLeafUuid: evidence,
        text: 'private checkpoint',
      },
    });
    await append('assistant', [
      {
        functionCall: {
          name: 'session_notes',
          args: { action: 'write', text: 'recursive checkpoint' },
        },
      },
    ]);
    const page = JSON.parse(
      await service.query(
        { action: 'search', query: 'RECOVERY_KEY', role: 'tool' },
        signal,
      ),
    );
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].ref).toBe(`${evidence}:0`);
    const result = await service.query(
      { action: 'read', ref: page.entries[0].ref },
      signal,
    );
    expect(result).toContain('RECOVERY_KEY=canary');
    expect(result).toContain('media omitted');
    for (const hidden of [
      'SNAKE_BASE64_CANARY',
      'AUDIO_CANARY',
      'hidden_base64',
      'media_base64',
      'private replay',
      'secret_signature',
      'private reasoning',
      'private checkpoint',
      'recursive checkpoint',
    ]) {
      expect(
        await service.query({ action: 'search', query: hidden }, signal),
      ).not.toContain(hidden);
    }
    expect(
      JSON.parse(
        await service.query(
          { action: 'search', query: 'recovery_key' },
          signal,
        ),
      ).entries,
    ).toEqual([]);
  });

  it('reads relocated transcripts while preserving project-bound cursor validation', async () => {
    await append('user', [{ text: 'first' }]);
    await append('user', [{ text: 'second' }]);
    const first = JSON.parse(
      await service.query({ action: 'list', limit: 1 }, signal),
    );
    workspace = path.join(runtime, 'other-project');
    const next = path.join(
      new Storage(workspace, runtime).getProjectDir(),
      'chats',
      `${sessionId}.jsonl`,
    );
    await fs.mkdir(path.dirname(next), { recursive: true });
    await fs.rename(transcript, next);
    reader = new SessionTranscriptReader(workspace, undefined, runtime);
    expect(
      JSON.parse(
        await service.query(
          { action: 'read', ref: first.entries[0].ref },
          signal,
        ),
      ).entries[0].text,
    ).toBe('first');
    await expect(
      service.query({ action: 'list', cursor: first.nextCursor }, signal),
    ).rejects.toThrow('History cursor expired. Start a new list or search.');
    expect(
      JSON.parse(await service.query({ action: 'list' }, signal)).entries.map(
        (entry: { text: string }) => entry.text,
      ),
    ).toEqual(['first', 'second']);
  });

  it('bounds token probes for a large recorded entry by the response byte budget', async () => {
    const id = await append('user', [{ text: 'large text '.repeat(100000) }]);
    const byteLength = vi.spyOn(Buffer, 'byteLength');
    const result = JSON.parse(
      await service.query({ action: 'read', ref: `${id}:0` }, signal),
    );
    expect(result.entries[0].nextStart).toBeGreaterThan(0);
    expect(byteLength).toHaveBeenCalled();
    expect(
      Math.max(
        ...byteLength.mock.calls.flatMap(([text]) =>
          typeof text === 'string' && text.startsWith('{"entries":')
            ? [text.length]
            : [],
        ),
      ),
    ).toBeLessThan(17000);
  });

  it('paginates a frozen snapshot and preserves refs across ordinary compaction', async () => {
    for (let index = 0; index < 24; index++)
      await append('user', [{ text: `message ${index}` }]);
    const first = JSON.parse(
      await service.query({ action: 'list', limit: 2 }, signal),
    );
    expect(first.entries).toHaveLength(2);
    const ref = first.entries[0].ref;
    await append('system', [], {
      subtype: 'chat_compression',
      systemPayload: {
        compressedHistory: [],
        info: {
          originalTokenCount: 1000,
          newTokenCount: 100,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      },
    });
    const second = JSON.parse(
      await service.query(
        { action: 'list', cursor: first.nextCursor, limit: 2 },
        signal,
      ),
    );
    expect(second.entries.map((entry: { text: string }) => entry.text)).toEqual(
      ['message 2', 'message 3'],
    );
    expect(
      JSON.parse(await service.query({ action: 'read', ref }, signal))
        .entries[0].text,
    ).toBe('message 0');
    await expect(
      service.query(
        { action: 'search', query: 'changed', cursor: first.nextCursor },
        signal,
      ),
    ).rejects.toThrow('same action');
  });

  it('skips malformed trailing parts without changing valid history references', async () => {
    const id = await append('user', [
      { text: 'valid recorded text' },
      null,
      7,
      { text: 42 },
    ] as unknown as Part[]);
    const page = JSON.parse(await service.query({ action: 'list' }, signal));
    expect(page.entries).toEqual([
      { ref: `${id}:0`, role: 'user', text: 'valid recorded text' },
    ]);
    const reader = new SessionTranscriptReader(workspace, undefined, runtime);
    expect((await reader.readNotesState(sessionId)).latestUser).toEqual({
      uuid: id,
      text: 'valid recorded text',
    });
  });

  it('invalidates abandoned-branch cursors and references after rewind', async () => {
    const root = await append('user', [{ text: 'survives' }]);
    const abandoned = await append('user', [{ text: 'abandoned' }]);
    const first = JSON.parse(
      await service.query({ action: 'list', limit: 1 }, signal),
    );
    await append('system', [], {
      subtype: 'rewind',
      parentUuid: root,
      systemPayload: { truncatedCount: 1 },
    });
    await expect(
      service.query({ action: 'list', cursor: first.nextCursor }, signal),
    ).rejects.toThrow();
    await expect(
      service.query({ action: 'read', ref: `${abandoned}:0` }, signal),
    ).rejects.toThrow();
    expect(
      JSON.parse(
        await service.query({ action: 'search', query: 'abandoned' }, signal),
      ).entries,
    ).toEqual([]);
  });

  it('bounds CJK reads and supports exact text continuation without splitting surrogate pairs', async () => {
    const text = '汉字🙂'.repeat(3000);
    const id = await append('tool_result', [{ text }]);
    let start = 0;
    let reconstructed = '';
    for (;;) {
      const response = await service.query(
        { action: 'read', ref: `${id}:0`, start },
        signal,
      );
      expect(Buffer.byteLength(response)).toBeLessThanOrEqual(16384);
      expect(estimateContextTextTokens(response)).toBeLessThanOrEqual(2048);
      const entry = JSON.parse(response).entries[0];
      expect(entry.text).not.toMatch(/[\uD800-\uDBFF]$/u);
      reconstructed += entry.text;
      if (entry.nextStart === undefined) break;
      expect(entry.nextStart).toBeGreaterThan(start);
      start = entry.nextStart;
    }
    expect(reconstructed).toBe(text);
  });

  it('returns a continuation after a bounded scan with no match and obeys cancellation/headroom', async () => {
    for (let index = 0; index < 105; index++)
      await append('user', [
        { text: index === 104 ? 'late match' : `record ${index}` },
      ]);
    const first = JSON.parse(
      await service.query({ action: 'search', query: 'late match' }, signal),
    );
    expect(first.entries).toEqual([]);
    expect(first.partial).toBe(true);
    const last = JSON.parse(
      await service.query(
        { action: 'search', cursor: first.nextCursor },
        signal,
      ),
    );
    expect(last.entries[0].text).toBe('late match');
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      service.query({ action: 'list' }, cancelled.signal),
    ).rejects.toThrow();
    const lowBudget = new SessionHistoryService(
      () => new SessionTranscriptReader(workspace, undefined, runtime),
      sessionId,
      () => 50,
    );
    await expect(lowBudget.query({ action: 'list' }, signal)).rejects.toThrow(
      'Too little context',
    );
  });
  it('gives a current-branch error for a rewound history ref', async () => {
    const root = await append('user', [{ text: 'survives' }]);
    const abandoned = await append('user', [{ text: 'abandoned' }]);
    await append('system', [], {
      subtype: 'rewind',
      parentUuid: root,
      systemPayload: { truncatedCount: 1 },
    });
    await expect(
      service.query({ action: 'read', ref: `${abandoned}:0` }, signal),
    ).rejects.toThrow(
      'This reference is not available on the current session branch.',
    );
  });

  it('gives restart instructions for a rewound history cursor', async () => {
    const root = await append('user', [{ text: 'survives' }]);
    await append('user', [{ text: 'abandoned' }]);
    const first = JSON.parse(
      await service.query({ action: 'list', limit: 1 }, signal),
    );
    expect(first.nextCursor).toBeDefined();
    await append('system', [], {
      subtype: 'rewind',
      parentUuid: root,
      systemPayload: { truncatedCount: 1 },
    });
    await expect(
      service.query({ action: 'list', cursor: first.nextCursor }, signal),
    ).rejects.toThrow('History cursor expired. Start a new list or search.');
  });

  it('returns a valid first page before a later oversized record', async () => {
    const first = await append('user', [{ text: 'small record' }]);
    const oversized = await append('tool_result', [
      { text: 'x'.repeat(16 * 1024 * 1024) },
    ]);
    const page = await reader.readContextHistory(sessionId, { limit: 2 });
    expect(page.records.map((record) => record.uuid)).toEqual([first]);
    expect(page.nextOffset).toBe(1);
    await expect(
      reader.readContextHistory(sessionId, {
        snapshot: page.snapshot,
        offset: 1,
      }),
    ).resolves.toMatchObject({
      records: [],
      omittedOversizedRecords: 1,
      startOffset: 2,
    });
    await expect(
      reader.readContextHistory(sessionId, { recordId: oversized }),
    ).rejects.toThrow('exceeds');
  });

  it('replays the same latest real-user mention as the live reducer', async () => {
    await append('user', [{ text: 'original request' }]);
    const mention = await append('user', [{ text: 'new @worker constraint' }], {
      subtype: 'agent_mention',
      provenance: 'real_user',
    });
    const live: SessionNotesState = {};
    const records = (await fs.readFile(transcript, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatRecord);
    for (const record of records) applySessionNotesRecord(live, record);
    expect(live.latestUser?.uuid).toBe(mention);
    expect((await reader.readNotesState(sessionId)).latestUser).toEqual(
      live.latestUser,
    );
  });

  it('excludes internal notifications and cron from user history', async () => {
    const user = await append('user', [{ text: 'real prompt' }], {
      provenance: 'real_user',
    });
    await append('user', [{ text: 'background tool complete' }], {
      subtype: 'notification',
      provenance: 'system',
    });
    await append('user', [{ text: 'cron maintenance' }], {
      subtype: 'cron',
      provenance: 'system',
    });
    const page = JSON.parse(
      await service.query({ action: 'list', role: 'user' }, signal),
    );
    expect(page.entries).toEqual([
      { ref: `${user}:0`, role: 'user', text: 'real prompt' },
    ]);
    const search = JSON.parse(
      await service.query(
        { action: 'search', query: 'maintenance', role: 'user' },
        signal,
      ),
    );
    expect(search.entries).toEqual([]);
  });

  it('rejects a frozen prefix whose leaf changed after a same-inode rewrite', async () => {
    const root = await append('user', [{ text: 'root' }]);
    const leaf = await append('user', [{ text: 'leaf' }]);
    const page = await reader.readContextHistory(sessionId, { limit: 1 });
    const before = await fs.stat(transcript);
    const records = (await fs.readFile(transcript, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatRecord);
    const [rootRecord, leafRecord] = records;
    expect(rootRecord.uuid).toBe(root);
    const replacement = { ...leafRecord, uuid: randomUUID() };
    const prefix =
      JSON.stringify(rootRecord) + '\n' + JSON.stringify(replacement) + '\n';
    expect(Buffer.byteLength(prefix)).toBe(before.size);
    const rewritten =
      prefix +
      JSON.stringify({ ...leafRecord, parentUuid: replacement.uuid }) +
      '\n';
    await fs.writeFile(transcript, rewritten);
    expect((await fs.stat(transcript)).ino).toBe(before.ino);
    resetSessionTranscriptIndexCacheForTest();
    const current = await reader.readContextHistory(sessionId);
    expect(current.records.at(-1)?.uuid).toBe(leaf);
    await expect(
      reader.readContextHistory(sessionId, {
        snapshot: page.snapshot,
        offset: 1,
      }),
    ).rejects.toThrow();
  });
});
