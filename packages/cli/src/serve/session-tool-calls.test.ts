/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  SessionTranscriptCursorCodec,
  SessionTranscriptReader,
} from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core';
import * as historyReplay from '../acp-integration/session/history-replay-page.js';
import {
  readSessionToolCalls,
  SessionToolCallsLimitError,
  SessionToolCallsReplayError,
} from './session-tool-calls.js';

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const timestamp = '2026-09-21T08:00:00.000Z';
let directory: string;
let reader: SessionTranscriptReader;
const codec = new SessionTranscriptCursorCodec(Buffer.alloc(32, 7));

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-turn-calls-'));
  reader = new SessionTranscriptReader(directory, codec, directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

function record(
  uuid: string,
  fields: Record<string, unknown> = {},
): ChatRecord {
  return {
    uuid,
    parentUuid: null,
    sessionId,
    timestamp,
    type: 'user',
    cwd: '/workspace',
    version: '1.0.0',
    message: { role: 'user', parts: [{ text: uuid }] },
    ...fields,
  } as ChatRecord;
}
function call(uuid: string, id: string, name: string, args = {}): ChatRecord {
  return record(uuid, {
    type: 'assistant',
    message: { role: 'model', parts: [{ functionCall: { id, name, args } }] },
  });
}
function result(
  uuid: string,
  id: string,
  name: string,
  output: unknown,
): ChatRecord {
  return record(uuid, {
    type: 'tool_result',
    message: {
      role: 'user',
      parts: [{ functionResponse: { id, name, response: { output } } }],
    },
    toolCallResult: {
      callId: id,
      responseParts: [],
      resultDisplay: output,
    },
  });
}
async function write(records: ChatRecord[]) {
  const file = reader.getSessionFilePath(sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    records
      .map((entry, index) =>
        JSON.stringify({
          ...entry,
          parentUuid: records[index - 1]?.uuid ?? null,
        }),
      )
      .join('\n') + '\n',
  );
}
const read = () =>
  readSessionToolCalls({
    sessionId,
    turnId: 'turn-1',
    reader,
    codec,
    hasActivePrompt: () => false,
  });

it('keeps wrapped tool timings across real pages, ignores injections, and stops before the next prompt', async () => {
  await write([
    record('turn-1'),
    call('call-record', 'wrapped-call', 'tool_call', {
      name: 'mcp__db__query',
      arguments: { sql: 'select 1' },
    }),
    ...Array.from({ length: 248 }, (_, index) =>
      record(`filler-${index}`, {
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'working' }] },
      }),
    ),
    record('injected', { subtype: 'mid_turn_user_message' }),
    result('result-record', 'wrapped-call', 'tool_call', '{"answer":42}'),
    record('timing', {
      type: 'system',
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.tool_call',
          call_id: 'wrapped-call',
          function_name: 'mcp__db__query',
          started_at: 1000,
          duration_ms: 42,
          status: 'success',
        },
      },
    }),
    record('turn-2'),
    call('other-call', 'excluded', 'read_file'),
  ]);
  const readPage = vi.spyOn(reader, 'readPage');
  const events = await read();
  expect(readPage).toHaveBeenCalledTimes(2);
  const updates = events.map((event) => event.data);
  expect(updates).toContainEqual(
    expect.objectContaining({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'turn-1' },
    }),
  );
  expect(updates).toContainEqual(
    expect.objectContaining({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'wrapped-call',
      rawOutput: '{"answer":42}',
    }),
  );
  expect(updates).toContainEqual(
    expect.objectContaining({
      _meta: expect.objectContaining({
        timing: expect.objectContaining({
          callId: 'wrapped-call',
          toolName: 'mcp__db__query',
          startedAt: 1000,
          durationMs: 42,
        }),
      }),
    }),
  );
  expect(JSON.stringify(events)).not.toContain('excluded');
  expect(JSON.stringify(events)).not.toContain('working');
  expect(JSON.stringify(events)).not.toContain('injected');
});

it('returns agent summaries and keeps ordinary tool results intact', async () => {
  const replay = vi.spyOn(historyReplay, 'replayTranscriptRecordPage');
  await write([
    record('turn-1'),
    call('agent-call', 'agent-1', 'agent', {
      prompt: 'private long task',
      description: 'inspect',
    }),
    result('agent-result', 'agent-1', 'agent', {
      type: 'task_execution',
      status: 'completed',
      taskPrompt: 'private long task',
      toolCalls: [{ callId: 'child', toolName: 'read_file' }],
      summary: 'done',
    }),
    call('read-call', 'read-1', 'read_file', { file_path: '/tmp/result' }),
    result(
      'read-result',
      'read-1',
      'read_file',
      '{"complete":"ordinary output"}',
    ),
  ]);
  const events = await read();
  const beforeProjection: Awaited<
    ReturnType<typeof historyReplay.replayTranscriptRecordPage>
  > = await replay.mock.results[0].value;
  const agentResult = beforeProjection.updates.find(
    (update) =>
      'toolCallId' in update &&
      update.toolCallId === 'agent-1' &&
      'rawOutput' in update,
  );
  expect(
    agentResult && 'content' in agentResult && agentResult.content,
  ).toMatchObject([
    {
      type: 'content',
      content: {
        type: 'text',
        text: expect.stringContaining('private long task'),
      },
    },
  ]);
  const tool = events.find(
    (event) =>
      (event.data as Record<string, unknown>)['rawOutput'] &&
      (event.data as Record<string, unknown>)['toolCallId'] === 'agent-1',
  );
  expect(tool?.data).toMatchObject({
    rawOutput: { type: 'task_execution', status: 'completed', summary: 'done' },
    content: [],
  });
  expect(
    (tool?.data as Record<string, unknown>)['rawOutput'],
  ).not.toHaveProperty('toolCalls');
  expect(JSON.stringify(events)).not.toContain('private long task');
  expect(JSON.stringify(events)).toContain('ordinary output');
});

it.each([false, true])(
  'does not finalize a still-running tail call after scheduled boundary=%s',
  async (scheduled) => {
    await write([
      record('turn-1'),
      call('call', 'running', 'read_file'),
      ...(scheduled
        ? [
            record('cron', {
              subtype: 'cron',
              systemPayload: { displayText: 'Scheduled prompt' },
            }),
          ]
        : []),
    ]);
    const events = await readSessionToolCalls({
      sessionId,
      turnId: 'turn-1',
      reader,
      codec,
      hasActivePrompt: () => true,
    });
    expect(events.map((event) => event.data)).not.toContainEqual(
      expect.objectContaining({ toolCallId: 'running', status: 'failed' }),
    );
  },
);

it('rejects an unknown turn and a page from another session', async () => {
  await write([record('other')]);
  await expect(read()).rejects.toThrow('Invalid transcript turn anchor');
  await write([record('turn-1')]);
  const original = reader.readPage.bind(reader);
  vi.spyOn(reader, 'readPage').mockImplementation(async (...args) => {
    const page = await original(...args);
    return {
      ...page,
      records: page.records.map((entry) => ({
        ...entry,
        sessionId: 'foreign',
      })),
    };
  });
  await expect(read()).rejects.toThrow('snapshot is unavailable');
});

it('fails explicitly when pagination never completes', async () => {
  await write([record('turn-1')]);
  const original = reader.readPage.bind(reader);
  const page = await original(sessionId);
  vi.spyOn(reader, 'readPage').mockImplementation(
    async (_sessionId, options) => ({
      ...page,
      records: options?.cursor ? [] : page.records,
      hasMore: true,
      nextCursorState: {
        v: 1,
        sessionId,
        fileIdentity: { dev: 1, ino: 1, birthtimeMs: 1 },
        snapshotSize: 1,
        position: 1,
        leafUuid: 'turn-1',
        startTime: timestamp,
        lastUpdated: timestamp,
      },
    }),
  );
  let position = 0;
  const advancingCodec = { encode: () => `cursor-${position++}` };
  await expect(
    readSessionToolCalls({
      sessionId,
      turnId: 'turn-1',
      reader,
      codec: advancingCodec,
      hasActivePrompt: () => false,
    }),
  ).rejects.toBeInstanceOf(SessionToolCallsLimitError);
});

it('rejects partial replay instead of returning a successful partial list', async () => {
  await write([record('turn-1')]);
  vi.spyOn(historyReplay, 'replayTranscriptRecordPage').mockResolvedValue({
    updates: [],
    hasMore: false,
    partial: true,
    replayError: 'broken',
    startTime: timestamp,
    lastUpdated: timestamp,
  });
  await expect(read()).rejects.toThrow(SessionToolCallsReplayError);
});

it('uses navigation boundaries for ordinary prompts and consecutive visible scheduled prompts', async () => {
  await write([
    record('turn-1'),
    call('normal-call', 'normal', 'read_file'),
    result('normal-result', 'normal', 'read_file', 'normal output'),
    record('scheduled-1', {
      subtype: 'cron',
      systemPayload: { displayText: 'First scheduled prompt' },
    }),
    call('scheduled-call-1', 'scheduled-tool-1', 'read_file'),
    result(
      'scheduled-result-1',
      'scheduled-tool-1',
      'read_file',
      'first schedule output',
    ),
    record('hidden-cron', {
      subtype: 'cron',
      systemPayload: { displayText: '' },
    }),
    call('after-hidden', 'same-schedule', 'read_file'),
    result(
      'after-hidden-result',
      'same-schedule',
      'read_file',
      'same schedule output',
    ),
    record('scheduled-2', {
      subtype: 'cron',
      systemPayload: { displayText: 'Second scheduled prompt' },
    }),
    call('scheduled-call-2', 'scheduled-tool-2', 'read_file'),
    result(
      'scheduled-result-2',
      'scheduled-tool-2',
      'read_file',
      'second schedule output',
    ),
  ]);
  const index = await reader.readTurnIndexPage(sessionId);
  expect(index.turns.map((turn) => turn.turnId)).toEqual([
    'turn-1',
    'scheduled-1',
    'scheduled-2',
  ]);
  for (const [turnId, expectedIds] of [
    ['turn-1', ['normal']],
    ['scheduled-1', ['scheduled-tool-1', 'same-schedule']],
    ['scheduled-2', ['scheduled-tool-2']],
  ] as const) {
    const events = await readSessionToolCalls({
      sessionId,
      turnId,
      reader,
      codec,
      hasActivePrompt: () => false,
    });
    const calls = events
      .map((event) => event.data as Record<string, unknown>)
      .filter((update) => update['sessionUpdate'] === 'tool_call');
    expect(calls.map((update) => update['toolCallId'])).toEqual(expectedIds);
    expect(events.map((event) => event.data)).toContainEqual(
      expect.objectContaining({
        sessionUpdate: 'user_message_chunk',
        _meta: expect.objectContaining({
          qwenTranscript: expect.objectContaining({
            sourceRecordIds: [turnId],
          }),
        }),
      }),
    );
  }
});

it.each(['cron', 'realtime_message'] as const)(
  'pairs late results and timing with calls begun before %s boundaries across pages',
  async (subtype) => {
    const timing = (id: string, duration: number) =>
      record(`timing-${id}`, {
        type: 'system',
        subtype: 'ui_telemetry',
        systemPayload: {
          uiEvent: {
            'event.name': 'qwen-code.tool_call',
            call_id: id,
            function_name: 'read_file',
            duration_ms: duration,
            started_at: 1000,
            status: 'success',
          },
        },
      });
    await write([
      record('turn-1'),
      call('a1', 'call-1', 'read_file', { file_path: '/first' }),
      record('cron-1', {
        subtype,
        systemPayload: { displayText: 'First scheduled prompt' },
      }),
      call('a2', 'call-2', 'read_file', { file_path: '/second' }),
      ...Array.from({ length: 246 }, (_, index) =>
        record(`waiting-${index}`, {
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'waiting' }] },
        }),
      ),
      result('r1', 'call-1', 'read_file', 'first result'),
      timing('call-1', 42),
      record('cron-2', {
        subtype,
        systemPayload: { displayText: 'Second scheduled prompt' },
      }),
      result('r2', 'call-2', 'read_file', 'second result'),
      timing('call-2', 64),
      call('a3', 'call-3', 'read_file'),
      result('r3', 'call-3', 'read_file', 'third result'),
      record('next-prompt'),
      call('excluded', 'excluded', 'read_file'),
    ]);
    for (const [turnId, callId, output, duration] of [
      ['turn-1', 'call-1', 'first result', 42],
      ['cron-1', 'call-2', 'second result', 64],
      ['cron-2', 'call-3', 'third result', undefined],
    ] as const) {
      const updates = (
        await readSessionToolCalls({
          sessionId,
          turnId,
          reader,
          codec,
          hasActivePrompt: () => false,
        })
      ).map((event) => event.data as Record<string, unknown>);
      expect(
        updates
          .filter((update) => update['sessionUpdate'] === 'tool_call')
          .map((update) => update['toolCallId']),
      ).toEqual([callId]);
      expect(
        updates.filter(
          (update) => update['sessionUpdate'] === 'tool_call_update',
        ),
      ).toEqual([
        expect.objectContaining({
          toolCallId: callId,
          status: 'completed',
          rawOutput: output,
        }),
      ]);
      if (duration !== undefined)
        expect(updates).toContainEqual(
          expect.objectContaining({
            _meta: expect.objectContaining({
              timing: expect.objectContaining({ callId, durationMs: duration }),
            }),
          }),
        );
    }
  },
);

it.each([false, true])(
  'keeps agent failure diagnostics with structured summary=%s',
  async (structured) => {
    await write([
      record('turn-1'),
      call('agent-call', 'agent-1', 'agent', { description: 'inspect' }),
      record('agent-error', {
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'agent-1',
                name: 'agent',
                response: { error: 'Agent launch failed' },
              },
            },
          ],
        },
        toolCallResult: {
          callId: 'agent-1',
          responseParts: [],
          error: { message: 'Agent launch failed' },
          status: 'error',
          ...(structured
            ? {
                resultDisplay: {
                  type: 'task_execution',
                  status: 'failed',
                  terminateReason: 'error',
                },
              }
            : {}),
        },
      }),
    ]);
    const events = await read();
    expect(events.map((event) => event.data)).toContainEqual(
      expect.objectContaining({ toolCallId: 'agent-1', status: 'failed' }),
    );
    expect(JSON.stringify(events)).toContain('Agent launch failed');
  },
);

it('rejects an oversized replay segment before materializing its events', async () => {
  await write([record('turn-1'), call('later', 'later', 'read_file')]);
  const page = await reader.readPage(sessionId, { limit: 1 });
  const payload = 'x'.repeat(1024 * 1024);
  vi.spyOn(reader, 'readPage').mockResolvedValue({
    ...page,
    records: [
      record('turn-1', {
        message: { role: 'user', parts: [{ text: payload }] },
      }),
    ],
  });
  const replay = vi.spyOn(historyReplay, 'replayTranscriptRecordPage');
  let position = 0;
  await expect(
    readSessionToolCalls({
      sessionId,
      turnId: 'turn-1',
      reader,
      codec: { encode: () => `cursor-${position++}` },
      hasActivePrompt: () => false,
    }),
  ).rejects.toThrow('replay scan exceeds its byte budget');
  expect(replay).not.toHaveBeenCalled();
});
