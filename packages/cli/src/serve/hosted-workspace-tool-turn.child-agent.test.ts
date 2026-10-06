/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Part } from '@google/genai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { managedExtensionRecordKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  HostedWorkspaceToolTurn,
  HOSTED_AGENT_TOOL,
} from './hosted-workspace-tool-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';

// H4b: the kind gate admits `child_agent` for real, so this suite runs
// without an enablement mock. The Broker is mocked as in the sibling
// suite: the agent path never dispatches through it, but the turn's
// constructor warms it.
const broker = vi.hoisted(() => ({
  fileHistory: vi.fn(),
  warm: vi.fn().mockResolvedValue(undefined),
  acquire: vi.fn().mockResolvedValue(undefined),
  prepare: vi.fn(),
  prepareV3: vi.fn(),
  execute: vi.fn(),
  executeV3: vi.fn(),
  acknowledgeV3: vi.fn(),
  cancel: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined),
  registerPublisher: vi.fn().mockResolvedValue('1'),
  acknowledge: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./hosted-workspace-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hosted-workspace-broker.js')>()),
  HostedWorkspaceBroker: class {
    readonly runtimeSessionId = 'prompt';
    fileHistory = broker.fileHistory;
    warm = broker.warm;
    acquire = broker.acquire;
    prepare = broker.prepare;
    prepareV3 = broker.prepareV3;
    execute = broker.execute;
    executeV3 = broker.executeV3;
    acknowledgeV3 = broker.acknowledgeV3;
    cancel = broker.cancel;
    release = broker.release;
    registerPublisher = broker.registerPublisher;
    acknowledge = broker.acknowledge;
  },
}));

let root: string;
let session: ManagedSession;
let children: HostedChildAgentSession;
let sessionKey: { tenantId: string; workspaceId: string; sessionId: string };
let consumption: string[];

const messageFitsInline = vi.fn<
  ConstructorParameters<typeof HostedWorkspaceToolTurn>[5]
>(() => true);

function call(
  args: Record<string, unknown>,
  callId = 'call-1',
): ToolCallRequestInfo {
  return {
    name: 'agent',
    callId,
    args,
    isClientInitiated: false,
    prompt_id: 'prompt',
  } as ToolCallRequestInfo;
}

function createTurn(depth = 0): HostedWorkspaceToolTurn {
  return new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    createManagedHarnessHandle(session),
    'prompt',
    async (type, messageParts, model, identity) => {
      const uuid = identity?.uuid ?? randomUUID();
      await session.sink.write({
        uuid,
        parentUuid: null,
        sessionId: sessionKey.sessionId,
        timestamp: identity?.timestamp ?? new Date().toISOString(),
        model,
        type,
        cwd: root,
        version: 'test',
        daemonPromptId: 'prompt',
        message: {
          role: type === 'assistant' ? 'model' : 'user',
          parts: messageParts,
        },
      });
      return uuid;
    },
    messageFitsInline,
    undefined,
    {
      resources: session.resources,
      assertWritable: async () => undefined,
    },
    undefined,
    undefined,
    'hosted-workspace-shell/1',
    undefined,
    undefined,
    undefined,
    undefined,
    {
      funnel: children,
      depth,
      queueConsumption: (childRunId) => consumption.push(childRunId),
    },
  );
}

async function executeAgent(
  turn: HostedWorkspaceToolTurn,
  agentCall: ToolCallRequestInfo,
  signal = new AbortController().signal,
): Promise<Part[]> {
  return turn.execute(
    [agentCall],
    [
      {
        functionCall: {
          id: agentCall.callId,
          name: 'agent',
          args: agentCall.args,
        },
      },
    ],
    'model',
    signal,
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  for (const method of [
    broker.warm,
    broker.acquire,
    broker.cancel,
    broker.release,
    broker.acknowledge,
  ])
    method.mockResolvedValue(undefined);
  broker.registerPublisher.mockResolvedValue('1');
  messageFitsInline.mockReturnValue(true);
  root = await mkdtemp(path.join(tmpdir(), 'hosted-agent-turn-'));
  sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const definitionRef = await resources.publish(
    'managed-definition',
    Buffer.from('{}'),
  );
  const rootSnapshotRef = await resources.publish(
    'managed-root',
    Buffer.from('{}'),
  );
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
    create: { definitionRef, rootSnapshotRef, createdBy: 'test' },
  });
  children = new HostedChildAgentSession(
    { authority: session.authority, resources: session.resources },
    sessionKey,
  );
  consumption = [];
});

afterEach(async () => {
  await session?.close();
  await rm(root, { recursive: true, force: true });
});

it('declares the agent tool at the root and hides it from a child Session', async () => {
  const rootTurn = createTurn(0);
  const rootTools = await rootTurn.declarations(new AbortController().signal);
  expect(rootTools.some((tool) => tool.name === 'agent')).toBe(true);
  expect(HOSTED_AGENT_TOOL.parametersJsonSchema).toMatchObject({
    required: ['description', 'prompt'],
    additionalProperties: false,
  });
  const childTurn = createTurn(1);
  const childTools = await childTurn.declarations(new AbortController().signal);
  expect(childTools.some((tool) => tool.name === 'agent')).toBe(false);
});

it('refuses v1-unsupported agent arguments with a named scope', async () => {
  const turn = createTurn();
  const responses = await executeAgent(
    turn,
    call({ description: 'audit', prompt: 'review', subagent_type: 'explore' }),
  );
  expect(JSON.stringify(responses)).toContain('unsupported argument');
  expect(JSON.stringify(responses)).toContain('subagent_type');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

it('refuses a malformed background flag and an oversized description', async () => {
  const turn = createTurn();
  const malformed = await executeAgent(
    turn,
    call({
      description: 'audit',
      prompt: 'review',
      run_in_background: 'maybe',
    }),
  );
  expect(JSON.stringify(malformed)).toContain('run_in_background');
  const oversized = await executeAgent(
    turn,
    call({ description: 'd'.repeat(513), prompt: 'review' }),
  );
  expect(JSON.stringify(oversized)).toContain('description');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

it('commits the launch intent on the sent arm and answers with the task id', async () => {
  const turn = createTurn();
  const responses = await executeAgent(
    turn,
    call({ description: 'audit the diff', prompt: 'review the change' }),
  );
  const childRunId = `prompt:call-1`;
  const record = children.record(childRunId)!;
  expect(record).toMatchObject({
    kind: 'child_agent',
    completion: 'sent',
    childSessionId: null,
    run: {
      state: 'admitted',
      execution: 'intent',
      delivery: { target: 'session', state: 'planned' },
    },
  });
  const taskId = `task_${managedExtensionRecordKey(sessionKey.sessionId, 'child_run', childRunId)}`;
  expect(JSON.stringify(responses)).toContain(taskId);
  expect(JSON.stringify(responses)).toContain('notification');
  expect(session.authority.taskViews()).toHaveLength(1);
});

it('refuses a fifth concurrent launch with the count limit', async () => {
  const turn = createTurn();
  for (let index = 0; index < 4; index++) {
    await executeAgent(
      turn,
      call(
        { description: `task ${index}`, prompt: `work ${index}` },
        `call-${index}`,
      ),
    );
  }
  const responses = await executeAgent(
    turn,
    call({ description: 'task 5', prompt: 'work 5' }, 'call-5'),
  );
  expect(JSON.stringify(responses)).toContain('count_limit');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    4,
  );
});

it('answers the tool arm from the committed acceptance, accepting it', async () => {
  const turn = createTurn();
  const childRunId = `prompt:call-1`;
  const driving = (async () => {
    // The relay's side: watch the launch commit, then drive its chain.
    for (;;) {
      if (children.record(childRunId) !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await children.dispatchStarted(childRunId, {
      dispatchId: 'dispatch-1',
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    });
    await children.attach(childRunId, '550e8400-e29b-41d4-a716-446655440001');
    await children.settleCompleted(childRunId, {
      result: Buffer.from('审阅通过,无阻断问题。', 'utf8'),
      receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
    });
    await children.accept(childRunId);
  })();
  const responses = (
    await Promise.all([
      executeAgent(
        turn,
        call({
          description: 'audit the diff',
          prompt: 'review the change',
          run_in_background: false,
        }),
      ),
      driving,
    ])
  )[0];
  expect(JSON.stringify(responses)).toContain('审阅通过');
  const record = children.record(childRunId)!;
  expect(record.run.delivery).toEqual({
    target: 'session',
    state: 'accepted',
  });
  expect(children.acceptance(childRunId)).toMatchObject({
    parentExecutionCallId: childRunId,
  });
  expect(consumption).toEqual([childRunId]);
});

it('tells a failed child without waiting for an acceptance', async () => {
  const turn = createTurn();
  const childRunId = `prompt:call-1`;
  const driving = (async () => {
    for (;;) {
      if (children.record(childRunId) !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await children.settleFailed(childRunId, {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
  })();
  const responses = (
    await Promise.all([
      executeAgent(
        turn,
        call({
          description: 'audit the diff',
          prompt: 'review the change',
          run_in_background: false,
        }),
      ),
      driving,
    ])
  )[0];
  expect(JSON.stringify(responses)).toContain('failed');
  expect(consumption).toEqual([]);
});

it('a cancelled turn abandons the answer but never the committed child', async () => {
  const turn = createTurn();
  const abort = new AbortController();
  const childRunId = `prompt:call-1`;
  setTimeout(() => abort.abort(), 200);
  const responses = await executeAgent(
    turn,
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: false,
    }),
    abort.signal,
  );
  expect(JSON.stringify(responses)).toContain('cancelled');
  const record = children.record(childRunId)!;
  expect(record.run.state).toBe('admitted');
  expect(record.run.execution).toBe('intent');
});

it('replays a re-driven batch into the original record, never a second one', async () => {
  const first = createTurn();
  await executeAgent(
    first,
    call({ description: 'audit the diff', prompt: 'review the change' }),
  );
  const second = createTurn();
  await executeAgent(
    second,
    call({ description: 'audit the diff', prompt: 'review the change' }),
  );
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    1,
  );
});
