/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Content } from '@google/genai';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import type { Config } from '../config/config.js';
import { LlmChat } from '../core/llm-chat.js';
import { CompressionStatus } from '../core/turn.js';
import { detectTurnInterruption } from '../core/turn-interruption.js';
import { buildSessionRecoveryPlanFromApiHistory } from '../core/session-recovery.js';
import {
  buildApiHistoryFromConversation,
  buildSessionHistoryFromConversation,
  getLastApiHistoryPromptId,
  getLastApiPromptCancellation,
  markApiHistoryPrompt,
  cloneApiHistory,
} from './session-api-history.js';
import { composePostCompactHistory } from './postCompactAttachments.js';
import { microcompactHistory } from './microcompaction/microcompact.js';
import {
  InMemoryImagePayloadStore,
  replaceImagePayloadsInPlace,
} from './image-payload-references.js';
import { getStartupContextLength } from '../core/environmentContext.js';
import {
  countApiUserPrompts,
  findApiRewindCutPoint,
} from './api-user-prompt.js';
import { selectForkHistory } from '../tools/agent/fork-subagent.js';

describe('compressed recovery boundaries', () => {
  const checkpoint = (history: Content[]): ChatRecord => ({
    uuid: 'compression',
    parentUuid: null,
    sessionId: 'session',
    timestamp: '2026-10-15T00:00:00Z',
    cwd: '/tmp',
    version: 'test',
    type: 'system',
    subtype: 'chat_compression',
    systemPayload: {
      compressedHistory: JSON.parse(JSON.stringify(history)),
      info: {
        originalTokenCount: 100,
        newTokenCount: 20,
        compressionStatus: CompressionStatus.COMPRESSED,
      },
    },
  });
  const pending = (text: string): Content => ({
    role: 'user',
    parts: [{ text }],
  });

  it.each([false, true])(
    'preserves anonymous turns through an actual fast checkpoint file (startup: %s)',
    async (startup) => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-fast-checkpoint-'));
      const config = {
        getResumedSessionData: () => undefined,
        getSessionId: () => 'session',
        getProjectRoot: () => dir,
        getCliVersion: () => 'test',
        storage: { getProjectDir: () => dir },
        getClearContextOnIdle: () => ({ toolResultsNumToKeep: 1 }),
        getToolRegistry: () => undefined,
        getUsageStatisticsEnabled: () => false,
      } as unknown as Config;
      const recorder = new ChatRecordingService(config, undefined, false);
      try {
        const compacted = await composePostCompactHistory([], 'Summary.');
        if (startup)
          compacted.unshift(
            pending('<system-reminder>\nStartup\n</system-reminder>'),
          );
        const input = pending(
          'Recently accessed file (full current content embedded):\n\n## /tmp/a.ts\n\n```\nconst a = 1;\n```',
        );
        const records: ChatRecord[] = [
          checkpoint(compacted),
          ...[
            input,
            {
              role: 'model',
              parts: [
                { text: 'reasoning '.repeat(100), thought: true },
                { text: 'Done.' },
              ],
            },
          ].map(
            (message, index): ChatRecord => ({
              ...checkpoint([]),
              uuid: `turn-${index}`,
              parentUuid: index ? 'turn-0' : 'compression',
              type: index ? 'assistant' : 'user',
              subtype: undefined,
              systemPayload: undefined,
              message,
            }),
          ),
        ];
        const initial = buildApiHistoryFromConversation({ messages: records });
        expect(countApiUserPrompts(initial)).toBe(1);
        const chat = new LlmChat(config, {}, initial, recorder);
        expect(chat.compressFast().info.compressionStatus).toBe(
          CompressionStatus.COMPRESSED,
        );
        await recorder.flush();
        const saved: ChatRecord[] = readFileSync(
          join(dir, 'chats', 'session.jsonl'),
          'utf8',
        )
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(saved).toHaveLength(1);
        expect(saved[0].systemPayload).toMatchObject({
          contextPrefixLength: compacted.length,
        });
        const restored = buildApiHistoryFromConversation({ messages: saved });
        expect(JSON.stringify(restored)).toBe(
          JSON.stringify(chat.getHistory()),
        );
        expect(JSON.parse(JSON.stringify(restored))).toEqual([
          ...compacted,
          input,
          { role: 'model', parts: [{ text: 'Done.' }] },
        ]);
        for (const history of [initial, chat.getHistory(), restored]) {
          expect(
            getStartupContextLength(history, { includeCompressed: true }),
          ).toBe(compacted.length);
          expect(countApiUserPrompts(history)).toBe(1);
          expect(findApiRewindCutPoint(history, 0)).toBe(compacted.length);
          expect(selectForkHistory(history, 1)).toHaveLength(2);
          expect(detectTurnInterruption(history)).toEqual({ kind: 'none' });
        }
      } finally {
        await recorder.flush();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(['inline', 'partial', 'all', 'references'] as const)(
    'keeps %s image context and the original snapshot layout',
    async (mode) => {
      const image = { inlineData: { mimeType: 'image/png', data: 'AA==' } };
      let history = await composePostCompactHistory(
        [{ role: 'user', parts: [image, image, image] }],
        'Summary.',
        { maxFiles: 0, planModeActive: true },
      );
      if (mode === 'references') {
        replaceImagePayloadsInPlace(history, new InMemoryImagePayloadStore());
      } else if (mode !== 'inline') {
        if (mode === 'all')
          history.push(pending('Next image.'), {
            role: 'user',
            parts: [image],
          });
        history = microcompactHistory(
          history,
          null,
          { toolResultsNumToKeep: 1 },
          { force: true },
        ).history.slice(0, 3);
      }
      const wire = JSON.stringify(history);
      const restored = buildApiHistoryFromConversation({
        messages: [checkpoint(history)],
      });
      expect(JSON.stringify(restored)).toBe(wire);
      expect(detectTurnInterruption(restored)).toEqual({ kind: 'none' });
      expect(
        getStartupContextLength(restored, { includeCompressed: true }),
      ).toBe(3);
      expect(countApiUserPrompts(restored)).toBe(0);
      expect(findApiRewindCutPoint(restored, 0)).toBe(3);
      expect(selectForkHistory(restored, 1)).toEqual([]);
      const request = pending('Real failed request.');
      expect(detectTurnInterruption([...restored, request])).toEqual({
        kind: 'interrupted_prompt',
        parts: request.parts,
      });
    },
  );

  it.each([false, true])(
    'keeps genuine generated-looking input after an empty checkpoint (startup: %s)',
    async (startup) => {
      const compacted = await composePostCompactHistory([], 'Summary.');
      if (startup)
        compacted.unshift(
          pending('<system-reminder>\nStartup\n</system-reminder>'),
        );
      const texts = [
        '<background-tasks>\nExplain this tag.',
        'Recently accessed file (full current content embedded):',
        'Recently accessed file (full current content embedded):\n\n## /tmp/a.ts\n\n```\nconst a = 1;\n```',
        '[Old inline media cleared: image/png]',
        '[Image #0123456789ab: image/png, 3 bytes]',
      ];
      for (const text of texts) {
        for (const promptId of [undefined, 'real-input']) {
          const request = pending(text);
          const record: ChatRecord = {
            ...checkpoint([]),
            uuid: 'input',
            type: 'user',
            subtype: undefined,
            systemPayload: undefined,
            message: request,
            promptId,
          };
          const restored = buildApiHistoryFromConversation({
            messages: [checkpoint(compacted), record],
          });
          for (const copy of [
            restored,
            cloneApiHistory(restored),
            selectForkHistory(restored, 'all'),
            buildSessionRecoveryPlanFromApiHistory({
              sessionId: 'session',
              apiHistory: restored,
            }).apiHistory,
          ]) {
            expect(JSON.stringify(copy)).toBe(
              JSON.stringify([...compacted, request]),
            );
            expect(
              getStartupContextLength(copy, { includeCompressed: true }),
            ).toBe(compacted.length);
            expect(countApiUserPrompts(copy)).toBe(1);
            expect(JSON.stringify(selectForkHistory(copy, 1))).toBe(
              JSON.stringify([request]),
            );
            expect(getLastApiHistoryPromptId(copy)).toBe(promptId);
            expect(detectTurnInterruption(copy)).toEqual({
              kind: 'interrupted_prompt',
              parts: request.parts,
            });
          }
        }
      }
    },
  );
});

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

describe('cancelled prompt identity with automatic tails', () => {
  const base = {
    sessionId: 'session',
    timestamp: '2026-10-14T00:00:00.000Z',
    cwd: '/workspace',
    version: 'test',
    parentUuid: null,
  };
  const input: ChatRecord = {
    ...base,
    uuid: 'input',
    type: 'user',
    promptId: 'client-1',
    daemonPromptId: 'daemon-1',
    message: { role: 'user', parts: [{ text: 'work' }] },
  };
  const cancelledResult = {
    promptId: 'daemon-1',
    state: 'cancelled' as const,
    cancelledAt: 0,
    cancelReason: 'user' as const,
    endedAt: 1,
  };
  const terminal: ChatRecord = {
    ...base,
    uuid: 'terminal',
    type: 'system',
    subtype: 'turn_result',
    promptId: input.promptId,
    systemPayload: cancelledResult,
  };
  const guard =
    '[Todo Stop Guard] 1 todo item(s) are still pending or in progress. Continue executing the current task now. Do not ask the user whether to continue. If progress requires user input, use the structured question or permission flow. If progress depends on external state, report the blocker explicitly.';
  it.each([
    guard,
    '<task-notification><task-id>t</task-id><status>completed</status><summary>ready</summary></task-notification>',
  ])(
    'retains recorded cancellation through an untagged automatic tail (%s)',
    (text) => {
      const original = structuredClone(input.message!);
      markApiHistoryPrompt(original, input.promptId);
      const history: Content[] = [
        original,
        { role: 'user', parts: [{ text }] },
      ];
      const records: ChatRecord[] = [
        input,
        {
          ...base,
          uuid: 'attempt',
          type: 'system',
          subtype: 'turn_attempt',
          promptId: input.promptId,
          daemonPromptId: 'daemon-2',
        },
        {
          ...terminal,
          systemPayload: { ...cancelledResult, promptId: 'daemon-2' },
        },
      ];
      expect(getLastApiHistoryPromptId(history)).toBe('client-1');
      expect(getLastApiPromptCancellation(history, records)).toEqual({
        reason: 'user',
        promptId: 'daemon-2',
      });
      markApiHistoryPrompt(history[1]!, 'real-newer-input');
      records.push({
        ...input,
        uuid: 'newer',
        promptId: 'real-newer-input',
        daemonPromptId: 'daemon-3',
      });
      expect(getLastApiHistoryPromptId(history)).toBe('real-newer-input');
      expect(getLastApiPromptCancellation(history, records)).toBeUndefined();
    },
  );
  it('unidentified newer content cannot replace recorded ownership', () => {
    const original = structuredClone(input.message!);
    markApiHistoryPrompt(original, input.promptId);
    const history: Content[] = [
      original,
      { role: 'user', parts: [{ text: 'new real input' }] },
    ];
    expect(getLastApiHistoryPromptId(history)).toBe('client-1');
    expect(getLastApiPromptCancellation(history, [input, terminal])).toEqual({
      reason: 'user',
      promptId: 'daemon-1',
    });
  });
  it('zero notification count does not create prompt identity', () => {
    const original = structuredClone(input.message!);
    markApiHistoryPrompt(original, input.promptId);
    const history: Content[] = [
      original,
      {
        role: 'user',
        parts: [{ text: '<task-notification>ready</task-notification>' }],
      },
    ];
    const legacy = {
      ...terminal,
      promptId: undefined,
      systemPayload: { ...cancelledResult, cancelReason: undefined },
    };
    expect(getLastApiHistoryPromptId(history, 0)).toBe('client-1');
    expect(getLastApiPromptCancellation(history, [input, legacy], 0)).toEqual({
      reason: 'unknown',
      promptId: 'daemon-1',
      confirmationId: 'terminal',
    });
  });
  it.each([
    'user',
    'malformed',
    'duplicate-owner',
    'duplicate-result',
    'wrong-daemon',
    'duplicate-uuid',
  ])('does not offer legacy confirmation for %s records', (kind) => {
    const legacy: ChatRecord = {
      ...terminal,
      systemPayload: { ...cancelledResult, cancelReason: undefined },
    };
    const records = [input, legacy];
    if (kind === 'user') legacy.systemPayload = cancelledResult;
    if (kind === 'malformed') {
      legacy.systemPayload = {
        ...cancelledResult,
        cancelReason: undefined,
        endedAt: undefined,
      } as unknown as ChatRecord['systemPayload'];
    }
    if (kind === 'duplicate-owner')
      records.unshift({ ...input, uuid: 'duplicate' });
    if (kind === 'duplicate-result')
      records.push({ ...legacy, uuid: 'duplicate' });
    if (kind === 'wrong-daemon') {
      legacy.systemPayload = {
        ...cancelledResult,
        cancelReason: undefined,
        promptId: 'different-daemon',
      };
    }
    if (kind === 'duplicate-uuid') {
      records.push({
        ...legacy,
        promptId: 'other-client',
        systemPayload: {
          promptId: 'daemon-1',
          state: 'completed',
          endedAt: 3,
        },
      });
    }
    const history = buildApiHistoryFromConversation({ messages: [input] });
    expect(
      getLastApiPromptCancellation(history, records)?.confirmationId,
    ).toBeUndefined();
  });
  it('does not confirm an old legacy boundary after a later unowned user cancellation', () => {
    const legacy: ChatRecord = {
      ...terminal,
      systemPayload: { ...cancelledResult, cancelReason: undefined },
    };
    const history = buildApiHistoryFromConversation({ messages: [input] });
    const records = [
      input,
      legacy,
      {
        ...terminal,
        uuid: 'local-completed',
        promptId: undefined,
        systemPayload: {
          promptId: 'local-command',
          state: 'completed' as const,
          endedAt: 3,
        },
      },
    ];
    expect(getLastApiPromptCancellation(history, records)?.confirmationId).toBe(
      'terminal',
    );
    records.push({
      ...terminal,
      uuid: 'later-user-cancel',
      promptId: undefined,
      systemPayload: {
        ...cancelledResult,
        promptId: 'unowned-new-daemon',
        endedAt: 4,
      },
    });
    expect(
      getLastApiPromptCancellation(history, records)?.confirmationId,
    ).toBeUndefined();
  });

  it('offers a different confirmation after a new cancelled attempt', () => {
    const legacy: ChatRecord = {
      ...terminal,
      systemPayload: { ...cancelledResult, cancelReason: undefined },
    };
    const history = buildApiHistoryFromConversation({ messages: [input] });
    const records = [input, legacy];
    expect(getLastApiPromptCancellation(history, records)?.confirmationId).toBe(
      'terminal',
    );
    records.push({
      ...input,
      type: 'system',
      subtype: 'turn_attempt',
      uuid: 'attempt',
      daemonPromptId: 'daemon-2',
      message: undefined,
    });
    expect(getLastApiPromptCancellation(history, records)).toBeUndefined();
    records.push({
      ...legacy,
      uuid: 'new-terminal',
      systemPayload: {
        ...cancelledResult,
        cancelReason: undefined,
        promptId: 'daemon-2',
      },
    });
    expect(getLastApiPromptCancellation(history, records)?.confirmationId).toBe(
      'new-terminal',
    );
  });
  it('keeps cancellation through compression with several entries for the same turn', () => {
    const compression: ChatRecord = {
      ...base,
      uuid: 'compression',
      type: 'system',
      subtype: 'chat_compression',
      systemPayload: {
        compressedHistory: [
          input.message!,
          {
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
        ],
        promptIds: [input.promptId!, input.promptId!],
        info: {
          originalTokenCount: 100,
          newTokenCount: 20,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      },
    };
    const records = [input, compression, terminal];
    const history = buildApiHistoryFromConversation({ messages: records });
    expect(getLastApiPromptCancellation(history, records)).toEqual({
      reason: 'user',
      promptId: 'daemon-1',
    });
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
