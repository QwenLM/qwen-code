/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Presentation logic for the agents-and-threads surface.
 *
 * Everything here is pure and testable without a browser, following the same
 * split as `agents-manager-logic.ts`. Two rules it exists to enforce:
 *
 * 1. **The server decides a thread's state; this file only renders it.** The
 *    thread resolver already returns a status *and* the sentence explaining it.
 *    Deriving a second, shorter vocabulary here would give the product two
 *    answers to "why is this blocked", and the shorter one would win because it
 *    is the one on screen.
 * 2. **A label never asserts a cause its reason code does not carry.** Copy
 *    that conflates two causes sends people to fix the wrong thing — Multica
 *    learned this when "runtime offline" wording sent users to reconnect a
 *    machine that was already connected. Each refusal below names its own fix.
 */

/** Wire shape of a thread row, as the REST layer returns it. */
export interface ThreadSummaryView {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'cancelled';
  /** The resolver's own sentence. Rendered verbatim; never re-derived. */
  reason: string;
  updatedAt: number;
  liveRunCount: number;
  assigneeName?: string;
  parentThreadId?: string;
}

export interface ThreadGroup {
  key: 'needs_you' | 'running' | 'idle' | 'done';
  /** Sentence-case label. Not an all-caps eyebrow. */
  label: string;
  threads: ThreadSummaryView[];
  /** Finished work is evidence, not a task, so it starts collapsed. */
  collapsedByDefault: boolean;
}

/**
 * Groups threads by what they need, not by recency.
 *
 * Recency is the default sort and it buries the two threads that need a person
 * under twenty that do not. `blocked` and `in_review` share one group because
 * they are the same query for the reader — this is waiting on me — even though
 * one is a question and the other is finished work. What tells them apart is
 * each thread's own sentence, which is already on the row.
 */
export function groupThreads(
  threads: readonly ThreadSummaryView[],
): ThreadGroup[] {
  const needsYou: ThreadSummaryView[] = [];
  const running: ThreadSummaryView[] = [];
  const idle: ThreadSummaryView[] = [];
  const done: ThreadSummaryView[] = [];
  for (const thread of threads) {
    if (thread.parentThreadId) continue;
    // Cancelled files with done rather than idle: both are over, and an idle
    // group is a list of things still waiting for someone, which a withdrawn
    // task is not.
    if (thread.status === 'done' || thread.status === 'cancelled') {
      done.push(thread);
    }
    else if (thread.status === 'blocked' || thread.status === 'in_review') {
      needsYou.push(thread);
    } else if (thread.liveRunCount > 0) running.push(thread);
    else idle.push(thread);
  }
  const byRecency = (a: ThreadSummaryView, b: ThreadSummaryView) =>
    b.updatedAt - a.updatedAt;
  // Annotated before `.filter`, which otherwise strips the contextual type and
  // widens each `key` to `string` — so a typo in one would only be caught by
  // whatever reads it.
  const groups: ThreadGroup[] = [
    {
      key: 'needs_you',
      label: 'Needs you',
      threads: needsYou.sort(byRecency),
      collapsedByDefault: false,
    },
    {
      key: 'running',
      label: 'Running',
      threads: running.sort(byRecency),
      collapsedByDefault: false,
    },
    {
      key: 'idle',
      label: 'Idle',
      threads: idle.sort(byRecency),
      collapsedByDefault: false,
    },
    {
      key: 'done',
      label: 'Done',
      threads: done.sort(byRecency),
      collapsedByDefault: true,
    },
  ];
  return groups.filter((group) => group.threads.length > 0);
}

/** Which threads carry the single attention treatment. */
export function needsAttention(thread: ThreadSummaryView): boolean {
  return thread.status === 'blocked' || thread.status === 'in_review';
}

/** Wire shape of one run, as the REST layer returns it. */
export interface RunView {
  id: string;
  agentId: string;
  agentName: string;
  agentColor?: string;
  status:
    | 'queued'
    | 'running'
    | 'finishing'
    | 'cancelling'
    | 'completed'
    | 'failed'
    | 'cancelled';
  closeKind?: 'waiting' | 'blocked' | 'review' | 'unclosed' | 'stranded';
  closeAcknowledged: boolean;
  failureStage?: string;
  error?: string;
  /** Why this run exists, e.g. "assigned by you", "mentioned by alice". */
  trigger: string;
  startedAt?: number;
  endedAt?: number;
  /** The agent session this run took its turn in, once one is bound. */
  sessionId?: string;
}

export interface RunRow {
  run: RunView;
  /** What this run is doing or left behind, in the reader's words. */
  state: string;
  /** Live runs pin to the top; terminal runs collapse behind a count. */
  live: boolean;
  /** True when a person still owes this run an answer. */
  outstanding: boolean;
}

/**
 * Describes a run the way the reader asks about it.
 *
 * A failed run reports its failure whatever close it managed to record first,
 * because the failure is the thing a person has to act on.
 */
export function describeRun(run: RunView): string {
  if (run.status === 'failed') {
    return run.failureStage ? `failed at ${run.failureStage}` : 'failed';
  }
  if (run.status === 'cancelled') return 'cancelled';
  if (run.status === 'queued') return 'waiting to start';
  if (run.status === 'running') return 'working';
  if (run.status === 'cancelling') return 'stopping';
  switch (run.closeKind) {
    case 'blocked':
      return 'asked a question';
    case 'review':
      return 'submitted for review';
    case 'waiting':
      return 'waiting for other work';
    case 'unclosed':
      return 'ended without a hand-off';
    case 'stranded':
      // Says what happened to it, not what the agent did — nothing the agent
      // did ended this run, and a person has to decide what happens next.
      return 'stranded when collaboration was turned off';
    default:
      return run.status === 'finishing' ? 'finishing' : 'nothing outstanding';
  }
}

const LIVE_RUN_STATUSES = new Set([
  'queued',
  'running',
  'finishing',
  'cancelling',
]);

/**
 * Orders runs for the side panel: live first in start order, then terminal
 * runs newest-first behind their count.
 *
 * The row carries no agent-availability indicator. Whether an agent is
 * reachable is not this row's story — the run's own state is, and a second
 * signal beside it competes for the same glance.
 */
export function buildRunRows(runs: readonly RunView[]): {
  live: RunRow[];
  past: RunRow[];
} {
  const rows = runs.map((run) => ({
    run,
    state: describeRun(run),
    live: LIVE_RUN_STATUSES.has(run.status),
    outstanding:
      !run.closeAcknowledged &&
      !LIVE_RUN_STATUSES.has(run.status) &&
      (run.status === 'cancelled' ||
        run.status === 'failed' ||
        run.closeKind === 'blocked' ||
        run.closeKind === 'review' ||
        run.closeKind === 'unclosed' ||
        run.closeKind === 'stranded'),
  }));
  return {
    live: rows
      .filter((row) => row.live)
      .sort((a, b) => (a.run.startedAt ?? 0) - (b.run.startedAt ?? 0)),
    past: rows
      .filter((row) => !row.live)
      .sort((a, b) => (b.run.endedAt ?? 0) - (a.run.endedAt ?? 0)),
  };
}

/**
 * One line, not a bar. A budget is a limit you want to notice before it trips,
 * not a goal you are filling, and a bar invites the second reading.
 */
export function formatBudget(budget: {
  turnsUsed: number;
  turnLimit: number;
  tokensUsed: number;
  tokenLimit: number;
}): { turns: string; tokens: string; scope: string } {
  const compact = (value: number) =>
    value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
  return {
    turns: `${budget.turnsUsed} of ${budget.turnLimit} unattended turns`,
    tokens: `${compact(budget.tokensUsed)} of ${compact(budget.tokenLimit)} tokens`,
    scope: 'across this thread tree',
  };
}

/** One target's fate for a draft reply, as the server previews it. */
export interface RoutingPreviewTarget {
  agentName: string;
  willWake: boolean;
  kind?: 'dispatch' | 'coalesce' | 'skip';
  into?: 'queued' | 'running';
  /** Present when `willWake` is false. A skip reason from the rules layer. */
  reason?: string;
  /** True when the name matched no agent, so it renders as a warning. */
  unknown?: boolean;
}

/**
 * What a refusal means, and what to do about it.
 *
 * Each entry names its own fix. Two reasons that look alike but need different
 * fixes stay apart: a missing definition is repaired by pointing the agent at
 * one that exists, while a disabled agent is repaired by enabling it, and copy
 * that merged them would send the reader to the wrong screen.
 */
export function explainSkip(
  reason: string,
  target: string,
): { what: string; fix: string } {
  switch (reason) {
    case 'agent_unknown':
      return {
        what: `no agent named "${target}" in this workspace`,
        fix: 'Check the spelling, or add the agent.',
      };
    case 'agent_disabled':
      return {
        what: `${target} is disabled and cannot take work`,
        fix: `Enable ${target} to let it take work again.`,
      };
    case 'agent_retired':
      // Deliberately not the disabled copy: enabling a retired agent is
      // refused, so telling someone to enable it sends them at a wall.
      return {
        what: `${target} is retired and takes no new work`,
        fix: `Its posts stay on every thread. Hand this to another agent.`,
      };
    case 'no_target':
      return {
        what: 'your reply would reach nobody',
        fix: 'Mention an agent, or set an assignee for this thread.',
      };
    case 'queue_full':
      return {
        what: `${target} already has a full backlog`,
        fix: 'Wait for it to catch up, or give this to another agent.',
      };
    case 'turn_budget_exhausted':
      return {
        what: 'this thread has spent its unattended turns',
        fix: 'Your own reply resets the count and continues the work.',
      };
    case 'token_budget_exhausted':
      return {
        what: 'this thread tree has spent its token budget',
        fix: 'This limit is never reset. Open a new thread to continue.',
      };
    case 'thread_done':
      return {
        what: 'this thread is done and takes no new work',
        fix: 'Open a new thread.',
      };
    case 'self_trigger':
      return {
        what: `${target} wrote this post and cannot wake itself`,
        fix: 'Mention a different agent.',
      };
    default:
      // Never invent a cause the code did not carry.
      return {
        what: `${target} will not be woken`,
        fix: 'Open the thread after posting to see what happened.',
      };
  }
}

/**
 * A one-line summary of a preview, for the composer's collapsed state.
 *
 * Says who *will* run, because that is the consequence of pressing send. When
 * nobody will, that is the headline, since it is the case the system used to
 * swallow silently.
 */
export function summarizePreview(
  targets: readonly RoutingPreviewTarget[],
): string {
  const waking = targets.filter((target) => target.willWake);
  if (waking.length === 0) return 'Nobody will be woken by this reply.';
  return waking
    .map((target) =>
      target.kind === 'coalesce'
        ? `${target.agentName} will receive this in ${target.into === 'running' ? 'the running task' : 'queued work'}.`
        : `${target.agentName} will start working.`,
    )
    .join(' ');
}
