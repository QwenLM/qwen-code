/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Who, if anyone, a new thread post should wake.
 *
 * Kept pure and separate from the daemon service that acts on it, because
 * these rules are the difference between a working mesh and a token fire:
 * every one of them exists to stop a specific runaway or duplicate.
 *
 * The first four mirror what Multica arrived at (`server/internal/handler/
 * comment.go`): coalesce into a queued run, defer when one is already active,
 * never let an author wake itself, and let an explicit mention take routing
 * away from the assignee. The budget rule is ours: Multica's runs terminate
 * on their own and a human owns the issue, whereas two mesh agents answering
 * each other have nothing to stop them.
 */

import {
  agentConcurrencyLimit,
  isAgentEnabled,
} from './mesh-store.js';
import {
  DEFAULT_THREAD_AUTO_TURN_BUDGET,
  HUMAN_AUTHOR_ID,
  type MeshAgent,
  type Thread,
  type ThreadMessage,
} from './types.js';

export type DispatchDecision =
  /** Start a new run for this agent. */
  | { kind: 'dispatch' }
  /** Fold the message into an existing queued run that has not started. */
  | { kind: 'coalesce'; runId: string }
  /**
   * Do nothing now; the named run's completion re-evaluates the thread.
   * Distinct from `skip`: deferred work is expected to happen.
   */
  | { kind: 'defer'; reason: DeferReason; runId?: string }
  /** Nothing will run for this target, and nothing is pending. */
  | { kind: 'skip'; reason: SkipReason };

export type DeferReason = 'active_run' | 'agent_at_capacity';

export type SkipReason =
  | 'self_trigger'
  | 'agent_disabled'
  | 'agent_unknown'
  | 'explicit_routing'
  | 'budget_exhausted'
  | 'thread_done';

export interface DispatchContext {
  thread: Thread;
  /** The post being routed. Must already be appended to `thread.messages`. */
  message: ThreadMessage;
  /** The agent being considered as a target. */
  target: MeshAgent | undefined;
  /**
   * Runs this agent currently holds across every thread, counting `queued`
   * and `running`. The caller owns this because concurrency is a workspace
   * fact, not a thread one.
   */
  agentActiveRunCount: number;
  /** Absent uses {@link DEFAULT_THREAD_AUTO_TURN_BUDGET}. */
  autoTurnBudget?: number;
}

/**
 * Decides what a single (message, target) pair should do.
 *
 * Order is load-bearing. Identity and routing checks come first so a decision
 * never depends on run state that a concurrent writer could change; the
 * budget precedes the queue checks so an exhausted thread cannot keep
 * coalescing new work into a run it should not have; capacity comes last
 * because it is the only reason that resolves purely by waiting.
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

  // An explicit `@` is the routing decision: when the post names somebody,
  // the assignee stays out of it. Only mentioned agents proceed.
  if (message.mentions.length > 0 && !message.mentions.includes(target.id)) {
    return { kind: 'skip', reason: 'explicit_routing' };
  }

  // The loop breaker. Only agent-authored posts spend budget: a person
  // posting is the signal that the conversation is wanted, and it resets the
  // counter at the call site.
  if (message.from !== HUMAN_AUTHOR_ID) {
    const budget = context.autoTurnBudget ?? DEFAULT_THREAD_AUTO_TURN_BUDGET;
    if (thread.autoTurnsUsed >= budget) {
      return { kind: 'skip', reason: 'budget_exhausted' };
    }
  }

  const queued = thread.runs.find(
    (run) => run.agentId === target.id && run.status === 'queued',
  );
  if (queued) return { kind: 'coalesce', runId: queued.id };

  const active = thread.runs.find(
    (run) => run.agentId === target.id && run.status === 'running',
  );
  if (active) {
    return { kind: 'defer', reason: 'active_run', runId: active.id };
  }

  if (context.agentActiveRunCount >= agentConcurrencyLimit(target)) {
    return { kind: 'defer', reason: 'agent_at_capacity' };
  }

  return { kind: 'dispatch' };
}

/**
 * The agents a post is addressed to: everyone mentioned, or the assignee when
 * nobody is named. The author is included here and rejected by
 * {@link decideDispatch}, so "why did nothing happen" has one answer per
 * target rather than a silent omission.
 */
export function resolveTargets(thread: Thread, message: ThreadMessage): string[] {
  if (message.mentions.length > 0) return [...message.mentions];
  return thread.assigneeAgentId ? [thread.assigneeAgentId] : [];
}
