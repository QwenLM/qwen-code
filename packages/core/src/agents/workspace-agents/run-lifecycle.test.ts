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
import type { AgentRunContext } from './run-context.js';

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
    expect(result.thread.outbox).toHaveLength(1);
    expect(result.thread.outbox[0]?.payload['event']).toBe('blocker_raised');
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

  it('allows a wait once a sub-thread is open, and not for a mere sibling', async () => {
    const parent = await seed();
    const child = await createThread(PROJECT_ROOT, {
      title: 'read the code',
      parentThreadId: parent.id,
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
    expect(hasLiveDescendant([{ ...parent }, { ...child }], parent.id)).toBe(
      true,
    );
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

    const finished = await finish(thread.id, 'rn_bob', { status: 'completed' });
    expect(finished.status).toBe('in_review');
  });

  it('records a clean exit with no closing tool as unclosed and blocks', async () => {
    const thread = await seed();

    const finished = await finish(thread.id, 'rn_alice', {
      status: 'completed',
    });

    expect(finished.runs[0]?.closeKind).toBe('unclosed');
    expect(finished.status).toBe('blocked');
    expect(
      finished.outbox.some(
        (event) => event.payload['event'] === 'thread_blocked',
      ),
    ).toBe(true);
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
    expect(
      posted.thread.runs.find((entry) => entry.id === 'rn_alice')
        ?.closeAcknowledgedAtSequence,
    ).toBe(1);
  });

  it('blocks a quiescent thread whose post books nothing at all', async () => {
    const created = await createThread(PROJECT_ROOT, { title: 'unassigned' });

    const posted = await postMessage(PROJECT_ROOT, created.id, {
      from: HUMAN_AUTHOR_ID,
      text: 'anyone?',
    });

    expect(posted.dispatched).toHaveLength(0);
    expect(posted.thread.status).toBe('blocked');
    expect(
      posted.thread.outbox.some(
        (event) => event.payload['event'] === 'thread_blocked',
      ),
    ).toBe(true);
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
