/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../../config/storage.js';
import type {
  AgentMessageRecordPayload,
  SessionAgentRun,
  SessionAgentRunStatus,
} from '../session-agents/contract.js';
import { updateSessionAgents } from '../session-agents/binding-store.js';
import { QWEN_A2A_EXTENSION_URI } from './a2a-contract.js';
import { issueA2AGrant, revokeA2AGrant } from './a2a-grants.js';
import {
  A2ASessionError,
  a2aCancelTask,
  a2aGetTask,
  a2aListTasks,
  a2aSendMessage,
  type A2ACaller,
  type A2ARecordedReply,
  type A2ASessionPort,
  type A2ASessionRun,
} from './a2a-server.js';
import { updateWorkspaceAgents } from './store.js';

const PROJECT_ROOT = '/a2a-server-test';

/**
 * The orchestrator as A2A sees it: sessions, posts that start one queued run
 * per post (no coalescing unless asked), live runs, reply records.
 */
class FakeSessions implements A2ASessionPort {
  readonly sessions: Array<{ id: string; callerId: string; title: string }> =
    [];
  readonly posts: Array<{
    sessionId: string;
    text: string;
    clientMessageId: string;
  }> = [];
  readonly live = new Map<string, A2ASessionRun>();
  readonly replies = new Map<string, A2ARecordedReply>();
  readonly cancelled: string[] = [];
  createFailure?: A2ASessionError;
  mentionFailure?: A2ASessionError;
  /** When set, every post joins this run (the orchestrator coalesced it). */
  coalesceInto?: string;
  private nextRun = 1;

  async createSession(input: {
    callerId: string;
    agentId: string;
    title: string;
  }): Promise<string> {
    if (this.createFailure) throw this.createFailure;
    const id = randomUUID();
    this.sessions.push({ id, callerId: input.callerId, title: input.title });
    return id;
  }

  async mention(
    sessionId: string,
    input: { text: string; clientMessageId: string },
  ) {
    if (this.mentionFailure) throw this.mentionFailure;
    this.posts.push({ sessionId, ...input });
    const runId = this.coalesceInto ?? `sr_${this.nextRun++}`;
    this.live.set(runId, { status: 'queued', activityAt: 1_000 });
    return { runs: [{ runId, agentId: 'ag_lead' }] };
  }

  async liveRun(_sessionId: string, runId: string) {
    return this.live.get(runId);
  }

  async recordedReply(_sessionId: string, runId: string) {
    return this.replies.get(runId);
  }

  async cancel(sessionId: string, runId: string) {
    const run = this.live.get(runId);
    if (!run) return false;
    this.cancelled.push(runId);
    this.live.delete(runId);
    // A queued run is cancelled without a reply record; the orchestrator
    // persists it to the session's agent file.
    await persistRun(sessionId, {
      id: runId,
      status: 'cancelled',
      endedAt: 2_000,
    });
    return true;
  }

  /** The run finished and its reply record is in the transcript. */
  reply(
    runId: string,
    status: AgentMessageRecordPayload['status'],
    displayText: string,
    error?: string,
  ) {
    this.live.delete(runId);
    this.replies.set(runId, {
      at: 3_000,
      payload: {
        displayText,
        author: { agentId: 'ag_lead', name: 'lead' },
        runId,
        status,
        ...(error ? { error } : {}),
        totalTokens: 42,
      },
    });
  }
}

async function persistRun(
  sessionId: string,
  run: Partial<SessionAgentRun> & { id: string; status: SessionAgentRunStatus },
) {
  await updateSessionAgents(PROJECT_ROOT, sessionId, (file) => {
    file.runs.push({
      agentId: 'ag_lead',
      triggerRecordIds: [],
      chainDepth: 0,
      createdAt: 1,
      attempts: 1,
      ...run,
    });
  });
}

let runtimeDir: string;
let port: FakeSessions;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-server-test-'));
  Storage.setRuntimeBaseDir(runtimeDir);
  await updateWorkspaceAgents(PROJECT_ROOT, () => [
    { id: 'ag_lead', name: 'lead', createdAt: 1 },
    { id: 'ag_other', name: 'other', createdAt: 1 },
  ]);
  port = new FakeSessions();
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

async function grant(callerId = 'share_1'): Promise<A2ACaller> {
  const { secret } = await issueA2AGrant(PROJECT_ROOT, {
    callerId,
    agentId: 'ag_lead',
  });
  return { callerId, secret };
}

function send(
  caller: A2ACaller,
  messageId = 'msg-1',
  text = 'Why is the build slow?',
  contextId?: string,
) {
  return a2aSendMessage(PROJECT_ROOT, port, caller, {
    agentId: 'ag_lead',
    messageId,
    text,
    ...(contextId ? { contextId } : {}),
  });
}

async function sent(...args: Parameters<typeof send>) {
  const result = await send(...args);
  if (!result.ok) throw new Error(`send refused: ${result.kind}`);
  return result.value;
}

describe('A2A send', () => {
  it('posts to the granted agent in a session made for the caller', async () => {
    const caller = await grant();
    const task = await sent(caller, 'msg-1', 'Ask @other to look too.');

    expect(port.sessions).toEqual([
      { id: task.contextId, callerId: 'share_1', title: 'A2A · share_1' },
    ]);
    expect(port.posts).toHaveLength(1);
    expect(port.posts[0]).toMatchObject({ sessionId: task.contextId });
    expect(port.posts[0]!.text).toBe('@lead Ask @⁠other to look too.');
    expect(task).toMatchObject({
      id: 'sr_1',
      status: { state: 'TASK_STATE_SUBMITTED' },
      metadata: { [QWEN_A2A_EXTENSION_URI]: { localStatus: 'queued' } },
    });
  });

  it('answers a retry with the same task and refuses a reused id', async () => {
    const caller = await grant();
    const first = await sent(caller);
    const retry = await sent(caller);

    expect(retry.id).toBe(first.id);
    expect(port.posts).toHaveLength(1);
    await expect(send(caller, 'msg-1', 'Different.')).resolves.toEqual({
      ok: false,
      kind: 'conflict',
      existingTaskId: first.id,
    });
  });

  it('serializes concurrent retries of one request', async () => {
    const caller = await grant();
    const [a, b] = await Promise.all([sent(caller), sent(caller)]);

    expect(a.id).toBe(b.id);
    expect(port.sessions).toHaveLength(1);
    expect(port.posts).toHaveLength(1);
  });

  it('continues a context in the same session', async () => {
    const caller = await grant();
    const first = await sent(caller);
    const second = await sent(caller, 'msg-2', 'And now?', first.contextId);

    expect(second.contextId).toBe(first.contextId);
    expect(second.id).not.toBe(first.id);
    expect(port.sessions).toHaveLength(1);
    expect(port.posts.map((post) => post.sessionId)).toEqual([
      first.contextId,
      first.contextId,
    ]);
  });

  it("refuses a context that is not the caller's", async () => {
    const owner = await grant('share_1');
    const other = await grant('share_2');
    const task = await sent(owner);

    await expect(
      send(other, 'msg-1', 'Hijack.', task.contextId),
    ).resolves.toEqual({
      ok: false,
      kind: 'invalid',
      detail: 'Unknown contextId.',
    });
    await expect(send(owner, 'msg-2', 'Hi', '../x')).resolves.toEqual({
      ok: false,
      kind: 'invalid',
      detail: 'Unknown contextId.',
    });
    expect(port.posts).toHaveLength(1);
  });

  it('resumes in the same session after a failed post', async () => {
    const caller = await grant();
    port.mentionFailure = new A2ASessionError('unavailable', 'stopping');
    await expect(send(caller)).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
    });
    expect(port.sessions).toHaveLength(1);

    delete port.mentionFailure;
    const task = await sent(caller);
    expect(port.sessions).toHaveLength(1);
    expect(task.contextId).toBe(port.sessions[0]!.id);
  });

  it('refuses work for a retired agent but keeps its tasks readable', async () => {
    const caller = await grant();
    const task = await sent(caller);
    await updateWorkspaceAgents(PROJECT_ROOT, (agents) =>
      agents.map((agent) => ({ ...agent, retiredAt: 1 })),
    );

    await expect(send(caller, 'msg-2')).resolves.toEqual({
      ok: false,
      kind: 'refused',
    });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({ ok: true, value: { id: task.id } });
    await expect(
      a2aCancelTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('A2A task state', () => {
  it("returns the agent's reply once and keeps it", async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.live.set(task.id, { status: 'running', activityAt: 2_000 });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: { state: 'TASK_STATE_WORKING' } },
    });

    port.reply(task.id, 'completed', 'The cache key misses on every run.');
    const done = await a2aGetTask(PROJECT_ROOT, port, caller, task.id);
    expect(done).toMatchObject({
      ok: true,
      value: {
        answer: 'The cache key misses on every run.',
        status: {
          state: 'TASK_STATE_COMPLETED',
          timestamp: new Date(3_000).toISOString(),
        },
        metadata: { [QWEN_A2A_EXTENSION_URI]: { tokensUsed: 42 } },
      },
    });

    // The run's records may go (trimmed, session deleted); the result stays.
    port.replies.clear();
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toEqual(done);
  });

  it('reports a pending approval as input required, for the owner', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.live.set(task.id, { status: 'awaiting_approval', activityAt: 2_000 });

    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        status: { state: 'TASK_STATE_INPUT_REQUIRED' },
        statusText: expect.stringContaining('workspace owner'),
        metadata: {
          [QWEN_A2A_EXTENSION_URI]: { localStatus: 'awaiting_approval' },
        },
      },
    });
  });

  it('never reports completed without the reply', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.live.delete(task.id);
    // Finished, but its record is deferred behind a main-model turn.
    await persistRun(task.contextId, {
      id: task.id,
      status: 'completed',
      endedAt: 2_000,
    });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: { state: 'TASK_STATE_WORKING' } },
    });

    const second = await sent(caller, 'msg-2', 'Again.', task.contextId);
    port.live.delete(second.id);
    // Writing the record failed: the run carries why.
    await persistRun(task.contextId, {
      id: second.id,
      status: 'completed',
      endedAt: 2_000,
      error: 'Could not record the reply: boom',
    });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, second.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        status: { state: 'TASK_STATE_FAILED' },
        statusText: 'Could not record the reply: boom',
      },
    });
  });

  it('waits for a finished run whose reply record is still pending', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.live.set(task.id, {
      status: 'completed',
      activityAt: 2_000,
      recorded: false,
    });

    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        status: { state: 'TASK_STATE_WORKING' },
        statusText: expect.stringContaining('being recorded'),
      },
    });
  });

  it('follows a run the owner retried after a restart', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.live.set(task.id, {
      status: 'failed',
      activityAt: 2_000,
      error: 'daemon restarted',
      recorded: false,
      retryable: true,
    });
    // Failed for now, but not final: the owner may still retry it.
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        status: { state: 'TASK_STATE_FAILED' },
        statusText: expect.stringContaining('retry'),
      },
    });

    // Retried: the old frame names its replacement, which is persisted with
    // `retryOf` once the old frame is gone.
    port.live.set(task.id, { status: 'failed', retriedAsRunId: 'sr_9' });
    port.live.set('sr_9', { status: 'running', activityAt: 4_000 });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { id: task.id, status: { state: 'TASK_STATE_WORKING' } },
    });

    port.live.delete(task.id);
    await persistRun(task.contextId, {
      id: task.id,
      status: 'failed',
      error: 'daemon restarted',
    });
    await persistRun(task.contextId, {
      id: 'sr_9',
      status: 'completed',
      retryOf: task.id,
    });
    port.reply('sr_9', 'completed', 'Done after the retry.');
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        id: task.id,
        answer: 'Done after the retry.',
        status: { state: 'TASK_STATE_COMPLETED' },
      },
    });
  });

  it('fails a run nothing tracks any more', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.live.delete(task.id);

    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: { state: 'TASK_STATE_FAILED' } },
    });
  });
});

describe('A2A isolation and cancel', () => {
  it('hides tasks from other callers and from a revoked one', async () => {
    const owner = await grant('share_1');
    const other = await grant('share_2');
    const task = await sent(owner);

    await expect(
      a2aGetTask(PROJECT_ROOT, port, other, task.id),
    ).resolves.toEqual({ ok: false, kind: 'not_found' });
    await expect(
      a2aCancelTask(PROJECT_ROOT, port, other, task.id),
    ).resolves.toEqual({ ok: false, kind: 'not_found' });
    await expect(
      a2aListTasks(PROJECT_ROOT, port, other, 'ag_lead'),
    ).resolves.toEqual({ ok: true, value: [] });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, owner, '../workspace'),
    ).resolves.toEqual({ ok: false, kind: 'not_found' });

    await revokeA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, owner, task.id),
    ).resolves.toEqual({ ok: false, kind: 'not_found' });
    expect(port.cancelled).toEqual([]);
  });

  it('lists a coalesced run as one task', async () => {
    const caller = await grant();
    const first = await sent(caller);
    port.coalesceInto = first.id;
    await sent(caller, 'msg-2', 'Also this.', first.contextId);

    const listed = await a2aListTasks(PROJECT_ROOT, port, caller, 'ag_lead');
    expect(listed).toMatchObject({ ok: true, value: [{ id: first.id }] });
    if (listed.ok) expect(listed.value).toHaveLength(1);
  });

  it('cancels a queued run', async () => {
    const caller = await grant();
    const task = await sent(caller);

    await expect(
      a2aCancelTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        task: { status: { state: 'TASK_STATE_CANCELED' } },
        runsStillLive: 0,
      },
    });
    expect(port.cancelled).toEqual([task.id]);
  });

  it('does not rewrite a finished task as cancelled', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.reply(task.id, 'completed', 'Done.');
    await a2aGetTask(PROJECT_ROOT, port, caller, task.id);

    await expect(
      a2aCancelTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        task: { status: { state: 'TASK_STATE_COMPLETED' }, answer: 'Done.' },
        runsStillLive: 0,
      },
    });
    expect(port.cancelled).toEqual([]);
  });

  it('reports an executing run as still live after the request', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.live.set(task.id, { status: 'running', activityAt: 2_000 });
    // Asked to stop; the program has not stopped yet.
    port.cancel = async () => true;

    await expect(
      a2aCancelTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        task: { status: { state: 'TASK_STATE_WORKING' } },
        runsStillLive: 1,
      },
    });
  });
});
