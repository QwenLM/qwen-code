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
  resumeEventsFromSession,
} from './resume-session.js';
import { foldLiveEvent } from './live-session-model.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import type { Config } from '@qwen-code/qwen-code-core';

const CALL_ID = 'call_1bd0c3272fc749f6a25cd2c8';

function sampleMessages(): unknown[] {
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
  it('replays user / thought / tool-call / tool-result / assistant turns', () => {
    const events = resumeEventsFromSession({
      conversation: { messages: sampleMessages() },
    });

    expect(events).toEqual([
      { type: 'user', text: '读一下 README' },
      { type: 'thinking', delta: '我先看看文件。' },
      { type: 'thinking-end' },
      {
        type: 'tool-start',
        id: CALL_ID,
        tool: 'read_file',
        title: 'read_file',
      },
      { type: 'tool-output', id: CALL_ID, delta: '# README\nhello' },
      { type: 'tool-end', id: CALL_ID, success: true, summary: 'ok' },
      { type: 'text', delta: 'README 内容已读取。' },
      { type: 'done' },
    ]);
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
              resultDisplay: { fileDiff, fileName: 'a.txt' },
            },
          },
        ],
      },
    });
    // Never the "[object Object]" the previous String() flattening produced.
    expect(events).toContainEqual({
      type: 'tool-result',
      id: 'c1',
      display: '',
      diff: { fileDiff, fileName: 'a.txt' },
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
      id: 'c1',
      success: false,
      summary: 'error',
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
      { type: 'user', text: '/compact' },
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
        conversation: { messages: sampleMessages() },
      }),
    } as unknown as Config;
    const events = resumeEventsFromConfig(config);
    expect(events?.[0]).toEqual({ type: 'user', text: '读一下 README' });
    expect(events?.at(-1)).toEqual({ type: 'done' });
  });
});
