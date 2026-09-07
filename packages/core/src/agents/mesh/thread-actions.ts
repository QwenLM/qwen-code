/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  generateMessageId,
  generateRunId,
  prepareThreadInTransaction,
  withMeshStoreTransaction,
  type MeshStoreTransaction,
} from './mesh-store.js';
import { mentionToken, parseMentions } from './mentions.js';
import {
  applyAggregateStatus,
  finishRunInTransaction,
} from './run-lifecycle.js';
import { acknowledgeCloseObligations } from './thread-status.js';
import type { MeshRunContext } from './run-context.js';
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
  /**
   * `system` for a structured trigger — an assignment, or a parent dependency
   * report. Derived from `from` when absent. A system trigger still records the
   * run or human action that caused it, so it is charged as unattended work
   * without being suppressed as an ordinary self-authored post.
   */
  authorKind?: ThreadMessage['authorKind'];
  /** The run that caused this post. Server-derived; never model-supplied. */
  sourceRunId?: string;
  /** What kind of trigger this was, e.g. `assignment`. */
  triggerKind?: string;
}

/** Author id recorded for a post neither a person nor an agent wrote. */
export const SYSTEM_AUTHOR_ID = 'system';

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
  /** New thread not yet written, so its first assignment lands atomically. */
  initialThread?: Thread;
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
  const current =
    options.initialThread ?? (await transaction.readThread(threadId));
  if (!current) throw new Error(`No thread with id "${threadId}".`);
  if (current.id !== threadId) {
    throw new Error(`Initial thread id does not match "${threadId}".`);
  }

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
  const listed = await transaction.listThreads();
  const { unreadable } = listed;
  if (unreadable.length > 0) {
    throw new Error(
      `Cannot admit a message while thread records are unreadable: ${unreadable.join(', ')}.`,
    );
  }
  const threads = listed.threads.some((thread) => thread.id === current.id)
    ? listed.threads.map((thread) =>
        thread.id === current.id ? current : thread,
      )
    : [...listed.threads, current];
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
    authorKind:
      input.authorKind ?? (input.from === HUMAN_AUTHOR_ID ? 'human' : 'agent'),
    from: input.from,
    authorNameSnapshot:
      input.from === HUMAN_AUTHOR_ID || input.from === SYSTEM_AUTHOR_ID
        ? input.from
        : (agents.find((agent) => agent.id === input.from)?.name ?? input.from),
    text: input.text,
    mentions: parsed.ids,
    outcomes: [],
    at: now,
    ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
    ...(input.triggerKind ? { triggerKind: input.triggerKind } : {}),
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
    next = acknowledgeCloseObligations(
      next,
      storedMessage.sequence,
      (obligation) =>
        storedMessage.authorKind === 'human' ||
        obligation.kind === 'cancelled' ||
        obligation.kind === 'failure' ||
        obligation.kind === 'unclosed' ||
        (storedMessage.authorKind === 'system' &&
          storedMessage.triggerKind === 'child_report' &&
          obligation.kind === 'waiting'),
    );
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

export async function createAssignedThread(
  projectRoot: string,
  input: {
    title: string;
    body?: string;
    assignee: MeshAgent;
  },
): Promise<{ thread: Thread; assignment: PostMessageResult }> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const thread = await prepareThreadInTransaction(transaction, {
      title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
      assigneeAgentId: input.assignee.id,
    });
    const assignment = await postMessageInTransaction(
      transaction,
      thread.id,
      {
        from: HUMAN_AUTHOR_ID,
        authorKind: 'human',
        triggerKind: 'assignment',
        text: `Assigned to ${mentionToken(input.assignee)}.`,
      },
      { initialThread: thread },
    );
    return { thread: assignment.thread, assignment };
  });
}

export interface ClaimRunInput {
  threadId: string;
  runId: string;
  now?: number;
}

export interface ClaimedRun {
  thread: Thread;
  run: ThreadRun;
}

export async function claimRun(
  projectRoot: string,
  input: ClaimRunInput,
): Promise<ClaimedRun | undefined> {
  const now = input.now ?? Date.now();
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(input.threadId);
    const target = thread?.runs.find((run) => run.id === input.runId);
    if (!thread || !target || target.status !== 'queued') return undefined;

    const { threads, unreadable } = await transaction.listThreads();
    if (unreadable.length > 0) {
      throw new Error(
        `Cannot claim a run while thread records are unreadable: ${unreadable.join(', ')}.`,
      );
    }
    const alreadyLive = threads.some((candidate) =>
      candidate.runs.some(
        (run) =>
          run.id !== target.id &&
          run.agentId === target.agentId &&
          (run.status === 'running' ||
            run.status === 'finishing' ||
            run.status === 'cancelling'),
      ),
    );
    if (alreadyLive) return undefined;

    const claimed: ThreadRun = {
      ...target,
      status: 'running',
      startedAt: now,
      attempts: target.attempts + 1,
    };
    const stored = await transaction.writeThread({
      ...thread,
      runs: thread.runs.map((run) => (run.id === target.id ? claimed : run)),
    });
    return { thread: stored, run: claimed };
  });
}

export interface BindRunSessionInput {
  threadId: string;
  runId: string;
  attempt: number;
  /** Session carrying the work, so the run maps to a transcript slice. */
  sessionId: string;
  /**
   * Highest message sequence the prompt for this turn contained. Recorded on
   * the run and committed to the agent's delivery watermark, because the
   * initial prompt is consumed the moment the turn starts — unlike input
   * pushed into a running turn, which is committed only when the runtime
   * reports draining it.
   */
  contextThroughSequence?: number;
  /** Launch/revive input is already in history when start returns. */
  consumedOnStart?: boolean;
  /** Content hash of the agent definition in force, for drift audit (§9.4). */
  definitionVersion?: string;
  /** Byte offset into the agent's transcript where this run's slice begins. */
  transcriptStartOffset?: number;
}

export async function bindRunSession(
  projectRoot: string,
  input: BindRunSessionInput,
): Promise<Thread> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(input.threadId);
    if (!thread) throw new Error(`No thread with id "${input.threadId}".`);
    const target = thread.runs.find((run) => run.id === input.runId);
    if (
      !target ||
      target.status !== 'running' ||
      target.attempts !== input.attempt
    ) {
      throw new Error(
        `Run "${input.runId}" is not the claimed attempt on thread "${input.threadId}".`,
      );
    }
    const previousCommitted =
      thread.deliveryByAgent[target.agentId]?.committedThroughSequence ?? 0;
    const through = input.contextThroughSequence;
    const deliveredMessageIds =
      through === undefined
        ? []
        : thread.messages
            .filter(
              (message) =>
                message.sequence > previousCommitted &&
                message.sequence <= through,
            )
            .map((message) => message.id);
    const delivery =
      !input.consumedOnStart || input.contextThroughSequence === undefined
        ? thread.deliveryByAgent
        : {
            ...thread.deliveryByAgent,
            [target.agentId]: {
              committedThroughSequence: Math.max(
                thread.deliveryByAgent[target.agentId]
                  ?.committedThroughSequence ?? 0,
                input.contextThroughSequence,
              ),
            },
          };
    return transaction.writeThread({
      ...thread,
      deliveryByAgent: delivery,
      runs: thread.runs.map((run) =>
        run.id === input.runId
          ? {
              ...run,
              sessionId: input.sessionId,
              acceptedMessageIds: Array.from(
                new Set([...run.acceptedMessageIds, ...deliveredMessageIds]),
              ),
              consumedMessageIds: input.consumedOnStart
                ? Array.from(
                    new Set([
                      ...run.consumedMessageIds,
                      ...deliveredMessageIds,
                    ]),
                  )
                : run.consumedMessageIds,
              ...(input.contextThroughSequence !== undefined
                ? { contextThroughSequence: input.contextThroughSequence }
                : {}),
              ...(input.definitionVersion
                ? { definitionVersion: input.definitionVersion }
                : {}),
              ...(input.transcriptStartOffset !== undefined
                ? { transcriptStartOffset: input.transcriptStartOffset }
                : {}),
            }
          : run,
      ),
    });
  });
}

export async function consumeRunDelivery(
  projectRoot: string,
  context: MeshRunContext,
  deliveryId = context.runId,
): Promise<Thread> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(context.threadId);
    const run = thread?.runs.find((entry) => entry.id === context.runId);
    if (
      transaction.workspaceId !== context.workspaceId ||
      thread?.rootThreadId !== context.rootThreadId ||
      !run ||
      run.agentId !== context.agentId ||
      run.attempts !== context.attempt ||
      (run.status !== 'running' && run.status !== 'finishing')
    ) {
      throw new Error(
        `Run "${context.runId}" is no longer the active delivery attempt.`,
      );
    }

    const deliveredMessage = thread.messages.find(
      (message) => message.id === deliveryId,
    );
    const through =
      deliveryId === context.runId
        ? (context.contextThroughSequence ?? run.contextThroughSequence)
        : deliveredMessage?.sequence;
    if (through === undefined) return thread;
    const previousCommitted =
      thread.deliveryByAgent[run.agentId]?.committedThroughSequence ?? 0;
    const deliveredMessageIds = thread.messages
      .filter(
        (message) =>
          message.sequence > previousCommitted && message.sequence <= through,
      )
      .map((message) => message.id);
    const acceptedMessageIds = Array.from(
      new Set([...run.acceptedMessageIds, ...deliveredMessageIds]),
    );

    return transaction.writeThread({
      ...thread,
      deliveryByAgent: {
        ...thread.deliveryByAgent,
        [run.agentId]: {
          committedThroughSequence: Math.max(previousCommitted, through),
        },
      },
      runs: thread.runs.map((entry) =>
        entry.id === run.id
          ? {
              ...entry,
              acceptedMessageIds,
              consumedMessageIds: Array.from(
                new Set([...entry.consumedMessageIds, ...deliveredMessageIds]),
              ),
              contextThroughSequence: through,
            }
          : entry,
      ),
    });
  });
}

export async function requeueRun(
  projectRoot: string,
  input: { threadId: string; runId: string; attempt: number },
): Promise<boolean> {
  return withMeshStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(input.threadId);
    const run = thread?.runs.find((entry) => entry.id === input.runId);
    if (
      !thread ||
      !run ||
      run.status !== 'running' ||
      run.attempts !== input.attempt
    ) {
      return false;
    }
    await transaction.writeThread({
      ...thread,
      runs: thread.runs.map((entry) =>
        entry.id === run.id
          ? {
              ...entry,
              status: 'queued',
              sessionId: undefined,
              startedAt: undefined,
              endedAt: undefined,
              transcriptStartOffset: undefined,
              transcriptEndOffset: undefined,
              error: undefined,
              failureStage: undefined,
            }
          : entry,
      ),
    });
    return true;
  });
}

export async function releaseRunClaim(
  projectRoot: string,
  input: { threadId: string; runId: string; attempt: number },
): Promise<void> {
  await withMeshStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(input.threadId);
    if (!thread) return;
    const target = thread.runs.find((run) => run.id === input.runId);
    if (
      !target ||
      target.status !== 'running' ||
      target.sessionId ||
      target.attempts !== input.attempt
    ) {
      return;
    }
    await transaction.writeThread({
      ...thread,
      runs: thread.runs.map((run) =>
        run.id === target.id
          ? {
              ...run,
              status: 'queued',
              attempts: run.attempts - 1,
              startedAt: undefined,
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
    attempt?: number;
    error?: string;
    failureStage?: string;
    transcriptEndOffset?: number;
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
