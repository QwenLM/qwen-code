/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import type {
  ChatCompressionRecordPayload,
  ChatRecord,
} from './chatRecordingService.js';
import { CompressionStatus } from '../core/turn.js';
import { detectTurnInterruption } from '../core/turn-interruption.js';
import {
  buildApiHistoryFromConversation,
  buildSessionHistoryFromConversation,
  findApiHistoryPromptIndex,
  getApiHistoryPromptId,
} from './session-api-history.js';

const permit = { goalId: 'goal', revision: 1, turnId: 'turn' };

describe('legacy source-record rewind identity', () => {
  function userRecord(): ChatRecord {
    return {
      uuid: 'legacy-user',
      parentUuid: null,
      type: 'user',
      sessionId: 'session',
      timestamp: '2026-10-09T00:00:00.000Z',
      cwd: '/workspace',
      version: 'test',
      message: {
        role: 'user',
        parts: [{ text: '[Old inline media cleared: image/png]' }],
      },
    };
  }

  it('recovers a record key without changing the transcript or provider JSON', () => {
    const record = userRecord();
    const original = structuredClone(record);
    const history = buildApiHistoryFromConversation({ messages: [record] });

    expect(getApiHistoryPromptId(history[0]!)).toBe(
      'legacy-record:legacy-user',
    );
    expect(JSON.stringify(history)).toBe(JSON.stringify([record.message]));
    expect(record).toEqual(original);
    record.promptId = 'session########12';
    expect(
      getApiHistoryPromptId(
        buildApiHistoryFromConversation({ messages: [record] })[0]!,
      ),
    ).toBe('session########12');
  });

  it('restores a recovered key from a compression sidecar, but never guesses a missing one', () => {
    const record = userRecord();
    const compressedHistory = [record.message!];
    const compression: ChatRecord = {
      ...record,
      uuid: 'compression',
      type: 'system',
      subtype: 'chat_compression',
      message: undefined,
      systemPayload: {
        info: {
          originalTokenCount: 100,
          newTokenCount: 50,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory,
        promptIds: ['legacy-record:legacy-user'],
      },
    };
    const restored = buildApiHistoryFromConversation({
      messages: [record, compression],
    });
    expect(
      findApiHistoryPromptIndex(restored, 'legacy-record:legacy-user'),
    ).toBe(0);
    compression.systemPayload = {
      ...(compression.systemPayload as ChatCompressionRecordPayload),
      promptIds: undefined,
    };
    const oldSnapshot = buildApiHistoryFromConversation({
      messages: [record, compression],
    });
    expect(
      findApiHistoryPromptIndex(oldSnapshot, 'legacy-record:legacy-user'),
    ).toBe(-1);
  });
});

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
      expect(history).toMatchObject([pending.message]);
      expect(getApiHistoryPromptId(history[0]!)).toBe('legacy-record:pending');
      expect(detectTurnInterruption(history).kind).toBe('interrupted_prompt');
    }
    expect(buildApiHistoryFromConversation({ messages: [user] })).toMatchObject(
      [user.message],
    );
    expect(
      buildApiHistoryFromConversation({ messages: [user, pending, output] }),
    ).toMatchObject([user.message, pending.message]);
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
      ).toMatchObject([user.message]);
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
      ).toMatchObject([user.message]);
    },
  );

  it('does not discard unrelated results or merged mid-turn input', () => {
    const [user, output] = commandRecords();
    const unrelated = commandRecords('/other')[1];
    expect(
      buildApiHistoryFromConversation({ messages: [user, unrelated] }),
    ).toMatchObject([user.message]);
    const midTurn: ChatRecord = {
      ...user,
      uuid: 'mid',
      subtype: 'mid_turn_user_message',
    };
    expect(
      buildApiHistoryFromConversation({ messages: [user, midTurn, output] }),
    ).toMatchObject([
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

  it('does not count a delivered notification turn entry (#12042 shape A)', () => {
    // `client.ts` stamps the record of a notification turn it actually sends
    // with `deliveredTurn: true`. The trim exists only for records persisted
    // BEFORE their turn ran; a delivered-but-unanswered entry is an
    // interrupted prompt, so it must stay classifiable.
    const messages = [
      modelRecord('earlier answer'),
      { ...notificationRecord(), deliveredTurn: true },
    ];
    expect(
      buildSessionHistoryFromConversation({ messages })
        .trailingSystemNotifications,
    ).toBe(0);
  });

  it('counts a cold record behind a delivered one only up to the delivered entry', () => {
    // A failed delivered turn leaves [cold, delivered] at the tail: the
    // trailing count is 0 (the last entry is delivered), so neither entry is
    // trimmed and both ride the Retry re-submission. The reverse order —
    // [delivered, cold], a new notification persisted after the turn failed —
    // counts 1 and trims only the genuinely cold tail entry.
    const delivered = {
      ...notificationRecord(),
      deliveredTurn: true,
    };
    expect(
      buildSessionHistoryFromConversation({
        messages: [notificationRecord(), delivered],
      }).trailingSystemNotifications,
    ).toBe(0);
    expect(
      buildSessionHistoryFromConversation({
        messages: [delivered, notificationRecord()],
      }).trailingSystemNotifications,
    ).toBe(1);
  });
});

describe('internal Code Mode tool results', () => {
  it('keeps the internal functionResponse out of model history', () => {
    const base = {
      sessionId: 'session',
      timestamp: '2026-10-07T00:00:00.000Z',
      cwd: '/workspace',
      version: 'test',
    };
    const messages: ChatRecord[] = [
      {
        ...base,
        uuid: 'call',
        parentUuid: null,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [{ functionCall: { id: 'outer', name: 'exec' } }],
        },
      },
      {
        ...base,
        uuid: 'nested',
        parentUuid: 'call',
        type: 'tool_result',
        subtype: 'code_mode_tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'nested',
                name: 'write_file',
                response: { output: 'internal' },
              },
            },
          ],
        },
      },
      {
        ...base,
        uuid: 'result',
        parentUuid: 'nested',
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'outer',
                name: 'exec',
                response: { output: 'script finished' },
              },
            },
          ],
        },
      },
    ];

    const parts = buildApiHistoryFromConversation({ messages }).flatMap(
      (entry) => entry.parts ?? [],
    );

    expect(parts.some((part) => part.functionResponse?.id === 'outer')).toBe(
      true,
    );
    expect(parts.some((part) => part.functionResponse?.id === 'nested')).toBe(
      false,
    );
  });
});
