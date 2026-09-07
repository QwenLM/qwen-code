/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  generateMessageId,
  generateRunId,
  withMeshStoreTransaction,
  type MeshStoreTransaction,
} from './mesh-store.js';
import { parseMentions } from './mentions.js';
import {
  applyAggregateStatus,
  finishRunInTransaction,
} from './run-lifecycle.js';
import { acknowledgeCloseObligations } from './thread-status.js';
import {
  decideDispatch,
  resolveTargets,
  type BudgetLimits,
  type DispatchDecision,
} from './dispatch-policy.js';
import {
  HUMAN_AUTHOR_ID,
  type MeshAgent,
  type MessageOutcome,
  type RunUsageRound,
  type Thread,
  type ThreadMessage,
  type ThreadRun,
} from './types.js';

export interface PostMessageInput {
  from: string;
  text: string;
  originEventId?: string;
}

export interface TargetOutcome {
  agentId?: string;
  agentName?: string;
  decision: DispatchDecision;
  runId?: string;
}

export interface PostMessageResult {
  thread: Thread;
  message: ThreadMessage;
  outcomes: TargetOutcome[];
  unknownMentions: string[];
  dispatched: ThreadRun[];
}

export interface PostMessageOptions {
  agents?: readonly MeshAgent[];
  limits?: BudgetLimits;
  now?: number;
}

export function countQueuedElsewhere(
  threads: readonly Thread[],
  agentId: string,
): number {
  return threads.reduce(
    (count, thread) =>
      count +
      thread.runs.filter(
        (run) => run.agentId === agentId && run.status === 'queued',
      ).length,
    0,
  );
}

function storeOutcome(outcome: TargetOutcome): MessageOutcome {
  const decision = outcome.decision;
  return {
    ...(outcome.agentId ? { targetAgentId: outcome.agentId } : {}),
    ...(outcome.agentName ? { targetAgentName: outcome.agentName } : {}),
    kind: decision.kind,
    ...(decision.kind === 'skip' ? { reason: decision.reason } : {}),
    ...(decision.kind === 'coalesce' ? { into: decision.into } : {}),
    ...(outcome.runId ? { runId: outcome.runId } : {}),
  };
}

function restoreOutcome(outcome: MessageOutcome): TargetOutcome {
  let decision: DispatchDecision;
  if (outcome.kind === 'dispatch') {
    decision = { kind: 'dispatch' };
  } else if (outcome.kind === 'coalesce') {
    if (!outcome.runId || !outcome.into) {
      throw new Error('Malformed persisted coalesce outcome.');
    }
    decision = {
      kind: 'coalesce',
      runId: outcome.runId,
      into: outcome.into,
    };
  } else {
    if (!outcome.reason) throw new Error('Malformed persisted skip outcome.');
    decision = {
      kind: 'skip',
      reason: outcome.reason as Extract<
        DispatchDecision,
        { kind: 'skip' }
      >['reason'],
    };
  }
  return {
    ...(outcome.targetAgentId ? { agentId: outcome.targetAgentId } : {}),
    ...(outcome.targetAgentName ? { agentName: outcome.targetAgentName } : {}),
    decision,
    ...(outcome.runId ? { runId: outcome.runId } : {}),
  };
}

export async function postMessageInTransaction(
  transaction: MeshStoreTransaction,
  threadId: string,
  input: PostMessageInput,
  options: PostMessageOptions = {},
): Promise<PostMessageResult> {
  const current = await transaction.readThread(threadId);
  if (!current) throw new Error(`No thread with id "${threadId}".`);

  if (input.originEventId) {
    const persisted = current.messages.find(
      (message) => message.originEventId === input.originEventId,
    );
    if (persisted) {
      const outcomes = persisted.outcomes.map(restoreOutcome);
      return {
        thread: current,
        message: persisted,
        outcomes,
        unknownMentions: outcomes
          .filter((outcome) =>
            outcome.decision.kind === 'skip'
              ? outcome.decision.reason === 'agent_unknown'
              : false,
          )
          .flatMap((outcome) => (outcome.agentName ? [outcome.agentName] : [])),
        dispatched: [],
      };
    }
  }

  const agents = options.agents ?? (await transaction.readAgents());
  const { threads, unreadable } = await transaction.listThreads();
  if (unreadable.length > 0) {
    throw new Error(
      `Cannot admit a message while thread records are unreadable: ${unreadable.join(', ')}.`,
    );
  }
  const root = threads.find((thread) => thread.id === current.rootThreadId);
  if (!root || root.rootThreadId !== root.id) {
    throw new Error(
      `No valid root thread with id "${current.rootThreadId}" for "${current.id}".`,
    );
  }
  const treeTokens = threads
    .filter((thread) => thread.rootThreadId === root.id)
    .reduce(
      (total, thread) =>
        total +
        thread.runs.reduce(
          (runTotal, run) =>
            runTotal +
            run.usageByRound.reduce(
              (usageTotal, usage) => usageTotal + usage.tokens,
              0,
            ),
          0,
        ),
      0,
    );
  const parsed = parseMentions(input.text, agents);
  const now = options.now ?? Date.now();
  const message: ThreadMessage = {
    id: generateMessageId(),
    sequence: current.nextMessageSequence,
    authorKind: input.from === HUMAN_AUTHOR_ID ? 'human' : 'agent',
    from: input.from,
    authorNameSnapshot:
      input.from === HUMAN_AUTHOR_ID
        ? HUMAN_AUTHOR_ID
        : (agents.find((agent) => agent.id === input.from)?.name ?? input.from),
    text: input.text,
    mentions: parsed.ids,
    outcomes: [],
    at: now,
    ...(input.originEventId ? { originEventId: input.originEventId } : {}),
  };
  const outcomes: TargetOutcome[] = parsed.unknown.map((agentName) => ({
    agentName,
    decision: { kind: 'skip', reason: 'agent_unknown' },
  }));
  const dispatched: ThreadRun[] = [];
  let autoTurnsUsed =
    input.from === HUMAN_AUTHOR_ID ? 0 : current.autoTurnsUsed;
  let next: Thread = {
    ...current,
    messages: [...current.messages, message],
    nextMessageSequence: current.nextMessageSequence + 1,
    autoTurnsUsed,
  };

  const hasExplicitMention = parsed.ids.length > 0 || parsed.unknown.length > 0;
  const targetIds = resolveTargets(next, message, hasExplicitMention);
  if (targetIds.length === 0 && !hasExplicitMention) {
    outcomes.push({ decision: { kind: 'skip', reason: 'no_target' } });
  }

  for (const agentId of targetIds) {
    const target = agents.find((candidate) => candidate.id === agentId);
    const decision = decideDispatch({
      thread: next,
      message,
      target,
      budget: { autoTurnsUsed, tokensUsed: treeTokens },
      agentQueuedElsewhere: countQueuedElsewhere(
        threads.filter((thread) => thread.id !== current.id),
        agentId,
      ),
      ...(options.limits ? { limits: options.limits } : {}),
    });

    if (decision.kind === 'coalesce') {
      const chargeTurn =
        input.from !== HUMAN_AUTHOR_ID && decision.into === 'running';
      if (chargeTurn) autoTurnsUsed += 1;
      next = {
        ...next,
        runs: next.runs.map((run) =>
          run.id === decision.runId
            ? {
                ...run,
                triggerMessageIds: [...run.triggerMessageIds, message.id],
              }
            : run,
        ),
        autoTurnsUsed,
        status:
          next.status === 'open' ||
          (input.from === HUMAN_AUTHOR_ID &&
            (next.status === 'blocked' || next.status === 'in_review'))
            ? 'in_progress'
            : next.status,
      };
      outcomes.push({
        agentId,
        agentName: target?.name,
        decision,
        runId: decision.runId,
      });
      continue;
    }

    if (decision.kind === 'dispatch') {
      const run: ThreadRun = {
        id: generateRunId(),
        agentId,
        status: 'queued',
        triggerMessageIds: [message.id],
        acceptedMessageIds: [],
        consumedMessageIds: [],
        usageByRound: [],
        queueSequence: await transaction.allocateRunSequence(),
        queuedAt: now,
        attempts: 0,
      };
      if (input.from !== HUMAN_AUTHOR_ID) autoTurnsUsed += 1;
      next = {
        ...next,
        runs: [...next.runs, run],
        autoTurnsUsed,
        status:
          next.status === 'open' ||
          (input.from === HUMAN_AUTHOR_ID &&
            (next.status === 'blocked' || next.status === 'in_review'))
            ? 'in_progress'
            : next.status,
      };
      dispatched.push(run);
      outcomes.push({
        agentId,
        agentName: target?.name,
        decision,
        runId: run.id,
      });
      continue;
    }

    outcomes.push({ agentId, agentName: target?.name, decision });
  }

  const storedMessage = { ...message, outcomes: outcomes.map(storeOutcome) };
  next = {
    ...next,
    messages: next.messages.map((candidate) =>
      candidate.id === message.id ? storedMessage : candidate,
    ),
  };
  // A post that actually books work says the thread has moved on, so an
  // earlier failure or unclosed return stops pinning it to `blocked`. Round-2
  // finding I2: acknowledgement used to be human-only, which left one launch
  // failure blocking the thread even after another agent finished the job.
  if (
    dispatched.length > 0 ||
    outcomes.some((o) => o.decision.kind === 'coalesce')
  ) {
    next = acknowledgeCloseObligations(next, storedMessage.sequence);
  }
  // The status is an aggregate over every run, never last-writer-wins, and it
  // is recomputed here so an admission that books nothing cannot leave the
  // thread sitting in `in_progress` with no live run and no explanation.
  next = await applyAggregateStatus(transaction, next, now);
  const thread = await transaction.writeThread(next);
  return {
    thread,
    message: storedMessage,
    outcomes,
    unknownMentions: parsed.unknown,
    dispatched,
  };
}

export async function postMessage(
  projectRoot: string,
  threadId: string,
  input: PostMessageInput,
  options: PostMessageOptions = {},
): Promise<PostMessageResult> {
  return withMeshStoreTransaction(projectRoot, (transaction) =>
    postMessageInTransaction(transaction, threadId, input, options),
  );
}

export async function startRun(
  projectRoot: string,
  threadId: string,
  runId: string,
  sessionId: string,
  now = Date.now(),
): Promise<Thread> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(threadId);
    if (!thread) throw new Error(`No thread with id "${threadId}".`);
    return transaction.writeThread({
      ...thread,
      runs: thread.runs.map((run) =>
        run.id === runId && run.status === 'queued'
          ? {
              ...run,
              status: 'running',
              sessionId,
              startedAt: now,
              attempts: run.attempts + 1,
            }
          : run,
      ),
    });
  });
}

/**
 * Records a run's terminal state.
 *
 * Delegates to the lifecycle module so a run has exactly one way to end and
 * the thread's aggregate status is recomputed from the same place every time.
 */
export async function finishRun(
  projectRoot: string,
  threadId: string,
  runId: string,
  outcome: {
    status: 'completed' | 'failed' | 'cancelled';
    error?: string;
    failureStage?: string;
  },
  now = Date.now(),
): Promise<Thread> {
  return withMeshStoreTransaction(projectRoot, (transaction) =>
    finishRunInTransaction(transaction, { threadId, runId, outcome, now }),
  );
}

export async function upsertRunUsage(
  projectRoot: string,
  threadId: string,
  runId: string,
  usage: RunUsageRound,
): Promise<Thread> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(threadId);
    if (!thread) throw new Error(`No thread with id "${threadId}".`);
    let found = false;
    const runs = thread.runs.map((run) => {
      if (run.id !== runId) return run;
      found = true;
      const usageByRound = run.usageByRound.filter(
        (entry) =>
          entry.attempt !== usage.attempt || entry.round !== usage.round,
      );
      usageByRound.push(usage);
      usageByRound.sort((a, b) => a.attempt - b.attempt || a.round - b.round);
      return { ...run, usageByRound };
    });
    if (!found) throw new Error(`No run with id "${runId}".`);
    return transaction.writeThread({
      ...thread,
      runs,
    });
  });
}
