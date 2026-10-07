/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A2A on sessions, end to end inside one daemon: the JSON-RPC transport,
 * core's grants and caller mapping, the session port and a real
 * SessionAgentOrchestrator. Only the ACP child (records) and the agent
 * program (turns) are fakes, so what is checked is the wiring between them:
 * a task becomes one agent run in a chat session, a context continues that
 * session, retries are idempotent and a caller reaches only its granted agent.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { issueA2AGrant } from '@qwen-code/qwen-code-core/agents/workspace-agents/a2a-grants.js';
import { updateWorkspaceAgents } from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import { createSquad } from '@qwen-code/qwen-code-core/agents/session-agents/squad-store.js';
import type { ConversationRecordLike } from '@qwen-code/qwen-code-core/agents/session-agents/conversation-delta.js';
import type {
  AgentAdapterTurnInput,
  AgentAdapterTurnResult,
  SessionAgentPermissionPrompt,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerA2ATransportRoutes } from '../routes/a2a.js';
import { SessionAgentEventHub } from './events.js';
import {
  SessionAgentOrchestrator,
  type SessionAgentBridge,
  type SessionAgentRecordWriter,
} from './orchestrator.js';
import {
  createA2ASessionPort,
  type A2ASessionBridge,
  type A2ATranscriptRecord,
} from './a2a-sessions.js';

type RecordRequest = Parameters<
  SessionAgentRecordWriter['appendExternalRecord']
>[1];

/** A transcript record as both the orchestrator and the A2A port read it. */
type StoredRecord = ConversationRecordLike & A2ATranscriptRecord;

/**
 * The daemon side the A2A port and the orchestrator share: session spawn,
 * and the ACP child's idempotent record writes, kept per session.
 */
class FakeDaemon {
  readonly spawned: string[] = [];
  private readonly records = new Map<string, StoredRecord[]>();
  private readonly keys = new Map<string, string>();
  private next = 0;

  spawnOrAttach = vi.fn(async () => {
    const sessionId = randomUUID();
    this.spawned.push(sessionId);
    this.records.set(sessionId, []);
    return { sessionId, workspaceCwd: projectRoot, attached: false };
  });

  updateSessionMetadata = vi.fn(() => ({}));

  appendExternalRecord = vi.fn(
    async (sessionId: string, record: RecordRequest) => {
      const existing = this.keys.get(record.recordKey);
      if (existing) return { sessionId, recordId: existing, created: false };
      const uuid = `rec-${++this.next}`;
      this.recordsOf(sessionId).push({
        uuid,
        type: 'user',
        subtype: record.kind,
        timestamp: new Date().toISOString(),
        systemPayload: record.payload,
      });
      this.keys.set(record.recordKey, uuid);
      return { sessionId, recordId: uuid, created: true };
    },
  );

  resumeSession = vi.fn(async () => ({}));

  recordsOf(sessionId: string): StoredRecord[] {
    let list = this.records.get(sessionId);
    if (!list) {
      list = [];
      this.records.set(sessionId, list);
    }
    return list;
  }
}

interface Turn {
  agentId: string;
  input: AgentAdapterTurnInput;
  finish(result?: Partial<AgentAdapterTurnResult>): void;
}

let runtimeDir: string;
let projectRoot: string;
let daemon: FakeDaemon;
let orchestrator: SessionAgentOrchestrator;
let turns: Turn[];
let app: express.Express;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-sessions-int-'));
  projectRoot = path.join(runtimeDir, 'project');
  Storage.setRuntimeBaseDir(runtimeDir);
  // The `session_send` server's command line names the CLI entry.
  vi.stubEnv('QWEN_CLI_ENTRY', '/opt/qwen/cli.js');

  await updateWorkspaceAgents(projectRoot, () => [
    {
      id: 'ag_alice',
      name: 'alice',
      createdAt: 1,
      execution: { mode: 'local', provider: 'claude' },
    },
    {
      id: 'ag_bob',
      name: 'bob',
      createdAt: 1,
      execution: { mode: 'local', provider: 'claude' },
    },
  ]);
  await createSquad(projectRoot, { name: 'crew', leaderAgentId: 'ag_bob' });

  daemon = new FakeDaemon();
  turns = [];
  orchestrator = new SessionAgentOrchestrator({
    workspaceCwd: projectRoot,
    bridge: daemon as unknown as SessionAgentBridge,
    hub: new SessionAgentEventHub(0),
    chainLimit: () => 0,
    loadRecords: async (sessionId) => daemon.recordsOf(sessionId),
    getAdapter: (program, context) => ({
      program,
      runTurn: (input) =>
        new Promise<AgentAdapterTurnResult>((resolve) => {
          input.signal.addEventListener(
            'abort',
            () => resolve({ status: 'cancelled', outputText: '' }),
            { once: true },
          );
          turns.push({
            agentId: context.agentId,
            input,
            finish: (result = {}) =>
              resolve({ status: 'completed', outputText: '', ...result }),
          });
        }),
    }),
    startTimers: false,
    recordWatchMs: 5,
  });

  const runtime = {
    workspaceId: 'primary',
    workspaceCwd: projectRoot,
    primary: true,
    trusted: true,
  } as WorkspaceRuntime;
  app = express();
  registerA2ATransportRoutes(
    app,
    createWorkspaceRegistry([runtime]),
    undefined,
    undefined,
    () =>
      createA2ASessionPort({
        workspaceCwd: projectRoot,
        bridge: daemon as unknown as A2ASessionBridge,
        orchestrator,
        loadRecords: async (sessionId) => daemon.recordsOf(sessionId),
      }),
  );
});

afterEach(async () => {
  await orchestrator.dispose();
  // Let cancelled turns finish their (now pointless) writes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  Storage.setRuntimeBaseDir(null);
  vi.unstubAllEnvs();
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

async function grantFor(agentId: string) {
  const callerId = `share_${agentId}`;
  const { secret } = await issueA2AGrant(projectRoot, { callerId, agentId });
  return (method: string, params: unknown) =>
    request(app)
      .post('/a2a/v1')
      .set({
        authorization: `Bearer ${secret}`,
        'x-qwen-workspace-id': 'primary',
        'x-qwen-caller-id': callerId,
        'x-qwen-agent-id': agentId,
        'A2A-Version': '1.0',
      })
      .send({ jsonrpc: '2.0', id: 1, method, params });
}

function message(messageId: string, text: string, contextId?: string) {
  return {
    message: {
      role: 'ROLE_USER',
      messageId,
      parts: [{ text }],
      ...(contextId ? { contextId } : {}),
    },
  };
}

describe('A2A on session agents', () => {
  it('runs a task as an agent turn in a session and continues that session by contextId', async () => {
    const call = await grantFor('ag_alice');

    const sent = await call(
      'SendMessage',
      message('m1', 'What is in README.md?'),
    );
    expect(sent.body.error).toBeUndefined();
    const task = sent.body.result.task as { id: string; contextId: string };
    // The context is the chat session the task runs in.
    expect(daemon.spawned).toEqual([task.contextId]);
    expect(daemon.updateSessionMetadata).toHaveBeenCalledWith(
      task.contextId,
      expect.objectContaining({ displayName: expect.stringContaining('A2A') }),
    );

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]!.agentId).toBe('ag_alice');
    expect(turns[0]!.input.prompt).toContain('What is in README.md?');
    turns[0]!.finish({ outputText: 'A short readme.', nativeSessionId: 'n1' });

    await vi.waitFor(async () => {
      const polled = await call('GetTask', { id: task.id });
      expect(polled.body.result).toMatchObject({
        id: task.id,
        contextId: task.contextId,
        status: { state: 'TASK_STATE_COMPLETED' },
      });
      expect(JSON.stringify(polled.body.result.artifacts)).toContain(
        'A short readme.',
      );
    });

    // A message in the same context is the agent's next turn in that
    // session, resuming its native session.
    const followUp = await call(
      'SendMessage',
      message('m2', 'And the license?', task.contextId),
    );
    expect(followUp.body.error).toBeUndefined();
    expect(followUp.body.result.task.contextId).toBe(task.contextId);
    expect(daemon.spawned).toHaveLength(1);
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]!.input.nativeSessionId).toBe('n1');
    expect(turns[1]!.input.prompt).toContain('And the license?');
  });

  it('answers a retry with the same task and refuses a reused message id', async () => {
    const call = await grantFor('ag_alice');
    const first = await call('SendMessage', message('m1', 'Check the build.'));
    const taskId = first.body.result.task.id as string;
    await vi.waitFor(() => expect(turns).toHaveLength(1));

    const retry = await call('SendMessage', message('m1', 'Check the build.'));
    expect(retry.body.error).toBeUndefined();
    expect(retry.body.result.task.id).toBe(taskId);

    const reused = await call('SendMessage', message('m1', 'Something else.'));
    expect(reused.body.error).toMatchObject({ code: -32011 });

    // Neither started another run or another session.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(turns).toHaveLength(1);
    expect(daemon.spawned).toHaveLength(1);
  });

  it('wakes only the granted agent, whatever the text mentions', async () => {
    const call = await grantFor('ag_alice');
    const sent = await call(
      'SendMessage',
      message('m1', 'Ask @bob and @crew about it.'),
    );
    expect(sent.body.error).toBeUndefined();

    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(turns.map((turn) => turn.agentId)).toEqual(['ag_alice']);
    const snapshot = await orchestrator.snapshot(
      sent.body.result.task.contextId,
    );
    expect(snapshot.map((frame) => frame.agentId)).toEqual(['ag_alice']);
  });

  it('reports a run waiting on approval as input required', async () => {
    const call = await grantFor('ag_alice');
    const sent = await call('SendMessage', message('m1', 'Create a2a.txt.'));
    const task = sent.body.result.task as { id: string; contextId: string };
    await vi.waitFor(() => expect(turns).toHaveLength(1));

    const prompt: SessionAgentPermissionPrompt = {
      requestId: 'p1',
      title: 'Write a2a.txt',
      toolName: 'write_file',
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    };
    const turn = turns[0]!;
    turn.input.onEvent({ type: 'permission_request', prompt });
    const answer = turn.input.awaitPermission(prompt);

    await vi.waitFor(async () => {
      const polled = await call('GetTask', { id: task.id });
      expect(polled.body.result.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
      expect(JSON.stringify(polled.body.result.metadata)).toContain(
        '"localStatus":"awaiting_approval"',
      );
    });

    // The workspace owner answers in the session; the caller cannot.
    orchestrator.resolvePermission(task.contextId, task.id, 'p1', 'yes');
    await expect(answer).resolves.toBe('yes');
    turn.input.onEvent({ type: 'permission_resolved', requestId: 'p1' });
    turn.finish({ outputText: 'Created a2a.txt.' });

    await vi.waitFor(async () => {
      const polled = await call('GetTask', { id: task.id });
      expect(polled.body.result.status.state).toBe('TASK_STATE_COMPLETED');
    });
  });
});
