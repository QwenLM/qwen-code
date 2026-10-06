/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Storage } from '../../config/storage.js';
import {
  createThread,
  readAgentWorkspace,
  readThread,
  updateWorkspaceAgents,
  writeThread,
} from './store.js';
import {
  closeRun,
  consumeAgentInput,
  finishRunInTransaction,
  hasLiveDescendant,
  RunCloseRejectedError,
} from './run-lifecycle.js';
import { withAgentStoreTransaction } from './store.js';
import { postMessage } from './thread-actions.js';
import {
  HUMAN_AUTHOR_ID,
  type WorkspaceAgent,
  type Thread,
  type ThreadRun,
} from './types.js';
import { runWithAgentRunContext, type AgentRunContext } from './run-context.js';

const PROJECT_ROOT = '/agent-lifecycle-test';
const ALICE: WorkspaceAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };
const BOB: WorkspaceAgent = { id: 'ag_bob', name: 'bob', createdAt: 1 };
let workspaceId: string;

function run(overrides: Partial<ThreadRun> = {}): ThreadRun {
  return {
    id: 'rn_alice',
    agentId: ALICE.id,
    status: 'running',
    triggerMessageIds: [],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    // Well clear of the workspace counter: these fixtures are hand-written and
    // must not collide with a sequence the store allocates during the test.
    queueSequence: 100,
    queuedAt: 1_000,
    attempts: 1,
    ...overrides,
  };
}

function context(
  threadId: string,
  overrides: Partial<AgentRunContext> = {},
): AgentRunContext {
  return {
    workspaceId,
    agentId: ALICE.id,
    runId: 'rn_alice',
    threadId,
    rootThreadId: threadId,
    attempt: 1,
    ...overrides,
  };
}

async function seed(overrides: Partial<Thread> = {}): Promise<Thread> {
  const created = await createThread(PROJECT_ROOT, { title: 'Investigate' });
  const thread: Thread = {
    ...created,
    status: 'in_progress',
    runs: [run()],
    ...overrides,
  };
  await writeThread(PROJECT_ROOT, thread);
  return thread;
}

function finish(
  threadId: string,
  runId: string,
  outcome: Parameters<typeof finishRunInTransaction>[1]['outcome'],
) {
  return withAgentStoreTransaction(PROJECT_ROOT, (transaction) =>
    finishRunInTransaction(transaction, { threadId, runId, outcome }),
  );
}

describe('agent run lifecycle', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lifecycle-'));
    Storage.setRuntimeBaseDir(runtimeDir);
    await updateWorkspaceAgents(PROJECT_ROOT, () => [ALICE, BOB]);
    workspaceId = (await readAgentWorkspace(PROJECT_ROOT)).workspaceId;
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('records a drained window only for the active ambient attempt', async () => {
    const thread = await seed({ assigneeAgentId: ALICE.id });
    await postMessage(PROJECT_ROOT, thread.id, {
      from: HUMAN_AUTHOR_ID,
      text: 'correction',
    });
    const message = (await readThread(PROJECT_ROOT, thread.id))!.messages[0]!;
    await expect(
      runWithAgentRunContext(context(thread.id, { attempt: 2 }), () =>
        consumeAgentInput(PROJECT_ROOT, message.id, message.sequence),
      ),
    ).rejects.toThrow(/no longer the active attempt/);
    await runWithAgentRunContext(context(thread.id), () =>
      consumeAgentInput(PROJECT_ROOT, message.id, message.sequence),
    );
    const stored = (await readThread(PROJECT_ROOT, thread.id))!;
    expect(stored.runs[0]!.consumedMessageIds).toContain(message.id);
    expect(stored.deliveryByAgent[ALICE.id]?.committedThroughSequence).toBe(
      message.sequence,
    );
  });

  it('posts the question, records the close, and ends the turn without finishing the run', async () => {
    const thread = await seed();

    const result = await closeRun(PROJECT_ROOT, {
      context: context(thread.id),
      request: { kind: 'blocked', question: 'which retry path?' },
    });

    expect(result.message?.text).toBe('which retry path?');
    expect(result.message?.authorKind).toBe('agent');
    expect(result.message?.sourceRunId).toBe('rn_alice');
    expect(result.message?.authorNameSnapshot).toBe('alice');
    // The runtime is still executing, so the run may not be marked terminal.
    expect(result.thread.runs[0]?.status).toBe('finishing');
    expect(result.thread.runs[0]?.closeKind).toBe('blocked');
    expect(result.thread.runs[0]?.finalMessageId).toBe(result.message?.id);
    expect(result.thread.status).toBe('in_progress');
  });

  it('refuses a wait that nothing could ever wake', async () => {
    const thread = await seed();

    await expect(
      closeRun(PROJECT_ROOT, {
        context: context(thread.id),
        request: { kind: 'waiting' },
      }),
    ).rejects.toThrow(RunCloseRejectedError);
  });

  it('refuses a wait whose only live peer is already finishing', async () => {
    // A finishing run already executed its close tool — its discharge of
    // waiters happened at that moment, so a wait admitted against it could
    // never be discharged and would strand the thread as blocked.
    const thread = await seed({
      runs: [run(), run({ id: 'rn_bob', agentId: BOB.id, queueSequence: 101 })],
    });
    await closeRun(PROJECT_ROOT, {
      context: context(thread.id, { agentId: BOB.id, runId: 'rn_bob' }),
      request: { kind: 'review', summary: 'bob is done' },
    });

    await expect(
      closeRun(PROJECT_ROOT, {
        context: context(thread.id),
        request: { kind: 'waiting' },
      }),
    ).rejects.toThrow(RunCloseRejectedError);
  });

  it('allows a wait once a sub-thread is open, and not for a mere sibling', async () => {
    const parent = await seed();
    // Assigned and posted to, not merely created: an `open` child with no run
    // and no pending parent report cannot wake anyone, so waiting on it would
    // strand the thread — which is what `no_live_dependency` refuses. The
    // dependency has to be something that can actually come back.
    const child = await createThread(PROJECT_ROOT, {
      title: 'read the code',
      parentThreadId: parent.id,
      assigneeAgentId: BOB.id,
    });
    await postMessage(PROJECT_ROOT, child.id, {
      from: HUMAN_AUTHOR_ID,
      text: 'over to you',
    });

    const waited = await closeRun(PROJECT_ROOT, {
      context: context(parent.id),
      request: { kind: 'waiting' },
    });
    expect(waited.thread.runs[0]?.closeKind).toBe('waiting');

    // A sibling under the same root is not this thread's dependency.
    const sibling = await createThread(PROJECT_ROOT, {
      title: 'unrelated',
      parentThreadId: parent.id,
    });
    const threads = [
      { ...parent },
      { ...child, status: 'done' as const },
      { ...sibling, status: 'done' as const },
    ];
    expect(hasLiveDescendant(threads, parent.id)).toBe(false);
    // The live child is the one with a run on it; the bare `open` sibling is
    // not a dependency even though it is not done.
    const liveChild = (await readThread(PROJECT_ROOT, child.id))!;
    expect(hasLiveDescendant([{ ...parent }, liveChild], parent.id)).toBe(true);
    expect(hasLiveDescendant([{ ...parent }, { ...sibling }], parent.id)).toBe(
      false,
    );

    // A cancelled child with no report owed can never wake the parent: it
    // must not count as live, or a parent waiting on it strands forever.
    const cancelledChild: Thread = {
      ...child,
      status: 'cancelled',
      runs: [],
      outbox: [],
    };
    expect(hasLiveDescendant([{ ...parent }, cancelledChild], parent.id)).toBe(
      false,
    );
    // But a terminal child that still owes a report can still wake it.
    const cancelledWithReport: Thread = {
      ...cancelledChild,
      outbox: [
        {
          id: 'ev1',
          kind: 'parent_report',
          payload: {},
          status: 'pending',
          attempts: 0,
          createdAt: Date.now(),
        },
      ],
    };
    expect(
      hasLiveDescendant([{ ...parent }, cancelledWithReport], parent.id),
    ).toBe(true);
  });

  it('refuses a close for a run the caller does not own', async () => {
    const thread = await seed();

    await expect(
      closeRun(PROJECT_ROOT, {
        context: context(thread.id, { agentId: BOB.id }),
        request: { kind: 'review', summary: 'done' },
      }),
    ).rejects.toThrow(/no longer the active attempt/);
  });

  it('reports blocked to the parent when a failed run was never reported itself', async () => {
    // A failure while a sibling is live queues no child_failed — the sibling's
    // completion is expected to carry the news — but a plain completion emits
    // nothing, so without the aggregate fallback the parent never hears it.
    const parent = await seed();
    const child = await createThread(PROJECT_ROOT, {
      title: 'child',
      parentThreadId: parent.id,
    });
    await writeThread(PROJECT_ROOT, {
      ...child,
      status: 'in_progress',
      runs: [
        run({ queueSequence: 100 }),
        run({ id: 'rn_bob', agentId: BOB.id, queueSequence: 101 }),
      ],
    });

    // Alice fails while Bob is still running: no report yet.
    let stored = await finish(child.id, 'rn_alice', { status: 'failed' });
    expect(stored.outbox).toEqual([]);

    // Bob completes: a plain completion emits nothing either…
    stored = await finish(child.id, 'rn_bob', { status: 'completed' });
    expect(
      stored.outbox.some((event) => event.payload['event'] === 'child_failed'),
    ).toBe(false);
    // …but the aggregate block must not stay silent: the failure was never
    // reported, so the block itself is the news the parent gets.
    expect(stored.status).toBe('blocked');
    expect(
      stored.outbox.some(
        (event) =>
          event.payload['event'] === 'child_blocked' &&
          event.causedByRunId === 'rn_alice',
      ),
    ).toBe(true);
  });

  it('does not stack child_cancelled on top of a person-done report', async () => {
    // Marking a thread done already queued child_done; settling the runs its
    // cancellation started must not append a contradicting child_cancelled.
    const parent = await seed();
    const child = await createThread(PROJECT_ROOT, {
      title: 'child',
      parentThreadId: parent.id,
    });
    await writeThread(PROJECT_ROOT, {
      ...child,
      status: 'done',
      runs: [run({ status: 'cancelling' })],
      outbox: [
        {
          id: 'ev_done',
          kind: 'parent_report',
          payload: {
            event: 'child_done',
            threadId: child.id,
            parentThreadId: parent.id,
          },
          status: 'pending',
          attempts: 0,
          createdAt: 1,
        },
      ],
    });

    const stored = await finish(child.id, 'rn_alice', { status: 'cancelled' });
    expect(
      stored.outbox.filter((event) => event.kind === 'parent_report'),
    ).toHaveLength(1);
    expect(stored.outbox[0]?.payload['event']).toBe('child_done');
  });

  it('discharges a peer wait so a review is not reported as blocked', async () => {
    const thread = await seed({
      runs: [
        run({ id: 'rn_wait', status: 'completed', closeKind: 'waiting' }),
        run({
          id: 'rn_bob',
          agentId: BOB.id,
          status: 'running',
          queueSequence: 101,
        }),
      ],
    });

    const closed = await closeRun(PROJECT_ROOT, {
      context: context(thread.id, { agentId: BOB.id, runId: 'rn_bob' }),
      request: { kind: 'review', summary: 'the flake is the retry path' },
    });
    expect(
      closed.thread.runs.find((entry) => entry.id === 'rn_wait')
        ?.closeAcknowledgedAtSequence,
    ).toBe(1);

    // The named property: the discharged wait does not leave the thread
    // reading as blocked. It does not settle to `in_review` here any more,
    // because the close @-mentions the waiter and books it a run — the thread
    // is genuinely in progress again, with someone to answer. What that woken
    // run then records is a separate subject, covered by the `unclosed` case
    // below.
    const finished = await finish(thread.id, 'rn_bob', { status: 'completed' });
    expect(finished.status).not.toBe('blocked');
    expect(finished.status).toBe('in_progress');
    expect(finished.runs.some((entry) => entry.status === 'queued')).toBe(true);
  });

  it('discharges a waiter that is still finishing when the close wakes it', async () => {
    // Alice closed `waiting` but her run has not landed yet. Bob's close
    // @-mentions her; the same close must discharge her wait, or it outlives
    // the answer and reads as blocked once she is woken and replies.
    const thread = await seed({
      runs: [
        run({ id: 'rn_wait', status: 'finishing', closeKind: 'waiting' }),
        run({
          id: 'rn_bob',
          agentId: BOB.id,
          status: 'running',
          queueSequence: 101,
        }),
      ],
    });

    const closed = await closeRun(PROJECT_ROOT, {
      context: context(thread.id, { agentId: BOB.id, runId: 'rn_bob' }),
      request: { kind: 'review', summary: 'the flake is the retry path' },
    });
    const wait = closed.thread.runs.find((entry) => entry.id === 'rn_wait');
    expect(wait?.closeAcknowledgedAtSequence).toBe(closed.message?.sequence);
  });

  it('does not count a quiet child as a dependency a wait can rest on', async () => {
    // A child left `in_progress` by a plain answer has nothing running and
    // owes nothing: it can never wake the parent, so waiting on it would
    // strand the parent in `in_progress`.
    const parent = await seed();
    const created = await createThread(PROJECT_ROOT, {
      title: 'answered',
      parentThreadId: parent.id,
    });
    const quietChild: Thread = {
      ...created,
      status: 'in_progress',
      runs: [run({ id: 'rn_child', agentId: BOB.id, status: 'completed' })],
    };
    await writeThread(PROJECT_ROOT, quietChild);

    expect(hasLiveDescendant([{ ...parent }, quietChild], parent.id)).toBe(
      false,
    );
    await expect(
      closeRun(PROJECT_ROOT, {
        context: context(parent.id),
        request: { kind: 'waiting' },
      }),
    ).rejects.toThrow(RunCloseRejectedError);
  });

  it('records a clean exit with no closing tool as unclosed and blocks', async () => {
    const thread = await seed();

    const finished = await finish(thread.id, 'rn_alice', {
      status: 'completed',
    });

    expect(finished.runs[0]?.closeKind).toBe('unclosed');
    expect(finished.status).toBe('blocked');
  });

  it('reports a child in review to its parent exactly once', async () => {
    const parent = await createThread(PROJECT_ROOT, { title: 'parent' });
    const created = await createThread(PROJECT_ROOT, {
      title: 'child',
      parentThreadId: parent.id,
    });
    await writeThread(PROJECT_ROOT, {
      ...created,
      status: 'in_progress',
      runs: [run()],
    });

    await closeRun(PROJECT_ROOT, {
      context: context(created.id, { rootThreadId: parent.id }),
      request: { kind: 'review', summary: 'root cause found' },
    });
    const finished = await finish(created.id, 'rn_alice', {
      status: 'completed',
    });

    expect(finished.status).toBe('in_review');
    const reports = finished.outbox.filter(
      (event) => event.kind === 'parent_report',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.payload['parentThreadId']).toBe(parent.id);

    // Re-running the terminal write must not enqueue a second report.
    const again = await finish(created.id, 'rn_alice', { status: 'completed' });
    expect(again.outbox.filter((e) => e.kind === 'parent_report')).toHaveLength(
      1,
    );
  });

  it('carries a typed failure stage onto the run and blocks the thread', async () => {
    const thread = await seed();

    const finished = await finish(thread.id, 'rn_alice', {
      status: 'failed',
      error: 'definition missing',
      failureStage: 'launch',
    });

    expect(finished.runs[0]?.failureStage).toBe('launch');
    expect(finished.status).toBe('blocked');
  });

  it('drops a Host result receipt when settlement overrode the outcome', async () => {
    // A cancel leaves the lease in place, so a Host that finished before it
    // learned of the cancellation still settles here. The reported status is
    // overridden, so nothing was applied for that result, and a receipt would
    // answer an exact re-post of it with `alreadyApplied`.
    const hostResultReceipt = {
      attempt: 1,
      leaseId: 'lease',
      digest: 'a'.repeat(64),
    };
    const cancelling = await seed({ runs: [run({ status: 'cancelling' })] });

    const cancelled = await finish(cancelling.id, 'rn_alice', {
      status: 'completed',
      attempt: 1,
      hostResultReceipt,
    });

    expect(cancelled.runs[0]?.status).toBe('cancelled');
    expect(cancelled.runs[0]?.hostResultReceipt).toBeUndefined();

    // The receipt records that this outcome's answer was applied, so a run
    // settled to the status its Host reported keeps it.
    const live = await seed();

    const applied = await finish(live.id, 'rn_alice', {
      status: 'completed',
      attempt: 1,
      hostResultReceipt,
    });

    expect(applied.runs[0]?.status).toBe('completed');
    expect(applied.runs[0]?.hostResultReceipt).toEqual(hostResultReceipt);
  });

  it('refuses any close on a thread a person already marked done', async () => {
    const thread = await seed({ status: 'done' });

    await expect(
      closeRun(PROJECT_ROOT, {
        context: context(thread.id),
        request: { kind: 'review', summary: 'late' },
      }),
    ).rejects.toThrow(/is done/);
  });

  it('clears an obsolete failure when a later post books real work', async () => {
    const thread = await seed({ assigneeAgentId: ALICE.id });
    const failed = await finish(thread.id, 'rn_alice', {
      status: 'failed',
      error: 'launch failed',
    });
    expect(failed.status).toBe('blocked');

    const posted = await postMessage(PROJECT_ROOT, thread.id, {
      from: HUMAN_AUTHOR_ID,
      text: 'try again please',
    });

    expect(posted.dispatched).toHaveLength(1);
    expect(posted.thread.status).toBe('in_progress');
    // Tied to the post that cleared it rather than to a literal: a failed run
    // also records a `run_failure` system message, so pinning the number
    // pinned how many messages precede this one.
    expect(
      posted.thread.runs.find((entry) => entry.id === 'rn_alice')
        ?.closeAcknowledgedAtSequence,
    ).toBe(posted.message.sequence);
  });

  it('blocks a quiescent thread whose post books nothing at all', async () => {
    const created = await createThread(PROJECT_ROOT, { title: 'unassigned' });

    const posted = await postMessage(PROJECT_ROOT, created.id, {
      from: HUMAN_AUTHOR_ID,
      text: 'anyone?',
    });

    expect(posted.dispatched).toHaveLength(0);
    expect(posted.thread.status).toBe('blocked');
  });

  it('leaves a thread in_progress while another run is still live', async () => {
    const thread = await seed({
      runs: [
        run(),
        run({
          id: 'rn_bob',
          agentId: BOB.id,
          status: 'queued',
          queueSequence: 101,
        }),
      ],
    });

    await closeRun(PROJECT_ROOT, {
      context: context(thread.id),
      request: { kind: 'review', summary: 'my part is done' },
    });
    const finished = await finish(thread.id, 'rn_alice', {
      status: 'completed',
    });

    expect(finished.status).toBe('in_progress');
    expect(await readThread(PROJECT_ROOT, thread.id)).toMatchObject({
      status: 'in_progress',
    });
  });
});
