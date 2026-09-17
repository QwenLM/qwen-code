/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type {
  ChatRecord,
  Config,
  GoalRecord,
  GoalStateCause,
} from '@qwen-code/qwen-code-core';
import { collectSessionData } from './collect.js';
import { toJsonl } from './formatters/jsonl.js';
import type { ExportConfig } from './types.js';

describe('collectSessionData', () => {
  const config = {
    getToolRegistry: vi.fn().mockReturnValue({
      getTool: vi.fn().mockReturnValue(null),
    }),
  } as unknown as Config;

  it('keeps oversized canonical tool results lossless in offline export', async () => {
    const source = `head-${'x'.repeat(499_999)}-tail`;
    const records: ChatRecord[] = [
      {
        uuid: 'assistant-large',
        parentUuid: null,
        sessionId: 'session-large',
        timestamp: '2026-08-03T00:00:00.000Z',
        type: 'assistant',
        cwd: '/workspace',
        version: '1.0.0',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-large',
                name: 'read_file',
                args: { path: '/workspace/large.txt' },
              },
            },
          ],
        },
      },
      {
        uuid: 'tool-large',
        parentUuid: 'assistant-large',
        sessionId: 'session-large',
        timestamp: '2026-08-03T00:00:01.000Z',
        type: 'tool_result',
        cwd: '/workspace',
        version: '1.0.0',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-large',
                name: 'read_file',
                response: { output: source },
              },
            },
          ],
        },
        toolCallResult: {
          callId: 'call-large',
          responseParts: [],
          resultDisplay: source,
        },
      },
    ];

    const data = await collectSessionData(
      {
        sessionId: 'session-large',
        startTime: '2026-08-03T00:00:00.000Z',
        messages: records,
      },
      config,
    );
    const toolCall = data.messages.find(
      (message) => message.type === 'tool_call',
    );
    const exportedText = (
      toolCall?.toolCall?.content?.[0] as
        | { content?: { text?: string } }
        | undefined
    )?.content?.text;

    expect(exportedText?.length).toBe(source.length);
    expect(
      createHash('sha256')
        .update(exportedText ?? '')
        .digest('hex'),
    ).toBe(createHash('sha256').update(source).digest('hex'));
  });

  it('skips line-count fallback for truncated saved-session previews', async () => {
    const records: ChatRecord[] = [
      {
        uuid: 'assistant-1',
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:00.000Z',
        type: 'assistant',
        cwd: '',
        version: '1.0.0',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'edit_file',
                args: { file_path: '/test/file.ts' },
              },
            },
          ],
        },
      },
      {
        uuid: 'tool-1',
        parentUuid: 'assistant-1',
        sessionId: 'session-1',
        timestamp: '2025-01-01T00:00:01.000Z',
        type: 'tool_result',
        cwd: '',
        version: '1.0.0',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'edit_file',
                response: { output: 'ok' },
              },
            },
          ],
        },
        toolCallResult: {
          callId: 'call-1',
          resultDisplay: {
            fileName: 'file.ts',
            fileDiff:
              '--- file.ts\n+++ file.ts\n@@ -1,2 +1,2 @@\n-old\n-preview\n+new\n+preview',
            originalContent: 'old\npreview',
            newContent: 'new\npreview',
            truncatedForSession: true,
          },
        },
      },
    ];

    const data = await collectSessionData(
      {
        sessionId: 'session-1',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: records,
      },
      config,
    );

    expect(data.metadata?.filesWritten).toBe(1);
    expect(data.metadata?.uniqueFiles).toEqual(['/test/file.ts']);
    expect(data.metadata?.linesAdded).toBe(0);
    expect(data.metadata?.linesRemoved).toBe(0);
  });

  it('accepts the minimal daemon export config shape', async () => {
    const minimalConfig: ExportConfig = {
      getChannel: () => 'web-shell',
    };

    const data = await collectSessionData(
      {
        sessionId: 'session-minimal',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [
          {
            uuid: 'user-1',
            parentUuid: null,
            sessionId: 'session-minimal',
            timestamp: '2025-01-01T00:00:00.000Z',
            type: 'user',
            cwd: '',
            version: '1.0.0',
            message: {
              role: 'user',
              parts: [{ text: 'hello' }],
            },
          },
        ],
      },
      minimalConfig,
    );

    expect(data.metadata?.channel).toBe('web-shell');
    expect(data.messages[0]?.message?.parts?.[0]?.text).toBe('hello');
  });

  it('exports a session whose transcript ends on an active goal', async () => {
    // The daemon export config is a Proxy that throws on any method it does not
    // implement, and it implements none of the /goal trust gates. Anything the
    // replayer asks of `config` beyond that shape takes the whole export down.
    const minimalConfig: ExportConfig = { getChannel: () => 'daemon' };

    const data = await collectSessionData(
      {
        sessionId: 'session-goal',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [
          {
            uuid: 'goal-1',
            parentUuid: null,
            sessionId: 'session-goal',
            timestamp: '2025-01-01T00:00:00.000Z',
            type: 'system',
            subtype: 'slash_command',
            cwd: '',
            version: '1.0.0',
            systemPayload: {
              phase: 'result',
              rawCommand: '/goal',
              outputHistoryItems: [
                { type: 'goal_status', kind: 'set', condition: 'ship it' },
              ],
            },
          } as unknown as ChatRecord,
        ],
      },
      minimalConfig,
    );

    expect(data.metadata?.channel).toBe('daemon');
  });

  describe('goal_state records', () => {
    const GOAL: GoalRecord = {
      goalId: 'goal-1',
      revision: 1,
      objective: 'ship it',
      status: 'active',
      evidenceCursor: { recordId: 'user-1' },
      turnCount: 0,
      activeTimeMs: 0,
      tokensUsed: 0,
      createdAt: 100,
      updatedAt: 100,
    };

    function base(uuid: string, second: number) {
      return {
        uuid,
        parentUuid: null,
        sessionId: 'session-goal-state',
        timestamp: `2026-09-17T00:00:0${second}.000Z`,
        cwd: '',
        version: '1.0.0',
      };
    }

    function goalState(
      uuid: string,
      second: number,
      cause: GoalStateCause,
      goal: GoalRecord | null,
    ): ChatRecord {
      return {
        ...base(uuid, second),
        type: 'system',
        subtype: 'goal_state',
        systemPayload: {
          v: 2,
          cause,
          snapshot: { v: 2, activity: 'idle', goal },
        },
      } as unknown as ChatRecord;
    }

    function text(uuid: string, second: number, type: 'user' | 'assistant') {
      return {
        ...base(uuid, second),
        type,
        message: {
          role: type === 'user' ? 'user' : 'model',
          parts: [{ text: `${type} ${uuid}` }],
        },
      } as unknown as ChatRecord;
    }

    const turned: GoalRecord = { ...GOAL, turnCount: 1, updatedAt: 200 };
    const rejected: GoalRecord = {
      ...turned,
      updatedAt: 300,
      lastReason: 'npm test output is missing',
    };

    it('writes every Goal transition in record order, bookkeeping included', async () => {
      const data = await collectSessionData(
        {
          sessionId: 'session-goal-state',
          startTime: '2026-09-17T00:00:00.000Z',
          messages: [
            text('user-1', 0, 'user'),
            goalState('goal-create', 1, 'create', GOAL),
            text('assistant-1', 2, 'assistant'),
            goalState('goal-turn', 3, 'turn_finished', turned),
            // Replay hides this one: same snapshot, checkpoint cause.
            goalState('goal-checkpoint', 4, 'checkpoint', turned),
            goalState('goal-reject', 5, 'verifier_reject', rejected),
            text('assistant-2', 6, 'assistant'),
          ],
        },
        config,
      );

      expect(
        data.messages.map((message) => [
          message.type,
          message.goalState?.cause ??
            message.message?.parts?.map((part) => part.text).join(' | '),
        ]),
      ).toEqual([
        // The replayed `/goal …` line joins the user message before it, and
        // the transition it caused follows both.
        ['user', 'user user-1 | /goal ship it'],
        ['system', 'create'],
        ['assistant', 'assistant assistant-1'],
        ['system', 'turn_finished'],
        ['system', 'checkpoint'],
        ['system', 'verifier_reject'],
        ['assistant', 'assistant assistant-2'],
      ]);

      // One uuid, one entry: the text replayed from the transition's own
      // record keeps that record's timestamp but not its uuid, so a record
      // reference in a snapshot resolves to the transition alone.
      const uuids = data.messages.map((message) => message.uuid);
      expect(new Set(uuids).size).toBe(uuids.length);
      expect(data.messages[0]).toMatchObject({
        type: 'user',
        timestamp: '2026-09-17T00:00:01.000Z',
      });
      expect(data.messages[0]!.uuid).not.toBe('goal-create');
      expect(data.messages[1]).toMatchObject({
        uuid: 'goal-create',
        goalState: { v: 2, cause: 'create' },
      });

      const reject = data.messages.find(
        (message) => message.goalState?.cause === 'verifier_reject',
      );
      expect(reject).toMatchObject({
        uuid: 'goal-reject',
        timestamp: '2026-09-17T00:00:05.000Z',
        message: {
          role: 'system',
          parts: [
            {
              text: 'Goal verifier_reject (active, turn 1): npm test output is missing',
            },
          ],
        },
        goalState: { snapshot: { v: 2, goal: rejected } },
      });
    });

    it('writes a transition that is the last record of the session', async () => {
      const data = await collectSessionData(
        {
          sessionId: 'session-goal-state',
          startTime: '2026-09-17T00:00:00.000Z',
          messages: [
            text('user-1', 0, 'user'),
            goalState('goal-create', 1, 'create', GOAL),
            goalState('goal-clear', 2, 'clear', null),
          ],
        },
        config,
      );

      expect(data.messages.at(-1)).toMatchObject({
        type: 'system',
        message: { parts: [{ text: 'Goal clear' }] },
        goalState: { cause: 'clear', snapshot: { goal: null } },
      });
      const lines = toJsonl(data)
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        lines.filter((line) => line.goalState).map((line) => line.uuid),
      ).toEqual(['goal-create', 'goal-clear']);
    });

    it('carries the whole journaled payload, blocked audit included', async () => {
      const audited = goalState('goal-turn', 1, 'turn_finished', turned);
      const blockedAudit = {
        fingerprint: 'external\nregistry is down',
        count: 2,
        turnIds: ['turn-1', 'turn-2'],
      };
      (audited.systemPayload as unknown as Record<string, unknown>)[
        'blockedAudit'
      ] = blockedAudit;

      const data = await collectSessionData(
        {
          sessionId: 'session-goal-state',
          startTime: '2026-09-17T00:00:00.000Z',
          messages: [text('user-1', 0, 'user'), audited],
        },
        config,
      );

      expect(data.messages.at(-1)?.goalState).toEqual({
        v: 2,
        cause: 'turn_finished',
        snapshot: { v: 2, activity: 'idle', goal: turned },
        blockedAudit,
      });
    });

    it('leaves out a goal_state record it cannot parse', async () => {
      const malformed = {
        ...goalState('goal-bad', 1, 'create', GOAL),
        systemPayload: { v: 2, cause: 'create' },
      } as unknown as ChatRecord;

      const data = await collectSessionData(
        {
          sessionId: 'session-goal-state',
          startTime: '2026-09-17T00:00:00.000Z',
          messages: [text('user-1', 0, 'user'), malformed],
        },
        config,
      );

      expect(data.messages.map((message) => message.type)).toEqual(['user']);
    });
  });

  it('replays tool calls when daemon export config has no tool registry', async () => {
    const minimalConfig: ExportConfig = {};

    const data = await collectSessionData(
      {
        sessionId: 'session-minimal-tool',
        startTime: '2025-01-01T00:00:00.000Z',
        messages: [
          {
            uuid: 'assistant-tool-1',
            parentUuid: null,
            sessionId: 'session-minimal-tool',
            timestamp: '2025-01-01T00:00:00.000Z',
            type: 'assistant',
            cwd: '',
            version: '1.0.0',
            message: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-minimal',
                    name: 'shell',
                    args: { command: 'pwd' },
                  },
                },
              ],
            },
          },
        ],
      },
      minimalConfig,
    );

    const toolCall = data.messages.find(
      (message) => message.type === 'tool_call',
    );
    expect(toolCall?.toolCall).toMatchObject({
      toolCallId: 'call-minimal',
      title: 'shell',
      status: 'failed',
    });
  });
});
