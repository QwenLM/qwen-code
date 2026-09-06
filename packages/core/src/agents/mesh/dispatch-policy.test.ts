/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { decideDispatch, resolveTargets } from './dispatch-policy.js';
import {
  HUMAN_AUTHOR_ID,
  type MeshAgent,
  type Thread,
  type ThreadMessage,
  type ThreadRun,
} from './types.js';

function agent(overrides: Partial<MeshAgent> = {}): MeshAgent {
  return {
    id: 'ag_alice',
    name: 'alice',
    createdAt: 1_000,
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'th_1',
    title: 'Investigate the flake',
    body: '',
    status: 'open',
    createdAt: 1_000,
    createdBy: HUMAN_AUTHOR_ID,
    messages: [],
    runs: [],
    autoTurnsUsed: 0,
    ...overrides,
  };
}

function message(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'ms_1',
    from: HUMAN_AUTHOR_ID,
    text: 'have a look',
    mentions: [],
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
    queuedAt: 1_500,
    ...overrides,
  };
}

describe('decideDispatch', () => {
  it('dispatches a mentioned, idle agent', () => {
    expect(
      decideDispatch({
        thread: thread(),
        message: message({ mentions: ['ag_alice'] }),
        target: agent(),
        agentActiveRunCount: 0,
      }),
    ).toEqual({ kind: 'dispatch' });
  });

  it('never wakes an agent on its own post', () => {
    expect(
      decideDispatch({
        thread: thread(),
        message: message({ from: 'ag_alice', mentions: ['ag_alice'] }),
        target: agent(),
        agentActiveRunCount: 0,
      }),
    ).toEqual({ kind: 'skip', reason: 'self_trigger' });
  });

  it('keeps the assignee out of a post that names someone else', () => {
    expect(
      decideDispatch({
        thread: thread({ assigneeAgentId: 'ag_alice' }),
        message: message({ mentions: ['ag_bob'] }),
        target: agent(),
        agentActiveRunCount: 0,
      }),
    ).toEqual({ kind: 'skip', reason: 'explicit_routing' });
  });

  it('coalesces into a run that has not started', () => {
    expect(
      decideDispatch({
        thread: thread({ runs: [run({ status: 'queued' })] }),
        message: message({ mentions: ['ag_alice'] }),
        target: agent(),
        agentActiveRunCount: 1,
      }),
    ).toEqual({ kind: 'coalesce', runId: 'rn_1' });
  });

  it('defers while a run is already executing', () => {
    expect(
      decideDispatch({
        thread: thread({ runs: [run({ status: 'running' })] }),
        message: message({ mentions: ['ag_alice'] }),
        target: agent(),
        agentActiveRunCount: 1,
      }),
    ).toEqual({ kind: 'defer', reason: 'active_run', runId: 'rn_1' });
  });

  it('defers a mention that would exceed the agent concurrency limit', () => {
    expect(
      decideDispatch({
        thread: thread(),
        message: message({ mentions: ['ag_alice'] }),
        target: agent({ maxConcurrentRuns: 2 }),
        agentActiveRunCount: 2,
      }),
    ).toEqual({ kind: 'defer', reason: 'agent_at_capacity' });
  });

  it('stops an agent-to-agent loop once the thread budget is spent', () => {
    expect(
      decideDispatch({
        thread: thread({ autoTurnsUsed: 3 }),
        message: message({ from: 'ag_bob', mentions: ['ag_alice'] }),
        target: agent(),
        agentActiveRunCount: 0,
        autoTurnBudget: 3,
      }),
    ).toEqual({ kind: 'skip', reason: 'budget_exhausted' });
  });

  it('lets a person through a thread whose auto budget is spent', () => {
    expect(
      decideDispatch({
        thread: thread({ autoTurnsUsed: 99 }),
        message: message({ mentions: ['ag_alice'] }),
        target: agent(),
        agentActiveRunCount: 0,
        autoTurnBudget: 3,
      }),
    ).toEqual({ kind: 'dispatch' });
  });

  it('reports a disabled agent as skipped rather than unknown', () => {
    expect(
      decideDispatch({
        thread: thread(),
        message: message({ mentions: ['ag_alice'] }),
        target: agent({ enabled: false }),
        agentActiveRunCount: 0,
      }),
    ).toEqual({ kind: 'skip', reason: 'agent_disabled' });
  });

  it('does not reopen a finished thread', () => {
    expect(
      decideDispatch({
        thread: thread({ status: 'done' }),
        message: message({ mentions: ['ag_alice'] }),
        target: agent(),
        agentActiveRunCount: 0,
      }),
    ).toEqual({ kind: 'skip', reason: 'thread_done' });
  });
});

describe('resolveTargets', () => {
  it('prefers explicit mentions over the assignee', () => {
    expect(
      resolveTargets(
        thread({ assigneeAgentId: 'ag_alice' }),
        message({ mentions: ['ag_bob', 'ag_carol'] }),
      ),
    ).toEqual(['ag_bob', 'ag_carol']);
  });

  it('falls back to the assignee when nobody is named', () => {
    expect(
      resolveTargets(thread({ assigneeAgentId: 'ag_alice' }), message()),
    ).toEqual(['ag_alice']);
  });

  it('returns nobody for an unassigned thread with no mentions', () => {
    expect(resolveTargets(thread(), message())).toEqual([]);
  });
});
