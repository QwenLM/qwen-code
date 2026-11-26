/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ASK_USER_TOOL_NAME,
  CoreToolCallStatus,
  type UnifiedTask,
} from '@qwen-code/core';
import { StreamingState, type HistoryItemWithoutId } from '../types.js';
import {
  getProgramStatusBlocker,
  MAX_SUBAGENT_RECORDS,
  PROGRAM_STATUS_MESSAGES,
  toMainProgramStatus,
  toSubagentProgramStatuses,
  type ProgramStatusBlockerInput,
} from './programStatus.js';

const noBlockers: ProgramStatusBlockerInput = {
  signInRequired: false,
  authConsentPending: false,
  pendingHistoryItems: [],
  permissionQueueToolNames: [],
  commandConfirmationPending: false,
  otherApprovalPending: false,
};

function awaitingTool(confirmationType: string): HistoryItemWithoutId {
  return {
    type: 'tool_group',
    tools: [
      {
        callId: 'c1',
        name: 'tool',
        status: CoreToolCallStatus.AwaitingApproval,
        confirmationDetails: { type: confirmationType },
      },
    ],
  } as unknown as HistoryItemWithoutId;
}

describe('getProgramStatusBlocker', () => {
  it('returns nothing when no prompt is open', () => {
    expect(getProgramStatusBlocker(noBlockers)).toBeUndefined();
  });

  it('maps sign-in and auth consent to auth', () => {
    expect(getProgramStatusBlocker({ ...noBlockers, signInRequired: true })).toEqual({
      kind: 'auth',
      msg: PROGRAM_STATUS_MESSAGES.signIn,
    });
    expect(
      getProgramStatusBlocker({ ...noBlockers, authConsentPending: true }),
    ).toMatchObject({ kind: 'auth' });
  });

  it('maps AskUser to question and other confirmations to permission', () => {
    expect(
      getProgramStatusBlocker({
        ...noBlockers,
        pendingHistoryItems: [awaitingTool(ASK_USER_TOOL_NAME)],
      }),
    ).toEqual({ kind: 'question', msg: PROGRAM_STATUS_MESSAGES.question });
    expect(
      getProgramStatusBlocker({
        ...noBlockers,
        permissionQueueToolNames: [ASK_USER_TOOL_NAME],
      }),
    ).toMatchObject({ kind: 'question' });
    expect(
      getProgramStatusBlocker({
        ...noBlockers,
        pendingHistoryItems: [awaitingTool('exec')],
      }),
    ).toEqual({ kind: 'permission', msg: PROGRAM_STATUS_MESSAGES.toolConfirmation });
    expect(
      getProgramStatusBlocker({ ...noBlockers, permissionQueueToolNames: ['Bash'] }),
    ).toMatchObject({ kind: 'permission' });
    expect(
      getProgramStatusBlocker({ ...noBlockers, commandConfirmationPending: true }),
    ).toMatchObject({ kind: 'permission' });
    expect(
      getProgramStatusBlocker({ ...noBlockers, otherApprovalPending: true }),
    ).toMatchObject({ kind: 'permission' });
  });

  it('puts auth ahead of a pending permission', () => {
    expect(
      getProgramStatusBlocker({
        ...noBlockers,
        signInRequired: true,
        permissionQueueToolNames: ['Bash'],
      }),
    ).toMatchObject({ kind: 'auth' });
  });
});

describe('toMainProgramStatus', () => {
  const base = {
    streamingState: StreamingState.Idle,
    queued: false,
    blocker: undefined,
    lastTurnEnd: null,
  } as const;

  it('starts idle', () => {
    expect(toMainProgramStatus(base)).toEqual({ state: 'idle' });
  });

  it('reports working while responding or with a queued prompt', () => {
    expect(
      toMainProgramStatus({ ...base, streamingState: StreamingState.Responding }),
    ).toEqual({ state: 'working', msg: undefined });
    expect(toMainProgramStatus({ ...base, queued: true })).toMatchObject({
      state: 'working',
    });
  });

  it('lets blocked outrank working', () => {
    expect(
      toMainProgramStatus({
        ...base,
        streamingState: StreamingState.WaitingForConfirmation,
        blocker: { kind: 'permission', msg: 'Tool confirmation required' },
      }),
    ).toEqual({
      state: 'blocked',
      kind: 'permission',
      msg: 'Tool confirmation required',
    });
  });

  it('maps the last turn end to done, idle or error', () => {
    expect(
      toMainProgramStatus({
        ...base,
        lastTurnEnd: 'completed',
        customSessionTitle: 'Fix login',
      }),
    ).toEqual({ state: 'done', msg: 'Fix login' });
    expect(toMainProgramStatus({ ...base, lastTurnEnd: 'cancelled' })).toEqual({
      state: 'idle',
    });
    expect(
      toMainProgramStatus({
        ...base,
        lastTurnEnd: { error: '\n[API Error: 503 overloaded]\nstack line' },
      }),
    ).toEqual({ state: 'error', msg: '[API Error: 503 overloaded]' });
  });

  it('only uses the explicit session title in msg', () => {
    expect(
      toMainProgramStatus({ ...base, streamingState: StreamingState.Responding }).msg,
    ).toBeUndefined();
  });
});

function task(overrides: Partial<UnifiedTask> & Pick<UnifiedTask, 'id' | 'type'>) {
  return {
    status: 'running',
    description: 'Explore the repo',
    startTime: 0,
    notified: false,
    executionId: 1,
    completionBehavior: 'notify',
    ...overrides,
  } as unknown as UnifiedTask;
}

describe('toSubagentProgramStatuses', () => {
  it('reports active agents and workflows, skipping shells and finished tasks', () => {
    const records = toSubagentProgramStatuses([
      task({ id: 'a-explore-1', type: 'local_agent' }),
      task({ id: 'b-1', type: 'local_bash' }),
      task({ id: 'a-done', type: 'local_agent', status: 'completed' }),
      task({ id: 'w-1', type: 'local_workflow', title: 'Release' } as Partial<UnifiedTask> & Pick<UnifiedTask, 'id' | 'type'>),
      task({ id: 't-idle', type: 'in_process_teammate', isIdle: true } as Partial<UnifiedTask> & Pick<UnifiedTask, 'id' | 'type'>),
      task({ id: 'a-paused', type: 'local_agent', status: 'paused' }),
    ]);
    expect(records).toEqual([
      { id: 'a-explore-1', state: 'working', title: 'Explore the repo' },
      { id: 'a-paused', state: 'idle', title: 'Explore the repo' },
      { id: 'w-1', state: 'working', title: 'Release' },
    ]);
  });

  it('caps the number of records', () => {
    const tasks = Array.from({ length: 40 }, (_, i) =>
      task({ id: `a-${String(i).padStart(2, '0')}`, type: 'local_agent' }),
    );
    expect(toSubagentProgramStatuses(tasks)).toHaveLength(MAX_SUBAGENT_RECORDS);
  });
});
