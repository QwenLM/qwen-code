/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Storage } from '../../config/storage.js';
import {
  createThread,
  listThreads,
  readAgentWorkspace,
  readThread,
  updateWorkspaceAgents,
  writeThread,
} from './store.js';
import {
  dispatchOnce,
  selectCandidates,
  type AgentBodyState,
  type AgentDispatchPort,
  type AgentStartResult,
} from './dispatcher.js';
import { closeRun, finishRunInTransaction } from './run-lifecycle.js';
import { withAgentStoreTransaction } from './store.js';
import { postMessage } from './thread-actions.js';
import {
  HUMAN_AUTHOR_ID,
  AGENTS_SCHEMA_VERSION,
  DEFAULT_THREAD_PRIORITY,
  THREAD_PRIORITY_ORDER,
  threadPriorityRank,
  type WorkspaceAgent,
  type Thread,
  type ThreadRun,
} from './types.js';

const PROJECT_ROOT = '/agent-dispatch-test';
const ALICE: WorkspaceAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };
const BOB: WorkspaceAgent = { id: 'ag_bob', name: 'bob', createdAt: 1 };
let workspaceId: string;

function run(overrides: Partial<ThreadRun> = {}): ThreadRun {
  return {
    id: 'rn_1',
    agentId: ALICE.id,
    status: 'queued',
    triggerMessageIds: [],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    queueSequence: 500,
    queuedAt: 1_000,
    attempts: 0,
    ...overrides,
  };
}

function threadFixture(overrides: Partial<Thread> = {}): Thread {
  return {
    schemaVersion: AGENTS_SCHEMA_VERSION,
    id: 'th_x',
    title: 'x',
    body: '',
    status: 'in_progress',
    createdAt: 1,
    createdBy: HUMAN_AUTHOR_ID,
    rootThreadId: 'th_x',
    messages: [],
    runs: [],
    nextMessageSequence: 1,
    deliveryByAgent: {},
    outbox: [],
    autoTurnsUsed: 0,
    tokensUsed: 0,
    ...overrides,
  };
}

function port(
  overrides: Partial<AgentDispatchPort> & {
    state?: AgentBodyState;
    result?: AgentStartResult;
  } = {},
): AgentDispatchPort & { start: ReturnType<typeof vi.fn> } {
  const start = vi.fn(
    async () =>
      overrides.result ?? ({ status: 'started', sessionId: 'se_1' } as const),
  );
  return {
    inspect:
      overrides.inspect ?? (async () => overrides.state ?? { kind: 'absent' }),
    start,
  } as AgentDispatchPort & { start: ReturnType<typeof vi.fn> };
}

async function seedQueued(overrides: Partial<Thread> = {}): Promise<Thread> {
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

describe('threadPriorityRank', () => {
  it('orders the priorities highest first', () => {
    expect(THREAD_PRIORITY_ORDER.map(threadPriorityRank)).toEqual([0, 1, 2, 3]);
  });

  it('ranks an absent priority as the default', () => {
    // What keeps a thread written before the field existed in its place.
    expect(threadPriorityRank()).toBe(
      threadPriorityRank(DEFAULT_THREAD_PRIORITY),
    );
  });

  it('ranks an unrecognised priority as the default rather than first', () => {
    // The store refuses a malformed value, so this is defence in depth. If one
    // ever reaches here it must not silently jump the queue.
    expect(
      threadPriorityRank('critical' as (typeof THREAD_PRIORITY_ORDER)[number]),
    ).toBe(threadPriorityRank(DEFAULT_THREAD_PRIORITY));
  });
});

describe('selectCandidates', () => {
  it('lets priority outrank age, and only priority', () => {
    // The queue is first-come by design. Priority is the one thing allowed to
    // reorder it, so an urgent thread booked later still goes first.
    const old = threadFixture({
      id: 'th_old',
      rootThreadId: 'th_old',
      runs: [run({ id: 'rn_old', queueSequence: 1 })],
    });
    const urgent = threadFixture({
      id: 'th_urgent',
      rootThreadId: 'th_urgent',
      priority: 'urgent',
      runs: [run({ id: 'rn_urgent', queueSequence: 99 })],
    });

    expect(
      selectCandidates([{ ...ALICE, maxConcurrentRuns: 5 }], [old, urgent]).map(
        (c) => c.run.id,
      ),
    ).toEqual(['rn_urgent', 'rn_old']);
  });

  it('stays first-come within one priority', () => {
    // Otherwise a steady arrival of equal-priority peers could starve a
    // thread that has been waiting.
    const late = threadFixture({
      id: 'th_late',
      rootThreadId: 'th_late',
      priority: 'high',
      runs: [run({ id: 'rn_late', queueSequence: 9 })],
    });
    const early = threadFixture({
      id: 'th_early',
      rootThreadId: 'th_early',
      priority: 'high',
      runs: [run({ id: 'rn_early', queueSequence: 2 })],
    });

    expect(
      selectCandidates([{ ...ALICE, maxConcurrentRuns: 5 }], [late, early]).map(
        (c) => c.run.id,
      ),
    ).toEqual(['rn_early', 'rn_late']);
  });

  it('ranks a thread with no priority as normal, neither sinking nor jumping', () => {
    // A thread written before the field existed must keep its place.
    const none = threadFixture({
      id: 'th_none',
      rootThreadId: 'th_none',
      runs: [run({ id: 'rn_none', queueSequence: 5 })],
    });
    const low = threadFixture({
      id: 'th_low',
      rootThreadId: 'th_low',
      priority: 'low',
      runs: [run({ id: 'rn_low', queueSequence: 1 })],
    });
    const high = threadFixture({
      id: 'th_high',
      rootThreadId: 'th_high',
      priority: 'high',
      runs: [run({ id: 'rn_high', queueSequence: 9 })],
    });

    expect(
      selectCandidates(
        [{ ...ALICE, maxConcurrentRuns: 5 }],
        [none, low, high],
      ).map((c) => c.run.id),
    ).toEqual(['rn_high', 'rn_none', 'rn_low']);
  });

  it('fills an agent only to its concurrency limit', () => {
    const first = threadFixture({
      id: 'th_1',
      rootThreadId: 'th_1',
      runs: [run({ id: 'rn_1', queueSequence: 1 })],
    });
    const second = threadFixture({
      id: 'th_2',
      rootThreadId: 'th_2',
      runs: [run({ id: 'rn_2', queueSequence: 2 })],
    });
    const third = threadFixture({
      id: 'th_3',
      rootThreadId: 'th_3',
      runs: [run({ id: 'rn_3', queueSequence: 3 })],
    });

    expect(
      selectCandidates(
        [{ ...ALICE, maxConcurrentRuns: 2 }],
        [first, second, third],
      ).map((c) => c.run.id),
    ).toEqual(['rn_1', 'rn_2']);
  });

  it('counts a live run against that limit', () => {
    // Capacity is what is left, not what the policy allows in total.
    const working = threadFixture({
      id: 'th_live',
      rootThreadId: 'th_live',
      runs: [run({ id: 'rn_live', status: 'running', queueSequence: 1 })],
    });
    const waiting = threadFixture({
      id: 'th_wait',
      rootThreadId: 'th_wait',
      runs: [run({ id: 'rn_wait', queueSequence: 2 })],
    });

    expect(
      selectCandidates(
        [{ ...ALICE, maxConcurrentRuns: 1 }],
        [working, waiting],
      ),
    ).toEqual([]);
  });

  it('offers nothing to a retired agent', () => {
    // Its name still resolves so old posts read; it just takes no work.
    const queued = threadFixture({
      id: 'th_r',
      rootThreadId: 'th_r',
      runs: [run({ id: 'rn_r', queueSequence: 1 })],
    });

    expect(selectCandidates([{ ...ALICE, retiredAt: 123 }], [queued])).toEqual(
      [],
    );
  });

  it('takes each agent oldest-first by queue sequence, not by file order', () => {
    const later = threadFixture({
      id: 'th_aaa',
      rootThreadId: 'th_aaa',
      runs: [run({ id: 'rn_late', queueSequence: 9 })],
    });
    const earlier = threadFixture({
      id: 'th_zzz',
      rootThreadId: 'th_zzz',
      runs: [run({ id: 'rn_early', queueSequence: 2 })],
    });

    expect(
      selectCandidates([ALICE], [later, earlier]).map((c) => c.run.id),
    ).toEqual(['rn_early']);
  });

  it('skips an agent that already has live work anywhere', () => {
    const busy = threadFixture({
      id: 'th_busy',
      rootThreadId: 'th_busy',
      runs: [run({ id: 'rn_live', status: 'running', queueSequence: 1 })],
    });
    const waiting = threadFixture({
      id: 'th_wait',
      rootThreadId: 'th_wait',
      runs: [run({ id: 'rn_wait', queueSequence: 2 })],
    });

    expect(selectCandidates([ALICE], [busy, waiting])).toEqual([]);
  });

  it('ignores disabled agents and finished threads', () => {
    const done = threadFixture({
      id: 'th_done',
      rootThreadId: 'th_done',
      status: 'done',
      runs: [run({ queueSequence: 1 })],
    });
    const disabled = threadFixture({
      id: 'th_off',
      rootThreadId: 'th_off',
      runs: [run({ id: 'rn_off', agentId: BOB.id, queueSequence: 2 })],
    });

    expect(
      selectCandidates([ALICE, { ...BOB, enabled: false }], [done, disabled]),
    ).toEqual([]);
  });
});

describe('dispatchOnce', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dispatch-'));
    Storage.setRuntimeBaseDir(runtimeDir);
    await updateWorkspaceAgents(PROJECT_ROOT, () => [ALICE, BOB]);
    workspaceId = (await readAgentWorkspace(PROJECT_ROOT)).workspaceId;
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('starts a queued run and commits the prompt window it actually sent', async () => {
    const thread = await seedQueued();
    await postMessage(PROJECT_ROOT, thread.id, {
      from: HUMAN_AUTHOR_ID,
      text: 'have a look',
    });
    const driver = port();

    const records = await dispatchOnce(PROJECT_ROOT, driver);

    expect(records).toEqual([
      {
        agentId: ALICE.id,
        threadId: thread.id,
        runId: 'rn_1',
        kind: 'started',
      },
    ]);
    const stored = await readThread(PROJECT_ROOT, thread.id);
    const started = stored!.runs.find((entry) => entry.id === 'rn_1')!;
    expect(started.status).toBe('running');
    expect(started.sessionId).toBe('se_1');
    expect(started.attempts).toBe(1);
    // The window the turn was sent is recorded on the run, but starting is not
    // consuming: the initial input is confirmed after the transcript flush.
    // So the run accepts the message here and the delivery watermark stays
    // put until that confirmation arrives.
    expect(started.contextThroughSequence).toBe(1);
    // The posted message, not the seeded thread's own first entry.
    expect(started.acceptedMessageIds.length).toBeGreaterThan(0);
    expect(
      stored!.deliveryByAgent[ALICE.id]?.committedThroughSequence ?? 0,
    ).toBe(0);
    // The prompt the port received is the envelope, not a bare task string.
    const prompt = driver.start.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('YOUR RUN');
    expect(prompt).toContain(thread.id);
  });

  it('posts a plain-text answer as the agent’s message and does not block', async () => {
    const thread = await seedQueued({ assigneeAgentId: ALICE.id });
    await writeThread(PROJECT_ROOT, {
      ...thread,
      runs: [
        run({
          status: 'running',
          attempts: 1,
          sessionId: 'se_1',
          progress: {
            attempt: 1,
            sequence: 3,
            receivedAt: 1,
            activityAt: 1,
            stage: 'responding',
            detail: '',
            outputText: 'The flake comes from a shared temp dir.',
          },
        }),
      ],
    });

    await dispatchOnce(PROJECT_ROOT, port({ state: { kind: 'completed' } }));
    await dispatchOnce(PROJECT_ROOT, port({ state: { kind: 'completed' } }));

    const after = (await readThread(PROJECT_ROOT, thread.id))!;
    const finished = after.runs.find((entry) => entry.id === 'rn_1')!;
    expect(finished.status).toBe('completed');
    expect(finished.closeKind).toBeUndefined();
    const replies = after.messages.filter(
      (message) => message.sourceRunId === 'rn_1',
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      authorKind: 'agent',
      from: ALICE.id,
      text: 'The flake comes from a shared temp dir.',
    });
    expect(after.status).not.toBe('blocked');
  });

  it('rebooks accepted but unread input after an explicit close', async () => {
    const thread = await seedQueued({ assigneeAgentId: ALICE.id });
    await postMessage(PROJECT_ROOT, thread.id, {
      from: HUMAN_AUTHOR_ID,
      text: 'unread correction',
    });
    const stored = (await readThread(PROJECT_ROOT, thread.id))!;
    const messageId = stored.messages[0]!.id;
    await writeThread(PROJECT_ROOT, {
      ...stored,
      runs: [
        run({
          status: 'finishing',
          closeKind: 'review',
          attempts: 1,
          triggerMessageIds: [messageId],
          acceptedMessageIds: [messageId],
        }),
      ],
    });

    await dispatchOnce(PROJECT_ROOT, port({ state: { kind: 'completed' } }));

    const after = (await readThread(PROJECT_ROOT, thread.id))!;
    const finished = after.runs.find((entry) => entry.id === 'rn_1')!;
    expect(finished.status).toBe('completed');
    expect(finished.consumedMessageIds).toEqual([]);
    expect(after.deliveryByAgent[ALICE.id]?.committedThroughSequence ?? 0).toBe(
      0,
    );
    expect(
      after.runs.some(
        (entry) =>
          entry.id !== finished.id &&
          entry.triggerMessageIds.includes(messageId),
      ),
    ).toBe(true);
  });

  it('keeps cancellation pending until the body stops and charges its usage', async () => {
    const thread = await seedQueued({
      runs: [
        run({ status: 'cancelling', attempts: 1, usageBaselineTokens: 100 }),
      ],
    });
    let state: AgentBodyState = {
      kind: 'running',
      threadId: thread.id,
      runId: 'rn_1',
      attempt: 1,
    };
    const driver = {
      ...port({ inspect: async () => state }),
      cancel: async () => false,
      totalTokens: async () => 125,
    };
    expect((await dispatchOnce(PROJECT_ROOT, driver))[0]?.kind).toBe(
      'cancelling',
    );
    expect((await readThread(PROJECT_ROOT, thread.id))!.runs[0]!.status).toBe(
      'cancelling',
    );
    state = { kind: 'completed' };
    await dispatchOnce(PROJECT_ROOT, driver);
    const stopped = (await readThread(PROJECT_ROOT, thread.id))!.runs[0]!;
    expect(stopped.status).toBe('cancelled');
    expect(stopped.usageByRound[0]?.tokens).toBe(25);
  });

  it('charges an interrupted attempt before replacing its usage baseline', async () => {
    const thread = await seedQueued({
      runs: [run({ attempts: 1, usageBaselineTokens: 100 })],
    });
    await dispatchOnce(PROJECT_ROOT, {
      ...port(),
      totalTokens: async () => 125,
    });
    const resumed = (await readThread(PROJECT_ROOT, thread.id))!.runs[0]!;
    expect(resumed.attempts).toBe(2);
    expect(resumed.usageBaselineTokens).toBe(125);
    expect(resumed.usageByRound).toEqual([
      { attempt: 1, round: 1, tokens: 25 },
    ]);
  });

  it('releases the queue slot when a launch fails for good', async () => {
    const thread = await seedQueued();

    const records = await dispatchOnce(
      PROJECT_ROOT,
      port({
        result: { status: 'agent_unavailable', error: 'definition missing' },
      }),
    );

    expect(records[0]?.kind).toBe('agent_unavailable');
    const stored = await readThread(PROJECT_ROOT, thread.id);
    expect(stored!.runs[0]?.status).toBe('failed');
    expect(stored!.runs[0]?.failureStage).toBe('definition');
    // A broken definition must not look like an agent that is merely slow.
    expect(stored!.status).toBe('blocked');
  });

  it('does not start a second body when the runtime says the agent is busy', async () => {
    const thread = await seedQueued();
    const driver = port({ state: { kind: 'running', threadId: 'th_other' } });

    const records = await dispatchOnce(PROJECT_ROOT, driver);

    expect(records[0]).toMatchObject({
      kind: 'busy_other_thread',
      detail: 'th_other',
    });
    expect(driver.start).not.toHaveBeenCalled();
    const stored = await readThread(PROJECT_ROOT, thread.id);
    expect(stored!.runs[0]?.status).toBe('queued');
  });

  it('delivers a child review to its parent exactly once across replays', async () => {
    const parent = await createThread(PROJECT_ROOT, {
      title: 'parent',
      assigneeAgentId: BOB.id,
    });
    const created = await createThread(PROJECT_ROOT, {
      title: 'child',
      parentThreadId: parent.id,
    });
    await writeThread(PROJECT_ROOT, {
      ...created,
      status: 'in_progress',
      runs: [run({ id: 'rn_child', status: 'running', attempts: 1 })],
    });
    await closeRun(PROJECT_ROOT, {
      context: {
        workspaceId,
        agentId: ALICE.id,
        runId: 'rn_child',
        threadId: created.id,
        rootThreadId: parent.id,
        attempt: 1,
      },
      request: { kind: 'review', summary: 'root cause found' },
    });
    await withAgentStoreTransaction(PROJECT_ROOT, (transaction) =>
      finishRunInTransaction(transaction, {
        threadId: created.id,
        runId: 'rn_child',
        outcome: { status: 'completed' },
      }),
    );

    await dispatchOnce(PROJECT_ROOT, port());
    await dispatchOnce(PROJECT_ROOT, port());

    const { threads } = await listThreads(PROJECT_ROOT);
    const parentAfter = threads.find((thread) => thread.id === parent.id)!;
    const reports = parentAfter.messages.filter(
      (message) => message.triggerKind === 'child_report',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.authorKind).toBe('system');
    // The report wakes the parent's assignee even though one agent could own
    // both threads: it is system-authored, so self-trigger cannot suppress it.
    expect(
      parentAfter.runs.filter((entry) => entry.agentId === BOB.id),
    ).toHaveLength(1);
    const childAfter = threads.find((thread) => thread.id === created.id)!;
    expect(
      childAfter.outbox.filter((event) => event.kind === 'parent_report')[0]
        ?.status,
    ).toBe('acknowledged');
  });
});
