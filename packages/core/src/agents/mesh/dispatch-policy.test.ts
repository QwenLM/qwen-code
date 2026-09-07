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
  MESH_SCHEMA_VERSION,
  type MeshAgent,
  type Thread,
  type ThreadMessage,
  type ThreadRun,
} from './types.js';

function agent(overrides: Partial<MeshAgent> = {}): MeshAgent {
  return { id: 'ag_alice', name: 'alice', createdAt: 1_000, ...overrides };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    schemaVersion: MESH_SCHEMA_VERSION,
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
    // waste — this is the case Multica has to defer.
    expect(
      decideDispatch(
        context({ thread: thread({ runs: [run({ status: 'running' })] }) }),
      ),
    ).toEqual({ kind: 'coalesce', runId: 'rn_1', into: 'running' });
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
          budget: { autoTurnsUsed: 3, tokensUsed: 0 },
          limits: { autoTurns: 3 },
        }),
      ),
    ).toEqual({ kind: 'skip', reason: 'turn_budget_exhausted' });
  });

  it('stops once the token budget is spent', () => {
    expect(
      decideDispatch(
        context({
          message: message({ from: 'ag_bob', mentions: ['ag_alice'] }),
          budget: { autoTurnsUsed: 0, tokensUsed: 200_000 },
          limits: { tokens: 200_000 },
        }),
      ),
    ).toEqual({ kind: 'skip', reason: 'token_budget_exhausted' });
  });

  it('lets a person reset the local turn gate', () => {
    expect(
      decideDispatch(
        context({
          budget: { autoTurnsUsed: 99, tokensUsed: 0 },
          limits: { autoTurns: 3, tokens: 10 },
        }),
      ),
    ).toEqual({ kind: 'dispatch' });
  });

  it('does not let a person bypass the token gate', () => {
    expect(
      decideDispatch(
        context({
          budget: { autoTurnsUsed: 0, tokensUsed: 10 },
          limits: { tokens: 10 },
        }),
      ),
    ).toEqual({ kind: 'skip', reason: 'token_budget_exhausted' });
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
      resolveTargets(
        thread({ assigneeAgentId: 'ag_alice' }),
        message(),
        false,
      ),
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
