/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview How a mesh run ends, and what the thread does about it.
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
  withMeshStoreTransaction,
  type MeshStoreTransaction,
} from './mesh-store.js';
import {
  acknowledgeCloseObligations,
  resolveThreadStatus,
} from './thread-status.js';
import type { MeshRunContext } from './run-context.js';
import type { Thread, ThreadEvent, ThreadMessage } from './types.js';

/** How an agent says its run is done. `unclosed` is recorded, never chosen. */
export type RunCloseRequest =
  | { kind: 'waiting' }
  | { kind: 'blocked'; question: string }
  | { kind: 'review'; summary: string };

/** Raised when a close is refused, so a tool can tell the model what to do. */
export class MeshCloseRejectedError extends Error {
  constructor(
    readonly code: 'no_live_dependency' | 'run_not_bound' | 'thread_done',
    message: string,
  ) {
    super(message);
    this.name = 'MeshCloseRejectedError';
  }
}

export interface CloseRunInput {
  /** The ambient frame, never model input. */
  context: MeshRunContext;
  request: RunCloseRequest;
  now?: number;
}

export interface CloseRunResult {
  thread: Thread;
  /** Present for `blocked` and `review`, which post before they close. */
  message?: ThreadMessage;
}

export async function requireLiveRunInTransaction(
  transaction: MeshStoreTransaction,
  context: MeshRunContext,
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
    throw new MeshCloseRejectedError(
      'run_not_bound',
      `${toolName}: run "${context.runId}" is no longer the active attempt on this thread.`,
    );
  }
  return thread;
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
      if (child.status !== 'done') return true;
      queue.push(child.id);
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
  transaction: MeshStoreTransaction,
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
    throw new MeshCloseRejectedError(
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
      throw new MeshCloseRejectedError(
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
  return withMeshStoreTransaction(projectRoot, (transaction) =>
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
  transaction: MeshStoreTransaction,
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
      next = enqueue(
        next,
        {
          kind: 'parent_report',
          payload: {
            event: 'child_in_review',
            threadId: next.id,
            parentThreadId: next.parentThreadId,
            summaryMessageId: next.messages[next.messages.length - 1]?.id,
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
  transaction: MeshStoreTransaction,
  input: {
    threadId: string;
    runId: string;
    outcome: {
      status: 'completed' | 'failed' | 'cancelled';
      error?: string;
      failureStage?: string;
    };
    now?: number;
  },
): Promise<Thread> {
  const now = input.now ?? Date.now();
  const thread = await transaction.readThread(input.threadId);
  if (!thread) throw new Error(`No thread with id "${input.threadId}".`);

  let next: Thread = {
    ...thread,
    runs: thread.runs.map((run) =>
      run.id === input.runId &&
      (run.status === 'queued' ||
        run.status === 'running' ||
        run.status === 'finishing' ||
        run.status === 'cancelling')
        ? {
            ...run,
            status: input.outcome.status,
            endedAt: now,
            // A run that stopped without calling a closing tool is recorded as
            // `unclosed`, never as an implicit success.
            closeKind:
              run.closeKind ??
              (input.outcome.status === 'completed' ? 'unclosed' : undefined),
            ...(input.outcome.error ? { error: input.outcome.error } : {}),
            ...(input.outcome.failureStage
              ? { failureStage: input.outcome.failureStage }
              : {}),
          }
        : run,
    ),
  };

  next = await applyAggregateStatus(transaction, next, now);
  return transaction.writeThread(next);
}
