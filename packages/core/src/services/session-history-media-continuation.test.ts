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

  const mediaJsonFields = [
    {
      name: 'inline_data',
      field: '"inline_data":{"mime_type":"image/png","data":"R9_MEDIA_CANARY"}',
    },
    {
      name: 'escaped inline_data key',
      field: String.raw`"inline\u005fdata":{"mime_type":"image/png","data":"R9_MEDIA_CANARY"}`,
    },
    {
      name: 'fileData',
      field: '"fileData":{"mimeType":"image/png","fileUri":"R9_MEDIA_CANARY"}',
    },
    { name: 'b64_json', field: '"b64_json":"R9_MEDIA_CANARY"' },
    {
      name: 'bytesBase64Encoded',
      field: '"bytesBase64Encoded":"R9_MEDIA_CANARY"',
    },
    {
      name: 'typed image',
      field: '"payload":{"type":"image","data":"R9_MEDIA_CANARY"}',
    },
    {
      name: 'MIME source',
      field: '"payload":{"mime_type":"audio/wav","source":"R9_MEDIA_CANARY"}',
    },
    {
      name: 'typed base64',
      field: '"payload":{"type":"base64","data":"R9_MEDIA_CANARY"}',
    },
    {
      name: 'array media item',
      field: '"payload":[{"type":"image","data":"R9_MEDIA_CANARY"}]',
    },
  ];

  for (const media of mediaJsonFields) {
    it.each(['text', 'read-file-output', 'mcp-text', 'nested-json'] as const)(
      `omits ${media.name} inside JSON strings in %s without changing evidence`,
      async (kind) => {
        const json =
          '{"request_id":9007199254740993,"amount":1.2300e+4,' +
          '"evidence":"SIBLING_JSON_EVIDENCE",' +
          media.field +
          '}';
        const part: Part =
          kind === 'text'
            ? { text: json }
            : kind === 'nested-json'
              ? { text: JSON.stringify({ encoded: json }) }
              : {
                  functionResponse: {
                    name: kind === 'mcp-text' ? 'mcp_read_asset' : 'read_file',
                    response:
                      kind === 'mcp-text'
                        ? { content: [{ type: 'text', text: json }] }
                        : { output: json },
                  },
                };
        const ref = await append(
          kind === 'text' || kind === 'nested-json' ? 'user' : 'tool_result',
          part,
        );
        for (const request of [
          { action: 'list' as const },
          { action: 'read' as const, ref },
          { action: 'search' as const, query: 'SIBLING_JSON_EVIDENCE' },
        ]) {
          const result = await service.query(request, signal);
          expect.soft(result).not.toContain('R9_MEDIA_CANARY');
          expect.soft(result).toContain('[Recorded media omitted]');
          if (request.action !== 'search') {
            expect.soft(result).toContain('9007199254740993');
            expect.soft(result).toContain('1.2300e+4');
          }
          expect.soft(result).toContain('SIBLING_JSON_EVIDENCE');
        }
        expect(
          JSON.parse(
            await service.query(
              { action: 'search', query: 'R9_MEDIA_CANARY' },
              signal,
            ),
          ).entries,
        ).toEqual([]);
      },
    );
  }

  it.each([
    '90071992547409931234567890',
    '1.2300e+4',
    '-0',
    '0.0000',
    '1e-999',
    '1e999',
  ])(
    'preserves numeric spelling %s when an adjacent JSON media field changes',
    async (literal) => {
      const json =
        `{"retained":${literal},"inline_data":{"data":"R9_NUMERIC_MEDIA_CANARY"},` +
        '"evidence":"NUMERIC_SIBLING_EVIDENCE"}';
      const ref = await append('tool_result', {
        functionResponse: { name: 'read_file', response: { output: json } },
      });
      const result = await service.query({ action: 'read', ref }, signal);
      const text = JSON.parse(result).entries[0].text as string;
      const projected = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
        output: string;
      };
      expect.soft(projected.output).toContain(`"retained":${literal}`);
      expect.soft(text).toContain('[Recorded media omitted]');
      expect.soft(text).toContain('NUMERIC_SIBLING_EVIDENCE');
      expect.soft(text).not.toContain('R9_NUMERIC_MEDIA_CANARY');
    },
  );

  it.each(['text', 'read-file-output'] as const)(
    'does not expose media when valid JSON exceeds the redactor stack in %s',
    async (kind) => {
      const json =
        '['.repeat(4000) +
        '{"inline_data":{"data":"DEEP_MEDIA_CANARY"},"evidence":"safe"}' +
        ']'.repeat(4000);
      expect(() => JSON.parse(json)).not.toThrow();
      const part: Part =
        kind === 'text'
          ? { text: json }
          : {
              functionResponse: {
                name: 'read_file',
                response: { output: json, evidence: 'OUTSIDE_DEEP_EVIDENCE' },
              },
            };
      const ref = await append(kind === 'text' ? 'user' : 'tool_result', part);
      const result = await service.query({ action: 'read', ref }, signal);
      expect.soft(result).not.toContain('DEEP_MEDIA_CANARY');
      expect(
        JSON.parse(
          await service.query(
            { action: 'search', query: '[Recorded media omitted]' },
            signal,
          ),
        ).entries,
      ).toHaveLength(1);
      if (kind === 'read-file-output') {
        expect(
          JSON.parse(
            await service.query(
              { action: 'search', query: 'OUTSIDE_DEEP_EVIDENCE' },
              signal,
            ),
          ).entries,
        ).toHaveLength(1);
      }
      expect(
        JSON.parse(
          await service.query(
            { action: 'search', query: 'DEEP_MEDIA_CANARY' },
            signal,
          ),
        ).entries,
      ).toEqual([]);
    },
  );

  it('keeps ordinary brace-prefixed text after a JSON syntax failure', async () => {
    const text = '{request failed: MALFORMED_LOG_RECOVERY_KEY';
    const ref = await append('user', { text });
    const result = await service.query({ action: 'read', ref }, signal);
    expect(JSON.parse(result).entries[0].text).toBe(text);
    expect(result).not.toContain('[Recorded media omitted]');
  });

  it.each([
    'screenshot data:image/png;base64,iVBORw0KGgoAAAA\nexit code 1: tests failed',
    'BEFORE data:image/png;base64,iVBORw0KGgo AAAANSUhEUg AFTER_ERROR',
  ])(
    'keeps the documented ambiguous inline-URL tail omitted: %j',
    async (text) => {
      const ref = await append('tool_result', {
        functionResponse: {
          name: 'read_file',
          response: { text, evidence: 'SEPARATE_FIELD_EVIDENCE' },
        },
      });
      const result = await service.query({ action: 'read', ref }, signal);
      expect(result).toContain('[Recorded media omitted]');
      expect(result).toContain('SEPARATE_FIELD_EVIDENCE');
      expect(result).not.toContain('iVBORw0KGgo');
      expect(result).not.toContain('AAAANSUhEUg');
      expect(result).not.toContain('tests failed');
      expect(result).not.toContain('AFTER_ERROR');
      expect(JSON.parse(result).entries[0].truncated).toBeUndefined();
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
