/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  acknowledgeCloseObligations,
  outstandingCloseObligations,
  resolveThreadStatus,
} from './thread-status.js';
import {
  HUMAN_AUTHOR_ID,
  AGENTS_SCHEMA_VERSION,
  type MessageOutcome,
  type Thread,
  type ThreadMessage,
  type ThreadRun,
} from './types.js';

function run(overrides: Partial<ThreadRun> = {}): ThreadRun {
  return {
    id: 'rn_1',
    agentId: 'ag_alice',
    status: 'completed',
    triggerMessageIds: ['ms_1'],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    queueSequence: 1,
    queuedAt: 1_000,
    attempts: 1,
    ...overrides,
  };
}

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'ms_1',
    sequence: 1,
    authorKind: 'human',
    from: HUMAN_AUTHOR_ID,
    authorNameSnapshot: 'user',
    text: 'have a look',
    mentions: [],
    outcomes: [],
    at: 2_000,
    ...overrides,
  };
}

const booked: MessageOutcome[] = [
  { kind: 'dispatch', targetAgentId: 'ag_alice', runId: 'rn_1' },
];

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    schemaVersion: AGENTS_SCHEMA_VERSION,
    id: 'th_1',
    title: 'Investigate',
    body: '',
    status: 'in_progress',
    createdAt: 1_000,
    createdBy: HUMAN_AUTHOR_ID,
    rootThreadId: 'th_1',
    messages: [message({ outcomes: booked })],
    runs: [],
    nextMessageSequence: 2,
    deliveryByAgent: {},
    outbox: [],
    autoTurnsUsed: 0,
    tokensUsed: 0,
    ...overrides,
  };
}

function resolve(thread: Thread, hasLiveChildDependency = false) {
  return resolveThreadStatus({ thread, hasLiveChildDependency });
}

describe('resolveThreadStatus', () => {
  it('stays in_progress while any run is live, whatever another run recorded', () => {
    // The case status-as-last-writer got wrong: alice reviews, bob is still
    // working. A person must not be told this is ready.
    const result = resolve(
      thread({
        runs: [
          run({ id: 'rn_alice', closeKind: 'review' }),
          run({ id: 'rn_bob', agentId: 'ag_bob', status: 'running' }),
        ],
      }),
    );

    expect(result.status).toBe('in_progress');
    expect(result.reason).toBe('1 Agent run(s) active');
  });

  it('reports in_review once the last run is quiescent', () => {
    const result = resolve(
      thread({
        runs: [
          run({ id: 'rn_alice', closeKind: 'review' }),
          run({
            id: 'rn_bob',
            agentId: 'ag_bob',
            closeKind: 'unclosed',
            closeAcknowledgedAtSequence: 1,
          }),
        ],
      }),
    );

    expect(result.status).toBe('in_review');
    // The reason is prose for a person now, not a run id. Which run produced
    // the status is carried in `outstanding`, which is where a caller that
    // needs the id reads it.
    expect(result.outstanding).toContainEqual(
      expect.objectContaining({ runId: 'rn_alice', kind: 'review' }),
    );
  });

  it('lets a blocker outrank a review from another agent', () => {
    const result = resolve(
      thread({
        runs: [
          run({ id: 'rn_alice', closeKind: 'review' }),
          run({ id: 'rn_bob', agentId: 'ag_bob', closeKind: 'blocked' }),
        ],
      }),
    );

    expect(result.status).toBe('blocked');
    expect(result.outstanding).toContainEqual(
      expect.objectContaining({ runId: 'rn_bob', kind: 'blocked' }),
    );
  });

  it('does not pin the thread to a failure that later work superseded', () => {
    // Round-2 finding I2: acknowledgement was human-only, so one launch
    // failure blocked the thread forever even after another agent finished.
    const failed = thread({
      runs: [run({ id: 'rn_alice', status: 'failed', error: 'launch failed' })],
    });
    expect(resolve(failed).status).toBe('blocked');

    const afterBooking = acknowledgeCloseObligations(failed, 2, () => true);
    const withReview = {
      ...afterBooking,
      runs: [
        ...afterBooking.runs,
        run({ id: 'rn_bob', agentId: 'ag_bob', closeKind: 'review' }),
      ],
    };

    expect(resolve(withReview).status).toBe('in_review');
  });

  it('treats a same-thread wait as satisfied by a later close', () => {
    // Round-2 finding I1: A waits for B, B reviews without @-ing A. Blocked
    // outranks review, so the thread used to report blocked when it was ready.
    const waiting = thread({
      runs: [run({ id: 'rn_alice', closeKind: 'waiting' })],
    });
    expect(resolve(waiting).status).toBe('blocked');

    const released = acknowledgeCloseObligations(
      waiting,
      2,
      (obligation) => obligation.kind === 'waiting',
    );
    const withReview = {
      ...released,
      runs: [
        ...released.runs,
        run({ id: 'rn_bob', agentId: 'ag_bob', closeKind: 'review' }),
      ],
    };

    expect(resolve(withReview).status).toBe('in_review');
  });

  it('keeps a wait in_progress only while a child can still wake it', () => {
    const waiting = thread({
      runs: [run({ id: 'rn_alice', closeKind: 'waiting' })],
    });

    expect(resolve(waiting, true).status).toBe('in_progress');
    expect(resolve(waiting, false).status).toBe('blocked');
    expect(resolve(waiting, false).reason).toContain('no longer exists');
  });

  it('blocks a quiescent thread whose last admission booked nothing', () => {
    // Round-2 finding I6: the silent path. A post whose assignee is gone left
    // the thread in in_progress with no live run and no explanation.
    const result = resolve(
      thread({
        messages: [
          message({
            sequence: 1,
            outcomes: [{ kind: 'skip', reason: 'agent_unknown' }],
          }),
        ],
      }),
    );

    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('agent_unknown');
  });

  it('ignores a post that was never an admission', () => {
    const result = resolve(
      thread({ messages: [message({ sequence: 1, outcomes: [] })] }),
    );

    expect(result.status).toBe('in_progress');
  });

  it('keeps done sticky against a late post', () => {
    const result = resolve(
      thread({
        status: 'done',
        messages: [
          message({
            sequence: 1,
            outcomes: [{ kind: 'skip', reason: 'thread_done' }],
          }),
        ],
        runs: [run({ id: 'rn_alice', status: 'failed' })],
      }),
    );

    expect(result.status).toBe('done');
  });

  it('leaves an untouched thread open', () => {
    expect(resolve(thread({ status: 'open', messages: [] })).status).toBe(
      'open',
    );
  });
});

describe('close obligations', () => {
  it('reports a failed run as a failure even when it recorded a close kind', () => {
    const obligations = outstandingCloseObligations(
      thread({
        runs: [run({ status: 'failed', closeKind: 'review' })],
      }),
    );

    expect(obligations).toEqual([
      { runId: 'rn_1', agentId: 'ag_alice', kind: 'failure' },
    ]);
  });

  it('ignores live runs and already-acknowledged closes', () => {
    const obligations = outstandingCloseObligations(
      thread({
        runs: [
          run({ id: 'rn_live', status: 'running' }),
          run({
            id: 'rn_done',
            closeKind: 'review',
            closeAcknowledgedAtSequence: 4,
          }),
        ],
      }),
    );

    expect(obligations).toEqual([]);
  });

  it('acknowledges only what the selector matches and is a no-op otherwise', () => {
    const source = thread({
      runs: [
        run({ id: 'rn_wait', closeKind: 'waiting' }),
        run({ id: 'rn_block', agentId: 'ag_bob', closeKind: 'blocked' }),
      ],
    });

    const partial = acknowledgeCloseObligations(
      source,
      7,
      (obligation) => obligation.kind === 'waiting',
    );
    expect(
      partial.runs.map((entry) => entry.closeAcknowledgedAtSequence),
    ).toEqual([7, undefined]);

    const none = acknowledgeCloseObligations(partial, 8, () => false);
    expect(none).toBe(partial);
  });
});
