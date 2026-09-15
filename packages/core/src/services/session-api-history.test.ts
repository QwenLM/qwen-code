/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ChatRecord } from './chatRecordingService.js';
import { CompressionStatus } from '../core/turn.js';
import {
  buildApiHistoryFromConversation,
  buildSessionHistoryFromConversation,
} from './session-api-history.js';

const permit = { goalId: 'goal', revision: 1, turnId: 'turn' };

function records(toolCallId = 'finish'): ChatRecord[] {
  const base = {
    sessionId: 'session',
    timestamp: '2026-09-15T00:00:00.000Z',
    cwd: '/workspace',
    version: 'test',
    goalContext: permit,
  };
  return [
    {
      ...base,
      uuid: 'call',
      parentUuid: null,
      type: 'assistant',
      message: {
        role: 'model',
        parts: [{ functionCall: { id: toolCallId, name: 'update_goal' } }],
      },
    },
    {
      ...base,
      uuid: 'result',
      parentUuid: 'call',
      type: 'tool_result',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: toolCallId,
              name: 'update_goal',
              response: { readyForVerification: true },
            },
          },
        ],
      },
    },
    {
      ...base,
      uuid: 'end',
      parentUuid: 'result',
      type: 'system',
      subtype: 'goal_turn_end',
      systemPayload: { toolCallId },
    },
  ];
}

describe('Goal turn end history metadata', () => {
  it('keeps the boundary outside model history and across a later user prompt', () => {
    const messages = records();
    const before = buildApiHistoryFromConversation({
      messages: messages.slice(0, 2),
    });
    expect(buildSessionHistoryFromConversation({ messages })).toEqual({
      apiHistory: before,
      completedToolCallIds: ['finish'],
    });
    messages.push({
      ...messages[1]!,
      uuid: 'next',
      parentUuid: 'end',
      type: 'user',
      subtype: 'mid_turn_user_message',
      message: { role: 'user', parts: [{ text: 'new request' }] },
    });
    const restored = buildSessionHistoryFromConversation({ messages });
    expect(restored.completedToolCallIds).toEqual(['finish']);
    expect(restored.apiHistory).toEqual([
      ...before,
      { role: 'user', parts: [{ text: 'new request' }] },
    ]);
  });

  it.each(['goalId', 'revision', 'turnId'] as const)(
    'ignores a boundary with a mismatched %s',
    (field) => {
      const messages = records();
      messages[2]!.goalContext = {
        ...permit,
        [field]: field === 'revision' ? 2 : 'other',
      };
      expect(
        buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
      ).toBeUndefined();
    },
  );

  it('requires the most recent material record to contain the ending result', () => {
    const messages = records();
    messages.splice(2, 0, {
      ...messages[1]!,
      uuid: 'new-prompt',
      type: 'user',
      message: { role: 'user', parts: [{ text: 'new request' }] },
    });
    expect(
      buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
    ).toBeUndefined();
    messages.splice(2, 1);
    messages[2]!.systemPayload = { toolCallId: 'unrelated' };
    expect(
      buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
    ).toBeUndefined();
  });

  it('invalidates a boundary when its tool id is reused later', () => {
    const messages = records();
    messages.push({
      ...messages[0]!,
      uuid: 'duplicate-call',
      parentUuid: 'end',
    });
    expect(
      buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
    ).toBeUndefined();
    messages.pop();
    messages.unshift({ ...messages[1]!, uuid: 'duplicate-result' });
    expect(
      buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
    ).toBeUndefined();
  });

  it('retains earlier boundaries and removes only a reused tool id', () => {
    const messages = [...records(), ...records('finish-2')];
    messages.push({ ...messages.at(-1)! });
    expect(
      buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
    ).toEqual(['finish', 'finish-2']);
    messages.push({ ...records()[0]!, uuid: 'reused-call' });
    expect(
      buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
    ).toEqual(['finish-2']);
  });

  it('restores only an explicitly preserved compression boundary', () => {
    const messages = records();
    const compressedHistory = buildApiHistoryFromConversation({ messages });
    const payload = {
      info: {
        originalTokenCount: 100,
        newTokenCount: 50,
        compressionStatus: CompressionStatus.COMPRESSED,
      },
      compressedHistory,
    };
    const compression: ChatRecord = {
      ...messages[2]!,
      uuid: 'compression',
      parentUuid: 'end',
      subtype: 'chat_compression',
      systemPayload: payload,
    };
    messages.push(compression);
    expect(
      buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
    ).toBeUndefined();
    compression.systemPayload = {
      ...payload,
      completedToolCallIds: ['finish', 'missing', 'finish'],
    };
    expect(
      buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
    ).toEqual(['finish']);
    compression.systemPayload = {
      ...payload,
      completedToolCallIds: ['finish'],
      compressedHistory: [{ role: 'model', parts: [{ text: 'summary' }] }],
    };
    expect(
      buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
    ).toBeUndefined();
  });
});
