/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Accepting work from an authenticated external caller.
 *
 * The protocol half of this is frozen in `a2a-contract.ts`; this is the store
 * half, and it exists separately because the two things it has to get right are
 * both about persistence rather than about A2A:
 *
 *   - a retry must not produce a second piece of work, and
 *   - one caller must not be able to read or steer another's.
 *
 * Neither needs a network to be wrong, so neither waits for one to be checked.
 */

import { createHash } from 'node:crypto';

import { externalRequestKey } from './a2a-contract.js';
import {
  createThreadInTransaction,
  withAgentStoreTransaction,
} from './store.js';
import { isThreadTerminal } from './types.js';
import { postMessageInTransaction } from './thread-actions.js';
import { HUMAN_AUTHOR_ID } from './types.js';
import type { ExternalIntake, Thread } from './types.js';

/**
 * Raised when a caller reuses a key for different content.
 *
 * Its own class because the transport has to answer this one differently from
 * every other failure: it is not "your request failed", it is "you already used
 * this id for something else", and a caller that cannot tell those apart will
 * retry forever.
 */
export class ExternalIntakeConflictError extends Error {
  constructor(
    readonly key: string,
    readonly existingThreadId: string,
  ) {
    super(
      `Request key already accepted for different content (thread ${existingThreadId})`,
    );
    this.name = 'ExternalIntakeConflictError';
  }
}

export interface ExternalSubmission {
  /** Stable id of the authenticated caller, from the transport's auth. */
  callerId: string;
  /** The local agent this work is aimed at. */
  targetAgentId: string;
  /** `Message.messageId` as the caller minted it. */
  messageId: string;
  title: string;
  body: string;
  acceptanceCriteria?: string;
}

export interface ExternalAcceptance {
  /** `accepted` on first sight; `duplicate` when the same submission returns. */
  outcome: 'accepted' | 'duplicate';
  thread: Thread;
}

/**
 * The digest that decides whether a repeated key is the same request.
 *
 * Length-prefixed for the same reason the key itself is: these are strings from
 * outside, and joining them with a separator would let a caller move content
 * across field boundaries without changing the digest.
 */
function contentHashOf(submission: ExternalSubmission): string {
  const parts = [
    submission.title,
    submission.body,
    submission.acceptanceCriteria ?? '',
  ];
  const hash = createHash('sha256');
  for (const part of parts) hash.update(`${part.length}:${part}`);
  return hash.digest('hex');
}

function findByKey(threads: readonly Thread[], key: string): Thread | undefined {
  return threads.find((thread) => thread.externalIntake?.key === key);
}

/**
 * Accept one external submission, or recognise it as a retry.
 *
 * The lookup, the intake record and the thread are one transaction. Split
 * across two, a retry arriving between them would be looked up, not found, and
 * accepted a second time — which is exactly the failure the key exists to
 * prevent, so writing it afterwards would be writing it too late.
 */
export async function acceptExternalSubmission(
  projectRoot: string,
  submission: ExternalSubmission,
  now = Date.now(),
): Promise<ExternalAcceptance> {
  const key = externalRequestKey({
    callerId: submission.callerId,
    targetAgentId: submission.targetAgentId,
    messageId: submission.messageId,
  });
  const contentHash = contentHashOf(submission);

  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const { threads } = await transaction.listThreads();
    const existing = findByKey(threads, key);
    if (existing) {
      if (existing.externalIntake?.contentHash !== contentHash) {
        throw new ExternalIntakeConflictError(key, existing.id);
      }
      // Deliberately does not post the message again. A retry means the caller
      // did not hear the answer, not that it wants the work done twice.
      return { outcome: 'duplicate' as const, thread: existing };
    }

    const intake: ExternalIntake = {
      key,
      callerId: submission.callerId,
      targetAgentId: submission.targetAgentId,
      messageId: submission.messageId,
      contentHash,
      receivedAt: now,
    };
    const created = await createThreadInTransaction(transaction, {
      title: submission.title,
      body: submission.body,
      createdBy: HUMAN_AUTHOR_ID,
      assigneeAgentId: submission.targetAgentId,
      externalIntake: intake,
      ...(submission.acceptanceCriteria
        ? { acceptanceCriteria: submission.acceptanceCriteria }
        : {}),
    });
    // The message is what books a run, so it lands in the same write as the
    // intake record: a thread accepted but never dispatched would report
    // `SUBMITTED` forever with nothing behind it.
    const posted = await postMessageInTransaction(transaction, created.id, {
      from: HUMAN_AUTHOR_ID,
      text: submission.body,
    });
    return { outcome: 'accepted' as const, thread: posted.thread };
  });
}

/**
 * The threads one caller may see.
 *
 * Scoped by `callerId`, not merely filtered for convenience: B serves several
 * authorized clients over one queue, and a second client must not be able to
 * read — or cancel, or add to — the first client's work. Locally raised threads
 * have no intake record and so belong to no external caller; they are not
 * listed to any of them.
 */
export async function listExternalThreadsForCaller(
  projectRoot: string,
  callerId: string,
): Promise<Thread[]> {
  if (!callerId) return [];
  const { threads } = await withAgentStoreTransaction(projectRoot, (t) =>
    t.listThreads(),
  );
  return threads.filter(
    (thread) => thread.externalIntake?.callerId === callerId,
  );
}

/**
 * Withdraw one of this caller's tasks.
 *
 * Two writes are deliberately NOT collapsed into one here: this marks the
 * thread terminal, which stops anything further being dispatched for it, but
 * it does not claim the body has stopped. A run already executing keeps
 * running until the dispatcher's own cancellation path reaches it, and the
 * plan is explicit that a cancellation receipt and an actual stop are
 * separately reported — a caller told "cancelled" while the work continues is
 * the failure worth avoiding, so the receipt says what is true: no further
 * work will be started.
 *
 * Returns `undefined` for a thread that is not this caller's, on the same
 * reasoning as {@link getExternalThreadForCaller}: distinguishing "no such
 * task" from "not yours" leaks another client's task ids.
 */
export async function cancelExternalThreadForCaller(
  projectRoot: string,
  callerId: string,
  threadId: string,
): Promise<{ thread: Thread; runsStillLive: number } | undefined> {
  if (!callerId || !threadId) return undefined;
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(threadId);
    if (!thread || thread.externalIntake?.callerId !== callerId) {
      return undefined;
    }
    const runsStillLive = thread.runs.filter(
      (run) =>
        run.status === 'running' ||
        run.status === 'finishing' ||
        run.status === 'cancelling',
    ).length;
    // Already terminal: report it rather than overwriting a `done` with a
    // `cancelled`, which would rewrite how the work actually ended.
    if (isThreadTerminal(thread.status)) {
      return { thread, runsStillLive };
    }
    // Retires the runs the same way the "mark done" path does: a queued run
    // that no selection will ever pick is still shown as pending work on a
    // task its caller withdrew, and a live one has to be asked to stop rather
    // than quietly relabelled. `cancelling` is a request, not a report — which
    // is why `runsStillLive` is returned separately, so the receipt can say
    // "no further work will start" without claiming the body has stopped.
    const now = Date.now();
    const next = await transaction.writeThread({
      ...thread,
      status: 'cancelled' as const,
      runs: thread.runs.map((run) =>
        run.status === 'queued'
          ? { ...run, status: 'cancelled' as const, endedAt: now }
          : run.status === 'running' || run.status === 'finishing'
            ? { ...run, status: 'cancelling' as const }
            : run,
      ),
    });
    return { thread: next, runsStillLive };
  });
}

/**
 * One thread, if it is this caller's.
 *
 * Returns `undefined` for "no such thread" and for "not yours" alike. The
 * transport must not distinguish them either: a caller able to tell a thread
 * exists but belongs to someone else can enumerate another client's work.
 */
export async function getExternalThreadForCaller(
  projectRoot: string,
  callerId: string,
  threadId: string,
): Promise<Thread | undefined> {
  if (!callerId || !threadId) return undefined;
  const thread = await withAgentStoreTransaction(projectRoot, (t) =>
    t.readThread(threadId),
  );
  if (!thread) return undefined;
  return thread.externalIntake?.callerId === callerId ? thread : undefined;
}
