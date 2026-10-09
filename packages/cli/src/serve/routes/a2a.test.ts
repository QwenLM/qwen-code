/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  issueA2AGrant,
  revokeA2AGrant,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/a2a-grants.js';
import { updateWorkspaceAgents } from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import type { AgentAdapterTurnResult } from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { Storage, type A2ASessionPort } from '@qwen-code/qwen-code-core';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { SessionAgentEventHub } from '../session-agents/events.js';
import {
  disposeSessionAgentOrchestrator,
  ensureSessionAgentOrchestrator,
  type SessionAgentBridge,
} from '../session-agents/orchestrator.js';
import { registerA2ATransportRoutes } from './a2a.js';

const PROJECT_ROOT = '/a2a-route-test';
const headers = {
  authorization: '',
  'x-qwen-workspace-id': 'primary',
  'x-qwen-caller-id': 'share_1',
  'x-qwen-agent-id': 'ag_lead',
};

/** Session agents as A2A sees them; a cancel ends the run at once. */
function fakeSessions() {
  const sessions: string[] = [];
  const runs = new Map<string, 'queued' | 'awaiting_approval' | 'cancelled'>();
  const posts: string[] = [];
  const port: A2ASessionPort = {
    async createSession() {
      const id = randomUUID();
      sessions.push(id);
      return id;
    },
    async discardSession() {},
    async mention(_sessionId, input) {
      posts.push(input.text);
      const runId = `sr_${runs.size + 1}`;
      runs.set(runId, 'queued');
      return { runs: [{ runId, agentId: 'ag_lead' }] };
    },
    async liveRun(_sessionId, runId) {
      const status = runs.get(runId);
      return status === 'queued' || status === 'awaiting_approval'
        ? { status, activityAt: 1_000 }
        : undefined;
    },
    async recordedReply(_sessionId, runId) {
      return runs.get(runId) === 'cancelled'
        ? {
            at: 2_000,
            payload: {
              displayText: '',
              author: { agentId: 'ag_lead', name: 'lead' },
              runId,
              status: 'cancelled',
            },
          }
        : undefined;
    },
    async cancel(_sessionId, runId) {
      if (runs.get(runId) !== 'queued') return false;
      runs.set(runId, 'cancelled');
      return true;
    },
  };
  return { port, sessions, posts, runs };
}

let runtimeDir: string;
let sessions: ReturnType<typeof fakeSessions>;

beforeEach(async () => {
  sessions = fakeSessions();
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-route-test-'));
  Storage.setRuntimeBaseDir(runtimeDir);
  await updateWorkspaceAgents(PROJECT_ROOT, () => [
    { id: 'ag_lead', name: 'lead', createdAt: 1 },
  ]);
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

function runtime(trusted: boolean): WorkspaceRuntime {
  return {
    workspaceId: 'primary',
    workspaceCwd: PROJECT_ROOT,
    primary: true,
    trusted,
  } as WorkspaceRuntime;
}

function appFor(trusted: boolean, checkRate: ReturnType<typeof vi.fn>) {
  const app = express();
  registerA2ATransportRoutes(
    app,
    createWorkspaceRegistry([runtime(trusted)]),
    { checkRate },
    undefined,
    () => sessions.port,
  );
  return app;
}

describe('A2A transport', () => {
  it('serves the task lifecycle and enforces isolation and revocation', async () => {
    const first = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const second = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_2',
      agentId: 'ag_lead',
    });
    const app = appFor(
      true,
      vi.fn(() => true),
    );

    const card = await request(app).get('/.well-known/agent-card.json');
    expect(card.body).toMatchObject({
      name: 'Qwen Code workspace agents',
      supportedInterfaces: [
        expect.objectContaining({
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        }),
      ],
      capabilities: { streaming: false, pushNotifications: false },
    });

    const call = (
      callerId: string,
      secret: string,
      method: string,
      params: unknown,
    ) =>
      request(app)
        .post('/a2a/v1')
        .set({
          ...headers,
          authorization: `Bearer ${secret}`,
          'x-qwen-caller-id': callerId,
          'A2A-Version': '1.0',
        })
        .send({ jsonrpc: '2.0', id: 1, method, params });

    const sent = await call('share_1', first.secret, 'SendMessage', {
      message: {
        role: 'ROLE_USER',
        messageId: 'msg-1',
        parts: [{ text: 'Inspect the cache.' }],
      },
    });
    expect(sent.body.error).toBeUndefined();
    const taskId = sent.body.result.task.id as string;
    const contextId = sent.body.result.task.contextId as string;
    expect(contextId).toBe(sessions.sessions[0]);
    expect(sessions.posts).toEqual(['@lead Inspect the cache.']);

    // Another message in the same context is the next turn there.
    const followUp = await call('share_1', first.secret, 'SendMessage', {
      message: {
        role: 'ROLE_USER',
        messageId: 'msg-2',
        contextId,
        parts: [{ text: 'And the lockfile?' }],
      },
    });
    expect(followUp.body.result.task).toMatchObject({ contextId });
    expect(sessions.sessions).toHaveLength(1);

    const polled = await call('share_1', first.secret, 'GetTask', {
      id: taskId,
    });
    expect(polled.body.result).toMatchObject({ id: taskId });

    const listed = await call('share_1', first.secret, 'ListTasks', {});
    expect(listed.body.result).toMatchObject({
      tasks: [expect.objectContaining({ id: taskId }), expect.anything()],
      totalSize: 2,
    });

    const privatePoll = await call('share_2', second.secret, 'GetTask', {
      id: taskId,
    });
    expect(privatePoll.body.error).toMatchObject({
      code: -32001,
      message: 'Task not found.',
    });

    const cancelled = await call('share_1', first.secret, 'CancelTask', {
      id: taskId,
    });
    expect(cancelled.body.result).toMatchObject({
      id: taskId,
      status: { state: 'TASK_STATE_CANCELED' },
    });

    await revokeA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const revokedPoll = await call('share_1', first.secret, 'GetTask', {
      id: taskId,
    });
    expect(revokedPoll.body.error).toMatchObject({
      code: -32010,
      message: 'Request refused.',
    });
  });

  it('says in the status message that an approval waits on the owner', async () => {
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const app = appFor(
      true,
      vi.fn(() => true),
    );
    const call = (method: string, params: unknown) =>
      request(app)
        .post('/a2a/v1')
        .set({
          ...headers,
          authorization: `Bearer ${secret}`,
          'x-qwen-caller-id': 'share_1',
          'A2A-Version': '1.0',
        })
        .send({ jsonrpc: '2.0', id: 1, method, params });

    const sent = await call('SendMessage', {
      message: {
        role: 'ROLE_USER',
        messageId: 'msg-1',
        parts: [{ text: 'Write the fix.' }],
      },
    });
    const taskId = sent.body.result.task.id as string;
    sessions.runs.set(taskId, 'awaiting_approval');

    const polled = await call('GetTask', { id: taskId });
    expect(polled.body.result.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    // `localStatus` is in optional extension metadata; this is what any
    // client reads.
    expect(JSON.stringify(polled.body.result.status.message)).toContain(
      'workspace owner',
    );
  });

  it('rejects an untrusted primary workspace', async () => {
    const checkRate = vi.fn(() => true);
    const response = await request(appFor(false, checkRate))
      .post('/a2a/v1')
      .set({ ...headers, authorization: `Bearer ${'a'.repeat(32)}` })
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'untrusted_workspace' });
  });

  it('rate limits both the source address and authenticated caller', async () => {
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const checkRate = vi
      .fn<(_: string, __: string) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const response = await request(appFor(true, checkRate))
      .post('/a2a/v1')
      .set({ ...headers, authorization: `Bearer ${secret}` })
      .send({});

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ code: 'rate_limit_exceeded' });
    expect(checkRate).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^a2a:preauth:/),
      'mutation',
    );
    expect(checkRate).toHaveBeenNthCalledWith(
      2,
      'a2a:caller:share_1',
      'mutation',
    );
  });

  it('refuses adding a message to an existing task', async () => {
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    const response = await request(
      appFor(
        true,
        vi.fn(() => true),
      ),
    )
      .post('/a2a/v1')
      .set({ ...headers, authorization: `Bearer ${secret}` })
      .set('A2A-Version', '1.0')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            role: 'ROLE_USER',
            messageId: 'msg-2',
            taskId: 'existing-task',
            parts: [{ text: 'Continue.' }],
          },
        },
      });

    expect(response.body).toMatchObject({
      error: {
        message:
          'Messages cannot be added to an existing task; send a new message with its contextId.',
      },
    });
    expect(sessions.posts).toEqual([]);
  });
});

it.each(['replaced', 'untrusted', 'disabled'] as const)(
  'refuses a request whose workspace becomes %s during authentication',
  async (change) => {
    const { secret } = await issueA2AGrant(PROJECT_ROOT, {
      callerId: 'share_1',
      agentId: 'ag_lead',
    });
    let trusted = true;
    const selected = {
      ...runtime(true),
      get trusted() {
        return trusted;
      },
    };
    const registry = createWorkspaceRegistry([selected]);
    let enabled = true;
    const checkRate = vi.fn((key: string) => {
      if (key === 'a2a:caller:share_1') {
        if (change === 'replaced') {
          const entry = registry.primaryEntry;
          registry.beginReplacement(entry, 'new');
          registry.activateReplacement(entry, runtime(true), 'new');
        } else if (change === 'untrusted') trusted = false;
        else enabled = false;
      }
      return true;
    });
    const app = express();
    registerA2ATransportRoutes(
      app,
      registry,
      { checkRate },
      () => enabled,
      () => sessions.port,
    );
    const response = await request(app)
      .post('/a2a/v1')
      .set({
        ...headers,
        authorization: `Bearer ${secret}`,
        'A2A-Version': '1.0',
      })
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            role: 'ROLE_USER',
            messageId: 'msg-removed',
            parts: [{ text: 'Do not admit stale work.' }],
          },
        },
      });
    expect(response.body.error).toBeDefined();
    expect(sessions.sessions).toEqual([]);
    expect(sessions.posts).toEqual([]);
  },
);

describe('the default session port factory', () => {
  it('reads replies from, and discards sessions under, the runtime session dir', async () => {
    // A workspace whose own session runtime dir is NOT the ambient default,
    // so reading the ambient dir would silently miss its transcripts.
    const projectRoot = path.join(runtimeDir, 'default-port-ws');
    const sessionRuntimeDir = path.join(runtimeDir, 'default-port-runtime');
    await updateWorkspaceAgents(projectRoot, () => [
      {
        id: 'ag_lead',
        name: 'lead',
        createdAt: 1,
        execution: { mode: 'local', provider: 'claude' },
      },
    ]);
    const transcripts = new SessionService(projectRoot, {
      runtimeBaseDir: sessionRuntimeDir,
    });
    const spawned: string[] = [];
    /** Track the transcript chain per session, as a transcript would grow. */
    const chains = new Map<string, string[]>();
    const fakes = {
      spawnOrAttach: async () => {
        const sessionId = randomUUID();
        spawned.push(sessionId);
        // A spawned session's transcript exists before any agent record.
        await fs.mkdir(
          path.dirname(transcripts.getSessionTranscriptPath(sessionId)),
          { recursive: true },
        );
        await fs.appendFile(
          transcripts.getSessionTranscriptPath(sessionId),
          `${JSON.stringify({
            uuid: 'seed-0',
            parentUuid: null,
            sessionId,
            cwd: projectRoot,
            timestamp: new Date().toISOString(),
            type: 'system',
          })}\n`,
        );
        chains.set(sessionId, ['seed-0']);
        return { sessionId, workspaceCwd: projectRoot, attached: false };
      },
      updateSessionMetadata: () => ({}),
      killSession: async () => true,
      resumeSession: async () => ({}),
      // The ACP child's side: every external record lands in the workspace's
      // own session transcripts, durably, before the answer.
      appendExternalRecord: async (
        sessionId: string,
        record: {
          kind: string;
          modelText: string;
          payload: unknown;
          recordKey: string;
        },
      ) => {
        const chain = chains.get(sessionId)!;
        const uuid = `rec-${chain.length}`;
        await fs.appendFile(
          transcripts.getSessionTranscriptPath(sessionId),
          `${JSON.stringify({
            uuid,
            parentUuid: chain[chain.length - 1] ?? null,
            sessionId,
            cwd: projectRoot,
            timestamp: new Date().toISOString(),
            type: 'user',
            subtype: record.kind,
            message: { role: 'user', parts: [{ text: record.modelText }] },
            systemPayload: record.payload,
            externalRecordKey: record.recordKey,
          })}\n`,
        );
        chain.push(uuid);
        return { sessionId, recordId: uuid, created: true };
      },
    };
    const appendExternalRecord = vi.fn(fakes.appendExternalRecord);
    const bridge = {
      ...fakes,
      appendExternalRecord,
    } as unknown as SessionAgentBridge;
    const runtime = {
      workspaceId: 'primary',
      workspaceCwd: projectRoot,
      sessionRuntimeBaseDir: sessionRuntimeDir,
      primary: true,
      trusted: true,
      bridge,
    } as WorkspaceRuntime;
    ensureSessionAgentOrchestrator({
      workspaceCwd: projectRoot,
      bridge,
      hub: new SessionAgentEventHub(0),
      chainLimit: () => 0,
      loadRecords: async () => [],
      getAdapter: (program) => ({
        program,
        runTurn: (input) =>
          new Promise<AgentAdapterTurnResult>((resolve) => {
            input.signal.addEventListener(
              'abort',
              () => resolve({ status: 'cancelled', outputText: '' }),
              { once: true },
            );
            resolve({
              status: 'completed',
              outputText: 'The painted session dir.',
            });
          }),
      }),
      startTimers: false,
      recordWatchMs: 5,
    });
    const app = express();
    // No factory argument: the transport's own default is under test.
    registerA2ATransportRoutes(
      app,
      createWorkspaceRegistry([runtime]),
      undefined,
      undefined,
    );
    const grants = {
      share_1: await issueA2AGrant(projectRoot, {
        callerId: 'share_1',
        agentId: 'ag_lead',
      }),
      share_2: await issueA2AGrant(projectRoot, {
        callerId: 'share_2',
        agentId: 'ag_lead',
      }),
    };
    const call = (
      callerId: 'share_1' | 'share_2',
      method: string,
      params: unknown,
    ) =>
      request(app)
        .post('/a2a/v1')
        .set({
          'x-qwen-workspace-id': 'primary',
          'x-qwen-agent-id': 'ag_lead',
          authorization: `Bearer ${grants[callerId].secret}`,
          'x-qwen-caller-id': callerId,
          'A2A-Version': '1.0',
        })
        .send({ jsonrpc: '2.0', id: 1, method, params });

    try {
      const sent = await call('share_1', 'SendMessage', {
        message: {
          role: 'ROLE_USER',
          messageId: 'msg-1',
          parts: [{ text: 'Which dir does the transcript live in?' }],
        },
      });
      expect(sent.body.error).toBeUndefined();
      const taskId = sent.body.result.task.id as string;
      const contextId = sent.body.result.task.contextId as string;

      // COMPLETED with the answer only if the default factory reads the
      // reply record from THIS workspace's session runtime dir.
      await vi.waitFor(
        async () => {
          const polled = await call('share_1', 'GetTask', { id: taskId });
          expect(polled.body.result).toMatchObject({
            id: taskId,
            contextId,
            status: { state: 'TASK_STATE_COMPLETED' },
          });
          expect(JSON.stringify(polled.body.result.artifacts)).toContain(
            'The painted session dir.',
          );
        },
        { timeout: 5_000 },
      );

      // A session created for a refused message is discarded from that same
      // dir: its transcript is gone, not merely forgotten.
      appendExternalRecord.mockRejectedValueOnce(
        new Error('managed_session_unsupported'),
      );
      const refused = await call('share_2', 'SendMessage', {
        message: {
          role: 'ROLE_USER',
          messageId: 'msg-2',
          parts: [{ text: 'This mention is refused.' }],
        },
      });
      expect(refused.body.error).toMatchObject({ code: -32010 });
      expect(spawned).toHaveLength(2);
      expect(await transcripts.getSessionLocation(spawned[1]!)).toBeUndefined();
      // The completed task's session is untouched: only the discarded one
      // was removed.
      expect(await transcripts.getSessionLocation(contextId)).toBeDefined();
    } finally {
      await disposeSessionAgentOrchestrator(projectRoot);
    }
  });
});
