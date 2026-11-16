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
import { SessionTranscriptReader } from './session-transcript-reader.js';

describe('session history media continuations', () => {
  let runtime: string;
  let workspace: string;
  let transcript: string;
  let sessionId: string;
  let service: SessionHistoryService;
  let tail: string | null;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    runtime = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-media-continuation-'),
    );
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
    const reader = new SessionTranscriptReader(workspace, undefined, runtime);
    service = new SessionHistoryService(
      () => reader,
      sessionId,
      () => 10000,
    );
  });

  afterEach(async () => {
    await fs.rm(runtime, { recursive: true, force: true });
  });

  async function append(type: ChatRecord['type'], part: Part) {
    const uuid = randomUUID();
    const record: ChatRecord = {
      uuid,
      parentUuid: tail,
      sessionId,
      type,
      timestamp: new Date().toISOString(),
      cwd: workspace,
      version: 'test',
      message: { role: type === 'assistant' ? 'model' : 'user', parts: [part] },
    };
    await fs.appendFile(transcript, JSON.stringify(record) + '\n');
    tail = uuid;
    return `${uuid}:0`;
  }

  it('keeps an ordinary recovery key searchable', async () => {
    await append('user', { text: 'RECOVERY_KEY_12345' });
    const result = await service.query(
      { action: 'search', query: 'RECOVERY_KEY_12345' },
      signal,
    );
    expect(JSON.parse(result).entries).toHaveLength(1);
    expect(result).toContain('RECOVERY_KEY_12345');
    expect(result).not.toContain('[Recorded media omitted]');
  });

  it.each(['text', 'response', 'json-response'] as const)(
    'redacts media keys without changing numeric evidence in %s',
    async (kind) => {
      const json =
        '{"data:image/png;base64,KEY_MEDIA_CANARY":"CACHE_HIT",' +
        '"request_id":9007199254740993,"evidence":"SIBLING_EVIDENCE"}';
      const part: Part =
        kind === 'text'
          ? { text: json }
          : {
              functionResponse: {
                name: 'read_file',
                response:
                  kind === 'json-response'
                    ? { output: json }
                    : {
                        'data:image/png;base64,KEY_MEDIA_CANARY': 'CACHE_HIT',
                        request_id: '9007199254740993',
                        evidence: 'SIBLING_EVIDENCE',
                      },
              },
            };
      const ref = await append(kind === 'text' ? 'user' : 'tool_result', part);
      const result = await service.query({ action: 'read', ref }, signal);
      expect(result).not.toContain('KEY_MEDIA_CANARY');
      expect(result).toContain('9007199254740993');
      expect(result).toContain('SIBLING_EVIDENCE');
      expect(
        JSON.parse(
          await service.query(
            { action: 'search', query: '9007199254740993' },
            signal,
          ),
        ).entries,
      ).toHaveLength(1);
      expect(
        JSON.parse(
          await service.query(
            { action: 'search', query: 'KEY_MEDIA_CANARY' },
            signal,
          ),
        ).entries,
      ).toEqual([]);
    },
  );

  const variants = [
    {
      name: 'space',
      text: 'BEFORE data:image/png;base64,iVBORw0KGgo AAAANSUhEUg AFTER_ERROR',
      payload: 'AAAANSUhEUg',
    },
    {
      name: 'JSON-escaped slash',
      text: String.raw`BEFORE data:image/png;base64,iVBORw0KGgo\/AAAASUVORK5CYII= AFTER_ERROR`,
      payload: 'AAAASUVORK5CYII',
    },
  ];

  for (const variant of variants) {
    it.each(['text', 'call', 'response', 'json-response'] as const)(
      `${variant.name} continuation in %s is omitted by list/read/search`,
      async (kind) => {
        const part: Part =
          kind === 'text'
            ? { text: variant.text }
            : kind === 'call'
              ? {
                  functionCall: {
                    name: 'read_file',
                    args: { text: variant.text, evidence: 'SIBLING_EVIDENCE' },
                  },
                }
              : {
                  functionResponse: {
                    name: 'read_file',
                    response:
                      kind === 'json-response'
                        ? {
                            output: JSON.stringify({
                              text: variant.text,
                              evidence: 'SIBLING_EVIDENCE',
                            }),
                          }
                        : { text: variant.text, evidence: 'SIBLING_EVIDENCE' },
                  },
                };
        const ref = await append(
          kind === 'response' || kind === 'json-response'
            ? 'tool_result'
            : 'user',
          part,
        );
        await append('user', { text: 'RECOVERY_KEY_12345' });
        for (const request of [
          { action: 'list' as const },
          { action: 'read' as const, ref },
          { action: 'search' as const, query: 'AFTER_ERROR' },
          { action: 'search' as const, query: variant.payload },
        ]) {
          const result = await service.query(request, signal);
          expect.soft(result).not.toContain(variant.payload);
          if (
            request.action === 'search' &&
            request.query === variant.payload
          ) {
            expect.soft(JSON.parse(result).entries).toEqual([]);
          } else if (request.action !== 'search') {
            expect.soft(result).toContain('[Recorded media omitted]');
            if (kind !== 'text')
              expect.soft(result).toContain('SIBLING_EVIDENCE');
          }
        }
        const recovery = await service.query(
          { action: 'search', query: 'RECOVERY_KEY_12345' },
          signal,
        );
        expect(recovery).toContain('RECOVERY_KEY_12345');
      },
    );
  }
});
