/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview How a agent run ends, and what the thread does about it.
 *
 * A closing tool cannot mark its own still-executing runtime finished: the
 * model is mid-turn when it calls one. So closing is two writes. The tool
 * records *what* the run is closing as and moves it to `finishing`, which ends
 * the agent's turn; the runtime callback then records the terminal state, and
 * only there is the thread's status recomputed. Splitting it this way is what
 * makes a crash between the two recoverable — a `finishing` run with a
 * `closeKind` is a complete instruction for restart reconciliation, whereas a
 * status written optimistically before the runtime actually stopped is a lie
 * the next reader cannot detect.
 *
 * The status itself is never written by the closing run. See `thread-status.ts`
 * for why, and for the three acknowledgement rules this module drives.
 */

import {
  generateEventId,
  generateMessageId,
  withAgentStoreTransaction,
  type AgentStoreTransaction,
} from './store.js';
import {
  acknowledgeCloseObligations,
  resolveThreadStatus,
} from './thread-status.js';
import { requireAgentRunContext, type AgentRunContext } from './run-context.js';
import type { Thread, ThreadEvent, ThreadMessage } from './types.js';

/** How an agent says its run is done. `unclosed` is recorded, never chosen. */
export type RunCloseRequest =
  | { kind: 'waiting' }
  | { kind: 'blocked'; question: string }
  | { kind: 'review'; summary: string };

/** Raised when a close is refused, so a tool can tell the model what to do. */
export class RunCloseRejectedError extends Error {
  constructor(
    readonly code: 'no_live_dependency' | 'run_not_bound' | 'thread_done',
    message: string,
  ) {
    super(message);
    this.name = 'RunCloseRejectedError';
  }
}

export interface CloseRunInput {
  /** The ambient frame, never model input. */
  context: AgentRunContext;
  request: RunCloseRequest;
  now?: number;
}

export interface CloseRunResult {
  thread: Thread;
  /** Present for `blocked` and `review`, which post before they close. */
  message?: ThreadMessage;
}

export async function requireLiveRunInTransaction(
  transaction: AgentStoreTransaction,
  context: AgentRunContext,
  toolName: string,
): Promise<Thread> {
  const thread = await transaction.readThread(context.threadId);
  const run = thread?.runs.find((entry) => entry.id === context.runId);
  if (
    transaction.workspaceId !== context.workspaceId ||
    thread?.rootThreadId !== context.rootThreadId ||
    !run ||
    run.agentId !== context.agentId ||
    run.status !== 'running' ||
    run.attempts !== context.attempt
  ) {
    throw new RunCloseRejectedError(
      'run_not_bound',
      `${toolName}: run "${context.runId}" is no longer the active attempt on this thread.`,
    );
  }
  return thread;
}

export async function consumeAgentInput(
  projectRoot: string,
  deliveryId: string,
  throughSequence: number,
): Promise<void> {
  const context = requireAgentRunContext('consumeAgentInput');
  await withAgentStoreTransaction(projectRoot, async (transaction) => {
    const thread = await requireLiveRunInTransaction(
      transaction,
      context,
      'consumeAgentInput',
    );
    if (
      !thread.messages.some(
        (message) =>
          message.id === deliveryId && message.sequence === throughSequence,
      )
    ) {
      throw new Error('Agent delivery does not match its thread watermark');
    }
    const previous =
      thread.deliveryByAgent[context.agentId]?.committedThroughSequence ?? 0;
    const ids = thread.messages
      .filter(
        (message) =>
          message.sequence > previous && message.sequence <= throughSequence,
      )
      .map((message) => message.id);
    await transaction.writeThread({
      ...thread,
      deliveryByAgent: {
        ...thread.deliveryByAgent,
        [context.agentId]: {
          committedThroughSequence: Math.max(previous, throughSequence),
        },
      },
      runs: thread.runs.map((run) =>
        run.id === context.runId
          ? {
              ...run,
              acceptedMessageIds: Array.from(
                new Set([...run.acceptedMessageIds, ...ids]),
              ),
              consumedMessageIds: Array.from(
                new Set([...run.consumedMessageIds, ...ids]),
              ),
              contextThroughSequence: Math.max(
                run.contextThroughSequence ?? 0,
                throughSequence,
              ),
            }
          : run,
      ),
    });
  });
}

/**
 * A descendant of `threadId` that is not `done`.
 *
 * Walked over `parentThreadId` rather than `rootThreadId` so a sibling
 * sub-thread of the same root does not count as this thread's dependency —
 * waiting on work that was never delegated here is exactly the stranded wait
 * the status resolver has to catch.
 */
export function hasLiveDescendant(
  threads: readonly Thread[],
  threadId: string,
): boolean {
  const byParent = new Map<string, Thread[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const siblings = byParent.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    byParent.set(thread.parentThreadId, siblings);
  }
  const seen = new Set<string>([threadId]);
  const queue = [threadId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of byParent.get(current) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
      if (child.status === 'done') continue;
      const canWakeParent =
        child.status !== 'open' ||
        child.runs.some(
          (run) =>
            run.status === 'queued' ||
            run.status === 'running' ||
            run.status === 'finishing' ||
            run.status === 'cancelling',
        ) ||
        child.outbox.some(
          (event) =>
            event.kind === 'parent_report' && event.status === 'pending',
        );
      if (canWakeParent) return true;
    }
  }
  return false;
}

function appendMessage(
  thread: Thread,
  fields: {
    from: string;
    authorNameSnapshot: string;
    text: string;
    sourceRunId?: string;
    triggerKind?: string;
    authorKind: ThreadMessage['authorKind'];
  },
  now: number,
): { thread: Thread; message: ThreadMessage } {
  const message: ThreadMessage = {
    id: generateMessageId(),
    sequence: thread.nextMessageSequence,
    authorKind: fields.authorKind,
    from: fields.from,
    authorNameSnapshot: fields.authorNameSnapshot,
    ...(fields.sourceRunId ? { sourceRunId: fields.sourceRunId } : {}),
    ...(fields.triggerKind ? { triggerKind: fields.triggerKind } : {}),
    text: fields.text,
    mentions: [],
    outcomes: [],
    at: now,
  };
  return {
    thread: {
      ...thread,
      messages: [...thread.messages, message],
      nextMessageSequence: thread.nextMessageSequence + 1,
    },
    message,
  };
}

function enqueue(
  thread: Thread,
  event: Omit<ThreadEvent, 'id' | 'status' | 'attempts' | 'createdAt'>,
  now: number,
): Thread {
  const stored: ThreadEvent = {
    ...event,
    id: generateEventId(),
    status: 'pending',
    attempts: 0,
    createdAt: now,
  };
  return { ...thread, outbox: [...thread.outbox, stored] };
}

/**
 * Records a run's close and ends its turn.
 *
 * The run is verified against the caller's ambient identity before anything is
 * written: a close that names a run the agent does not own, or a run that is
 * not executing, is a wiring or replay error, not a workflow event.
 */
export async function closeRunInTransaction(
  transaction: AgentStoreTransaction,
  input: CloseRunInput,
): Promise<CloseRunResult> {
  const now = input.now ?? Date.now();
  const { context } = input;
  const thread = await requireLiveRunInTransaction(
    transaction,
    context,
    `thread_${input.request.kind}`,
  );
  if (thread.status === 'done') {
    throw new RunCloseRejectedError(
      'thread_done',
      `Thread "${context.threadId}" is done; it accepts no further work.`,
    );
  }

  const run = thread.runs.find((entry) => entry.id === context.runId)!;

  if (input.request.kind === 'waiting') {
    const otherLive = thread.runs.some(
      (entry) =>
        entry.id !== run.id &&
        (entry.status === 'queued' ||
          entry.status === 'running' ||
          entry.status === 'finishing'),
    );
    const { threads } = await transaction.listThreads();
    if (!otherLive && !hasLiveDescendant(threads, thread.id)) {
      throw new RunCloseRejectedError(
        'no_live_dependency',
        'Nothing else is running on this thread and no sub-thread is open, so waiting would strand it. Block with a question, submit for review, or keep working.',
      );
    }
  }

  const agents = await transaction.readAgents();
  const self = agents.find((agent) => agent.id === context.agentId);
  const authorName = self?.name ?? context.agentId;

  let next = thread;
  let message: ThreadMessage | undefined;
  if (input.request.kind !== 'waiting') {
    const appended = appendMessage(
      next,
      {
        authorKind: 'agent',
        from: context.agentId,
        authorNameSnapshot: authorName,
        sourceRunId: run.id,
        triggerKind: `thread_${input.request.kind}`,
        text:
          input.request.kind === 'blocked'
            ? input.request.question
            : input.request.summary,
      },
      now,
    );
    next = appended.thread;
    message = appended.message;
  }

  // Any close discharges peers' waits on this thread: whatever they were
  // waiting to see has now happened, and leaving the obligation outstanding
  // would report the thread blocked when it is merely finished.
  next = acknowledgeCloseObligations(
    next,
    next.nextMessageSequence - 1,
    (obligation) =>
      obligation.kind === 'waiting' && obligation.runId !== run.id,
  );

  next = {
    ...next,
    runs: next.runs.map((entry) =>
      entry.id === run.id
        ? {
            ...entry,
            status: 'finishing',
            closeKind: input.request.kind,
            ...(message ? { finalMessageId: message.id } : {}),
          }
        : entry,
    ),
  };

  if (input.request.kind === 'blocked') {
    next = enqueue(
      next,
      {
        kind: 'notification',
        causedByRunId: run.id,
        payload: {
          event: 'blocker_raised',
          threadId: thread.id,
          agentId: context.agentId,
          messageId: message?.id,
        },
      },
      now,
    );
  }

  return {
    thread: await transaction.writeThread(next),
    ...(message ? { message } : {}),
  };
}

export async function closeRun(
  projectRoot: string,
  input: CloseRunInput,
): Promise<CloseRunResult> {
  return withAgentStoreTransaction(projectRoot, (transaction) =>
    closeRunInTransaction(transaction, input),
  );
}

/**
 * Applies the aggregate status and emits what the new status owes.
 *
 * Called after any write that can make a thread quiescent. The parent report
 * is emitted here rather than at close time because `in_review` is a property
 * of the whole thread: an agent submitting its part while another still works
 * must not wake the parent.
 */
export async function applyAggregateStatus(
  transaction: AgentStoreTransaction,
  thread: Thread,
  now = Date.now(),
): Promise<Thread> {
  const { threads } = await transaction.listThreads();
  const resolution = resolveThreadStatus({
    thread,
    hasLiveChildDependency: hasLiveDescendant(threads, thread.id),
  });
  if (resolution.status === thread.status) return thread;

  let next: Thread = { ...thread, status: resolution.status };

  const alreadyReported = (kind: string) =>
    next.outbox.some(
      (event) => event.payload['event'] === kind && event.status === 'pending',
    );

  if (resolution.status === 'in_review') {
    if (next.parentThreadId && !alreadyReported('child_in_review')) {
      const summary = next.messages[next.messages.length - 1];
      next = enqueue(
        next,
        {
          kind: 'parent_report',
          ...(summary?.sourceRunId
            ? { causedByRunId: summary.sourceRunId }
            : {}),
          payload: {
            event: 'child_in_review',
            threadId: next.id,
            parentThreadId: next.parentThreadId,
            summaryMessageId: summary?.id,
          },
        },
        now,
      );
    }
    if (!alreadyReported('thread_in_review')) {
      next = enqueue(
        next,
        {
          kind: 'notification',
          payload: { event: 'thread_in_review', threadId: next.id },
        },
        now,
      );
    }
  }

  if (
    resolution.status === 'blocked' &&
    next.parentThreadId &&
    !resolution.outstanding.some(
      (obligation) =>
        (obligation.kind === 'failure' || obligation.kind === 'cancelled') &&
        obligation.acknowledgedAtSequence === undefined,
    ) &&
    !alreadyReported('child_blocked')
  ) {
    const cause = resolution.outstanding.find(
      (obligation) => obligation.acknowledgedAtSequence === undefined,
    );
    next = enqueue(
      next,
      {
        kind: 'parent_report',
        ...(cause ? { causedByRunId: cause.runId } : {}),
        payload: {
          event: 'child_blocked',
          threadId: next.id,
          parentThreadId: next.parentThreadId,
          reason: resolution.reason,
        },
      },
      now,
    );
  }

  if (resolution.status === 'blocked' && !alreadyReported('thread_blocked')) {
    next = enqueue(
      next,
      {
        kind: 'notification',
        payload: {
          event: 'thread_blocked',
          threadId: next.id,
          reason: resolution.reason,
        },
      },
      now,
    );
  }

  return next;
}

/**
 * Records a run's terminal state and recomputes the thread from it.
 *
 * A run that already reached a terminal state is left alone so a late
 * completion cannot overwrite a cancellation.
 */
export async function finishRunInTransaction(
  transaction: AgentStoreTransaction,
  input: {
    threadId: string;
    runId: string;
    outcome: {
      status: 'completed' | 'failed' | 'cancelled';
      attempt?: number;
      error?: string;
      failureStage?: string;
      transcriptEndOffset?: number;
    };
    now?: number;
  },
): Promise<Thread> {
  const now = input.now ?? Date.now();
  const thread = await transaction.readThread(input.threadId);
  if (!thread) throw new Error(`No thread with id "${input.threadId}".`);
  const target = thread.runs.find((run) => run.id === input.runId);
  if (
    !target ||
    (input.outcome.attempt !== undefined &&
      target.attempts !== input.outcome.attempt) ||
    (target.status !== 'queued' &&
      target.status !== 'running' &&
      target.status !== 'finishing' &&
      target.status !== 'cancelling')
  ) {
    return thread;
  }
  const terminalStatus =
    target.status === 'cancelling' ? 'cancelled' : input.outcome.status;
  const terminalError =
    terminalStatus === input.outcome.status ? input.outcome.error : undefined;
  const terminalFailureStage =
    terminalStatus === input.outcome.status
      ? input.outcome.failureStage
      : undefined;

  const closedThrough =
    target.status === 'finishing'
      ? thread.messages
          .filter((message) => target.consumedMessageIds.includes(message.id))
          .reduce<
            number | undefined
          >((highest, message) => (highest === undefined ? message.sequence : Math.max(highest, message.sequence)), undefined)
      : undefined;
  let next: Thread = {
    ...thread,
    deliveryByAgent:
      closedThrough === undefined
        ? thread.deliveryByAgent
        : {
            ...thread.deliveryByAgent,
            [target.agentId]: {
              committedThroughSequence: Math.max(
                thread.deliveryByAgent[target.agentId]
                  ?.committedThroughSequence ?? 0,
                closedThrough,
              ),
            },
          },
    runs: thread.runs.map((run) =>
      run.id === input.runId &&
      (run.status === 'queued' ||
        run.status === 'running' ||
        run.status === 'finishing' ||
        run.status === 'cancelling')
        ? {
            ...run,
            status: terminalStatus,
            endedAt: now,
            // A run that stopped without calling a closing tool is recorded as
            // `unclosed`, never as an implicit success.
            closeKind:
              run.closeKind ??
              (terminalStatus === 'completed' ? 'unclosed' : undefined),
            ...(terminalError ? { error: terminalError } : {}),
            ...(terminalFailureStage
              ? { failureStage: terminalFailureStage }
              : {}),
            ...(input.outcome.transcriptEndOffset !== undefined
              ? { transcriptEndOffset: input.outcome.transcriptEndOffset }
              : {}),
          }
        : run,
    ),
  };

  if (
    terminalStatus === 'failed' &&
    !next.messages.some(
      (message) =>
        message.sourceRunId === target.id &&
        message.triggerKind === 'run_failure',
    )
  ) {
    const message: ThreadMessage = {
      id: generateMessageId(),
      sequence: next.nextMessageSequence,
      authorKind: 'system',
      from: 'system',
      authorNameSnapshot: 'system',
      sourceRunId: target.id,
      triggerKind: 'run_failure',
      text: `Run ${target.id} failed${terminalFailureStage ? ` during ${terminalFailureStage}` : ''}: ${terminalError ?? 'unknown error'}`,
      mentions: [],
      outcomes: [],
      at: now,
    };
    next = {
      ...next,
      messages: [...next.messages, message],
      nextMessageSequence: next.nextMessageSequence + 1,
    };
  }

  const hasLiveRun = next.runs.some(
    (run) =>
      run.status === 'queued' ||
      run.status === 'running' ||
      run.status === 'finishing' ||
      run.status === 'cancelling',
  );
  const parentEvent =
    terminalStatus === 'failed'
      ? 'child_failed'
      : terminalStatus === 'cancelled'
        ? 'child_cancelled'
        : undefined;
  if (
    next.parentThreadId &&
    !hasLiveRun &&
    parentEvent &&
    !next.outbox.some(
      (event) =>
        event.payload['event'] === parentEvent && event.status === 'pending',
    )
  ) {
    next = enqueue(
      next,
      {
        kind: 'parent_report',
        causedByRunId: target.id,
        payload: {
          event: parentEvent,
          threadId: next.id,
          parentThreadId: next.parentThreadId,
          ...(terminalError ? { error: terminalError } : {}),
        },
      },
      now,
    );
  }

  if (
    terminalStatus === 'failed' &&
    target.attempts >= 2 &&
    !next.outbox.some(
      (event) =>
        event.payload['event'] === 'run_failed_after_retry' &&
        event.causedByRunId === target.id,
    )
  ) {
    next = enqueue(
      next,
      {
        kind: 'notification',
        causedByRunId: target.id,
        payload: {
          event: 'run_failed_after_retry',
          threadId: next.id,
          agentId: target.agentId,
          error: terminalError,
        },
      },
      now,
    );
  }

  next = await applyAggregateStatus(transaction, next, now);
  return transaction.writeThread(next);
}
