/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI resume path replays a real session (ChatRecord shapes
 * as persisted under ~/.qwen/projects/<dir>/chats/<id>.jsonl) through the
 * transcript adapter into the neutral model: user / assistant / tool /
 * thought all surface, tool results pair with their calls, and the replay
 * ends with `done` so the composer returns to the ready state.
 */

import { describe, it, expect } from 'vitest';
import {
  resumeEventsFromConfig,
  resumeEventsFromSession as replaySession,
} from './resume-session.js';
import { foldLiveEvent, rewindBoundaryHistory } from './live-session-model.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import type { ChatRecord, Config } from '@qwen-code/qwen-code-core';

const CALL_ID = 'call_1bd0c3272fc749f6a25cd2c8';

function resumeEventsFromSession(
  input: { conversation: { messages: Array<Partial<ChatRecord>> } },
  config?: Config,
) {
  return replaySession(
    {
      conversation: {
        sessionId: 's1',
        projectHash: 'project',
        startTime: '2026-10-21T00:00:00Z',
        lastUpdated: '2026-10-21T00:00:00Z',
        messages: input.conversation.messages.map((record, index) => ({
          uuid: String(index),
          parentUuid: index ? String(index - 1) : null,
          sessionId: 's1',
          timestamp: '2026-10-21T00:00:00Z',
          cwd: '/owned',
          version: 'test',
          type: 'user',
          ...record,
        })),
      },
    },
    config,
  );
}

function sampleMessages(): Array<Partial<ChatRecord>> {
  return [
    {
      type: 'user',
      message: { role: 'user', parts: [{ text: '读一下 README' }] },
    },
    {
      type: 'assistant',
      message: {
        role: 'model',
        parts: [
          { text: '我先看看文件。', thought: true },
          { functionCall: { id: CALL_ID, name: 'read_file', args: {} } },
        ],
      },
    },
    {
      type: 'tool_result',
      message: {
        role: 'user',
        parts: [{ functionResponse: { id: CALL_ID, name: 'read_file' } }],
      },
      toolCallResult: {
        callId: CALL_ID,
        status: 'success',
        resultDisplay: '# README\nhello',
      },
    },
    {
      type: 'assistant',
      message: { role: 'model', parts: [{ text: 'README 内容已读取。' }] },
    },
  ];
}

describe('opentui resume mapping', () => {
  it('retains canonical prompt identity and skips synthetic user records', () => {
    const events = resumeEventsFromSession({
      conversation: {
        messages: [
          {
            type: 'user',
            promptId: 'p1',
            message: { role: 'user', parts: [{ text: 'same' }] },
          },
          {
            type: 'system',
            subtype: 'slash_command',
            promptId: 'p2',
            systemPayload: {
              phase: 'invocation',
              rawCommand: '/skill',
              sentToModel: true,
            },
          },
          {
            type: 'system',
            subtype: 'slash_command',
            systemPayload: {
              phase: 'invocation',
              rawCommand: '/about',
              sentToModel: false,
            },
          },
          {
            type: 'user',
            subtype: 'goal_runtime',
            message: { role: 'user', parts: [{ text: 'hidden' }] },
          },
          {
            type: 'user',
            promptId: 'p3',
            message: { role: 'user', parts: [{ text: 'same' }] },
          },
        ],
      },
    });
    const users = events.filter((event) => event.type === 'user');
    expect(
      users.map(({ text, promptId, sentToModel }) => ({
        text,
        promptId,
        sentToModel,
      })),
    ).toEqual([
      { text: 'same', promptId: 'p1', sentToModel: undefined },
      { text: '/skill', promptId: 'p2', sentToModel: true },
      { text: '/about', promptId: undefined, sentToModel: false },
      { text: 'same', promptId: 'p3', sentToModel: undefined },
    ]);
    expect(new Set(users.map(({ historyId }) => historyId)).size).toBe(4);
  });

  it('replays user / thought / tool-call / tool-result / assistant turns', () => {
    const events = resumeEventsFromSession({
      conversation: { messages: sampleMessages() },
    });

    const toolGroup = {
      id: expect.any(Number),
      type: 'tool_group',
      tools: [
        {
          callId: CALL_ID,
          name: 'read_file',
          args: {},
          description: '',
          confirmationDetails: undefined,
          resultDisplay: '# README\nhello',
          status: 'Success',
        },
      ],
    };
    expect(events).toEqual([
      {
        type: 'user',
        text: '读一下 README',
        canonicalHistoryItem: {
          id: expect.any(Number),
          type: 'user',
          text: '读一下 README',
          rewindId: 'legacy-record:0',
        },
        historyId: expect.any(Number),
        promptId: undefined,
        sentToModel: undefined,
      },
      {
        type: 'thinking',
        delta: '我先看看文件。',
        canonicalHistoryItem: {
          id: expect.any(Number),
          type: 'gemini_thought',
          text: '我先看看文件。',
        },
        historyId: expect.any(Number),
      },
      {
        type: 'thinking-end',
        historyId: expect.any(Number),
        canonicalHistoryItem: {
          id: expect.any(Number),
          type: 'gemini_thought',
          text: '我先看看文件。',
        },
      },
      {
        type: 'tool-start',
        historyId: expect.any(Number),
        id: CALL_ID,
        tool: 'read_file',
        title: 'read_file',
        canonicalHistoryItem: toolGroup,
      },
      {
        type: 'tool-result',
        id: CALL_ID,
        display: '# README\nhello',
        canonicalHistoryItem: toolGroup,
        historyId: expect.any(Number),
      },
      {
        type: 'tool-end',
        id: CALL_ID,
        success: true,
        summary: 'ok',
        canonicalHistoryItem: toolGroup,
        historyId: expect.any(Number),
      },
      { type: 'done' },
      {
        type: 'text',
        delta: 'README 内容已读取。',
        canonicalHistoryItem: {
          id: expect.any(Number),
          type: 'gemini',
          text: 'README 内容已读取。',
          timestamp: Date.parse('2026-10-21T00:00:00Z'),
        },
        historyId: expect.any(Number),
        timestamp: Date.parse('2026-10-21T00:00:00Z'),
      },
      { type: 'done' },
    ]);
  });

  it('preserves recovered legacy identity through the displayed rewind boundary', () => {
    const events = resumeEventsFromSession({
      conversation: { messages: sampleMessages() },
    });
    const items = events.reduce(
      (history, event) => foldLiveEvent(history, event),
      [] as ReturnType<typeof foldLiveEvent>,
    );
    const boundary = rewindBoundaryHistory(items).find(
      (item) => item.type === 'user',
    );
    expect(boundary).toMatchObject({
      type: 'user',
      text: '读一下 README',
      rewindId: 'legacy-record:0',
    });
    expect(boundary).not.toHaveProperty('promptId', expect.any(String));
  });

  it('carries FileDiff tool results as structured diff events', () => {
    const fileDiff = '@@ -1,1 +1,1 @@\n-old\n+new';
    const events: OpenTuiStreamEvent[] = resumeEventsFromSession({
      conversation: {
        messages: [
          {
            type: 'assistant',
            message: {
              role: 'model',
              parts: [{ functionCall: { id: 'c1', name: 'edit', args: {} } }],
            },
          },
          {
            type: 'tool_result',
            message: {
              role: 'user',
              parts: [{ functionResponse: { id: 'c1', name: 'edit' } }],
            },
            toolCallResult: {
              callId: 'c1',
              status: 'success',
              resultDisplay: {
                fileDiff,
                fileName: 'a.txt',
                originalContent: 'old',
                newContent: 'new',
              },
            },
          },
        ],
      },
    });
    // Never the "[object Object]" the previous String() flattening produced.
    expect(events).toContainEqual({
      type: 'tool-result',
      historyId: expect.any(Number),
      id: 'c1',
      display: '',
      diff: { fileDiff, fileName: 'a.txt' },
      canonicalHistoryItem: {
        id: expect.any(Number),
        type: 'tool_group',
        tools: [
          {
            callId: 'c1',
            name: 'edit',
            args: {},
            description: '',
            confirmationDetails: undefined,
            status: 'Success',
            resultDisplay: {
              fileDiff,
              fileName: 'a.txt',
              originalContent: 'old',
              newContent: 'new',
            },
          },
        ],
      },
    });
  });

  it('carries TodoWrite results as a todo list, not as raw JSON', () => {
    const todos = [
      { id: '1', content: 'write the design', status: 'completed' as const },
      { id: '2', content: 'run the matrix', status: 'in_progress' as const },
    ];
    const events: OpenTuiStreamEvent[] = resumeEventsFromSession({
      conversation: {
        messages: [
          {
            type: 'assistant',
            message: {
              role: 'model',
              parts: [{ functionCall: { id: 'c1', name: 'todo_write' } }],
            },
          },
          {
            type: 'tool_result',
            message: {
              role: 'user',
              parts: [{ functionResponse: { id: 'c1', name: 'todo_write' } }],
            },
            toolCallResult: {
              callId: 'c1',
              status: 'success',
              resultDisplay: { type: 'todo_list', todos },
            },
          },
        ],
      },
    });
    expect(events).toContainEqual({
      type: 'tool-result',
      historyId: expect.any(Number),
      id: 'c1',
      display: '',
      todos,
      canonicalHistoryItem: {
        id: expect.any(Number),
        type: 'tool_group',
        tools: [
          {
            callId: 'c1',
            name: 'todo_write',
            args: {},
            description: '',
            confirmationDetails: undefined,
            resultDisplay: { type: 'todo_list', todos },
            status: 'Success',
          },
        ],
      },
    });
  });

  it('folds the replay into render-ready history items', () => {
    const events = resumeEventsFromSession({
      conversation: { messages: sampleMessages() },
    });
    const items = events.reduce(
      (acc, ev) => foldLiveEvent(acc, ev),
      [] as ReturnType<typeof foldLiveEvent>,
    );

    expect(items.map((it) => it.kind)).toEqual([
      'user',
      'thinking',
      'tool',
      'assistant',
    ]);
    const tool = items[2];
    if (tool.kind !== 'tool') throw new Error('expected tool item');
    expect(tool.done).toBe(true);
    expect(tool.output).toBe('# README\nhello');
    const thought = items[1];
    if (thought.kind !== 'thinking') throw new Error('expected thinking item');
    expect(thought.done).toBe(true);
    // Replay must leave the composer ready, not "streaming".
    expect(events[events.length - 1]).toEqual({ type: 'done' });
    for (const event of events) {
      if ('canonicalHistoryItem' in event && event.canonicalHistoryItem) {
        expect(event.canonicalHistoryItem.id).toBe(event.historyId);
      }
    }
  });

  it('marks errored tool results as failed', () => {
    const events = resumeEventsFromSession({
      conversation: {
        messages: [
          {
            type: 'assistant',
            message: {
              role: 'model',
              parts: [{ functionCall: { id: 'c1', name: 'run_shell' } }],
            },
          },
          {
            type: 'tool_result',
            message: {
              role: 'user',
              parts: [{ functionResponse: { id: 'c1', name: 'run_shell' } }],
            },
            toolCallResult: { callId: 'c1', status: 'error' },
          },
        ],
      },
    });
    expect(events).toContainEqual({
      type: 'tool-end',
      historyId: expect.any(Number),
      id: 'c1',
      success: false,
      summary: 'error',
      canonicalHistoryItem: {
        id: expect.any(Number),
        type: 'tool_group',
        tools: [
          {
            callId: 'c1',
            name: 'run_shell',
            args: {},
            description: '',
            confirmationDetails: undefined,
            resultDisplay: undefined,
            status: 'Error',
          },
        ],
      },
    });
  });

  it('skips subtyped user records and replays slash-command invocations', () => {
    const events = resumeEventsFromSession({
      conversation: {
        messages: [
          {
            type: 'user',
            subtype: 'goal_runtime',
            message: { role: 'user', parts: [{ text: 'hidden' }] },
          },
          {
            type: 'system',
            subtype: 'slash_command',
            systemPayload: { phase: 'invocation', rawCommand: '/compact' },
          },
        ],
      },
    });
    expect(events).toEqual([
      {
        type: 'user',
        text: '/compact',
        canonicalHistoryItem: {
          id: expect.any(Number),
          type: 'user',
          text: '/compact',
        },
        historyId: expect.any(Number),
        promptId: undefined,
        sentToModel: undefined,
      },
      { type: 'done' },
    ]);
  });

  it('returns undefined for a config without a resumed session', () => {
    const config = {
      getResumedSessionData: () => undefined,
    } as unknown as Config;
    expect(resumeEventsFromConfig(config)).toBeUndefined();
  });

  it('reads the resumed conversation from the config when present', () => {
    const config = {
      getResumedSessionData: () => ({
        conversation: {
          messages: sampleMessages().map((record, index) => ({
            ...record,
            uuid: String(index),
            timestamp: '2026-10-21T00:00:00Z',
          })),
        },
      }),
      getToolRegistry: () => ({ getTool: () => undefined }),
    } as unknown as Config;
    const events = resumeEventsFromConfig(config);
    expect(events?.[0]).toEqual({
      type: 'user',
      text: '读一下 README',
      canonicalHistoryItem: {
        id: expect.any(Number),
        type: 'user',
        text: '读一下 README',
        rewindId: 'legacy-record:0',
      },
      historyId: expect.any(Number),
      promptId: undefined,
      sentToModel: undefined,
    });
    expect(events?.at(-1)).toEqual({ type: 'done' });
  });
});
