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
  readMeshAgents,
  updateThread,
} from './mesh-store.js';
import { parseMentions } from './mentions.js';
import {
  decideDispatch,
  resolveTargets,
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
  /**
   * Pre-resolved mention ids. Normally omitted so the text is the single
   * source of truth; supplied only by callers that already resolved them
   * against the same roster snapshot.
   */
  mentions?: string[];
}

/** One target's outcome, kept for the caller to act on and for the UI. */
export interface TargetOutcome {
  agentId: string;
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
 * Counts an agent's in-flight runs across every thread.
 *
 * Best effort by construction: it reads sibling threads without holding their
 * locks, so a run booked elsewhere in the same instant is not counted. The
 * consequence of losing that race is one extra concurrent run, which the
 * per-agent limit exists to bound rather than to guarantee — a stricter
 * reading would need a workspace-wide lock on every post.
 */
export function countActiveRuns(
  threads: readonly Thread[],
  agentId: string,
): number {
  let count = 0;
  for (const thread of threads) {
    for (const run of thread.runs) {
      if (
        run.agentId === agentId &&
        (run.status === 'queued' || run.status === 'running')
      ) {
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
    otherThreads?: readonly Thread[];
    autoTurnBudget?: number;
    now?: number;
  } = {},
): Promise<PostMessageResult> {
  const agents = options.agents ?? (await readMeshAgents(projectRoot));
  const otherThreads = options.otherThreads ?? [];
  const now = options.now ?? Date.now();

  const parsed = input.mentions
    ? { ids: input.mentions, unknown: [] as string[] }
    : parseMentions(input.text, agents);

  const message: ThreadMessage = {
    id: generateMessageId(),
    from: input.from,
    text: input.text,
    mentions: parsed.ids,
    at: now,
  };

  const outcomes: TargetOutcome[] = [];
  const dispatched: ThreadRun[] = [];

  const thread = await updateThread(projectRoot, threadId, (current) => {
    outcomes.length = 0;
    dispatched.length = 0;

    // A human post is the signal that the conversation is wanted, so it
    // clears the loop budget. Agent posts spend it.
    const autoTurnsUsed =
      input.from === HUMAN_AUTHOR_ID ? 0 : current.autoTurnsUsed;

    let next: Thread = {
      ...current,
      messages: [...current.messages, message],
      autoTurnsUsed,
    };

    for (const agentId of resolveTargets(next, message)) {
      const target = agents.find((candidate) => candidate.id === agentId);
      const decision = decideDispatch({
        thread: next,
        message,
        target,
        agentActiveRunCount:
          countActiveRuns(otherThreads, agentId) +
          countActiveRuns([next], agentId),
        ...(options.autoTurnBudget !== undefined
          ? { autoTurnBudget: options.autoTurnBudget }
          : {}),
      });

      if (decision.kind === 'coalesce') {
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
          queuedAt: now,
        };
        next = {
          ...next,
          runs: [...next.runs, run],
          // Booked, not finished: charging the budget at booking time is what
          // makes it a cap on attempts rather than on successes, so a pair of
          // agents that keep failing still runs out.
          autoTurnsUsed:
            input.from === HUMAN_AUTHOR_ID
              ? next.autoTurnsUsed
              : next.autoTurnsUsed + 1,
          status: next.status === 'open' ? 'in_progress' : next.status,
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

/** Marks a booked run as started and binds it to the session doing the work. */
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
        ? { ...run, status: 'running', sessionId, startedAt: now }
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
export function nextQueuedRun(
  thread: Thread,
  agentId: string,
): ThreadRun | undefined {
  return thread.runs.find(
    (run) => run.agentId === agentId && run.status === 'queued',
  );
}
