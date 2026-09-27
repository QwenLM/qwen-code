/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import type { ChatRecord } from './chatRecordingService.js';
import { CompressionStatus } from '../core/turn.js';
import { detectTurnInterruption } from '../core/turn-interruption.js';
import {
  buildApiHistoryFromConversation,
  buildSessionHistoryFromConversation,
} from './session-api-history.js';

const permit = { goalId: 'goal', revision: 1, turnId: 'turn' };

describe('completed local slash commands', () => {
  function commandRecords(command = '/docs'): ChatRecord[] {
    const base = {
      sessionId: 'session',
      timestamp: '2026-09-17T00:00:00.000Z',
      cwd: '/workspace',
      version: 'test',
    };
    return [
      {
        ...base,
        uuid: 'user',
        parentUuid: null,
        type: 'user',
        message: { role: 'user', parts: [{ text: command }] },
      },
      {
        ...base,
        uuid: 'output',
        parentUuid: 'user',
        type: 'system',
        subtype: 'slash_command',
        systemPayload: {
          phase: 'result',
          rawCommand: command,
          outputHistoryItems: [{ type: 'assistant', text: 'Done.' }],
        },
      },
    ];
  }

  it.each(['/docs', '/export md', '/effort', '/summary', '/model --fast test'])(
    'excludes completed %s from model history without changing the transcript',
    (command) => {
      const messages = commandRecords(command);
      const original = structuredClone(messages);
      const history = buildApiHistoryFromConversation({ messages });
      expect(history).toEqual([]);
      expect(detectTurnInterruption(history).kind).toBe('none');
      expect(messages).toEqual(original);
    },
  );

  it('preserves unanswered input before and after a completed command', () => {
    const [user, output] = commandRecords();
    const pending: ChatRecord = {
      ...user,
      uuid: 'pending',
      message: { role: 'user', parts: [{ text: 'unfinished request' }] },
    };
    for (const messages of [
      [pending, user, output, output],
      [user, output, pending],
    ]) {
      const history = buildApiHistoryFromConversation({ messages });
      expect(history).toEqual([pending.message]);
      expect(detectTurnInterruption(history).kind).toBe('interrupted_prompt');
    }
    expect(buildApiHistoryFromConversation({ messages: [user] })).toEqual([
      user.message,
    ]);
    expect(
      buildApiHistoryFromConversation({ messages: [user, pending, output] }),
    ).toEqual([user.message, pending.message]);
  });

  it.each([true, false])(
    'does not pair a TUI invocation (sentToModel=%s) with old input',
    (sentToModel) => {
      const [user, output] = commandRecords('/custom');
      const invocation: ChatRecord = {
        ...output,
        uuid: 'invocation',
        systemPayload: {
          phase: 'invocation',
          rawCommand: '/custom',
          sentToModel,
        },
      };
      expect(
        buildApiHistoryFromConversation({
          messages: [user, invocation, output],
        }),
      ).toEqual([user.message]);
    },
  );

  it.each(['info', 'away_recap', 'error'])(
    'does not mistake %s output for an ACP command result',
    (type) => {
      const [user, output] = commandRecords();
      output.systemPayload = {
        phase: 'result',
        rawCommand: '/docs',
        outputHistoryItems: [{ type, text: 'display only' }],
      };
      expect(
        buildApiHistoryFromConversation({ messages: [user, output] }),
      ).toEqual([user.message]);
    },
  );

  it('does not discard unrelated results or merged mid-turn input', () => {
    const [user, output] = commandRecords();
    const unrelated = commandRecords('/other')[1];
    expect(
      buildApiHistoryFromConversation({ messages: [user, unrelated] }),
    ).toEqual([user.message]);
    const midTurn: ChatRecord = {
      ...user,
      uuid: 'mid',
      subtype: 'mid_turn_user_message',
    };
    expect(
      buildApiHistoryFromConversation({ messages: [user, midTurn, output] }),
    ).toEqual([
      {
        role: 'user',
        parts: [...user.message!.parts!, ...midTurn.message!.parts!],
      },
    ]);
  });

  it('does not pop a compression snapshot when the old command result arrives', () => {
    const [user, output] = commandRecords();
    const compressedHistory = [{ role: 'model', parts: [{ text: 'summary' }] }];
    const compression: ChatRecord = {
      ...output,
      uuid: 'compression',
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          originalTokenCount: 100,
          newTokenCount: 50,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory,
      },
    };
    expect(
      buildApiHistoryFromConversation({
        messages: [user, compression, output],
      }),
    ).toEqual(compressedHistory);
  });
});

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
      trailingSystemNotifications: 0,
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

  it.each([0, 2])(
    'rejects a compression boundary with %s matching calls',
    (callCount) => {
      const messages = records();
      const [call, result] = buildApiHistoryFromConversation({ messages });
      messages.push({
        ...messages[2]!,
        uuid: 'compression',
        parentUuid: 'end',
        subtype: 'chat_compression',
        systemPayload: {
          info: {
            originalTokenCount: 100,
            newTokenCount: 50,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
          compressedHistory: [
            ...Array.from({ length: callCount }, () => call!),
            result!,
          ],
          completedToolCallIds: ['finish'],
        },
      });
      expect(
        buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
      ).toBeUndefined();
    },
  );

  it('drops a boundary whose result is removed when stripping thoughts', () => {
    const messages = records();
    messages[1]!.message!.parts![0]!.thought = true;
    expect(
      buildSessionHistoryFromConversation({ messages }).completedToolCallIds,
    ).toEqual(['finish']);
    const restored = buildSessionHistoryFromConversation(
      { messages },
      { stripThoughtsFromHistory: true },
    );
    expect(restored.completedToolCallIds).toBeUndefined();
    expect(
      restored.apiHistory
        .flatMap((entry) => entry.parts ?? [])
        .some((part) => part.functionResponse?.id === 'finish'),
    ).toBe(false);
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

describe('trailingSystemNotifications provenance signal', () => {
  const envelope =
    '<task-notification><task-id>agent-1</task-id>' +
    '<status>completed</status><summary>Agent "explore" completed.</summary>' +
    '</task-notification>';

  const base = {
    sessionId: 'session',
    timestamp: '2026-09-18T00:00:00.000Z',
    cwd: '/workspace',
    version: 'test',
  };

  let seq = 0;
  function userRecord(
    text: string,
    overrides: Partial<ChatRecord> = {},
  ): ChatRecord {
    seq += 1;
    return {
      ...base,
      uuid: `u${seq}`,
      parentUuid: null,
      type: 'user',
      provenance: 'real_user',
      message: { role: 'user', parts: [{ text }] },
      ...overrides,
    };
  }

  /** The stamp `createNotificationRecord` produces, verbatim. */
  function notificationRecord(text = envelope): ChatRecord {
    return userRecord(text, {
      subtype: 'notification',
      provenance: 'system',
    });
  }

  function modelRecord(text: string): ChatRecord {
    seq += 1;
    return {
      ...base,
      uuid: `m${seq}`,
      parentUuid: null,
      type: 'assistant',
      provenance: 'assistant_output',
      message: { role: 'model', parts: [{ text }] },
    };
  }

  it('reports 0 for a real user prompt even when its text is a bare envelope', () => {
    // The whole point of the signal: this record is shape-identical to a cold
    // notification, and only its `provenance: 'real_user'` says otherwise.
    const messages = [modelRecord('earlier answer'), userRecord(envelope)];
    expect(
      buildSessionHistoryFromConversation({ messages })
        .trailingSystemNotifications,
    ).toBe(0);
  });

  it('counts a consecutive trailing run of notification records', () => {
    const messages = [
      modelRecord('earlier answer'),
      notificationRecord(),
      notificationRecord(
        envelope.replace('explore', 'build').replace('agent-1', 'agent-2'),
      ),
    ];
    expect(
      buildSessionHistoryFromConversation({ messages })
        .trailingSystemNotifications,
    ).toBe(2);
  });

  it('stops the count at the first non-notification entry', () => {
    const messages = [
      notificationRecord(),
      modelRecord('earlier answer'),
      notificationRecord(),
    ];
    expect(
      buildSessionHistoryFromConversation({ messages })
        .trailingSystemNotifications,
    ).toBe(1);
  });

  it('does not count a cron record, which carries a user-authored prompt', () => {
    // `recordCronPrompt` goes through the same `createNotificationRecord`, so a
    // cron record carries the IDENTICAL `provenance: 'system'` — only
    // `subtype: 'cron'` separates it, and it carries a user-authored prompt the
    // shape predicate never trimmed. The subtype guard is what keeps it out.
    const messages = [
      userRecord('nightly digest', { subtype: 'cron', provenance: 'system' }),
    ];
    expect(
      buildSessionHistoryFromConversation({ messages })
        .trailingSystemNotifications,
    ).toBe(0);
  });

  it('does not count a notification stamp missing provenance', () => {
    const messages = [userRecord(envelope, { subtype: 'notification' })];
    expect(
      buildSessionHistoryFromConversation({ messages })
        .trailingSystemNotifications,
    ).toBe(0);
  });

  it('keeps the count aligned across a slash-command pop', () => {
    // The pop removes the trailing user entry; a stale flag would make the
    // notification behind it look like real input (or vice versa).
    const command = userRecord('/docs');
    const messages = [
      notificationRecord(),
      command,
      {
        ...base,
        uuid: 'cmd-out',
        parentUuid: command.uuid,
        type: 'system' as const,
        subtype: 'slash_command' as const,
        systemPayload: {
          phase: 'result' as const,
          rawCommand: '/docs',
          sentToModel: false,
          outputHistoryItems: [{ type: 'assistant', text: 'Done.' }],
        },
      },
    ];
    const built = buildSessionHistoryFromConversation({ messages });
    expect(built.apiHistory).toEqual([notificationRecord().message]);
    expect(built.trailingSystemNotifications).toBe(1);
  });

  it('reports 0 for compressed history, which has no source records', () => {
    const messages: ChatRecord[] = [
      {
        ...base,
        uuid: 'compression',
        parentUuid: null,
        type: 'system',
        subtype: 'chat_compression',
        systemPayload: {
          info: {
            originalTokenCount: 100,
            newTokenCount: 50,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
          compressedHistory: [
            { role: 'user', parts: [{ text: envelope }] },
          ] as Content[],
        },
      },
    ];
    const built = buildSessionHistoryFromConversation({ messages });
    expect(built.apiHistory).toHaveLength(1);
    expect(built.trailingSystemNotifications).toBe(0);
  });

  it('makes recovery keep an envelope-shaped real prompt and trim a cold notification', () => {
    // End to end through the classifier: same shape, opposite verdicts,
    // decided only by the record's own stamp.
    const prefix = [modelRecord('earlier answer')];
    const real = buildSessionHistoryFromConversation({
      messages: [...prefix, userRecord(envelope)],
    });
    expect(
      detectTurnInterruption(
        real.apiHistory,
        real.completedToolCallIds,
        real.trailingSystemNotifications,
      ).kind,
    ).toBe('interrupted_prompt');

    const cold = buildSessionHistoryFromConversation({
      messages: [...prefix, notificationRecord()],
    });
    expect(
      detectTurnInterruption(
        cold.apiHistory,
        cold.completedToolCallIds,
        cold.trailingSystemNotifications,
      ).kind,
    ).toBe('none');
  });
});
