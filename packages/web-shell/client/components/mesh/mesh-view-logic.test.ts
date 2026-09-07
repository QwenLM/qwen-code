/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildRunRows,
  describeRun,
  explainSkip,
  formatBudget,
  groupThreads,
  needsAttention,
  summarizePreview,
  type RunView,
  type ThreadSummaryView,
} from './mesh-view-logic';

function thread(overrides: Partial<ThreadSummaryView> = {}): ThreadSummaryView {
  return {
    id: 'th_1',
    title: 'Investigate the flake',
    status: 'in_progress',
    reason: '1 run(s) still queued, running, finishing or cancelling',
    updatedAt: 1_000,
    liveRunCount: 1,
    ...overrides,
  };
}

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    id: 'rn_1',
    agentId: 'ag_alice',
    agentName: 'alice',
    status: 'completed',
    closeAcknowledged: false,
    trigger: 'assigned by you',
    hasTranscriptSlice: true,
    ...overrides,
  };
}

describe('groupThreads', () => {
  it('puts what needs a person first, and collapses finished work', () => {
    const groups = groupThreads([
      thread({ id: 'th_done', status: 'done', liveRunCount: 0 }),
      thread({ id: 'th_run', status: 'in_progress', liveRunCount: 2 }),
      thread({ id: 'th_block', status: 'blocked', liveRunCount: 0 }),
      thread({ id: 'th_idle', status: 'open', liveRunCount: 0 }),
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      'needs_you',
      'running',
      'idle',
      'done',
    ]);
    expect(groups.at(-1)?.collapsedByDefault).toBe(true);
    expect(groups[0]?.collapsedByDefault).toBe(false);
  });

  it('treats a question and a finished summary as one reader query', () => {
    const groups = groupThreads([
      thread({ id: 'th_block', status: 'blocked', liveRunCount: 0 }),
      thread({ id: 'th_review', status: 'in_review', liveRunCount: 0 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads.map((entry) => entry.id)).toEqual([
      'th_block',
      'th_review',
    ]);
    expect(needsAttention(thread({ status: 'in_progress' }))).toBe(false);
  });

  it('drops empty groups instead of showing an empty heading', () => {
    expect(groupThreads([thread()]).map((group) => group.key)).toEqual([
      'running',
    ]);
  });

  it('shows a thread with no live run as idle, not running', () => {
    const groups = groupThreads([thread({ liveRunCount: 0 })]);
    expect(groups[0]?.key).toBe('idle');
  });
});

describe('describeRun', () => {
  it.each([
    [{ status: 'running' }, 'working'],
    [{ status: 'queued' }, 'waiting to start'],
    [{ status: 'completed', closeKind: 'blocked' }, 'asked a question'],
    [{ status: 'completed', closeKind: 'review' }, 'submitted for review'],
    [{ status: 'completed', closeKind: 'waiting' }, 'waiting on a sub-thread'],
    [
      { status: 'completed', closeKind: 'unclosed' },
      'ended without a hand-off',
    ],
    [{ status: 'completed' }, 'nothing outstanding'],
    [{ status: 'cancelled' }, 'cancelled'],
  ])('describes %j as %s', (overrides, expected) => {
    expect(describeRun(run(overrides as Partial<RunView>))).toBe(expected);
  });

  it('reports a failure with its stage, over any close it recorded first', () => {
    expect(
      describeRun(
        run({ status: 'failed', failureStage: 'launch', closeKind: 'review' }),
      ),
    ).toBe('failed at launch');
  });
});

describe('buildRunRows', () => {
  it('pins live runs in start order and puts finished ones newest first', () => {
    const { live, past } = buildRunRows([
      run({ id: 'rn_old', status: 'completed', endedAt: 10 }),
      run({ id: 'rn_b', status: 'running', startedAt: 5 }),
      run({ id: 'rn_new', status: 'completed', endedAt: 90 }),
      run({ id: 'rn_a', status: 'running', startedAt: 1 }),
    ]);

    expect(live.map((row) => row.run.id)).toEqual(['rn_a', 'rn_b']);
    expect(past.map((row) => row.run.id)).toEqual(['rn_new', 'rn_old']);
  });

  it('marks only unacknowledged closes as owing a person something', () => {
    const { past } = buildRunRows([
      run({ id: 'rn_open', closeKind: 'blocked' }),
      run({ id: 'rn_seen', closeKind: 'blocked', closeAcknowledged: true }),
      run({ id: 'rn_wait', closeKind: 'waiting' }),
    ]);
    const outstanding = past
      .filter((row) => row.outstanding)
      .map((row) => row.run.id);

    // A wait is owed to another run, not to a person, so it is not on this list.
    expect(outstanding).toEqual(['rn_open']);
  });
});

describe('formatBudget', () => {
  it('states both limits and says the tree shares them', () => {
    expect(
      formatBudget({
        turnsUsed: 4,
        turnLimit: 12,
        tokensUsed: 31_200,
        tokenLimit: 200_000,
      }),
    ).toEqual({
      turns: '4 of 12 unattended turns',
      tokens: '31.2k of 200.0k tokens',
      scope: 'across this thread tree',
    });
  });
});

describe('explainSkip', () => {
  it('gives every refusal its own fix', () => {
    const reasons = [
      'agent_unknown',
      'agent_disabled',
      'agent_unavailable',
      'no_target',
      'queue_full',
      'turn_budget_exhausted',
      'token_budget_exhausted',
      'thread_done',
      'self_trigger',
    ];
    const fixes = reasons.map((reason) => explainSkip(reason, 'alice').fix);
    expect(new Set(fixes).size).toBe(reasons.length);
  });

  it('keeps a missing definition apart from a disabled agent', () => {
    // These look alike and need different screens. Copy that merged them would
    // send the reader to enable an agent whose definition is the real problem.
    const disabled = explainSkip('agent_disabled', 'alice');
    const unavailable = explainSkip('agent_unavailable', 'alice');
    expect(disabled.fix).toContain('Enable');
    expect(unavailable.fix).toContain('definition');
    expect(disabled.what).not.toEqual(unavailable.what);
  });

  it('never invents a cause for a reason it does not know', () => {
    const unknown = explainSkip('some_future_reason', 'alice');
    expect(unknown.what).toBe('alice will not be woken');
    expect(unknown.fix).not.toMatch(/disabled|definition|budget|backlog/);
  });

  it('says the token budget is never reset, because it is not', () => {
    expect(explainSkip('token_budget_exhausted', 'alice').fix).toContain(
      'never reset',
    );
    expect(explainSkip('turn_budget_exhausted', 'alice').fix).toContain(
      'resets the count',
    );
  });
});

describe('summarizePreview', () => {
  it('leads with the consequence of pressing send', () => {
    expect(
      summarizePreview([
        { agentName: 'alice', willWake: true },
        { agentName: 'bob', willWake: false, reason: 'queue_full' },
      ]),
    ).toBe('alice will start working.');
    expect(
      summarizePreview([
        { agentName: 'alice', willWake: true },
        { agentName: 'bob', willWake: true },
        { agentName: 'carol', willWake: true },
      ]),
    ).toBe('alice, bob and carol will start working.');
  });

  it('makes "nobody" the headline, because that case used to be silent', () => {
    expect(
      summarizePreview([
        {
          agentName: 'dave',
          willWake: false,
          unknown: true,
          reason: 'agent_unknown',
        },
      ]),
    ).toBe('Nobody will be woken by this reply.');
    expect(summarizePreview([])).toBe('Nobody will be woken by this reply.');
  });
});
