/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import type { ConversationRecord } from '../services/sessionService.js';
import { buildSessionRecoveryPlan } from './session-recovery.js';

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
