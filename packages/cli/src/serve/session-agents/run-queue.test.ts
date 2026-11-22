/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { SessionAgentRun } from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { enqueueTrigger, nextRunnable, queuePosition } from './run-queue.js';

function ids() {
  let next = 0;
  return () => `sr_${++next}`;
}

describe('session agent run queue', () => {
  it('creates a queued run for an idle agent and starts it', () => {
    const runs: SessionAgentRun[] = [];
    const outcome = enqueueTrigger(runs, {
      agentId: 'ag_a',
      recordId: 'r1',
      chainDepth: 0,
      now: 1,
      newRunId: ids(),
    });
    expect(outcome.kind).toBe('created');
    expect(nextRunnable(runs, 'ag_a')?.id).toBe('sr_1');
    expect(queuePosition(runs, outcome.run)).toBe(1);
  });

  it('allows one executing and one queued run per agent, coalescing the rest', () => {
    const runs: SessionAgentRun[] = [];
    const newRunId = ids();
    const first = enqueueTrigger(runs, {
      agentId: 'ag_a',
      recordId: 'r1',
      chainDepth: 2,
      now: 1,
      newRunId,
    });
    first.run.status = 'running';

    const second = enqueueTrigger(runs, {
      agentId: 'ag_a',
      recordId: 'r2',
      chainDepth: 2,
      now: 2,
      newRunId,
    });
    expect(second.kind).toBe('created');
    expect(nextRunnable(runs, 'ag_a')).toBeUndefined();

    const third = enqueueTrigger(runs, {
      agentId: 'ag_a',
      recordId: 'r3',
      chainDepth: 0,
      now: 3,
      newRunId,
    });
    expect(third.kind).toBe('coalesced');
    expect(third.run.id).toBe(second.run.id);
    expect(third.run.triggerRecordIds).toEqual(['r2', 'r3']);
    // A human trigger among the coalesced ones resets the chain.
    expect(third.run.chainDepth).toBe(0);
    expect(runs).toHaveLength(2);

    first.run.status = 'completed';
    expect(nextRunnable(runs, 'ag_a')?.id).toBe(second.run.id);
  });

  it('treats a repeated record as a duplicate', () => {
    const runs: SessionAgentRun[] = [];
    const newRunId = ids();
    enqueueTrigger(runs, {
      agentId: 'ag_a',
      recordId: 'r1',
      chainDepth: 0,
      now: 1,
      newRunId,
    });
    const again = enqueueTrigger(runs, {
      agentId: 'ag_a',
      recordId: 'r1',
      chainDepth: 0,
      now: 2,
      newRunId,
    });
    expect(again.kind).toBe('duplicate');
    expect(runs).toHaveLength(1);
  });

  it('keeps agents independent', () => {
    const runs: SessionAgentRun[] = [];
    const newRunId = ids();
    const a = enqueueTrigger(runs, {
      agentId: 'ag_a',
      recordId: 'r1',
      chainDepth: 0,
      now: 1,
      newRunId,
    });
    a.run.status = 'awaiting_approval';
    enqueueTrigger(runs, {
      agentId: 'ag_b',
      recordId: 'r1',
      chainDepth: 0,
      now: 1,
      newRunId,
    });
    expect(nextRunnable(runs, 'ag_a')).toBeUndefined();
    expect(nextRunnable(runs, 'ag_b')?.agentId).toBe('ag_b');
  });

  it('carries a squad onto a new or coalesced run without overriding one', () => {
    const runs: SessionAgentRun[] = [];
    const newRunId = ids();
    const base = { agentId: 'ag_lead', chainDepth: 0, now: 1, newRunId };
    const plain = enqueueTrigger(runs, { ...base, recordId: 'r1' });
    expect(plain.run.squadId).toBeUndefined();
    enqueueTrigger(runs, { ...base, recordId: 'r2', squadId: 'sq_1' });
    expect(plain.run.squadId).toBe('sq_1');
    enqueueTrigger(runs, { ...base, recordId: 'r3', squadId: 'sq_2' });
    expect(plain.run.squadId).toBe('sq_1');
    expect(plain.run.triggerRecordIds).toEqual(['r1', 'r2', 'r3']);
    const other = enqueueTrigger(runs, {
      ...base,
      agentId: 'ag_other',
      recordId: 'r4',
      squadId: 'sq_3',
    });
    expect(other.run.squadId).toBe('sq_3');
  });
});
