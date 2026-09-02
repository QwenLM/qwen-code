/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  projectChatRecordsToDaemonTranscript,
  TranscriptProjectionInputError,
} from '../../src/daemon/transcript.js';

function record(
  uuid: string,
  parentUuid: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    sessionId: 'session-1',
    timestamp: '2026-07-14T00:00:00.000Z',
    type: 'user',
    message: { role: 'user', parts: [{ text: uuid }] },
    ...overrides,
  };
}

describe('projectChatRecordsToDaemonTranscript', () => {
  it('projects the active branch with deterministic record boundaries', () => {
    const records = [
      record('root', null, {
        message: { role: 'user', parts: [{ text: 'hello' }] },
      }),
      record('abandoned', 'root', {
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'old answer' }] },
      }),
      record('active', 'root', {
        type: 'assistant',
        message: {
          role: 'model',
          parts: [{ text: 'thinking', thought: true }, { text: 'new answer' }],
        },
      }),
    ];

    const first = projectChatRecordsToDaemonTranscript(records);
    const second = projectChatRecordsToDaemonTranscript(records);
    expect(first).toEqual(second);
    expect(first.complete).toBe(true);
    expect(first.blocks.map((block) => block.kind)).toEqual([
      'user',
      'thought',
      'assistant',
    ]);
    expect(first.blocks.map((block) => block.sourceRecordIds)).toEqual([
      ['root'],
      ['active'],
      ['active'],
    ]);
    expect(first.blocks.every((block) => block.clientReceivedAt === 0)).toBe(
      true,
    );
    expect(
      first.blocks.every(
        (block) => !('meta' in block) || !block.meta?.['qwenTranscript'],
      ),
    ).toBe(true);
  });

  it('finalizes earlier assistant blocks when record boundaries prevent merging', () => {
    const projection = projectChatRecordsToDaemonTranscript([
      record('root', null),
      record('answer-1', 'root', {
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'first' }] },
      }),
      record('answer-2', 'answer-1', {
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'second' }] },
      }),
    ]);

    const assistantBlocks = projection.blocks.filter(
      (block) => block.kind === 'assistant',
    );
    expect(assistantBlocks).toHaveLength(2);
    expect(assistantBlocks.every((block) => block.streaming === false)).toBe(
      true,
    );
  });

  it('keeps image-only user records in separate provenance blocks', () => {
    const projection = projectChatRecordsToDaemonTranscript([
      record('image-1', null, {
        message: {
          role: 'user',
          parts: [{ inlineData: { data: 'a', mimeType: 'image/png' } }],
        },
      }),
      record('image-2', 'image-1', {
        message: {
          role: 'user',
          parts: [{ inlineData: { data: 'b', mimeType: 'image/png' } }],
        },
      }),
    ]);

    expect(projection.blocks.map((block) => block.sourceRecordIds)).toEqual([
      ['image-1'],
      ['image-2'],
    ]);
  });

  it('unions tool start and result provenance on one block', () => {
    const projection = projectChatRecordsToDaemonTranscript([
      record('root', null),
      record('tool-start', 'root', {
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: '__proto__',
                name: 'read_file',
                args: { path: '/tmp/a' },
              },
            },
          ],
        },
      }),
      record('tool-result', 'tool-start', {
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: '__proto__',
                name: 'read_file',
                response: { output: 'contents' },
              },
            },
          ],
        },
        toolCallResult: { callId: '__proto__', resultDisplay: 'contents' },
      }),
    ]);

    const tool = projection.blocks.find((block) => block.kind === 'tool');
    expect(tool).toMatchObject({
      kind: 'tool',
      toolCallId: '__proto__',
      status: 'completed',
      sourceRecordIds: ['tool-start', 'tool-result'],
    });
  });

  it('keeps Vision Bridge disclosure in rendered tool content', () => {
    const projection = projectChatRecordsToDaemonTranscript([
      record('tool-start', null, {
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'read-1',
                name: 'read_file',
                args: { path: '/tmp/a.pdf' },
              },
            },
          ],
        },
      }),
      record('tool-result', 'tool-start', {
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'read-1',
                name: 'read_file',
                response: { output: 'contents' },
              },
            },
          ],
        },
        toolCallResult: {
          callId: 'read-1',
          resultDisplay: {
            type: 'vision_bridge_notice',
            summary: 'Transcribed PDF pages 1-2',
            notice: 'Converted 2 images via qwen3-vl-plus.',
          },
        },
      }),
    ]);

    expect(projection.blocks.find((block) => block.kind === 'tool')).toEqual(
      expect.objectContaining({
        content: expect.arrayContaining([
          {
            type: 'content',
            content: {
              type: 'text',
              text:
                'Transcribed PDF pages 1-2\n' +
                'Converted 2 images via qwen3-vl-plus.',
            },
          },
        ]),
      }),
    );
  });

  it('treats persisted identifiers as data, including prototype names', () => {
    const identifiers = [
      '__proto__',
      'constructor',
      'prototype',
      'toString',
      'x'.repeat(8_192),
    ];
    const records: Record<string, unknown>[] = [record('__proto__', null)];
    let parentUuid = '__proto__';
    identifiers.forEach((callId, index) => {
      const startUuid = `start-${index}`;
      records.push(
        record(startUuid, parentUuid, {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: callId,
                  name: 'read_file',
                  args: {},
                },
              },
            ],
          },
        }),
      );
      const resultUuid = `result-${index}`;
      records.push(
        record(resultUuid, startUuid, {
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: callId,
                  name: 'read_file',
                  response: { output: 'ok' },
                },
              },
            ],
          },
          toolCallResult: { callId, resultDisplay: 'ok' },
        }),
      );
      parentUuid = resultUuid;
    });

    const projection = projectChatRecordsToDaemonTranscript(records);
    expect(
      projection.blocks
        .filter((block) => block.kind === 'tool')
        .map((block) => block.toolCallId),
    ).toEqual(identifiers);
    expect(projection.complete).toBe(true);
  });

  it('finalizes dangling tools as failed and marks the projection incomplete', () => {
    const projection = projectChatRecordsToDaemonTranscript([
      record('tool-start', null, {
        type: 'assistant',
        message: {
          role: 'model',
          parts: [{ functionCall: { name: 'read_file', args: {} } }],
        },
      }),
    ]);

    expect(projection.blocks[0]).toMatchObject({
      kind: 'tool',
      status: 'failed',
      toolCallId: 'qwen-replay-tool:tool-start:0',
    });
    expect(projection.complete).toBe(false);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'missing_tool_result',
        affectsCompleteness: true,
        recordId: 'tool-start',
      }),
    );
  });

  it('preserves assistant usage when the record ends with a tool call', () => {
    const projection = projectChatRecordsToDaemonTranscript([
      record('assistant', null, {
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            { text: 'I will read it' },
            {
              functionCall: {
                id: 'read-1',
                name: 'read_file',
                args: { path: '/tmp/a' },
              },
            },
          ],
        },
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 7,
        },
      }),
    ]);

    expect(
      projection.blocks.find((block) => block.kind === 'assistant'),
    ).toMatchObject({
      kind: 'assistant',
      text: 'I will read it',
      usage: { inputTokens: 11, outputTokens: 7, cachedTokens: 0 },
    });
  });

  it('preserves each todo plan snapshot as a separate block', () => {
    const projection = projectChatRecordsToDaemonTranscript([
      record('plan-1', null, {
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [{ functionResponse: { name: 'todo_write', response: {} } }],
        },
        toolCallResult: {
          callId: 'todo-1',
          resultDisplay: {
            type: 'todo_list',
            todos: [{ content: 'A', status: 'in_progress' }],
          },
        },
      }),
      record('plan-2', 'plan-1', {
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [{ functionResponse: { name: 'todo_write', response: {} } }],
        },
        toolCallResult: {
          callId: 'todo-2',
          resultDisplay: {
            type: 'todo_list',
            todos: [
              { content: 'A', status: 'completed' },
              { content: 'B', status: 'pending' },
            ],
          },
        },
      }),
    ]);

    const plans = projection.blocks.filter(
      (block) => block.kind === 'tool' && block.toolName === 'todo_write',
    );
    expect(plans).toHaveLength(2);
    expect(plans.map((block) => block.sourceRecordIds)).toEqual([
      ['plan-1'],
      ['plan-2'],
    ]);
    expect(new Set(plans.map((block) => block.toolCallId)).size).toBe(2);
  });

  it('does not merge a todo plan into a persisted daemon-plan tool id', () => {
    const projection = projectChatRecordsToDaemonTranscript([
      record('tool-start', null, {
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'daemon-plan',
                name: 'read_file',
                args: { path: '/tmp/a' },
              },
            },
          ],
        },
      }),
      record('tool-result', 'tool-start', {
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'daemon-plan',
                name: 'read_file',
                response: { output: 'contents' },
              },
            },
          ],
        },
        toolCallResult: { callId: 'daemon-plan', resultDisplay: 'contents' },
      }),
      record('plan', 'tool-result', {
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [{ functionResponse: { name: 'todo_write', response: {} } }],
        },
        toolCallResult: {
          callId: 'todo-1',
          resultDisplay: {
            type: 'todo_list',
            todos: [{ content: 'A', status: 'completed' }],
          },
        },
      }),
    ]);

    const tools = projection.blocks.filter((block) => block.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools).toContainEqual(
      expect.objectContaining({
        toolCallId: 'daemon-plan',
        toolName: 'read_file',
        rawInput: { path: '/tmp/a' },
        rawOutput: 'contents',
      }),
    );
    expect(tools).toContainEqual(
      expect.objectContaining({
        toolCallId: 'todo-1',
        toolName: 'todo_write',
        sourceRecordIds: ['plan'],
      }),
    );
  });

  it('returns diagnostics for gaps and partial input', () => {
    const projection = projectChatRecordsToDaemonTranscript([
      { broken: true },
      record('leaf', 'missing', {
        type: 'assistant',
        message: {
          role: 'model',
          parts: [null, { futurePart: true }, { text: 'kept' }],
        },
      }),
    ]);

    expect(projection.complete).toBe(false);
    expect(projection.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'invalid_record',
        'history_gap',
        'malformed_part',
        'unknown_record_or_part',
      ]),
    );
    expect(projection.blocks.at(-1)).toMatchObject({ text: 'kept' });
  });

  it('reports block and text truncation without scanning visible text', () => {
    const blocks = projectChatRecordsToDaemonTranscript(
      [
        record('root', null),
        record('answer', 'root', {
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'answer' }] },
        }),
      ],
      { maxBlocks: 1 },
    );
    expect(blocks).toMatchObject({ complete: false, truncated: true });
    expect(blocks.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'transcript_blocks_truncated',
      }),
    );

    const text = projectChatRecordsToDaemonTranscript([
      record('root', null, {
        message: { role: 'user', parts: [{ text: 'x'.repeat(100_001) }] },
      }),
    ]);
    expect(text).toMatchObject({ complete: false, truncated: true });
    expect(text.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'transcript_text_truncated',
        recordId: 'root',
        path: expect.stringMatching(/^blocks\./),
      }),
    );

    const boundary = projectChatRecordsToDaemonTranscript([
      record('root', null, {
        message: {
          role: 'user',
          parts: [{ text: 'x'.repeat(100_000) }, { text: 'lost' }],
        },
      }),
    ]);
    expect(boundary).toMatchObject({ complete: false, truncated: true });
    expect(boundary.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'transcript_text_truncated' }),
    );
  });

  it('returns an empty complete projection for empty and artifact-only input', () => {
    expect(projectChatRecordsToDaemonTranscript([])).toEqual({
      blocks: [],
      diagnostics: [],
      complete: true,
      truncated: false,
    });
    const artifact = projectChatRecordsToDaemonTranscript([
      record('artifact', null, {
        type: 'system',
        subtype: 'session_artifact_event',
        message: undefined,
      }),
    ]);
    expect(artifact.blocks).toEqual([]);
    expect(artifact.complete).toBe(true);
    expect(artifact.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'artifact_only' }),
    );
  });

  it('rejects invalid options, mixed sessions, and missing explicit leaves', () => {
    expect(() =>
      projectChatRecordsToDaemonTranscript([], { maxBlocks: 0 }),
    ).toThrowError(
      expect.objectContaining<Partial<TranscriptProjectionInputError>>({
        code: 'invalid_max_blocks',
      }),
    );
    expect(() =>
      projectChatRecordsToDaemonTranscript([
        record('a', null),
        record('b', 'a', { sessionId: 'session-2' }),
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<TranscriptProjectionInputError>>({
        code: 'mixed_session_ids',
      }),
    );
    expect(() =>
      projectChatRecordsToDaemonTranscript([record('a', null)], {
        leafUuid: 'missing',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<TranscriptProjectionInputError>>({
        code: 'leaf_not_found',
      }),
    );
    expect(() =>
      projectChatRecordsToDaemonTranscript([record('a', null)], {
        leafUuid: '',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<TranscriptProjectionInputError>>({
        code: 'leaf_not_found',
      }),
    );
  });
});
