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
import { issueA2AGrant } from './a2a-grants.js';
import {
  a2aCancelTask,
  a2aGetTask,
  a2aListTasks,
  a2aSendMessage,
} from './a2a-server.js';
import {
  createThread,
  getThreadPath,
  readAgentWorkspace,
  readThread,
  updateWorkspaceAgents,
  withAgentStoreTransaction,
} from './store.js';
import { claimRun, postMessage } from './thread-actions.js';
import { closeRun, finishRunInTransaction } from './run-lifecycle.js';

const PROJECT_ROOT = '/a2a-server-test';

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-server-test-'));
  Storage.setRuntimeBaseDir(runtimeDir);
  await updateWorkspaceAgents(PROJECT_ROOT, () => [
    { id: 'ag_lead', name: 'lead', createdAt: 1 },
  ]);
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

describe('A2A tasks', () => {
  it("returns the agent's latest post as the answer", async () => {
    // Without it a caller could watch the state change and never read the
    // result it asked for.
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const caller = { callerId: 'share_1', secret };
    const sent = await a2aSendMessage(PROJECT_ROOT, caller, {
      agentId: 'ag_lead',
      messageId: 'msg-1',
      title: '',
      body: 'Why is the build slow?',
    });
    if (!sent.ok) throw new Error('send refused');
    expect(sent.value.answer).toBeUndefined();

    await postMessage(PROJECT_ROOT, sent.value.id, {
      from: 'ag_lead',
      authorKind: 'agent',
      text: 'The cache key misses on every run.',
    });

    const polled = await a2aGetTask(PROJECT_ROOT, caller, sent.value.id);
    expect(polled).toMatchObject({
      ok: true,
      value: { answer: 'The cache key misses on every run.' },
    });
  });

  it('answers a malformed task id as not found', async () => {
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const caller = { callerId: 'share_1', secret };

    await expect(
      a2aGetTask(PROJECT_ROOT, caller, '../workspace'),
    ).resolves.toEqual({ ok: false, kind: 'not_found' });
    await expect(
      a2aCancelTask(PROJECT_ROOT, caller, '../workspace'),
    ).resolves.toEqual({ ok: false, kind: 'not_found' });
  });

  it('cancels queued external work without leaving a live run', async () => {
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const caller = { callerId: 'share_1', secret };
    const sent = await a2aSendMessage(PROJECT_ROOT, caller, {
      agentId: 'ag_lead',
      messageId: 'msg-1',
      title: 'Cancel me',
      body: 'Wait for cancellation.',
    });
    if (!sent.ok) throw new Error('send refused');

    await expect(
      a2aCancelTask(PROJECT_ROOT, caller, sent.value.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        task: { status: { state: 'TASK_STATE_CANCELED' } },
        runsStillLive: 0,
      },
    });
    await expect(
      readThread(PROJECT_ROOT, sent.value.id),
    ).resolves.toMatchObject({
      status: 'cancelled',
      runs: [{ status: 'cancelled' }],
    });
  });

  it('keeps a retired agent’s tasks readable and cancelable', async () => {
    // Retiring stops new work; it must not hide or strand work a caller with
    // a valid grant already submitted.
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const caller = { callerId: 'share_1', secret };
    const sent = await a2aSendMessage(PROJECT_ROOT, caller, {
      agentId: 'ag_lead',
      messageId: 'msg-1',
      title: 'Explain',
      body: 'Why is the build slow?',
    });
    if (!sent.ok) throw new Error('send refused');
    // Stamped directly: the retire action itself refuses while this task's
    // run is still queued, but a disabled or retired agent reaches here too.
    await updateWorkspaceAgents(PROJECT_ROOT, (agents) =>
      agents.map((agent) => ({ ...agent, retiredAt: 1 })),
    );

    await expect(
      a2aGetTask(PROJECT_ROOT, caller, sent.value.id),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      a2aCancelTask(PROJECT_ROOT, caller, sent.value.id),
    ).resolves.toMatchObject({ ok: true });
    // New work is still refused.
    await expect(
      a2aSendMessage(PROJECT_ROOT, caller, {
        agentId: 'ag_lead',
        messageId: 'msg-2',
        title: 'More',
        body: 'And the tests?',
      }),
    ).resolves.toEqual({ ok: false, kind: 'refused' });
  });

  it('lets a share follow the agent’s later configuration', async () => {
    // The chosen contract: a grant is checked against the agent's live
    // definition, so changing the agent after sharing applies to the share.
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    await updateWorkspaceAgents(PROJECT_ROOT, (agents) =>
      agents.map((agent) => ({ ...agent, instructions: 'Changed later.' })),
    );

    const caller = { callerId: 'share_1', secret };
    await expect(
      a2aSendMessage(PROJECT_ROOT, caller, {
        agentId: 'ag_lead',
        messageId: 'msg-1',
        title: 'Explain',
        body: 'Why is the build slow?',
      }),
    ).resolves.toMatchObject({ ok: true });
  });
});

async function startTask() {
  const { secret } = await issueA2AGrant(PROJECT_ROOT, {
    callerId: 'share_1',
    agentId: 'ag_lead',
  });
  const caller = { callerId: 'share_1', secret };
  const request = {
    agentId: 'ag_lead',
    messageId: 'msg-1',
    title: 'Inspect',
    body: 'Inspect the cache.',
  };
  const sent = await a2aSendMessage(PROJECT_ROOT, caller, request);
  if (!sent.ok) throw new Error('send refused');
  const stored = (await readThread(PROJECT_ROOT, sent.value.id))!;
  await claimRun(PROJECT_ROOT, {
    threadId: stored.id,
    runId: stored.runs[0]!.id,
  });
  return { caller, request, threadId: stored.id, runId: stored.runs[0]!.id };
}

async function answerAndClose(
  threadId: string,
  runId: string,
  summary: string,
) {
  const thread = (await readThread(PROJECT_ROOT, threadId))!;
  const run = thread.runs.find((entry) => entry.id === runId)!;
  await closeRun(PROJECT_ROOT, {
    context: {
      workspaceId: (await readAgentWorkspace(PROJECT_ROOT)).workspaceId,
      rootThreadId: thread.rootThreadId,
      threadId,
      agentId: run.agentId,
      runId,
      attempt: run.attempts,
    },
    request: { kind: 'review', summary },
  });
}

it.each(['completed', 'failed'] as const)(
  'preserves a published %s result across local follow-ups and cancellation',
  async (status) => {
    const { caller, request, threadId, runId } = await startTask();
    await answerAndClose(threadId, runId, 'Original answer.');
    await withAgentStoreTransaction(PROJECT_ROOT, (transaction) =>
      finishRunInTransaction(transaction, {
        threadId,
        runId,
        outcome: { status },
      }),
    );
    const first = await a2aGetTask(PROJECT_ROOT, caller, threadId);
    if (!first.ok) throw new Error('get refused');
    expect(first.value.status.state).toBe(
      status === 'completed' ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED',
    );
    expect(
      (await readThread(PROJECT_ROOT, threadId))?.externalIntake?.result?.state,
    ).toBe(first.value.status.state);

    await postMessage(PROJECT_ROOT, threadId, {
      from: 'user',
      authorKind: 'human',
      text: '@lead Please continue.',
    });
    const followup = (await readThread(PROJECT_ROOT, threadId))!;
    expect(followup.runs.some((run) => run.status === 'queued')).toBe(true);
    await postMessage(PROJECT_ROOT, threadId, {
      from: 'ag_lead',
      authorKind: 'agent',
      text: 'Later local answer.',
    });

    for (const value of [
      await a2aGetTask(PROJECT_ROOT, caller, threadId),
      await a2aSendMessage(PROJECT_ROOT, caller, request),
    ]) {
      expect(value).toMatchObject({
        ok: true,
        value: { status: first.value.status, answer: 'Original answer.' },
      });
    }
    expect(await a2aListTasks(PROJECT_ROOT, caller, 'ag_lead')).toMatchObject({
      ok: true,
      value: [{ status: first.value.status, answer: 'Original answer.' }],
    });
    expect(await a2aCancelTask(PROJECT_ROOT, caller, threadId)).toMatchObject({
      ok: true,
      value: { task: { status: first.value.status } },
    });
    expect(
      (await readThread(PROJECT_ROOT, threadId))?.runs.some(
        (run) => run.status === 'queued',
      ),
    ).toBe(true);
  },
);

it('reports an empty, unclosed turn as failed', async () => {
  const { caller, threadId, runId } = await startTask();
  await withAgentStoreTransaction(PROJECT_ROOT, (transaction) =>
    finishRunInTransaction(transaction, {
      threadId,
      runId,
      outcome: { status: 'completed' },
    }),
  );
  expect((await readThread(PROJECT_ROOT, threadId))?.runs[0]?.closeKind).toBe(
    'unclosed',
  );
  expect(await a2aGetTask(PROJECT_ROOT, caller, threadId)).toMatchObject({
    ok: true,
    value: { status: { state: 'TASK_STATE_FAILED' } },
  });
});

it('keeps the root working until its child run and parent report finish', async () => {
  const { caller, threadId, runId } = await startTask();
  const child = await createThread(PROJECT_ROOT, {
    title: 'Subtask',
    parentThreadId: threadId,
    assigneeAgentId: 'ag_lead',
  });
  await postMessage(PROJECT_ROOT, child.id, {
    from: 'user',
    authorKind: 'human',
    text: '@lead Inspect the dependency.',
  });
  await answerAndClose(threadId, runId, 'Work delegated.');
  await withAgentStoreTransaction(PROJECT_ROOT, (transaction) =>
    finishRunInTransaction(transaction, {
      threadId,
      runId,
      outcome: { status: 'completed' },
    }),
  );
  expect(await a2aGetTask(PROJECT_ROOT, caller, threadId)).toMatchObject({
    ok: true,
    value: { status: { state: 'TASK_STATE_WORKING' } },
  });
  const childRun = (await readThread(PROJECT_ROOT, child.id))!.runs[0]!;
  await claimRun(PROJECT_ROOT, { threadId: child.id, runId: childRun.id });
  await answerAndClose(child.id, childRun.id, 'Dependency result.');
  await withAgentStoreTransaction(PROJECT_ROOT, (transaction) =>
    finishRunInTransaction(transaction, {
      threadId: child.id,
      runId: childRun.id,
      outcome: { status: 'completed' },
    }),
  );
  expect(
    (await readThread(PROJECT_ROOT, child.id))?.outbox.some(
      (event) => event.status === 'pending',
    ),
  ).toBe(true);
  expect(await a2aGetTask(PROJECT_ROOT, caller, threadId)).toMatchObject({
    ok: true,
    value: { status: { state: 'TASK_STATE_WORKING' } },
  });
  await withAgentStoreTransaction(PROJECT_ROOT, async (transaction) => {
    const stored = (await transaction.readThread(child.id))!;
    await transaction.writeThread({
      ...stored,
      outbox: stored.outbox.map((event) => ({
        ...event,
        status: 'acknowledged',
      })),
    });
  });
  expect(await a2aGetTask(PROJECT_ROOT, caller, threadId)).toMatchObject({
    ok: true,
    value: {
      status: { state: 'TASK_STATE_COMPLETED' },
      answer: 'Work delegated.',
    },
  });
});

it('ignores a retired notification event when completing a task tree', async () => {
  const { caller, threadId, runId } = await startTask();
  const child = await createThread(PROJECT_ROOT, {
    title: 'Legacy child',
    parentThreadId: threadId,
  });
  await fs.writeFile(
    getThreadPath(PROJECT_ROOT, child.id),
    JSON.stringify({
      ...child,
      outbox: [
        {
          id: 'ev_legacy',
          kind: 'notification',
          status: 'pending',
          payload: {},
          attempts: 0,
          createdAt: 1,
        },
      ],
    }),
  );
  await answerAndClose(threadId, runId, 'Result ready.');
  await withAgentStoreTransaction(PROJECT_ROOT, (transaction) =>
    finishRunInTransaction(transaction, {
      threadId,
      runId,
      outcome: { status: 'completed' },
    }),
  );
  expect(await a2aGetTask(PROJECT_ROOT, caller, threadId)).toMatchObject({
    ok: true,
    value: {
      status: { state: 'TASK_STATE_COMPLETED' },
      answer: 'Result ready.',
    },
  });
});
