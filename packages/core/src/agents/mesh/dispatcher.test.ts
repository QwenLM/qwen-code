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
  readThread,
  updateMeshAgents,
  writeThread,
} from './mesh-store.js';
import {
  dispatchOnce,
  selectCandidates,
  type MeshBodyState,
  type MeshDispatchPort,
  type MeshStartResult,
} from './dispatcher.js';
import { closeRun, finishRunInTransaction } from './run-lifecycle.js';
import { withMeshStoreTransaction } from './mesh-store.js';
import { postMessage } from './thread-actions.js';
import {
  HUMAN_AUTHOR_ID,
  MESH_SCHEMA_VERSION,
  type MeshAgent,
  type Thread,
  type ThreadRun,
} from './types.js';

const PROJECT_ROOT = '/mesh-dispatch-test';
const ALICE: MeshAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };
const BOB: MeshAgent = { id: 'ag_bob', name: 'bob', createdAt: 1 };

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
    schemaVersion: MESH_SCHEMA_VERSION,
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
  overrides: Partial<MeshDispatchPort> & {
    state?: MeshBodyState;
    result?: MeshStartResult;
  } = {},
): MeshDispatchPort & { start: ReturnType<typeof vi.fn> } {
  const start = vi.fn(
    async () =>
      overrides.result ?? ({ status: 'started', sessionId: 'se_1' } as const),
  );
  return {
    inspect:
      overrides.inspect ?? (async () => overrides.state ?? { kind: 'absent' }),
    start,
    ...(overrides.definitionVersion
      ? { definitionVersion: overrides.definitionVersion }
      : {}),
  } as MeshDispatchPort & { start: ReturnType<typeof vi.fn> };
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

describe('selectCandidates', () => {
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
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-dispatch-'));
    Storage.setRuntimeBaseDir(runtimeDir);
    await updateMeshAgents(PROJECT_ROOT, () => [ALICE, BOB]);
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
    // The initial prompt is consumed the moment the turn starts, so the
    // watermark moves with it.
    expect(started.contextThroughSequence).toBe(1);
    expect(stored!.deliveryByAgent[ALICE.id]?.committedThroughSequence).toBe(1);
    // The prompt the port received is the envelope, not a bare task string.
    const prompt = driver.start.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('MESH RUN');
    expect(prompt).toContain(thread.id);
  });

  it('chooses the runtime entry point from the body state', async () => {
    await seedQueued();
    for (const [state, action] of [
      [{ kind: 'absent' }, 'launch'],
      [{ kind: 'paused' }, 'resume'],
      [{ kind: 'completed' }, 'continue_completed'],
    ] as const) {
      const driver = port({ state });
      await withMeshStoreTransaction(PROJECT_ROOT, async (transaction) => {
        const { threads } = await transaction.listThreads();
        for (const thread of threads) {
          await transaction.writeThread({
            ...thread,
            runs: thread.runs.map((entry) => ({
              ...entry,
              status: 'queued',
              attempts: 0,
            })),
          });
        }
      });
      await dispatchOnce(PROJECT_ROOT, driver);
      expect(driver.start.mock.calls[0]![0].action).toBe(action);
    }
  });

  it('leaves the run queued and its attempt unspent on capacity backpressure', async () => {
    const thread = await seedQueued();

    const records = await dispatchOnce(
      PROJECT_ROOT,
      port({ result: { status: 'capacity_wait' } }),
    );

    expect(records[0]?.kind).toBe('capacity_wait');
    const stored = await readThread(PROJECT_ROOT, thread.id);
    expect(stored!.runs[0]?.status).toBe('queued');
    expect(stored!.runs[0]?.attempts).toBe(0);
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
      threadId: created.id,
      runId: 'rn_child',
      agentId: ALICE.id,
      request: { kind: 'review', summary: 'root cause found' },
    });
    await withMeshStoreTransaction(PROJECT_ROOT, (transaction) =>
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
    // The notification nobody consumes yet stays pending rather than being
    // silently acknowledged.
    expect(
      childAfter.outbox.some(
        (event) => event.kind === 'notification' && event.status === 'pending',
      ),
    ).toBe(true);
  });
});
