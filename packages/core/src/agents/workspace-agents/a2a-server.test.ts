/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../../config/storage.js';
import type {
  AgentMessageRecordPayload,
  SessionAgentRun,
  SessionAgentRunStatus,
} from '../session-agents/contract.js';
import { updateSessionAgents } from '../session-agents/binding-store.js';
import { resolveMentionTargetsWithSquads } from '../session-agents/chain.js';
import { createSquad } from '../session-agents/squad-store.js';
import { QWEN_A2A_EXTENSION_URI } from './a2a-contract.js';
import { getExternalCallerFilePath } from './external-intake.js';
import { issueA2AGrant, revokeA2AGrant } from './a2a-grants.js';
import {
  A2ASessionError,
  a2aAgentCardForCaller,
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

vi.mock('../session-agents/chain.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../session-agents/chain.js')>();
  return {
    ...actual,
    resolveMentionTargetsWithSquads: vi.fn(
      actual.resolveMentionTargetsWithSquads,
    ),
  };
});

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
  readonly discarded: string[] = [];
  createFailure?: A2ASessionError;
  /** Runs once a session is made, before the caller's mapping records it. */
  afterCreate?: () => Promise<void>;
  mentionFailure?: A2ASessionError;
  /** When set, every post joins this run (the orchestrator coalesced it). */
  coalesceInto?: string;
  /** The agent the post's run is for. */
  runAgentId = 'ag_lead';
  /** Fails the call once its post has landed, as a crash would. */
  failAfterPost?: Error;
  /** Posts by `clientMessageId`: a replay answers the run it started. */
  private readonly byClientMessageId = new Map<string, string>();
  private nextRun = 1;

  async createSession(input: {
    callerId: string;
    agentId: string;
    title: string;
  }): Promise<string> {
    if (this.createFailure) throw this.createFailure;
    const id = randomUUID();
    this.sessions.push({ id, callerId: input.callerId, title: input.title });
    await this.afterCreate?.();
    return id;
  }

  async discardSession(sessionId: string): Promise<void> {
    this.discarded.push(sessionId);
  }

  async mention(
    sessionId: string,
    input: { text: string; clientMessageId: string },
  ) {
    if (this.mentionFailure) throw this.mentionFailure;
    const replayed = this.byClientMessageId.get(input.clientMessageId);
    if (replayed) {
      return { runs: [{ runId: replayed, agentId: this.runAgentId }] };
    }
    this.posts.push({ sessionId, ...input });
    const runId = this.coalesceInto ?? `sr_${this.nextRun++}`;
    this.byClientMessageId.set(input.clientMessageId, runId);
    this.live.set(runId, { status: 'queued', activityAt: 1_000 });
    const failure = this.failAfterPost;
    if (failure) {
      delete this.failAfterPost;
      throw failure;
    }
    return { runs: [{ runId, agentId: this.runAgentId }] };
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
    const index = file.runs.findIndex((candidate) => candidate.id === run.id);
    if (index >= 0) {
      file.runs[index] = { ...file.runs[index]!, ...run };
      return;
    }
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

  it('discards a session whose first post is refused for good', async () => {
    const caller = await grant();
    port.mentionFailure = new A2ASessionError('refused', 'invalid_text');
    await expect(send(caller)).resolves.toEqual({ ok: false, kind: 'refused' });
    expect(port.discarded).toEqual([port.sessions[0]!.id]);

    // A retry cannot reuse a discarded session: it starts over with a new
    // one, because the refusal released the reservation's session.
    delete port.mentionFailure;
    const task = await sent(caller);
    expect(port.sessions).toHaveLength(2);
    expect(task.contextId).toBe(port.sessions[1]!.id);
  });

  it('does not post twice when a send dies after posting', async () => {
    const caller = await grant();
    port.failAfterPost = new Error('daemon stopped');
    await expect(send(caller)).rejects.toThrow('daemon stopped');

    // The retry posts into the same session with the same id, which the
    // orchestrator answers with the run the first post started.
    const task = await sent(caller);
    expect(port.posts).toHaveLength(1);
    expect(task).toMatchObject({
      id: 'sr_1',
      contextId: port.posts[0]!.sessionId,
    });
  });

  it('neutralizes squad names too, and nothing that addresses no one', async () => {
    await createSquad(PROJECT_ROOT, {
      name: 'reviewers',
      leaderAgentId: 'ag_other',
    });
    const caller = await grant();
    await sent(caller, 'msg-1', 'Ask @reviewers; keep @media print as is.');

    expect(port.posts[0]!.text).toBe(
      '@lead Ask @\u2060reviewers; keep @media print as is.',
    );
  });

  it('refuses a post that would address more than the granted agent', async () => {
    const caller = await grant();
    const actual = await vi.importActual<
      typeof import('../session-agents/chain.js')
    >('../session-agents/chain.js');
    // As if another `@name` got past the neutralization.
    vi.mocked(resolveMentionTargetsWithSquads).mockImplementationOnce(
      (text, roster, squads) => ({
        ...actual.resolveMentionTargetsWithSquads(text, roster, squads),
        agents: [...roster],
      }),
    );

    await expect(send(caller)).resolves.toEqual({
      ok: false,
      kind: 'refused',
    });
    expect(port.posts).toEqual([]);
  });

  it('takes work for a remote agent and lists it only to its caller', async () => {
    await updateWorkspaceAgents(PROJECT_ROOT, (agents) => [
      ...agents,
      {
        id: 'ag_far',
        name: 'far',
        createdAt: 1,
        description: 'Runs elsewhere.',
        execution: { mode: 'managed-host', hostIds: ['ho_1'] },
      },
    ]);
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_2',
      agentId: 'ag_far',
    });
    port.runAgentId = 'ag_far';

    await expect(
      a2aSendMessage(
        PROJECT_ROOT,
        port,
        { callerId: 'share_2', secret },
        { agentId: 'ag_far', messageId: 'msg-1', text: 'Build it there.' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: { state: 'TASK_STATE_SUBMITTED' } },
    });
    expect(port.posts[0]?.text).toBe('@far Build it there.');

    const cardFor = (cardSecret: string) =>
      a2aAgentCardForCaller(
        PROJECT_ROOT,
        { callerId: 'share_2', secret: cardSecret },
        ['ag_far'],
        'http://localhost',
      );
    expect((await cardFor(secret)).skills).toEqual([
      { id: 'ag_far', name: 'far', description: 'Runs elsewhere.' },
    ]);
    // A caller without a valid grant learns nothing about it.
    expect((await cardFor('wrong')).skills).toEqual([]);
  });

  it('refuses when the daemon refuses the session', async () => {
    const caller = await grant();
    port.createFailure = new A2ASessionError('refused', 'managed session');
    await expect(send(caller)).resolves.toEqual({
      ok: false,
      kind: 'refused',
    });
  });

  it('removes a session it could not record', async () => {
    const caller = await grant();
    // The reservation is gone by the time the session would be recorded.
    port.afterCreate = () =>
      fs.rm(getExternalCallerFilePath(PROJECT_ROOT, caller.callerId));

    await expect(send(caller)).rejects.toThrow('disappeared');
    expect(port.discarded).toEqual([port.sessions[0]!.id]);
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
    // Finished before a restart with its record not yet landed: recovery
    // offers it to the owner, and the record may still land.
    await persistRun(task.contextId, {
      id: task.id,
      status: 'completed',
      endedAt: 2_000,
      recorded: false,
    });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: { state: 'TASK_STATE_WORKING' } },
    });

    // Dismissed (`recorded` dropped) with no record: none is coming.
    await persistRun(task.contextId, {
      id: task.id,
      status: 'completed',
      recorded: undefined,
    });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        status: { state: 'TASK_STATE_FAILED' },
        statusText: expect.stringContaining('not in the session'),
      },
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

    // Retried: the old frame is dropped and the replacement is persisted
    // with `retryOf`.
    port.live.delete(task.id);
    await persistRun(task.contextId, {
      id: task.id,
      status: 'failed',
      error: 'daemon restarted',
    });
    await persistRun(task.contextId, {
      id: 'sr_9',
      status: 'running',
      retryOf: task.id,
    });
    port.live.set('sr_9', { status: 'running', activityAt: 4_000 });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { id: task.id, status: { state: 'TASK_STATE_WORKING' } },
    });

    await persistRun(task.contextId, { id: 'sr_9', status: 'completed' });
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

  it('reports a finished run a restart left unrecorded as retryable', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.live.set(task.id, {
      status: 'completed',
      activityAt: 2_000,
      error: 'the reply was not recorded before the daemon stopped',
      recorded: false,
      retryable: true,
    });

    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        status: { state: 'TASK_STATE_WORKING' },
        statusText: expect.stringContaining('retry'),
        metadata: {
          [QWEN_A2A_EXTENSION_URI]: {
            error: 'the reply was not recorded before the daemon stopped',
          },
        },
      },
    });
  });

  it('does not keep a failure the owner may still retry', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.live.delete(task.id);
    // Interrupted by a restart; no orchestrator reports it (yet).
    await persistRun(task.contextId, {
      id: task.id,
      status: 'failed',
      error: 'daemon restarted',
      recorded: false,
    });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        status: { state: 'TASK_STATE_FAILED' },
        statusText: expect.stringContaining('retry'),
      },
    });

    await persistRun(task.contextId, {
      id: 'sr_9',
      status: 'running',
      retryOf: task.id,
    });
    port.live.set('sr_9', { status: 'running', activityAt: 4_000 });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: { state: 'TASK_STATE_WORKING' } },
    });
  });

  it('follows an owner retry of a failure it already kept', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.reply(task.id, 'failed', '', 'model error');
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: { state: 'TASK_STATE_FAILED' } },
    });

    await persistRun(task.contextId, {
      id: 'sr_9',
      status: 'running',
      retryOf: task.id,
    });
    port.live.set('sr_9', { status: 'running', activityAt: 4_000 });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: { state: 'TASK_STATE_WORKING' } },
    });

    port.reply('sr_9', 'completed', 'Done after the retry.');
    const done = await a2aGetTask(PROJECT_ROOT, port, caller, task.id);
    expect(done).toMatchObject({
      ok: true,
      value: {
        answer: 'Done after the retry.',
        status: { state: 'TASK_STATE_COMPLETED' },
      },
    });
    // The new outcome replaced the kept failure.
    port.replies.clear();
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toEqual(done);
  });

  it('follows a retry chain longer than any hop count', async () => {
    const caller = await grant();
    const task = await sent(caller);
    // The task's own run plus 11 owner retries of it. A persistently failing
    // agent is retried as often as the owner likes, so no depth is out of
    // reach, and the answer is at the end of the chain.
    let previous = task.id;
    for (let hop = 0; hop < 11; hop++) {
      const id = `sr_chain_${hop}`;
      await persistRun(task.contextId, {
        id,
        status: 'failed',
        retryOf: previous,
      });
      previous = id;
    }
    port.reply(previous, 'completed', 'Done at the end of the chain.');

    const done = await a2aGetTask(PROJECT_ROOT, port, caller, task.id);
    expect(done).toMatchObject({
      ok: true,
      value: {
        answer: 'Done at the end of the chain.',
        status: { state: 'TASK_STATE_COMPLETED' },
      },
    });
    // Kept, so the answer survives the runs it came from being trimmed.
    port.replies.clear();
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toEqual(done);
  });

  it('stops following a run whose retry names itself', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.live.delete(task.id);
    // A store file edited into a cycle: the run's replacement is itself.
    // The followed-set ends the walk instead of recursing without end.
    await persistRun(task.contextId, {
      id: task.id,
      status: 'failed',
      error: 'daemon restarted',
      retryOf: task.id,
    });
    await expect(
      a2aGetTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { status: { state: 'TASK_STATE_FAILED' } },
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
    // Records every request, so a cancel of the finished run would show.
    port.cancel = async (_sessionId, runId) => {
      port.cancelled.push(runId);
      return false;
    };

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

  it('cancels the run an owner retry replaced the task with', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.reply(task.id, 'failed', '', 'model error');
    await persistRun(task.contextId, {
      id: 'sr_9',
      status: 'queued',
      retryOf: task.id,
    });
    port.live.set('sr_9', { status: 'queued', activityAt: 4_000 });

    await expect(
      a2aCancelTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        task: { id: task.id, status: { state: 'TASK_STATE_CANCELED' } },
        runsStillLive: 0,
      },
    });
    expect(port.cancelled).toEqual(['sr_9']);
  });

  it('reports nothing live when the cancel stopped no run', async () => {
    const caller = await grant();
    const task = await sent(caller);
    // Finished, its record still pending: nothing to stop.
    port.live.set(task.id, {
      status: 'completed',
      activityAt: 2_000,
      recorded: false,
    });
    port.cancel = async () => false;

    await expect(
      a2aCancelTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        task: { status: { state: 'TASK_STATE_WORKING' } },
        runsStillLive: 0,
      },
    });
  });

  it('answers unavailable when the orchestrator cannot cancel', async () => {
    const caller = await grant();
    const task = await sent(caller);
    port.cancel = async () => {
      throw new A2ASessionError('unavailable', 'not running');
    };

    await expect(
      a2aCancelTask(PROJECT_ROOT, port, caller, task.id),
    ).resolves.toEqual({ ok: false, kind: 'unavailable' });
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
