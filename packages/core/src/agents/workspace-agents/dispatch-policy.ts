/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Whether a new thread post books work for a given agent.
 *
 * Kept pure and separate from the daemon service that acts on it, because
 * these rules are the difference between a working agent and a token fire:
 * every one exists to stop a specific runaway or duplicate.
 *
 * The scope is deliberately narrow — **book, coalesce, or refuse**. Whether a
 * booked run can start *right now* is the dispatcher's business, because it
 * depends on what the agent's single body happens to be doing. An earlier
 * revision had this function return `defer` for a busy agent, which put a
 * scheduling decision inside a rules function and gave the same situation two
 * spellings. A run that cannot start yet is simply a queued run.
 *
 * Four rules mirror what Multica arrived at (`server/internal/handler/
 * comment.go`): coalesce rather than double-book, never let an author wake
 * itself, let an explicit mention take routing away from the assignee, and
 * fail closed. The budget rules are ours: Multica's runs terminate on their
 * own and a human owns the issue, whereas two workspace agents answering each other
 * have nothing to stop them.
 */

import { isAgentEnabled, queueLimitFor } from './store.js';
import {
  DEFAULT_THREAD_AUTO_TURN_BUDGET,
  DEFAULT_THREAD_TOKEN_BUDGET,
  HUMAN_AUTHOR_ID,
  type WorkspaceAgent,
  type Thread,
  type ThreadMessage,
} from './types.js';

export type DispatchDecision =
  /** Book a new queued run. The dispatcher decides when it starts. */
  | { kind: 'dispatch' }
  /**
   * Add this message to a run the agent already has on this thread. Covers
   * both a run that has not started and one executing this same thread —
   * mid-run delivery is available here, so a second run would be waste.
   */
  | { kind: 'coalesce'; runId: string; into: 'queued' | 'running' }
  /** Nothing will run for this target, and nothing is pending. */
  | { kind: 'skip'; reason: SkipReason };

export type SkipReason =
  | 'self_trigger'
  | 'agent_disabled'
  | 'agent_unknown'
  | 'turn_budget_exhausted'
  | 'token_budget_exhausted'
  | 'queue_full'
  | 'thread_done'
  | 'no_target';

/** Local turn count plus the thread tree's root token spend. */
export interface BudgetState {
  autoTurnsUsed: number;
  tokensUsed: number;
}

export interface BudgetLimits {
  autoTurns?: number;
  tokens?: number;
}

export interface DispatchContext {
  thread: Thread;
  /** The post being routed. Must already be appended to `thread.messages`. */
  message: ThreadMessage;
  /** The agent being considered as a target. */
  target: WorkspaceAgent | undefined;
  /**
   * The current thread's turn count and its root thread's token count. The
   * caller resolves the root because reading another file is I/O.
   */
  budget: BudgetState;
  /**
   * Runs already waiting for this agent across every thread, excluding any on
   * this thread (those coalesce instead of queueing).
   */
  agentQueuedElsewhere: number;
  limits?: BudgetLimits;
}

/**
 * Decides what a single (message, target) pair should do.
 *
 * Order is load-bearing. Identity and routing come first, so a decision never
 * depends on run state a concurrent writer could change. Budget precedes the
 * queue checks so an exhausted tree cannot keep folding new work into a run it
 * should not have. Coalescing precedes the queue limit because joining an
 * existing run adds nothing to the queue.
 */
export function decideDispatch(context: DispatchContext): DispatchDecision {
  const { thread, message, target } = context;

  if (!target) return { kind: 'skip', reason: 'agent_unknown' };
  if (!isAgentEnabled(target)) {
    return { kind: 'skip', reason: 'agent_disabled' };
  }

  // A finished thread stops consuming model time. Reopening it is a
  // deliberate act, not something a late post should do implicitly.
  if (thread.status === 'done') return { kind: 'skip', reason: 'thread_done' };

  // An agent's own post never wakes it. Without this, a single "I'm done"
  // message becomes an infinite self-conversation.
  if (message.from === target.id) {
    return { kind: 'skip', reason: 'self_trigger' };
  }

  // The loop breaker. A person posting is the signal that the conversation is
  // wanted, and resets this thread's turn counter at the call site.
  if (message.from !== HUMAN_AUTHOR_ID) {
    const turnLimit =
      context.limits?.autoTurns ?? DEFAULT_THREAD_AUTO_TURN_BUDGET;
    if (context.budget.autoTurnsUsed >= turnLimit) {
      return { kind: 'skip', reason: 'turn_budget_exhausted' };
    }
  }

  // Token spend is a hard tree-wide cap, including human-authored triggers.
  // A person can start a fresh root thread rather than silently bypass money
  // already spent by this one.
  const tokenLimit = context.limits?.tokens ?? DEFAULT_THREAD_TOKEN_BUDGET;
  if (context.budget.tokensUsed >= tokenLimit) {
    return { kind: 'skip', reason: 'token_budget_exhausted' };
  }

  // An agent has one body, so at most one run of its own can be live on this
  // thread. Either state absorbs the message: a queued run has not been sent
  // yet, and a running one accepts mid-turn delivery.
  const existing =
    thread.runs.find(
      (run) => run.agentId === target.id && run.status === 'queued',
    ) ??
    thread.runs.find(
      (run) => run.agentId === target.id && run.status === 'running',
    );
  if (existing) {
    return {
      kind: 'coalesce',
      runId: existing.id,
      into: existing.status === 'running' ? 'running' : 'queued',
    };
  }

  // Refusing at the limit is the point: silently accepting would build a
  // backlog whose tail is stale by the time the agent reaches it.
  if (context.agentQueuedElsewhere >= queueLimitFor(target)) {
    return { kind: 'skip', reason: 'queue_full' };
  }

  return { kind: 'dispatch' };
}

/**
 * The agents a post is addressed to: everyone mentioned, or the assignee when
 * no mention token was present. The author is included here and rejected by
 * {@link decideDispatch} so a self-trigger has a visible outcome.
 */
export function resolveTargets(
  thread: Thread,
  message: ThreadMessage,
  /**
   * Whether the post carried any `@token`, known or unknown. Required, and
   * deliberately not defaulted to `message.mentions.length > 0`: an *unknown*
   * mention resolves to no id yet must still suppress the assignee fallback,
   * so a default computed from the resolved ids would silently reinstate the
   * "typo wakes the assignee" bug the admission foundation fixed.
   */
  hasExplicitMention: boolean,
): string[] {
  if (hasExplicitMention) return [...message.mentions];
  return thread.assigneeAgentId ? [thread.assigneeAgentId] : [];
}
