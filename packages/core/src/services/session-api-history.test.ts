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
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

const permit = { goalId: 'goal', revision: 1, turnId: 'turn' };

const recordBase = (timestamp: string) => ({
  sessionId: 'session',
  timestamp,
  cwd: '/workspace',
  version: 'test',
});

/** A chat_compression payload; `completedToolCallIds` only when given. */
const compressionPayload = (
  compressedHistory: Content[],
  completedToolCallIds?: string[],
) => ({
  info: {
    originalTokenCount: 100,
    newTokenCount: 50,
    compressionStatus: CompressionStatus.COMPRESSED,
  },
  compressedHistory,
  ...(completedToolCallIds ? { completedToolCallIds } : {}),
});

const api = (messages: ChatRecord[]) =>
  buildApiHistoryFromConversation({ messages });

const completedIds = (messages: ChatRecord[]) =>
  buildSessionHistoryFromConversation({ messages }).completedToolCallIds;

const trailingNotifications = (messages: ChatRecord[]) =>
  buildSessionHistoryFromConversation({ messages }).trailingSystemNotifications;

describe('completed local slash commands', () => {
  function commandRecords(command = '/docs'): ChatRecord[] {
    const base = recordBase('2026-09-17T00:00:00.000Z');
    return [
      {
        ...base,
        uuid: 'user',
        parentUuid: null,
        type: 'user',
        message: userText(command),
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
      const history = api(messages);
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
      message: userText('unfinished request'),
    };
    for (const messages of [
      [pending, user, output, output],
      [user, output, pending],
    ]) {
      const history = api(messages);
      expect(history).toEqual([pending.message]);
      expect(detectTurnInterruption(history).kind).toBe('interrupted_prompt');
    }
    expect(api([user])).toEqual([user.message]);
    expect(api([user, pending, output])).toEqual([
      user.message,
      pending.message,
    ]);
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
      expect(api([user, invocation, output])).toEqual([user.message]);
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
      expect(api([user, output])).toEqual([user.message]);
    },
  );

  it('does not discard unrelated results or merged mid-turn input', () => {
    const [user, output] = commandRecords();
    const unrelated = commandRecords('/other')[1];
    expect(api([user, unrelated])).toEqual([user.message]);
    const midTurn: ChatRecord = {
      ...user,
      uuid: 'mid',
      subtype: 'mid_turn_user_message',
    };
    expect(api([user, midTurn, output])).toEqual([
      content('user', ...user.message!.parts!, ...midTurn.message!.parts!),
    ]);
  });

  it('does not pop a compression snapshot when the old command result arrives', () => {
    const [user, output] = commandRecords();
    const compressedHistory = [modelText('summary')];
    const compression: ChatRecord = {
      ...output,
      uuid: 'compression',
      subtype: 'chat_compression',
      systemPayload: compressionPayload(compressedHistory),
    };
    expect(api([user, compression, output])).toEqual(compressedHistory);
  });
});

function records(toolCallId = 'finish'): ChatRecord[] {
  const base = {
    ...recordBase('2026-09-15T00:00:00.000Z'),
    goalContext: permit,
  };
  return [
    {
      ...base,
      uuid: 'call',
      parentUuid: null,
      type: 'assistant',
      message: content('model', fnCall('update_goal', undefined, toolCallId)),
    },
    {
      ...base,
      uuid: 'result',
      parentUuid: 'call',
      type: 'tool_result',
      message: content(
        'user',
        fnResponse('update_goal', { readyForVerification: true }, toolCallId),
      ),
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
    const before = api(messages.slice(0, 2));
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
      message: userText('new request'),
    });
    const restored = buildSessionHistoryFromConversation({ messages });
    expect(restored.completedToolCallIds).toEqual(['finish']);
    expect(restored.apiHistory).toEqual([...before, userText('new request')]);
  });

  it.each(['goalId', 'revision', 'turnId'] as const)(
    'ignores a boundary with a mismatched %s',
    (field) => {
      const messages = records();
      messages[2]!.goalContext = {
        ...permit,
        [field]: field === 'revision' ? 2 : 'other',
      };
      expect(completedIds(messages)).toBeUndefined();
    },
  );

  it('requires the most recent material record to contain the ending result', () => {
    const messages = records();
    messages.splice(2, 0, {
      ...messages[1]!,
      uuid: 'new-prompt',
      type: 'user',
      message: userText('new request'),
    });
    expect(completedIds(messages)).toBeUndefined();
    messages.splice(2, 1);
    messages[2]!.systemPayload = { toolCallId: 'unrelated' };
    expect(completedIds(messages)).toBeUndefined();
  });

  it('invalidates a boundary when its tool id is reused later', () => {
    const messages = records();
    messages.push({
      ...messages[0]!,
      uuid: 'duplicate-call',
      parentUuid: 'end',
    });
    expect(completedIds(messages)).toBeUndefined();
    messages.pop();
    messages.unshift({ ...messages[1]!, uuid: 'duplicate-result' });
    expect(completedIds(messages)).toBeUndefined();
  });

  it('retains earlier boundaries and removes only a reused tool id', () => {
    const messages = [...records(), ...records('finish-2')];
    messages.push({ ...messages.at(-1)! });
    expect(completedIds(messages)).toEqual(['finish', 'finish-2']);
    messages.push({ ...records()[0]!, uuid: 'reused-call' });
    expect(completedIds(messages)).toEqual(['finish-2']);
  });

  it.each([0, 2])(
    'rejects a compression boundary with %s matching calls',
    (callCount) => {
      const messages = records();
      const [call, result] = api(messages);
      messages.push({
        ...messages[2]!,
        uuid: 'compression',
        parentUuid: 'end',
        subtype: 'chat_compression',
        systemPayload: compressionPayload(
          [...Array.from({ length: callCount }, () => call!), result!],
          ['finish'],
        ),
      });
      expect(completedIds(messages)).toBeUndefined();
    },
  );

  it('drops a boundary whose result is removed when stripping thoughts', () => {
    const messages = records();
    messages[1]!.message!.parts![0]!.thought = true;
    expect(completedIds(messages)).toEqual(['finish']);
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
    const compressedHistory = api(messages);
    const payload = compressionPayload(compressedHistory);
    const compression: ChatRecord = {
      ...messages[2]!,
      uuid: 'compression',
      parentUuid: 'end',
      subtype: 'chat_compression',
      systemPayload: payload,
    };
    messages.push(compression);
    expect(completedIds(messages)).toBeUndefined();
    compression.systemPayload = {
      ...payload,
      completedToolCallIds: ['finish', 'missing', 'finish'],
    };
    expect(completedIds(messages)).toEqual(['finish']);
    compression.systemPayload = {
      ...payload,
      completedToolCallIds: ['finish'],
      compressedHistory: [modelText('summary')],
    };
    expect(completedIds(messages)).toBeUndefined();
  });
});

describe('trailingSystemNotifications provenance signal', () => {
  const envelope =
    '<task-notification><task-id>agent-1</task-id>' +
    '<status>completed</status><summary>Agent "explore" completed.</summary>' +
    '</task-notification>';

  const base = recordBase('2026-09-18T00:00:00.000Z');

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
      message: userText(text),
      ...overrides,
    };
  }

  /** The stamp `createNotificationRecord` produces, verbatim. */
  function notificationRecord(text = envelope): ChatRecord {
    return userRecord(text, { subtype: 'notification', provenance: 'system' });
  }

  function modelRecord(text: string): ChatRecord {
    seq += 1;
    return {
      ...base,
      uuid: `m${seq}`,
      parentUuid: null,
      type: 'assistant',
      provenance: 'assistant_output',
      message: modelText(text),
    };
  }

  it('reports 0 for a real user prompt even when its text is a bare envelope', () => {
    // The whole point of the signal: this record is shape-identical to a cold
    // notification, and only its `provenance: 'real_user'` says otherwise.
    const messages = [modelRecord('earlier answer'), userRecord(envelope)];
    expect(trailingNotifications(messages)).toBe(0);
  });

  it('counts a consecutive trailing run of notification records', () => {
    const messages = [
      modelRecord('earlier answer'),
      notificationRecord(),
      notificationRecord(
        envelope.replace('explore', 'build').replace('agent-1', 'agent-2'),
      ),
    ];
    expect(trailingNotifications(messages)).toBe(2);
  });

  it('stops the count at the first non-notification entry', () => {
    const messages = [
      notificationRecord(),
      modelRecord('earlier answer'),
      notificationRecord(),
    ];
    expect(trailingNotifications(messages)).toBe(1);
  });

  it('does not count a cron record, which carries a user-authored prompt', () => {
    // `recordCronPrompt` goes through the same `createNotificationRecord`, so a
    // cron record carries the IDENTICAL `provenance: 'system'` — only
    // `subtype: 'cron'` separates it, and it carries a user-authored prompt the
    // shape predicate never trimmed. The subtype guard is what keeps it out.
    const messages = [
      userRecord('nightly digest', { subtype: 'cron', provenance: 'system' }),
    ];
    expect(trailingNotifications(messages)).toBe(0);
  });

  it('does not count a notification stamp missing provenance', () => {
    const messages = [userRecord(envelope, { subtype: 'notification' })];
    expect(trailingNotifications(messages)).toBe(0);
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
        systemPayload: compressionPayload([userText(envelope)]),
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
    const recoveryKind = (last: ChatRecord) => {
      const built = buildSessionHistoryFromConversation({
        messages: [...prefix, last],
      });
      return detectTurnInterruption(
        built.apiHistory,
        built.completedToolCallIds,
        built.trailingSystemNotifications,
      ).kind;
    };
    expect(recoveryKind(userRecord(envelope))).toBe('interrupted_prompt');
    expect(recoveryKind(notificationRecord())).toBe('none');
  });
});
