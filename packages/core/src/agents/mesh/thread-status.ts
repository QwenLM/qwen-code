/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Thread status as an aggregate over every run, not last-writer-wins.
 *
 * Several agents work one thread. If each could stamp the thread's status when
 * its own run ended, the last one to finish would decide: an agent reviewing
 * its part would hide another agent still working, and a blocker raised by one
 * would be erased by another's clean exit. So no run writes the status. Each
 * run instead leaves a durable *close obligation*, and the status is derived
 * from the obligations that are still outstanding.
 *
 * Three rules here exist because a review of an earlier revision found each one
 * missing, and each failure was a thread stuck in a state nobody could clear:
 *
 * - A same-thread wait is discharged by any later close or human post. Without
 *   it, `A waits for B; B reviews without @-ing A` left A's wait looking
 *   orphaned, and blocked-class outranks review, so the thread reported
 *   `blocked` when it was ready for a person.
 * - Any later successful booking discharges an earlier failure or unclosed
 *   return, not only human feedback. Without it one launch failure pinned the
 *   thread to `blocked` forever, even after another agent did the work.
 * - An admission that books nothing and leaves no runnable target yields
 *   `blocked`. Without it a post whose assignee was disabled, or that named
 *   nobody at all, left the thread sitting in `in_progress` with no live run
 *   and no explanation — the silent path this design refuses to have.
 */

import type {
  MessageOutcome,
  Thread,
  ThreadMessage,
  ThreadRun,
  ThreadStatus,
} from './types.js';

/** Run states that keep a thread `in_progress` regardless of any obligation. */
export const LIVE_RUN_STATUSES = new Set([
  'queued',
  'running',
  'finishing',
  'cancelling',
]);

/**
 * What a finished run left behind for the thread to answer.
 *
 * `failure` is derived from the run status rather than a close kind: a run that
 * died never reached a closing tool, so it has no `closeKind` to read.
 */
export type CloseObligationKind =
  | 'blocked'
  | 'failure'
  | 'unclosed'
  | 'waiting'
  | 'review';

export interface CloseObligation {
  runId: string;
  agentId: string;
  kind: CloseObligationKind;
  /** Message sequence that discharged it, or `undefined` while outstanding. */
  acknowledgedAtSequence?: number;
}

/** Blocked-class obligations outrank a review; a waiting one is conditional. */
const BLOCKING_KINDS = new Set<CloseObligationKind>([
  'blocked',
  'failure',
  'unclosed',
]);

function obligationFor(run: ThreadRun): CloseObligation | undefined {
  if (LIVE_RUN_STATUSES.has(run.status)) return undefined;
  const base = { runId: run.id, agentId: run.agentId };
  const acknowledged =
    run.closeAcknowledgedAtSequence === undefined
      ? {}
      : { acknowledgedAtSequence: run.closeAcknowledgedAtSequence };
  // A failed run outranks whatever it managed to record first: the failure is
  // the thing a person has to see.
  if (run.status === 'failed') {
    return { ...base, kind: 'failure', ...acknowledged };
  }
  if (run.closeKind === undefined) return undefined;
  const kind: CloseObligationKind =
    run.closeKind === 'waiting'
      ? 'waiting'
      : run.closeKind === 'blocked'
        ? 'blocked'
        : run.closeKind === 'review'
          ? 'review'
          : 'unclosed';
  return { ...base, kind, ...acknowledged };
}

/** Every close obligation on the thread, acknowledged or not. */
export function listCloseObligations(thread: Thread): CloseObligation[] {
  return thread.runs
    .map(obligationFor)
    .filter((entry): entry is CloseObligation => entry !== undefined);
}

/** The obligations still awaiting an answer. */
export function outstandingCloseObligations(thread: Thread): CloseObligation[] {
  return listCloseObligations(thread).filter(
    (obligation) => obligation.acknowledgedAtSequence === undefined,
  );
}

function booksWork(outcome: MessageOutcome): boolean {
  return outcome.kind === 'dispatch' || outcome.kind === 'coalesce';
}

/**
 * True when this post was admitted and produced no work anywhere.
 *
 * A post with no outcomes at all is not an admission — a system audit append on
 * a `done` thread, say — and says nothing about whether the thread is stuck.
 */
export function admissionBookedNothing(message: ThreadMessage): boolean {
  return message.outcomes.length > 0 && !message.outcomes.some(booksWork);
}

export interface ThreadStatusInput {
  thread: Thread;
  /**
   * Whether a descendant thread is still live, so a `waiting` close can be
   * woken by a parent dependency event later. The caller resolves this because
   * reading sibling files is I/O and this function stays pure.
   */
  hasLiveChildDependency: boolean;
}

export interface ThreadStatusResolution {
  status: ThreadStatus;
  /** Why, in a form a UI can show beside the status. */
  reason: string;
  outstanding: CloseObligation[];
}

/**
 * Derives the thread's status from its runs and its most recent admission.
 *
 * `done` is sticky: only a person sets it, and a late post appends for audit
 * without reopening. Everything else is recomputed from scratch on every write,
 * so no ordering of concurrent run completions can leave a stale status behind.
 */
export function resolveThreadStatus(
  input: ThreadStatusInput,
): ThreadStatusResolution {
  const { thread } = input;
  const outstanding = outstandingCloseObligations(thread);

  if (thread.status === 'done') {
    return {
      status: 'done',
      reason: 'a person marked this thread done',
      outstanding,
    };
  }

  const live = thread.runs.filter((run) => LIVE_RUN_STATUSES.has(run.status));
  if (live.length > 0) {
    return {
      status: 'in_progress',
      reason: `${live.length} run(s) still queued, running, finishing or cancelling`,
      outstanding,
    };
  }

  // Quiescent from here: nothing will change this thread until someone posts.
  const blocking = outstanding.filter((obligation) =>
    BLOCKING_KINDS.has(obligation.kind),
  );
  if (blocking.length > 0) {
    const first = blocking[0]!;
    return {
      status: 'blocked',
      reason:
        first.kind === 'blocked'
          ? `run ${first.runId} asked a question and is waiting for a person`
          : first.kind === 'failure'
            ? `run ${first.runId} failed and no successor is runnable`
            : `run ${first.runId} ended without a hand-off`,
      outstanding,
    };
  }

  // A wait is only meaningful while something can still wake it. With every run
  // finished and no live child, the delegation it was waiting on is gone.
  const strandedWait = outstanding.find(
    (obligation) => obligation.kind === 'waiting',
  );
  if (strandedWait && !input.hasLiveChildDependency) {
    return {
      status: 'blocked',
      reason: `run ${strandedWait.runId} is waiting on work that no longer exists`,
      outstanding,
    };
  }

  const lastMessage = thread.messages[thread.messages.length - 1];
  if (lastMessage && admissionBookedNothing(lastMessage)) {
    return {
      status: 'blocked',
      reason: `the last post booked no work (${lastMessage.outcomes
        .map((outcome) => outcome.reason ?? outcome.kind)
        .join(', ')})`,
      outstanding,
    };
  }

  const review = outstanding.find((obligation) => obligation.kind === 'review');
  if (review) {
    return {
      status: 'in_review',
      reason: `run ${review.runId} submitted a summary for review`,
      outstanding,
    };
  }

  if (strandedWait) {
    return {
      status: 'in_progress',
      reason: `run ${strandedWait.runId} is waiting on a live sub-thread`,
      outstanding,
    };
  }

  return {
    status: thread.status === 'open' ? 'open' : 'in_progress',
    reason: 'no outstanding close obligation',
    outstanding,
  };
}

/**
 * Discharges outstanding close obligations at a message sequence.
 *
 * `select` narrows which ones. Two callers use it today: the close path passes
 * `waiting` so a later close on the same thread releases a peer's wait, and the
 * admission path passes nothing so any successful booking releases failures and
 * unclosed returns. Whether a human reply should discharge a blocker raised by
 * an agent it did not address is §9.11 and deliberately unresolved — until it
 * is, the default discharges every outstanding obligation, and narrowing it is
 * a change to this predicate rather than to the callers.
 */
export function acknowledgeCloseObligations(
  thread: Thread,
  atSequence: number,
  select: (obligation: CloseObligation) => boolean = () => true,
): Thread {
  const outstanding = new Map(
    outstandingCloseObligations(thread)
      .filter(select)
      .map((obligation) => [obligation.runId, obligation]),
  );
  if (outstanding.size === 0) return thread;
  return {
    ...thread,
    runs: thread.runs.map((run) =>
      outstanding.has(run.id)
        ? { ...run, closeAcknowledgedAtSequence: atSequence }
        : run,
    ),
  };
}
