/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Per (chat session, agent) run queue. Pure; no I/O.
 *
 * The rule that keeps a native session from being driven by two processes
 * at once (session-multi-agent design §8-3): per agent in a session, at most ONE executing run
 * (`running` / `awaiting_approval`) and at most ONE queued run. A trigger
 * that arrives while a run is queued is coalesced into it (its record id is
 * appended and the queued run will read it); one that arrives while a run
 * executes and nothing is queued creates the queued run. An executing run
 * never takes new triggers: its prompt is already built.
 *
 * Functions operate on the run array in place and report what they did.
 */

import { coalesceChainDepth } from '@qwen-code/qwen-code-core/agents/session-agents/chain.js';
import type { SessionAgentRun } from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';

export function isExecutingRun(run: SessionAgentRun): boolean {
  return run.status === 'running' || run.status === 'awaiting_approval';
}

export function isQueuedRun(run: SessionAgentRun): boolean {
  return run.status === 'queued';
}

export interface EnqueueTriggerInput {
  agentId: string;
  /** The chat record that triggered the run. */
  recordId: string;
  chainDepth: number;
  now: number;
  newRunId: () => string;
  /**
   * Run the agent as this squad's leader. Coalesced into a queued run that
   * has no squad yet; a queued run already leading another squad keeps it.
   */
  squadId?: string;
}

export type EnqueueTriggerOutcome =
  /** A new queued run. */
  | { kind: 'created'; run: SessionAgentRun }
  /** Appended to the agent's queued run. */
  | { kind: 'coalesced'; run: SessionAgentRun }
  /** A live run already carries this record (an idempotent replay). */
  | { kind: 'duplicate'; run: SessionAgentRun };

export function enqueueTrigger(
  runs: SessionAgentRun[],
  input: EnqueueTriggerInput,
): EnqueueTriggerOutcome {
  const live = runs.filter(
    (run) =>
      run.agentId === input.agentId &&
      (isQueuedRun(run) || isExecutingRun(run)),
  );
  const duplicate = live.find((run) =>
    run.triggerRecordIds.includes(input.recordId),
  );
  if (duplicate) return { kind: 'duplicate', run: duplicate };
  const queued = live.find(isQueuedRun);
  if (queued) {
    queued.triggerRecordIds.push(input.recordId);
    queued.chainDepth = coalesceChainDepth(queued.chainDepth, input.chainDepth);
    if (input.squadId !== undefined) queued.squadId ??= input.squadId;
    return { kind: 'coalesced', run: queued };
  }
  const run: SessionAgentRun = {
    id: input.newRunId(),
    agentId: input.agentId,
    status: 'queued',
    triggerRecordIds: [input.recordId],
    chainDepth: input.chainDepth,
    createdAt: input.now,
    attempts: 0,
    ...(input.squadId !== undefined ? { squadId: input.squadId } : {}),
  };
  runs.push(run);
  return { kind: 'created', run };
}

/**
 * The run to start next for `agentId`: its oldest queued run, unless one of
 * its runs is already executing.
 */
export function nextRunnable(
  runs: readonly SessionAgentRun[],
  agentId: string,
): SessionAgentRun | undefined {
  const mine = runs.filter((run) => run.agentId === agentId);
  if (mine.some(isExecutingRun)) return undefined;
  return mine.filter(isQueuedRun).sort((a, b) => a.createdAt - b.createdAt)[0];
}

/**
 * 1-based position among the agent's queued runs in `runs`, oldest first;
 * undefined when not queued. The orchestrator passes the runs of every chat
 * session, since an agent's `maxConcurrentRuns` is shared across them.
 */
export function queuePosition(
  runs: readonly SessionAgentRun[],
  run: SessionAgentRun,
): number | undefined {
  if (!isQueuedRun(run)) return undefined;
  const queued = runs
    .filter(
      (candidate) =>
        candidate.agentId === run.agentId && isQueuedRun(candidate),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  const index = queued.findIndex((candidate) => candidate.id === run.id);
  return index === -1 ? undefined : index + 1;
}
