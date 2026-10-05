/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { SessionAgentRunStatus } from '../session-agents/contract.js';
import {
  a2aMentionText,
  externalRequestKey,
  isTerminalA2ATaskState,
  toA2ATaskState,
} from './a2a-contract.js';
import { parseMentions } from './mentions.js';
import type { WorkspaceAgent } from './types.js';

const roster: WorkspaceAgent[] = [
  { id: 'ag_lead', name: 'lead', createdAt: 1 },
  { id: 'ag_other', name: 'other', createdAt: 1 },
  { id: 'ag_cn', name: '迁移助手', createdAt: 1 },
];

describe('A2A contract', () => {
  it('scopes opaque message ids without delimiter collisions', () => {
    const first = externalRequestKey({
      callerId: 'a:b',
      targetAgentId: 'c',
      messageId: 'd',
    });
    const second = externalRequestKey({
      callerId: 'a',
      targetAgentId: 'b:c',
      messageId: 'd',
    });

    expect(first).not.toBe(second);
  });

  it('maps every run status to a task state', () => {
    const cases: Array<[SessionAgentRunStatus, string]> = [
      ['queued', 'TASK_STATE_SUBMITTED'],
      ['running', 'TASK_STATE_WORKING'],
      ['awaiting_approval', 'TASK_STATE_INPUT_REQUIRED'],
      ['completed', 'TASK_STATE_COMPLETED'],
      ['failed', 'TASK_STATE_FAILED'],
      ['offline', 'TASK_STATE_FAILED'],
      ['cancelled', 'TASK_STATE_CANCELED'],
    ];
    for (const [status, state] of cases) {
      expect(toA2ATaskState(status)).toBe(state);
    }
    expect(isTerminalA2ATaskState('TASK_STATE_INPUT_REQUIRED')).toBe(false);
    expect(isTerminalA2ATaskState('TASK_STATE_CANCELED')).toBe(true);
  });

  it('refuses an unmapped run status', () => {
    expect(() => toA2ATaskState('future' as SessionAgentRunStatus)).toThrow(
      'Unmapped run status: future',
    );
  });

  it('addresses the granted agent only', () => {
    const text = a2aMentionText(
      'lead',
      'Ask @other and 请@迁移助手看一下, then mail ops@example.com about @scope/pkg.',
    );

    expect(text.startsWith('@lead ')).toBe(true);
    expect(parseMentions(text, roster)).toEqual({
      ids: ['ag_lead'],
      unknown: [],
    });
    // Addresses that were never mentions are left alone.
    expect(text).toContain('ops@example.com');
    // A caller naming the granted agent again does not change who answers.
    const repeated = a2aMentionText('lead', '@lead hi');
    expect(parseMentions(repeated, roster).ids).toEqual(['ag_lead']);
  });

  it('refuses a name that would not parse as a mention', () => {
    expect(() => a2aMentionText('two words', 'hi')).toThrow(
      'Invalid agent name',
    );
  });
});
