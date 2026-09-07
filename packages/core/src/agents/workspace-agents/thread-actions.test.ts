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
  deleteThread,
  readThread,
  writeThread,
} from './store.js';
import {
  countQueuedElsewhere,
  postMessage,
  upsertRunUsage,
} from './thread-actions.js';
import {
  HUMAN_AUTHOR_ID,
  AGENTS_SCHEMA_VERSION,
  type WorkspaceAgent,
  type Thread,
  type ThreadRun,
} from './types.js';

const PROJECT_ROOT = '/agent-test-project';
const ALICE: WorkspaceAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };
const BOB: WorkspaceAgent = { id: 'ag_bob', name: 'bob', createdAt: 1 };

function run(overrides: Partial<ThreadRun> = {}): ThreadRun {
  return {
    id: 'rn_1',
    agentId: ALICE.id,
    status: 'queued',
    triggerMessageIds: ['ms_0'],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    queueSequence: 1,
    attempts: 0,
    queuedAt: 2,
    ...overrides,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    schemaVersion: AGENTS_SCHEMA_VERSION,
    id: 'th_root',
    title: 'Investigate',
    body: '',
    status: 'open',
    createdAt: 1,
    createdBy: HUMAN_AUTHOR_ID,
    rootThreadId: 'th_root',
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

describe('agent thread actions', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
    Storage.setRuntimeBaseDir(runtimeDir);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('round-trips the blocked status', async () => {
    await writeThread(PROJECT_ROOT, thread({ status: 'blocked' }));
    await expect(readThread(PROJECT_ROOT, 'th_root')).resolves.toMatchObject({
      status: 'blocked',
    });
  });

  it('rejects negative budget counters', async () => {
    await expect(
      writeThread(PROJECT_ROOT, thread({ autoTurnsUsed: -1 })),
    ).rejects.toThrow(/Refusing to write malformed thread record/);
  });

  it('retains durable usage, idempotency keys, and active references past history bounds', async () => {
    const messages = Array.from({ length: 502 }, (_, index) => ({
      id: `ms_${index}`,
      sequence: index + 1,
      authorKind: 'human' as const,
      from: HUMAN_AUTHOR_ID,
      authorNameSnapshot: HUMAN_AUTHOR_ID,
      text: `message ${index}`,
      mentions: [],
      outcomes: [],
      at: index,
      ...(index === 0 ? { originEventId: 'ev_old' } : {}),
    }));
    const runs = [
      run({
        id: 'rn_usage',
        status: 'completed',
        triggerMessageIds: [],
        usageByRound: [{ attempt: 1, round: 1, tokens: 7 }],
      }),
      run({ id: 'rn_active', queueSequence: 2, triggerMessageIds: ['ms_1'] }),
      ...Array.from({ length: 200 }, (_, index) =>
        run({
          id: `rn_${index + 3}`,
          status: 'completed',
          queueSequence: index + 3,
          triggerMessageIds: [`ms_${index + 2}`],
        }),
      ),
    ];
    await writeThread(
      PROJECT_ROOT,
      thread({ messages, runs, nextMessageSequence: 503 }),
    );

    const stored = await readThread(PROJECT_ROOT, 'th_root');
    expect(stored?.messages[0]?.id).toBe('ms_0');
    expect(stored?.messages[1]?.id).toBe('ms_1');
    expect(stored?.runs[0]?.id).toBe('rn_usage');
    expect(stored?.runs[1]?.id).toBe('rn_active');
    expect(stored?.messages).toHaveLength(502);
    expect(stored?.runs).toHaveLength(202);
    expect(stored?.tokensUsed).toBe(7);
  });

  it('reports an unknown mention without waking the assignee', async () => {
    await writeThread(PROJECT_ROOT, thread({ assigneeAgentId: ALICE.id }));

    const result = await postMessage(
      PROJECT_ROOT,
      'th_root',
      { from: HUMAN_AUTHOR_ID, text: '@alicce please check' },
      { agents: [ALICE] },
    );

    expect(result.outcomes).toEqual([
      {
        agentName: 'alicce',
        decision: { kind: 'skip', reason: 'agent_unknown' },
      },
    ]);
    expect(result.dispatched).toEqual([]);
    await expect(readThread(PROJECT_ROOT, 'th_root')).resolves.toMatchObject({
      messages: [
        {
          sequence: 1,
          outcomes: [
            {
              kind: 'skip',
              reason: 'agent_unknown',
              targetAgentName: 'alicce',
            },
          ],
        },
      ],
    });
  });

  it('reports a post with no mention or assignee', async () => {
    await writeThread(PROJECT_ROOT, thread());

    const result = await postMessage(PROJECT_ROOT, 'th_root', {
      from: HUMAN_AUTHOR_ID,
      text: 'anyone?',
    });

    expect(result.outcomes).toEqual([
      { decision: { kind: 'skip', reason: 'no_target' } },
    ]);
  });

  it('resets only the thread where a person replies', async () => {
    await writeThread(PROJECT_ROOT, thread({ autoTurnsUsed: 9 }));
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_child',
        rootThreadId: 'th_root',
        parentThreadId: 'th_root',
        status: 'blocked',
        assigneeAgentId: ALICE.id,
        autoTurnsUsed: 4,
      }),
    );

    const result = await postMessage(
      PROJECT_ROOT,
      'th_child',
      { from: HUMAN_AUTHOR_ID, text: 'here is the answer' },
      { agents: [ALICE] },
    );

    expect(result.thread).toMatchObject({
      status: 'in_progress',
      autoTurnsUsed: 0,
    });
    await expect(readThread(PROJECT_ROOT, 'th_root')).resolves.toMatchObject({
      autoTurnsUsed: 9,
    });
  });

  it('charges agent delivery into a running run against the turn gate', async () => {
    await writeThread(
      PROJECT_ROOT,
      thread({ runs: [run({ status: 'running' })] }),
    );

    const first = await postMessage(
      PROJECT_ROOT,
      'th_root',
      { from: BOB.id, text: '@alice first' },
      { agents: [ALICE, BOB], limits: { autoTurns: 1 } },
    );
    expect(first.outcomes[0]?.decision).toMatchObject({
      kind: 'coalesce',
      into: 'running',
    });
    expect(first.thread.autoTurnsUsed).toBe(1);

    const second = await postMessage(
      PROJECT_ROOT,
      'th_root',
      { from: BOB.id, text: '@alice again' },
      { agents: [ALICE, BOB], limits: { autoTurns: 1 } },
    );
    expect(second.outcomes[0]?.decision).toEqual({
      kind: 'skip',
      reason: 'turn_budget_exhausted',
    });
  });

  it('counts only pending runs against the queue limit', () => {
    expect(
      countQueuedElsewhere(
        [thread({ runs: [run(), run({ id: 'rn_2', status: 'running' })] })],
        ALICE.id,
      ),
    ).toBe(1);
  });

  it('assigns monotonic message sequences', async () => {
    await writeThread(PROJECT_ROOT, thread());

    await postMessage(PROJECT_ROOT, 'th_root', {
      from: HUMAN_AUTHOR_ID,
      text: 'first',
    });
    const second = await postMessage(PROJECT_ROOT, 'th_root', {
      from: HUMAN_AUTHOR_ID,
      text: 'second',
    });

    expect(second.thread.messages.map((message) => message.sequence)).toEqual([
      1, 2,
    ]);
    expect(second.thread.nextMessageSequence).toBe(3);
  });

  it('assigns queue sequences across threads from the workspace counter', async () => {
    await writeThread(PROJECT_ROOT, thread({ assigneeAgentId: ALICE.id }));
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_second',
        rootThreadId: 'th_second',
        assigneeAgentId: ALICE.id,
      }),
    );

    const first = await postMessage(
      PROJECT_ROOT,
      'th_root',
      { from: HUMAN_AUTHOR_ID, text: 'first' },
      { agents: [ALICE] },
    );
    const second = await postMessage(
      PROJECT_ROOT,
      'th_second',
      { from: HUMAN_AUTHOR_ID, text: 'second' },
      { agents: [ALICE] },
    );

    expect(first.dispatched[0]?.queueSequence).toBe(1);
    expect(second.dispatched[0]?.queueSequence).toBe(2);
  });

  it('computes queue_full from threads on disk', async () => {
    const alice = { ...ALICE, queueLimit: 1 };
    await writeThread(
      PROJECT_ROOT,
      thread({ runs: [run({ agentId: ALICE.id })] }),
    );
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_second',
        rootThreadId: 'th_second',
        assigneeAgentId: ALICE.id,
      }),
    );

    const result = await postMessage(
      PROJECT_ROOT,
      'th_second',
      { from: HUMAN_AUTHOR_ID, text: 'next' },
      { agents: [alice] },
    );

    expect(result.outcomes[0]?.decision).toEqual({
      kind: 'skip',
      reason: 'queue_full',
    });
    expect(result.dispatched).toEqual([]);
  });

  it('upserts run usage by attempt and round and refreshes the cache', async () => {
    await writeThread(
      PROJECT_ROOT,
      thread({ runs: [run({ status: 'completed' })] }),
    );

    await upsertRunUsage(PROJECT_ROOT, 'th_root', 'rn_1', {
      attempt: 1,
      round: 1,
      tokens: 10,
    });
    const updated = await upsertRunUsage(PROJECT_ROOT, 'th_root', 'rn_1', {
      attempt: 1,
      round: 1,
      tokens: 12,
    });

    expect(updated.runs[0]?.usageByRound).toEqual([
      { attempt: 1, round: 1, tokens: 12 },
    ]);
    expect(updated.tokensUsed).toBe(12);
  });

  it('fails closed when a child root is missing', async () => {
    await writeThread(
      PROJECT_ROOT,
      thread({ id: 'th_child', rootThreadId: 'th_missing' }),
    );

    await expect(
      postMessage(
        PROJECT_ROOT,
        'th_child',
        { from: BOB.id, text: '@alice check' },
        { agents: [ALICE, BOB] },
      ),
    ).rejects.toThrow(/No valid root thread/);
  });

  it('fails closed when a child points to a non-root thread', async () => {
    await writeThread(
      PROJECT_ROOT,
      thread({ id: 'th_not_root', rootThreadId: 'th_actual_root' }),
    );
    await writeThread(
      PROJECT_ROOT,
      thread({ id: 'th_child', rootThreadId: 'th_not_root' }),
    );

    await expect(
      postMessage(
        PROJECT_ROOT,
        'th_child',
        { from: BOB.id, text: '@alice check' },
        { agents: [ALICE, BOB] },
      ),
    ).rejects.toThrow(/No valid root thread/);
  });

  it('inherits the parent turn count without minting a fresh allowance', async () => {
    await writeThread(PROJECT_ROOT, thread({ autoTurnsUsed: 7 }));

    const child = await createThread(PROJECT_ROOT, {
      title: 'Child',
      parentThreadId: 'th_root',
    });

    expect(child).toMatchObject({
      rootThreadId: 'th_root',
      autoTurnsUsed: 7,
    });
  });

  it('refuses to delete a root that still owns sub-threads', async () => {
    await writeThread(PROJECT_ROOT, thread());
    await writeThread(
      PROJECT_ROOT,
      thread({
        id: 'th_child',
        rootThreadId: 'th_root',
        parentThreadId: 'th_root',
      }),
    );

    await expect(deleteThread(PROJECT_ROOT, 'th_root')).rejects.toThrow(
      /with sub-threads/,
    );
  });
});
