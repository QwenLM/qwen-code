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

import type {
  AgentPermissionPromptView,
  AgentRunStepView,
} from './agent-events';

/**
 * Opens a thread body that carries the conversation it was started from. The
 * agents read it as-is; the chat view shows it folded instead of as a message.
 */
export const CONVERSATION_CONTEXT_PREFIX =
  'Context from the conversation this was sent from:\n\n';

/** Wire shape of a thread row, as the REST layer returns it. */
export interface ThreadSummaryView {
  id: string;
  title: string;
  status:
    | 'open'
    | 'in_progress'
    | 'blocked'
    | 'in_review'
    | 'done'
    | 'cancelled';
  /** The resolver's own sentence. Rendered verbatim; never re-derived. */
  reason: string;
  updatedAt: number;
  liveRunCount: number;
  assigneeName?: string;
  parentThreadId?: string;
}

export interface ThreadGroup {
  key: 'needs_you' | 'running' | 'idle' | 'done';
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
    } else if (thread.status === 'blocked' || thread.status === 'in_review') {
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
      threads: needsYou.sort(byRecency),
      collapsedByDefault: false,
    },
    {
      key: 'running',
      threads: running.sort(byRecency),
      collapsedByDefault: false,
    },
    {
      key: 'idle',
      threads: idle.sort(byRecency),
      collapsedByDefault: false,
    },
    {
      key: 'done',
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
  progress?: {
    attempt?: number;
    receivedAt: number;
    activityAt: number;
    /** A code: starting, thinking, responding, tool, awaiting_approval, stream_lost. */
    stage: string;
    /** Raw text such as a tool title; never UI copy. */
    detail: string;
    outputText?: string;
    thoughtText?: string;
    permission?: AgentPermissionPromptView;
    /** The turn's latest tool calls, oldest first. */
    steps?: AgentRunStepView[];
  };
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
  /** Queued runs of the same agent that start before this one. */
  queueAhead?: number;
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
export function describeRun(run: RunView, t: Translate): string {
  if (run.status === 'failed') {
    return run.failureStage
      ? t('collab.runState.failedAt', { stage: run.failureStage })
      : t('collab.runState.failed');
  }
  if (run.status === 'cancelled') return t('collab.runState.cancelled');
  if (run.status === 'queued') return t('collab.runState.queued');
  if (run.status === 'running') return t('collab.runState.working');
  if (run.status === 'cancelling') return t('collab.runState.stopping');
  switch (run.closeKind) {
    case 'blocked':
      return t('collab.runState.blocked');
    case 'review':
      return t('collab.runState.review');
    case 'waiting':
      return t('collab.runState.waiting');
    case 'unclosed':
      return t('collab.runState.unclosed');
    case 'stranded':
      // Says what happened to it, not what the agent did — nothing the agent
      // did ended this run, and a person has to decide what happens next.
      return t('collab.runState.stranded');
    default:
      return run.status === 'finishing'
        ? t('collab.runState.finishing')
        : t('collab.runState.idle');
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
export function buildRunRows(
  runs: readonly RunView[],
  t: Translate,
): {
  live: RunRow[];
  past: RunRow[];
} {
  const rows = runs.map((run) => ({
    run,
    state: describeRun(run, t),
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
export function formatBudget(
  budget: {
    turnsUsed: number;
    turnLimit: number;
    tokensUsed: number;
    tokenLimit: number;
  },
  t: Translate,
): { turns: string; tokens: string; scope: string } {
  const compact = (value: number) =>
    value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
  return {
    turns: t('collab.budget.turns', {
      used: budget.turnsUsed,
      limit: budget.turnLimit,
    }),
    tokens: t('collab.budget.tokens', {
      used: compact(budget.tokensUsed),
      limit: compact(budget.tokenLimit),
    }),
    scope: t('collab.budget.scope'),
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
  t: Translate,
): string {
  const known = new Set([
    'agent_unknown',
    'agent_disabled',
    'agent_retired',
    'no_target',
    'queue_full',
    'turn_budget_exhausted',
    'token_budget_exhausted',
    'thread_done',
    'self_trigger',
  ]);
  // Never invent a cause the code did not carry.
  return t(known.has(reason) ? `collab.skip.${reason}` : 'collab.skip.other', {
    name: target,
  });
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
  t: Translate,
): string {
  const waking = targets.filter((target) => target.willWake);
  if (waking.length === 0) return t('collab.preview.nobody');
  return waking
    .map((target) =>
      target.kind === 'coalesce'
        ? t(
            target.into === 'running'
              ? 'collab.preview.intoRunning'
              : 'collab.preview.intoQueued',
            { name: target.agentName },
          )
        : t('collab.preview.dispatch', { name: target.agentName }),
    )
    .join(' ');
}

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/** "45 秒" or "6 分 45 秒": the one duration format the collaboration UI uses. */
export function formatElapsed(ms: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return t('collab.elapsed.seconds', { count: seconds });
  return t('collab.elapsed.minutes', {
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
  });
}

/**
 * Why a run exists, in the reader's language. The server words this in
 * English from a fixed set; anything outside it is shown as sent.
 */
export function triggerLabel(trigger: string, t: Translate): string {
  switch (trigger) {
    case 'started by the dispatcher':
      return t('collab.trigger.dispatcher');
    case 'assigned to this thread':
      return t('collab.trigger.assigned');
    case 'a sub-thread reported back':
      return t('collab.trigger.childReport');
    case 'mentioned by you':
      return t('collab.trigger.mentionedByYou');
    case 'assigned by you':
      return t('collab.trigger.assignedByYou');
    default: {
      const by = /^mentioned by (.+)$/.exec(trigger)?.[1];
      return by ? t('collab.trigger.mentionedBy', { name: by }) : trigger;
    }
  }
}

const STATUS_REASON_KEYS: Record<string, string> = {
  'this thread was cancelled': 'collab.reason.cancelled',
  'a person marked this thread done': 'collab.reason.done',
  'an Agent asked a question and is waiting for you': 'collab.reason.question',
  'an Agent run was cancelled and no successor is runnable':
    'collab.reason.runCancelled',
  'an Agent run failed and no successor is runnable': 'collab.reason.runFailed',
  'an Agent ended without a hand-off': 'collab.reason.noHandoff',
  'an Agent is waiting on work that no longer exists':
    'collab.reason.strandedWait',
  'an Agent submitted a summary for review': 'collab.reason.review',
  'an Agent is waiting on a live subtask': 'collab.reason.waitingSubtask',
  'no outstanding close obligation': 'collab.reason.idle',
};

/**
 * A thread's status reason in the reader's language. The server words it
 * from a fixed set (the live-run line in Chinese, the rest in English);
 * anything outside it is shown as sent.
 */
export function statusReasonLabel(reason: string, t: Translate): string {
  const key = STATUS_REASON_KEYS[reason];
  if (key) return t(key);
  if (reason.startsWith('the last post booked no work')) {
    return t('collab.reason.bookedNothing');
  }
  const queued = /^(\d+) 个智能体排队中/.exec(reason);
  if (queued) return t('collab.reason.queued', { count: Number(queued[1]) });
  const working = /^(\d+) 个智能体执行中(?:，(\d+) 个排队中)?$/.exec(reason);
  if (working) {
    return working[2]
      ? t('collab.reason.workingQueued', {
          count: Number(working[1]),
          queued: Number(working[2]),
        })
      : t('collab.reason.working', { count: Number(working[1]) });
  }
  return reason;
}
