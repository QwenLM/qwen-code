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
import type {
  GoalRecord,
  GoalStateCause,
} from '@qwen-code/qwen-code-core/goalWire';

const GOAL: GoalRecord = {
  goalId: 'goal-1',
  revision: 3,
  objective: 'ship it',
  status: 'active',
  evidenceCursor: { recordId: 'record-0' },
  turnCount: 4,
  activeTimeMs: 2000,
  createdAt: 100,
  updatedAt: 200,
  lastReason: 'continuing',
};

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

function goalStateRecord(
  uuid: string,
  cause: GoalStateCause,
  goal: GoalRecord | null,
): TranscriptRecordInput {
  return record(uuid, 'system', {
    subtype: 'goal_state',
    systemPayload: {
      v: 2,
      cause,
      snapshot: { v: 2, activity: 'idle', goal },
    },
  });
}

describe('createTranscriptReplayMachine', () => {
  it('does not replay internal Goal runtime prompts as user messages', () => {
    expect(
      updates(
        createTranscriptReplayMachine(),
        record('goal-runtime', 'user', {
          subtype: 'goal_runtime',
          message: { role: 'user', parts: [{ text: 'Continue working.' }] },
        }),
      ),
    ).toEqual([]);
  });

  it('projects goal_state through v2-first metadata and preserves its UUID', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      goalStateRecord('goal-create', 'create', GOAL),
    );

    expect(projected).toHaveLength(1);
    const meta = projected[0]?._meta as Record<string, unknown>;
    expect(Object.keys(meta).slice(0, 3)).toEqual([
      'goalState',
      'goalStatus',
      'qwen.session.recordId',
    ]);
    expect(meta).toMatchObject({
      goalState: { v: 2, goal: GOAL, activity: 'idle' },
      goalStatus: { kind: 'set', condition: GOAL.objective },
      'qwen.session.recordId': 'goal-create',
    });
  });

  it('projects terminal metadata after v2 and legacy status', () => {
    const projected = updates(
      createTranscriptReplayMachine(),
      goalStateRecord('goal-complete', 'complete', {
        ...GOAL,
        status: 'complete',
      }),
    );

    const meta = projected[0]?._meta as Record<string, unknown>;
    expect(Object.keys(meta).slice(0, 3)).toEqual([
      'goalState',
      'goalStatus',
      'goalTerminal',
    ]);
    expect(meta['goalTerminal']).toMatchObject({
      kind: 'achieved',
      condition: GOAL.objective,
    });
  });

  it('tracks the previous goal across pages so clear keeps its objective', () => {
    const first = createTranscriptReplayMachine();
    updates(first, goalStateRecord('goal-create', 'create', GOAL));
    const second = createTranscriptReplayMachine({
      initialState: first.snapshot(),
    });

    const projected = updates(
      second,
      goalStateRecord('goal-clear', 'clear', null),
    );

    expect(projected[0]?._meta).toMatchObject({
      goalState: { v: 2, goal: null, activity: 'idle' },
      goalStatus: { kind: 'cleared', condition: GOAL.objective },
      'qwen.session.recordId': 'goal-clear',
    });
  });

  it('reports and skips a malformed goal_state record', () => {
    const onDiagnostic = vi.fn();
    const machine = createTranscriptReplayMachine({ onDiagnostic });
    const malformed = record('goal-malformed', 'system', {
      subtype: 'goal_state',
      systemPayload: {
        v: 2,
        cause: 'create',
        snapshot: { v: 2, activity: 'running', goal: GOAL },
      },
    });

    expect(updates(machine, malformed)).toEqual([]);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'malformed_goal_state',
        recordId: 'goal-malformed',
        path: 'systemPayload',
      }),
    );
  });

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
