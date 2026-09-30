/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  externalRequestKey,
  toA2ATaskState,
  toExternalA2ATaskState,
} from './a2a-contract.js';
import type { Thread, ThreadRun, ThreadStatus } from './types.js';

function run(overrides: Partial<ThreadRun>): ThreadRun {
  return {
    id: 'rn_1',
    agentId: 'ag_a',
    status: 'completed',
    triggerMessageIds: [],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    queueSequence: 1,
    attempts: 1,
    queuedAt: 1,
    ...overrides,
  };
}

function thread(status: ThreadStatus, runs: ThreadRun[]): Thread {
  return { status, runs, messages: [] } as unknown as Thread;
}

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

  it('gives an external task a terminal state once no run is live', () => {
    const state = (status: ThreadStatus, runs: ThreadRun[]) =>
      toExternalA2ATaskState(thread(status, runs));
    expect(state('open', [])).toBe('TASK_STATE_SUBMITTED');
    expect(state('in_progress', [run({ status: 'running' })])).toBe(
      'TASK_STATE_WORKING',
    );
    // An answer with nothing outstanding stays `in_progress` locally.
    expect(state('in_progress', [run({})])).toBe('TASK_STATE_COMPLETED');
    const review = run({ closeKind: 'review' });
    expect(state('in_review', [review])).toBe('TASK_STATE_COMPLETED');
    const failed = run({ status: 'failed' });
    expect(state('blocked', [failed])).toBe('TASK_STATE_FAILED');
    const waiting = run({ closeKind: 'waiting' });
    expect(state('in_progress', [waiting])).toBe('TASK_STATE_WORKING');
    const live = run({ status: 'running' });
    expect(state('cancelled', [live])).toBe('TASK_STATE_CANCELED');
  });

  it('reads a wait beside another obligation as an answer, not a failure', () => {
    // `blocked` / `in_review` is also what a question or a review outranking
    // a live wait resolves to; only a wait left alone is stranded.
    const state = (status: ThreadStatus, runs: ThreadRun[]) =>
      toExternalA2ATaskState(thread(status, runs));
    const waiting = run({ id: 'rn_wait', closeKind: 'waiting' });
    const review = run({ id: 'rn_review', closeKind: 'review' });
    const question = run({ id: 'rn_question', closeKind: 'blocked' });
    expect(state('in_review', [waiting, review])).toBe('TASK_STATE_COMPLETED');
    expect(state('blocked', [waiting, question])).toBe('TASK_STATE_COMPLETED');
    expect(state('blocked', [waiting])).toBe('TASK_STATE_FAILED');
  });

  it('refuses an unmapped local status', () => {
    expect(() => toA2ATaskState('future' as ThreadStatus)).toThrow(
      'Unmapped thread status: future',
    );
  });
});
