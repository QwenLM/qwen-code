/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import type { ChatRecord } from '../services/chatRecordingService.js';
import type { ConversationRecord } from '../services/sessionService.js';
import {
  buildSessionRecoveryPlan,
  buildSessionRecoveryPlanFromApiHistory,
} from './session-recovery.js';

function conversation(messages: Content[]): ConversationRecord {
  return {
    sessionId: 'session-1',
    projectHash: 'project-1',
    startTime: '2026-07-11T00:00:00.000Z',
    lastUpdated: '2026-07-11T00:00:00.000Z',
    messages: messages.map((message, index) => ({
      uuid: `m-${index}`,
      parentUuid: index === 0 ? null : `m-${index - 1}`,
      sessionId: 'session-1',
      timestamp: '2026-07-11T00:00:00.000Z',
      type: message.role === 'model' ? 'assistant' : 'user',
      cwd: '/tmp/project',
      version: 'test',
      message,
    })),
  };
}

/** The envelope the background registries emit as a notification's modelText. */
function taskNotification(summary: string): string {
  return (
    '<task-notification>' +
    '<task-id>agent-1</task-id>' +
    '<status>completed</status>' +
    `<summary>${summary}</summary>` +
    '</task-notification>'
  );
}

/**
 * A record shaped like `ChatRecordingService.createNotificationRecord` output:
 * user-role, `subtype: 'notification'`, `provenance: 'system'`, envelope as its
 * only part. Neither the subtype nor the provenance survives into `Content`, so
 * the api history projection holds a plain `role: 'user'` entry that role alone
 * cannot tell apart from a real prompt.
 */
function notificationRecord(index: number, summary: string): ChatRecord {
  return {
    uuid: `m-${index}`,
    parentUuid: index === 0 ? null : `m-${index - 1}`,
    sessionId: 'session-1',
    timestamp: '2026-07-11T00:00:00.000Z',
    type: 'user',
    subtype: 'notification',
    provenance: 'system',
    cwd: '/tmp/project',
    version: 'test',
    message: { role: 'user', parts: [{ text: taskNotification(summary) }] },
    systemPayload: { displayText: 'Background task completed.' },
  };
}

function conversationFromRecords(messages: ChatRecord[]): ConversationRecord {
  return {
    sessionId: 'session-1',
    projectHash: 'project-1',
    startTime: '2026-07-11T00:00:00.000Z',
    lastUpdated: '2026-07-11T00:00:00.000Z',
    messages,
  };
}

describe('buildSessionRecoveryPlan', () => {
  it('returns clean for a completed model text tail', () => {
    const plan = buildSessionRecoveryPlan({
      sessionId: 'session-1',
      conversation: conversation([
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'done' }] },
      ]),
    });

    expect(plan.kind).toBe('clean');
    expect(plan.canContinue).toBe(false);
    expect(plan.repairs).toEqual([]);
  });

  it('detects an interrupted prompt before applying provider-safe repair', () => {
    const plan = buildSessionRecoveryPlan({
      sessionId: 'session-1',
      conversation: conversation([
        { role: 'model', parts: [{ text: 'ready' }] },
        { role: 'user', parts: [{ text: 'do the thing' }] },
      ]),
    });

    expect(plan.kind).toBe('interrupted_prompt');
    expect(plan.continuation).toMatchObject({
      mode: 'retry_user_parts',
      parts: [{ text: 'do the thing' }],
    });
  });

  it('detects dangling tool calls from original history and repairs apiHistory', () => {
    const plan = buildSessionRecoveryPlan({
      sessionId: 'session-1',
      conversation: conversation([
        { role: 'user', parts: [{ text: 'read file' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'read_file',
                args: { path: 'a.txt' },
              },
            },
          ],
        },
      ]),
    });

    expect(plan.kind).toBe('interrupted_turn');
    expect(plan.continuation).toMatchObject({
      mode: 'tool_result_parts',
      parts: [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
          },
        },
      ],
    });
    expect(plan.repairs).toEqual([
      {
        type: 'synthesized_tool_result',
        callId: 'call-1',
        name: 'read_file',
      },
    ]);
    expect(plan.originalApiHistory.at(-1)?.role).toBe('model');
    expect(plan.apiHistory.at(-1)?.role).toBe('user');
    expect(plan.apiHistory.at(-1)?.parts?.[0]?.functionResponse?.id).toBe(
      'call-1',
    );
  });

  it('leaves a caller-supplied history unmutated while repairing its own copy', () => {
    const apiHistory: Content[] = [
      { role: 'user', parts: [{ text: 'read file' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-1',
              name: 'read_file',
              args: { path: 'a.txt' },
            },
          },
        ],
      },
    ];
    const supplied = structuredClone(apiHistory);

    const plan = buildSessionRecoveryPlanFromApiHistory({
      sessionId: 'session-1',
      apiHistory,
    });

    expect(plan.kind).toBe('interrupted_turn');
    // The repair must land on the plan's own copy: a builder that mutated the
    // argument would corrupt the live chat history the caller passed in.
    expect(apiHistory).toEqual(supplied);
    expect(plan.originalApiHistory.at(-1)?.role).toBe('model');
    expect(plan.apiHistory.at(-1)?.role).toBe('user');
  });

  it('marks sessions with history gaps as degraded and disables continuation', () => {
    const plan = buildSessionRecoveryPlan({
      sessionId: 'session-1',
      conversation: conversation([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]),
      historyGaps: [{ childUuid: 'm-1', missingParentUuid: 'missing' }],
    });

    expect(plan.kind).toBe('degraded_history');
    expect(plan.canContinue).toBe(false);
    expect(plan.canAutoContinue).toBe(false);
    expect(plan.requiresUserConfirmation).toBe(true);
    expect(plan.repairs).toContainEqual({
      type: 'history_gap',
      childUuid: 'm-1',
      missingParentUuid: 'missing',
    });
  });
});

/**
 * A recorded-but-unanswered `<task-notification>` tail is not an interrupted
 * turn. The daemon persists every background notification before its automatic
 * turn runs, and a notification whose turn never ran leaves a `role: 'user'`
 * projection tail that nothing ever answers — which used to classify as
 * `interrupted_prompt` with `canContinue: true`, pinning the Web Shell recovery
 * banner on a session whose last real turn ended with `end_turn`.
 */
describe('buildSessionRecoveryPlan with unanswered notifications', () => {
  const promptRecord = (index: number, text: string): ChatRecord => ({
    uuid: `m-${index}`,
    parentUuid: index === 0 ? null : `m-${index - 1}`,
    sessionId: 'session-1',
    timestamp: '2026-07-11T00:00:00.000Z',
    type: 'user',
    cwd: '/tmp/project',
    version: 'test',
    message: { role: 'user', parts: [{ text }] },
  });

  const modelRecord = (index: number, content: Content): ChatRecord => ({
    uuid: `m-${index}`,
    parentUuid: index === 0 ? null : `m-${index - 1}`,
    sessionId: 'session-1',
    timestamp: '2026-07-11T00:00:00.000Z',
    type: 'assistant',
    cwd: '/tmp/project',
    version: 'test',
    message: content,
  });

  it('reports clean for a completed turn followed by unanswered notifications', () => {
    const plan = buildSessionRecoveryPlan({
      sessionId: 'session-1',
      conversation: conversationFromRecords([
        promptRecord(0, 'run the agent in the background'),
        modelRecord(1, { role: 'model', parts: [{ text: 'all done' }] }),
        notificationRecord(2, 'Agent "explore" completed.'),
        notificationRecord(3, 'Agent "build" completed.'),
      ]),
    });

    expect(plan.kind).toBe('clean');
    expect(plan.canContinue).toBe(false);
    expect(plan.continuation).toBeUndefined();
  });

  it('still recovers a genuinely interrupted prompt sitting after a notification', () => {
    const plan = buildSessionRecoveryPlan({
      sessionId: 'session-1',
      conversation: conversationFromRecords([
        notificationRecord(0, 'Agent "explore" completed.'),
        promptRecord(1, 'do the thing'),
      ]),
    });

    // Reverse guard: trimming the notification tail must not blind detection to
    // a real orphaned prompt that follows it. `toEqual`, not `toContainEqual`:
    // the continuation re-submits the whole trailing user run the Retry send
    // path strips, so the leading notification belongs in `parts` too.
    expect(plan.kind).toBe('interrupted_prompt');
    expect(plan.canContinue).toBe(true);
    expect(plan.continuation?.mode).toBe('retry_user_parts');
    expect(plan.continuation?.parts).toEqual([
      { text: taskNotification('Agent "explore" completed.') },
      { text: 'do the thing' },
    ]);
  });

  it('keeps a dangling tool call interrupted when a notification follows it', () => {
    const plan = buildSessionRecoveryPlan({
      sessionId: 'session-1',
      conversation: conversationFromRecords([
        promptRecord(0, 'read file'),
        modelRecord(1, {
          role: 'model',
          parts: [{ functionCall: { id: 'call-1', name: 'read_file' } }],
        }),
        notificationRecord(2, 'Agent "explore" completed.'),
      ]),
    });

    expect(plan.kind).toBe('interrupted_turn');
    expect(plan.canContinue).toBe(true);
    expect(plan.continuation).toMatchObject({
      mode: 'tool_result_parts',
      parts: [{ functionResponse: { id: 'call-1', name: 'read_file' } }],
    });
  });
});
