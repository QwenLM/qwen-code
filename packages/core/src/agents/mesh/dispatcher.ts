/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The smallest thing that turns booked work into a running agent.
 *
 * Admission decides *whether* a run exists; this decides *when* it starts and
 * on which body. The split matters because a booked run is a durable fact that
 * stays true until something changes it under the lock, while "this agent is
 * free right now" is an observation that expires the moment it is read. Putting
 * the second kind in the rules layer is what an earlier revision did with a
 * `defer` outcome, and it gave one situation two spellings.
 *
 * Deliberately without recovery: no stall sweeper, no restart reconciliation,
 * no delivery into a running turn. Those need failure injection to prove and
 * belong to the reliability step. What is here is enough to run the live
 * vertical slice, which is the first evidence that any of this works at all.
 */

import { assembleMeshPrompt } from './prompt.js';
import {
  listThreads,
  readMeshAgents,
  readMeshWorkspace,
  reconcileThreadOutbox,
  withMeshStoreTransaction,
} from './mesh-store.js';
import { finishRunInTransaction, hasLiveDescendant } from './run-lifecycle.js';
import {
  bindRunSession,
  claimRun,
  postMessageInTransaction,
  releaseRunClaim,
  SYSTEM_AUTHOR_ID,
} from './thread-actions.js';
import type { MeshAgent, Thread, ThreadEvent, ThreadRun } from './types.js';

/** What the runtime says about an agent's long-lived body. */
export type MeshBodyState =
  | { kind: 'absent' }
  | { kind: 'paused' }
  | { kind: 'completed' }
  | { kind: 'running'; threadId?: string };

/**
 * How a body is brought back for the next turn.
 *
 * Three, not four. Writing the production adapter showed that "continue the
 * resident chat" and "revive from the transcript" are not a choice the
 * dispatcher can make: the registry decides, because only it knows whether a
 * resident runtime is still attached, and it already reports the fallback as a
 * typed outcome. A dispatcher that picked between them would be guessing at
 * state it cannot see, and would cold-revive a body that was still resident.
 * What the dispatcher does choose is which of the three genuinely distinct
 * entry points applies: build the persona from scratch, restart a paused
 * entry, or continue a completed one.
 */
export type MeshStartAction = 'launch' | 'resume' | 'continue_completed';

export type MeshStartResult =
  | {
      status: 'started';
      sessionId: string;
      transcriptStartOffset?: number;
      consumedOnStart?: boolean;
    }
  | { status: 'capacity_wait' }
  | { status: 'agent_unavailable'; error: string }
  | { status: 'launch_failed'; error: string; failureStage?: string };

export interface MeshDispatchPort {
  inspect(agent: MeshAgent): Promise<MeshBodyState>;
  start(input: {
    action: MeshStartAction;
    agent: MeshAgent;
    prompt: string;
    workspaceId: string;
    threadId: string;
    rootThreadId: string;
    runId: string;
    attempt: number;
    contextThroughSequence: number;
  }): Promise<MeshStartResult>;
  /** Definition content hash, when the port can supply one (§9.4). */
  definitionVersion?(agent: MeshAgent): Promise<string | undefined>;
}

export type DispatchResultKind =
  | 'started'
  | 'busy_other_thread'
  | 'capacity_wait'
  | 'launch_failed'
  | 'agent_unavailable'
  | 'runtime_divergence';

export interface DispatchRecord {
  agentId: string;
  threadId: string;
  runId: string;
  kind: DispatchResultKind;
  detail?: string;
}

interface Candidate {
  agent: MeshAgent;
  thread: Thread;
  run: ThreadRun;
}

const LIVE = new Set(['running', 'finishing', 'cancelling']);

/**
 * The oldest queued run for every agent that is not already working.
 *
 * Ordered by the lock-issued `queueSequence`, never by `queuedAt` or by file
 * enumeration: posts arrive from different processes whose wall clocks can
 * disagree, and directory order would let one thread starve behind another
 * purely because of how its id sorts.
 */
export function selectCandidates(
  agents: readonly MeshAgent[],
  threads: readonly Thread[],
): Candidate[] {
  const byAgent = new Map<string, Candidate>();
  const busy = new Set<string>();
  for (const thread of threads) {
    for (const run of thread.runs) {
      if (LIVE.has(run.status)) busy.add(run.agentId);
    }
  }
  for (const thread of threads) {
    if (thread.status === 'done') continue;
    for (const run of thread.runs) {
      if (run.status !== 'queued' || busy.has(run.agentId)) continue;
      const agent = agents.find((candidate) => candidate.id === run.agentId);
      if (!agent || agent.enabled === false) continue;
      const held = byAgent.get(run.agentId);
      if (!held || run.queueSequence < held.run.queueSequence) {
        byAgent.set(run.agentId, { agent, thread, run });
      }
    }
  }
  return [...byAgent.values()].sort(
    (a, b) => a.run.queueSequence - b.run.queueSequence,
  );
}

function actionFor(state: MeshBodyState): MeshStartAction | undefined {
  switch (state.kind) {
    case 'absent':
      return 'launch';
    case 'paused':
      return 'resume';
    case 'completed':
      return 'continue_completed';
    default:
      return undefined;
  }
}

/**
 * Starts at most one run per idle agent, then delivers parent reports.
 *
 * Returns what happened to each candidate. `capacity_wait` and
 * `busy_other_thread` leave the run queued on purpose: they are observations
 * about this instant, and the next pass re-reads them rather than persisting a
 * decision that was already stale when it was written.
 */
export async function dispatchOnce(
  projectRoot: string,
  port: MeshDispatchPort,
  options: { now?: number } = {},
): Promise<DispatchRecord[]> {
  const now = options.now ?? Date.now();
  const workspace = await readMeshWorkspace(projectRoot);
  const agents = await readMeshAgents(projectRoot);
  const { threads } = await listThreads(projectRoot);
  const records: DispatchRecord[] = [];

  for (const candidate of selectCandidates(agents, threads)) {
    const { agent, thread, run } = candidate;
    const base = { agentId: agent.id, threadId: thread.id, runId: run.id };

    const state = await port.inspect(agent);
    const action = actionFor(state);
    if (!action) {
      // The store says this agent is free and the runtime says it is not. The
      // runtime is authoritative about its own body, so leave the run queued
      // and report the divergence rather than starting a second one.
      records.push({
        ...base,
        kind:
          state.kind === 'running' ? 'busy_other_thread' : 'runtime_divergence',
        ...(state.kind === 'running' && state.threadId
          ? { detail: state.threadId }
          : {}),
      });
      continue;
    }

    const definitionVersion = await port.definitionVersion?.(agent);
    const claimed = await claimRun(projectRoot, {
      threadId: thread.id,
      runId: run.id,
      now,
    });
    if (!claimed) continue;

    const prompt = assembleMeshPrompt({
      workspaceId: workspace.workspaceId,
      agent,
      run: claimed.run,
      thread: claimed.thread,
      roster: agents,
      ...(definitionVersion ? { definitionVersion } : {}),
    });

    const result = await port.start({
      action,
      agent,
      prompt: prompt.text,
      workspaceId: workspace.workspaceId,
      threadId: thread.id,
      rootThreadId: thread.rootThreadId,
      runId: run.id,
      attempt: claimed.run.attempts,
      contextThroughSequence: prompt.contextThroughSequence,
    });

    if (result.status === 'started') {
      await bindRunSession(projectRoot, {
        threadId: thread.id,
        runId: run.id,
        attempt: claimed.run.attempts,
        sessionId: result.sessionId,
        contextThroughSequence: prompt.contextThroughSequence,
        consumedOnStart: result.consumedOnStart,
        ...(definitionVersion ? { definitionVersion } : {}),
        ...(result.transcriptStartOffset !== undefined
          ? { transcriptStartOffset: result.transcriptStartOffset }
          : {}),
      });
      records.push({ ...base, kind: 'started' });
      continue;
    }

    if (result.status === 'capacity_wait') {
      // Backpressure, not failure: the run keeps its place and its attempt.
      await releaseRunClaim(projectRoot, {
        threadId: thread.id,
        runId: run.id,
        attempt: claimed.run.attempts,
      });
      records.push({ ...base, kind: 'capacity_wait' });
      continue;
    }

    // A configuration error and a failed start are both terminal for this run,
    // and both must release the queue slot. Leaving it queued would make one
    // broken agent definition look like an agent that is merely slow.
    await withMeshStoreTransaction(projectRoot, (transaction) =>
      finishRunInTransaction(transaction, {
        threadId: thread.id,
        runId: run.id,
        outcome: {
          status: 'failed',
          error: result.error,
          failureStage:
            result.status === 'agent_unavailable' ? 'definition' : 'launch',
        },
        now,
      }),
    );
    records.push({
      ...base,
      kind:
        result.status === 'agent_unavailable'
          ? 'agent_unavailable'
          : 'launch_failed',
      detail: result.error,
    });
  }

  await deliverParentReports(projectRoot);
  return records;
}

function isParentReport(event: ThreadEvent): boolean {
  return event.kind === 'parent_report';
}

/**
 * Posts each pending parent report into its parent thread, exactly once.
 *
 * The event id is the idempotency key: a replay finds the message already
 * carrying that `originEventId` and returns it instead of posting again. The
 * report is system-authored but keeps the child run that caused it, so the hop
 * is auditable and charged rather than suppressed as a self-post — and because
 * it is not written by the parent's own assignee, it wakes them even when one
 * agent owns both threads.
 */
export async function deliverParentReports(
  projectRoot: string,
): Promise<number> {
  const { threads } = await listThreads(projectRoot);
  let delivered = 0;
  for (const thread of threads) {
    if (
      !thread.outbox.some(
        (event) => event.status === 'pending' && isParentReport(event),
      )
    ) {
      continue;
    }
    await reconcileThreadOutbox(
      projectRoot,
      thread.id,
      async (transaction, event) => {
        const parentThreadId = event.payload['parentThreadId'];
        if (typeof parentThreadId !== 'string') return;
        const parent = await transaction.readThread(parentThreadId);
        if (!parent) return;
        await postMessageInTransaction(transaction, parentThreadId, {
          from: SYSTEM_AUTHOR_ID,
          authorKind: 'system',
          ...(event.causedByRunId ? { sourceRunId: event.causedByRunId } : {}),
          triggerKind: 'child_report',
          originEventId: event.id,
          text: `Sub-thread ${thread.id} ("${thread.title}") is ready for review.`,
        });
        delivered += 1;
      },
      isParentReport,
    );
  }
  return delivered;
}

/** Whether a thread still has a descendant that can wake it. Re-exported for
 * callers that need the same rule the status resolver uses. */
export { hasLiveDescendant };
