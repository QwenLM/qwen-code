/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The transactional heart of the mesh: posting to a thread and
 * booking the runs that post implies.
 *
 * Appending the message and deciding who it wakes happen under one thread
 * lock. Splitting them would let two concurrent posts each observe "no queued
 * run for Alice" and book two — the same duplicate-dispatch race the Agent
 * Team lifecycle audit found in leader assignment (#10207).
 *
 * What this module does NOT do is start anything. It returns the bookings and
 * leaves waking a session to the daemon, so the rules stay testable without a
 * daemon and a tool call inside an agent turn cannot block on session I/O.
 */

import {
  generateMessageId,
  generateRunId,
  readTokenBudgetThread,
  readMeshAgents,
  readThread,
  updateThread,
} from './mesh-store.js';
import { parseMentions } from './mentions.js';
import {
  decideDispatch,
  resolveTargets,
  type BudgetLimits,
  type DispatchDecision,
} from './dispatch-policy.js';
import {
  HUMAN_AUTHOR_ID,
  type MeshAgent,
  type Thread,
  type ThreadMessage,
  type ThreadRun,
} from './types.js';

export interface PostMessageInput {
  /** {@link HUMAN_AUTHOR_ID} or the posting agent's id. */
  from: string;
  text: string;
}

/** One target's outcome, kept for the caller to act on and for the UI. */
export interface TargetOutcome {
  agentId?: string;
  agentName?: string;
  decision: DispatchDecision;
  /** Present when the decision created or extended a run. */
  runId?: string;
}

export interface PostMessageResult {
  thread: Thread;
  message: ThreadMessage;
  outcomes: TargetOutcome[];
  /** `@tokens` that matched no agent — surfaced so a typo is visible. */
  unknownMentions: string[];
  /** Runs newly booked by this post, for the dispatcher to start. */
  dispatched: ThreadRun[];
}

/**
 * Counts the runs already waiting for an agent on OTHER threads.
 *
 * Best effort by construction: it reads sibling threads without holding their
 * locks, so a run booked elsewhere in the same instant is not counted. Losing
 * that race admits one run past the queue limit, which is why the limit is a
 * backlog bound rather than a safety property — a stricter reading would need
 * a workspace-wide lock on every post. The dispatcher is the second line of
 * defence, and it is the one that must never start a second body for an agent
 * that already has one.
 */
export function countQueuedElsewhere(
  threads: readonly Thread[],
  agentId: string,
): number {
  let count = 0;
  for (const thread of threads) {
    for (const run of thread.runs) {
      if (run.agentId === agentId && run.status === 'queued') {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Appends a post and books the runs it implies.
 *
 * @param otherThreads Threads other than this one, for the concurrency count.
 *   The caller supplies them so this stays a pure-ish function over a
 *   snapshot the caller controls.
 */
export async function postMessage(
  projectRoot: string,
  threadId: string,
  input: PostMessageInput,
  options: {
    agents?: readonly MeshAgent[];
    /** Threads other than this one, for the queue count. */
    otherThreads?: readonly Thread[];
    limits?: BudgetLimits;
    now?: number;
  } = {},
): Promise<PostMessageResult> {
  const agents = options.agents ?? (await readMeshAgents(projectRoot));
  const otherThreads = options.otherThreads ?? [];
  const now = options.now ?? Date.now();

  const parsed = parseMentions(input.text, agents);

  const message: ThreadMessage = {
    id: generateMessageId(),
    from: input.from,
    text: input.text,
    mentions: parsed.ids,
    at: now,
  };

  const outcomes: TargetOutcome[] = [];
  const dispatched: ThreadRun[] = [];

  // Only token spend lives on the root. Read it before taking the child lock
  // to avoid lock inversion; a root post uses the locked record below.
  const existing = await readThread(projectRoot, threadId);
  if (!existing) throw new Error(`No thread with id "${threadId}".`);
  const budgetRecord = await readTokenBudgetThread(projectRoot, existing);
  const budgetSnapshot = {
    autoTurnsUsed: 0,
    tokensUsed: budgetRecord.tokensUsed,
  };

  const thread = await updateThread(projectRoot, threadId, (current) => {
    outcomes.length = 0;
    dispatched.length = 0;

    // A human post is the signal that the conversation is wanted, so it
    // clears the turn counter. Tokens are never cleared — see Thread.tokensUsed.
    const autoTurnsUsed =
      input.from === HUMAN_AUTHOR_ID ? 0 : current.autoTurnsUsed;

    let next: Thread = {
      ...current,
      messages: [...current.messages, message],
      autoTurnsUsed,
    };

    budgetSnapshot.autoTurnsUsed = next.autoTurnsUsed;
    budgetSnapshot.tokensUsed =
      current.rootThreadId === current.id
        ? current.tokensUsed
        : budgetRecord.tokensUsed;

    for (const name of parsed.unknown) {
      outcomes.push({
        agentName: name,
        decision: { kind: 'skip', reason: 'agent_unknown' },
      });
    }

    const hasExplicitMention =
      parsed.ids.length > 0 || parsed.unknown.length > 0;
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
        budget: {
          autoTurnsUsed: budgetSnapshot.autoTurnsUsed,
          tokensUsed: budgetSnapshot.tokensUsed,
        },
        agentQueuedElsewhere: countQueuedElsewhere(otherThreads, agentId),
        ...(options.limits ? { limits: options.limits } : {}),
      });

      if (decision.kind === 'coalesce') {
        const chargeTurn =
          input.from !== HUMAN_AUTHOR_ID && decision.into === 'running';
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
          autoTurnsUsed: next.autoTurnsUsed + (chargeTurn ? 1 : 0),
          status:
            next.status === 'open' ||
            (input.from === HUMAN_AUTHOR_ID &&
              (next.status === 'blocked' || next.status === 'in_review'))
              ? 'in_progress'
              : next.status,
        };
        if (chargeTurn) budgetSnapshot.autoTurnsUsed += 1;
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
          queuedAt: now,
          attempts: 0,
        };
        // Booked, not finished: charging at booking time makes the budget a
        // cap on attempts rather than on successes, so a pair of agents that
        // keep failing still runs out.
        if (input.from !== HUMAN_AUTHOR_ID) {
          budgetSnapshot.autoTurnsUsed += 1;
        }
        next = {
          ...next,
          runs: [...next.runs, run],
          autoTurnsUsed:
            input.from === HUMAN_AUTHOR_ID
              ? next.autoTurnsUsed
              : next.autoTurnsUsed + 1,
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

    return next;
  });

  return {
    thread,
    message,
    outcomes,
    unknownMentions: parsed.unknown,
    dispatched,
  };
}

/**
 * Marks a booked run as started, binds it to the session doing the work, and
 * counts the attempt. A revived run passes through here again, so `attempts`
 * is what makes the second failure terminal.
 */
export async function startRun(
  projectRoot: string,
  threadId: string,
  runId: string,
  sessionId: string,
  now = Date.now(),
): Promise<Thread> {
  return updateThread(projectRoot, threadId, (thread) => ({
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
  }));
}

/**
 * Records a terminal outcome. A run that already reached a terminal state is
 * left alone so a late completion cannot overwrite a cancellation.
 */
export async function finishRun(
  projectRoot: string,
  threadId: string,
  runId: string,
  outcome: { status: 'completed' | 'failed' | 'cancelled'; error?: string },
  now = Date.now(),
): Promise<Thread> {
  return updateThread(projectRoot, threadId, (thread) => ({
    ...thread,
    runs: thread.runs.map((run) =>
      run.id === runId && (run.status === 'queued' || run.status === 'running')
        ? {
            ...run,
            status: outcome.status,
            endedAt: now,
            ...(outcome.error ? { error: outcome.error } : {}),
          }
        : run,
    ),
  }));
}

/** The run a resuming dispatcher should hand to an agent next, if any. */
/**
 * Adds tokens spent by a run to the thread tree's counter.
 *
 * Called by the dispatcher with the usage delta observed across one run, so a
 * thread is charged for work done on its behalf rather than for everything the
 * agent's long-lived body has ever said.
 */
export async function chargeTokens(
  projectRoot: string,
  threadId: string,
  tokens: number,
): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const thread = await readThread(projectRoot, threadId);
  if (!thread) return;
  await updateThread(projectRoot, thread.rootThreadId, (root) => ({
    ...root,
    tokensUsed: root.tokensUsed + tokens,
  }));
}
