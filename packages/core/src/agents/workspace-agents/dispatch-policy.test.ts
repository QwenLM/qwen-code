/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  decideDispatch,
  resolveTargets,
  type DispatchContext,
} from './dispatch-policy.js';
import {
  HUMAN_AUTHOR_ID,
  AGENTS_SCHEMA_VERSION,
  DEFAULT_THREAD_AUTO_TURN_BUDGET,
  DEFAULT_THREAD_TOKEN_BUDGET,
  type WorkspaceAgent,
  type Thread,
  type ThreadMessage,
  type ThreadRun,
} from './types.js';

function agent(overrides: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  return { id: 'ag_alice', name: 'alice', createdAt: 1_000, ...overrides };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    schemaVersion: AGENTS_SCHEMA_VERSION,
    id: 'th_1',
    title: 'Investigate the flake',
    body: '',
    status: 'open',
    createdAt: 1_000,
    createdBy: HUMAN_AUTHOR_ID,
    rootThreadId: 'th_1',
    messages: [],
    runs: [],
    nextMessageSequence: 1,
    deliveryByAgent: {},
    outbox: [],
    autoTurnsUsed: 0,
    tokensUsed: 0,
    ...overrides,
  };
}

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'ms_1',
    sequence: 1,
    authorKind: 'human',
    from: HUMAN_AUTHOR_ID,
    authorNameSnapshot: HUMAN_AUTHOR_ID,
    text: 'have a look',
    mentions: [],
    outcomes: [],
    at: 2_000,
    ...overrides,
  };
}

function run(overrides: Partial<ThreadRun> = {}): ThreadRun {
  return {
    id: 'rn_1',
    agentId: 'ag_alice',
    status: 'queued',
    triggerMessageIds: ['ms_0'],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    queueSequence: 1,
    queuedAt: 1_500,
    attempts: 0,
    ...overrides,
  };
}

function context(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    thread: thread(),
    message: message({ mentions: ['ag_alice'] }),
    target: agent(),
    budget: { autoTurnsUsed: 0, tokensUsed: 0 },
    agentQueuedElsewhere: 0,
    ...overrides,
  };
}

describe('decideDispatch', () => {
  it('books a run for a mentioned, idle agent', () => {
    expect(decideDispatch(context())).toEqual({ kind: 'dispatch' });
  });

  it('never wakes an agent on its own post', () => {
    expect(
      decideDispatch(
        context({
          message: message({ from: 'ag_alice', mentions: ['ag_alice'] }),
        }),
      ),
    ).toEqual({ kind: 'skip', reason: 'self_trigger' });
  });

  it('coalesces into a run that has not started', () => {
    expect(
      decideDispatch(
        context({ thread: thread({ runs: [run({ status: 'queued' })] }) }),
      ),
    ).toEqual({ kind: 'coalesce', runId: 'rn_1', into: 'queued' });
  });

  it('coalesces into a run already executing this same thread', () => {
    // Mid-run delivery is available here, so booking a second run would be
    // waste.
    expect(
      decideDispatch(
        context({ thread: thread({ runs: [run({ status: 'running' })] }) }),
      ),
    ).toEqual({ kind: 'coalesce', runId: 'rn_1', into: 'running' });
  });

  it('books a new run instead of coalescing into one that is finishing', () => {
    // A `finishing` run already executed its close tool and only awaits the
    // terminal write, so it cannot act on this message. This is the wake half
    // of a discharged wait: `closeRun` mentions every unacknowledged waiter,
    // including one still `finishing`, and stamps its obligation in the same
    // transaction. Folding that mention into the dying run would leave the
    // peer with no obligation and no run — a wakeup nobody receives. Claiming
    // counts `finishing` against the agent's concurrency limit, so the fresh
    // run still cannot start before the old one settles.
    expect(
      decideDispatch(
        context({
          thread: thread({
            runs: [run({ status: 'finishing', closeKind: 'waiting' })],
          }),
        }),
      ),
    ).toEqual({ kind: 'dispatch' });
  });

  it('still books when the agent is busy on another thread', () => {
    // Whether a queued run can start now is the dispatcher's call, not a rule.
    expect(decideDispatch(context({ agentQueuedElsewhere: 1 }))).toEqual({
      kind: 'dispatch',
    });
  });

  it('refuses once the agent queue is full', () => {
    expect(
      decideDispatch(
        context({ target: agent({ queueLimit: 2 }), agentQueuedElsewhere: 2 }),
      ),
    ).toEqual({ kind: 'skip', reason: 'queue_full' });
  });

  it('stops an agent-to-agent loop once the turn budget is spent', () => {
    expect(
      decideDispatch(
        context({
          message: message({ from: 'ag_bob', mentions: ['ag_alice'] }),
          budget: {
            autoTurnsUsed: DEFAULT_THREAD_AUTO_TURN_BUDGET,
            tokensUsed: 0,
          },
        }),
      ),
    ).toEqual({ kind: 'skip', reason: 'turn_budget_exhausted' });
  });

  it('stops once the token budget is spent', () => {
    expect(
      decideDispatch(
        context({
          message: message({ from: 'ag_bob', mentions: ['ag_alice'] }),
          budget: {
            autoTurnsUsed: 0,
            tokensUsed: DEFAULT_THREAD_TOKEN_BUDGET,
          },
        }),
      ),
    ).toEqual({ kind: 'skip', reason: 'token_budget_exhausted' });
  });

  it('lets a person reset the local turn gate', () => {
    expect(
      decideDispatch(
        context({
          budget: { autoTurnsUsed: 99, tokensUsed: 0 },
        }),
      ),
    ).toEqual({ kind: 'dispatch' });
  });

  it('lets a person continue past the token budget', () => {
    expect(
      decideDispatch(
        context({
          budget: {
            autoTurnsUsed: 0,
            tokensUsed: DEFAULT_THREAD_TOKEN_BUDGET,
          },
        }),
      ),
    ).toEqual({ kind: 'dispatch' });
  });

  it('uses the current thread turn count', () => {
    expect(
      decideDispatch(
        context({
          thread: thread({ id: 'th_2', rootThreadId: 'th_1' }),
          message: message({ from: 'ag_bob', mentions: ['ag_alice'] }),
          budget: { autoTurnsUsed: 12, tokensUsed: 0 },
        }),
      ),
    ).toEqual({ kind: 'skip', reason: 'turn_budget_exhausted' });
  });

  it('reports a disabled agent as skipped rather than unknown', () => {
    expect(
      decideDispatch(context({ target: agent({ enabled: false }) })),
    ).toEqual({ kind: 'skip', reason: 'agent_disabled' });
  });

  it('reports an unresolvable target', () => {
    expect(decideDispatch(context({ target: undefined }))).toEqual({
      kind: 'skip',
      reason: 'agent_unknown',
    });
  });

  it('does not reopen a finished thread', () => {
    expect(
      decideDispatch(context({ thread: thread({ status: 'done' }) })),
    ).toEqual({ kind: 'skip', reason: 'thread_done' });
  });

  it('does not book work on a cancelled thread either', () => {
    expect(
      decideDispatch(context({ thread: thread({ status: 'cancelled' }) })),
    ).toEqual({ kind: 'skip', reason: 'thread_done' });
  });

  it('reports a retired agent instead of queueing a run it cannot start', () => {
    expect(
      decideDispatch(context({ target: agent({ retiredAt: 5_000 }) })),
    ).toEqual({ kind: 'skip', reason: 'agent_retired' });
    // Checked before `enabled`: retirement is the reason a person must see.
    expect(
      decideDispatch(
        context({ target: agent({ retiredAt: 5_000, enabled: false }) }),
      ),
    ).toEqual({ kind: 'skip', reason: 'agent_retired' });
  });

  it('still dispatches on a blocked thread, which is how a person unblocks it', () => {
    expect(
      decideDispatch(context({ thread: thread({ status: 'blocked' }) })),
    ).toEqual({ kind: 'dispatch' });
  });
});

describe('resolveTargets', () => {
  it('prefers explicit mentions over the assignee', () => {
    expect(
      resolveTargets(
        thread({ assigneeAgentId: 'ag_alice' }),
        message({ mentions: ['ag_bob', 'ag_carol'] }),
        true,
      ),
    ).toEqual(['ag_bob', 'ag_carol']);
  });

  it('falls back to the assignee when nobody is named', () => {
    expect(
      resolveTargets(thread({ assigneeAgentId: 'ag_alice' }), message(), false),
    ).toEqual(['ag_alice']);
  });

  it('returns nobody for an unassigned thread with no mentions', () => {
    expect(resolveTargets(thread(), message(), false)).toEqual([]);
  });

  it('does not fall back to the assignee for an unknown explicit mention', () => {
    expect(
      resolveTargets(thread({ assigneeAgentId: 'ag_alice' }), message(), true),
    ).toEqual([]);
  });
});
