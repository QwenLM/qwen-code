/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createTranscriptReplayMachine,
  MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE,
  type TranscriptReplayStateV1,
} from './transcript-replay.js';
import type { TranscriptRecordInput } from '@qwen-code/qwen-code-core/transcriptRecords';

function record(
  uuid: string,
  type: TranscriptRecordInput['type'],
  overrides: Partial<TranscriptRecordInput> = {},
): TranscriptRecordInput {
  return {
    uuid,
    parentUuid: null,
    sessionId: 'session-1',
    timestamp: '2026-07-14T00:00:00.000Z',
    type,
    ...overrides,
  };
}

function updates(
  machine: ReturnType<typeof createTranscriptReplayMachine>,
  item: TranscriptRecordInput,
) {
  return [...machine.project(item)].map((emission) => emission.update);
}

describe('createTranscriptReplayMachine', () => {
  it('projects ordered message parts with source metadata', () => {
    const machine = createTranscriptReplayMachine();
    const projected = updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [{ text: 'thinking', thought: true }, { text: 'answer' }],
        },
      }),
    );

    expect(projected.map((update) => update.sessionUpdate)).toEqual([
      'agent_thought_chunk',
      'agent_message_chunk',
    ]);
    expect(projected[0]?._meta).toMatchObject({
      timestamp: Date.parse('2026-07-14T00:00:00.000Z'),
      qwenTranscript: { sourceRecordIds: ['assistant-1'] },
    });
  });

  it('uses stable synthetic ids and finalizes dangling calls once', () => {
    const onDiagnostic = vi.fn();
    const machine = createTranscriptReplayMachine({ onDiagnostic });
    const projected = updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [{ functionCall: { name: 'read_file', args: {} } }],
        },
      }),
    );

    expect(projected[0]).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'qwen-replay-tool:assistant-1:0',
    });
    const finalized = [...machine.finalize()].map((item) => item.update);
    expect(finalized[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'qwen-replay-tool:assistant-1:0',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: MISSING_TRANSCRIPT_TOOL_RESULT_MESSAGE,
          },
        },
      ],
    });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'missing_tool_result',
        affectsCompleteness: true,
        recordId: 'assistant-1',
      }),
    );
    expect([...machine.finalize()]).toEqual([]);
  });

  it('correlates an id-less result only to one same-name pending call', () => {
    const machine = createTranscriptReplayMachine();
    updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [
            { functionCall: { name: 'read_file', args: {}, id: 'call-1' } },
          ],
        },
      }),
    );
    const result = updates(
      machine,
      record('result-1', 'tool_result', {
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: { output: 'contents' },
              },
            },
          ],
        },
      }),
    );

    expect(result[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
    });
    expect(machine.snapshot().pendingToolCalls).toEqual([]);
  });

  it('reports ambiguous same-name result correlation', () => {
    const onDiagnostic = vi.fn();
    const machine = createTranscriptReplayMachine({ onDiagnostic });
    updates(
      machine,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [
            { functionCall: { name: 'read_file', args: {}, id: 'call-1' } },
            { functionCall: { name: 'read_file', args: {}, id: 'call-2' } },
          ],
        },
      }),
    );
    const result = updates(
      machine,
      record('result-1', 'tool_result', {
        message: {
          role: 'user',
          parts: [{ functionResponse: { name: 'read_file', response: {} } }],
        },
      }),
    );

    expect(result[0]).toMatchObject({
      toolCallId: 'qwen-replay-tool:result-1:result',
    });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ambiguous_tool_call_correlation',
        affectsCompleteness: true,
      }),
    );
  });

  it('carries versioned state across pages and rejects unknown versions', () => {
    const first = createTranscriptReplayMachine();
    updates(
      first,
      record('assistant-1', 'assistant', {
        message: {
          role: 'model',
          parts: [
            { functionCall: { name: 'read_file', args: {}, id: 'call-1' } },
          ],
        },
      }),
    );

    const second = createTranscriptReplayMachine({
      initialState: first.snapshot(),
    });
    expect(second.snapshot()).toEqual(first.snapshot());
    expect(() =>
      createTranscriptReplayMachine({
        initialState: { v: 2 } as unknown as TranscriptReplayStateV1,
      }),
    ).toThrow('Unsupported transcript replay state version');
  });

  it('emits gaps, todo plans, and cumulative usage deterministically', () => {
    const machine = createTranscriptReplayMachine({
      gaps: [{ childUuid: 'assistant-1', missingParentUuid: 'missing' }],
    });
    const assistant = updates(
      machine,
      record('assistant-1', 'assistant', {
        message: { role: 'model', parts: [{ text: 'answer' }] },
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 3,
        },
      }),
    );
    expect(assistant.map((update) => update.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
    ]);

    const plan = updates(
      machine,
      record('todo-result', 'tool_result', {
        message: {
          role: 'user',
          parts: [{ functionResponse: { name: 'todo_write', response: {} } }],
        },
        toolCallResult: {
          callId: 'todo-call',
          resultDisplay: {
            type: 'todo_list',
            todos: [{ content: 'Ship it', status: 'completed' }],
          },
        },
      }),
    );
    expect(plan[0]).toMatchObject({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Ship it', priority: 'medium', status: 'completed' },
      ],
      _meta: {
        stats: {
          promptTokens: 5,
          candidateTokens: 3,
          cachedTokens: 0,
          apiTimeMs: 0,
        },
      },
    });
  });
});
