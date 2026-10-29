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
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  HostedWorkspaceToolTurn,
  HostedToolRecoveryRequiredError,
  HOSTED_SEND_MESSAGE_TO_CHILD_TOOL,
  HOSTED_SEND_MESSAGE_TO_PARENT_TOOL,
} from './hosted-workspace-tool-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedTeamSession } from './hosted-team-session.js';
import { ManagedSessionRecordError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { ManagedSessionStoreTransportError } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  HostedSessionMessageSession,
  type HostedSessionLineage,
} from './hosted-session-message-session.js';

// H4d-b: `session_message` and continuations are enabled for real, so this
// suite runs without an enablement mock. The Broker is mocked as in the
// sibling suites: a message never dispatches through it, but the turn's
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
    resolveCapabilities = async () => {};
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
  name = 'send_message',
): ToolCallRequestInfo {
  return {
    name,
    callId,
    args,
    isClientInitiated: false,
    prompt_id: 'prompt',
  } as ToolCallRequestInfo;
}

function createTurn(
  depth = 0,
  lineage?: HostedSessionLineage,
  promptName = 'prompt',
  teams?: HostedTeamSession,
): HostedWorkspaceToolTurn {
  return new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    createManagedHarnessHandle(session),
    promptName,
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
        daemonPromptId: promptName,
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
    {
      profile: 'hosted-workspace-shell/1',
      childAgents: {
        funnel: children,
        depth,
        queueConsumption: (childRunId) => consumption.push(childRunId),
      },
      messages: new HostedSessionMessageSession(
        { authority: session.authority, resources: session.resources },
        sessionKey,
        children,
        lineage,
      ),
      teams,
    },
  );
}

async function execute(
  turn: HostedWorkspaceToolTurn,
  ...batch: ToolCallRequestInfo[]
): Promise<Part[]> {
  return turn.execute(
    batch,
    batch.map((entry) => ({
      functionCall: { id: entry.callId, name: entry.name, args: entry.args },
    })),
    'model',
    new AbortController().signal,
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

const PARENT_LINEAGE = (): HostedSessionLineage => ({
  parentSessionId: randomUUID(),
  parentChildRunId: 'parent-prompt:call-1',
});

async function launchChild(childRunId = 'prompt:call-0'): Promise<string> {
  await children.admit({
    childRunId,
    ownerScopeId: sessionKey.sessionId,
    rootSessionId: sessionKey.sessionId,
    completion: 'sent',
    description: 'audit the diff',
    prompt: 'review the change',
    definition: {
      definitionId: 'hosted-agent/hosted-workspace-shell/1',
      definitionRevision: 1,
      definitionDigest: session.authority.sessionHeader.definitionRef.digest,
    },
    workingDirectory: '.',
    workspaceMode: 'shared',
    executionCallId: childRunId,
  });
  return children.taskIdOf(childRunId);
}

function messages() {
  return session.authority
    .extensionRecordsInDomain('session_message')
    .map((entry) => entry.record as Record<string, unknown>);
}

it('declares the task form at the root and the parent form in a child', async () => {
  const rootTools = await createTurn(0).declarations(
    new AbortController().signal,
  );
  expect(rootTools.filter((tool) => tool.name === 'send_message')).toEqual([
    HOSTED_SEND_MESSAGE_TO_CHILD_TOOL,
  ]);
  expect(HOSTED_SEND_MESSAGE_TO_CHILD_TOOL.parametersJsonSchema).toMatchObject({
    required: ['task_id', 'message'],
    additionalProperties: false,
  });
  const childTools = await createTurn(1, PARENT_LINEAGE()).declarations(
    new AbortController().signal,
  );
  expect(childTools.filter((tool) => tool.name === 'send_message')).toEqual([
    HOSTED_SEND_MESSAGE_TO_PARENT_TOOL,
  ]);
  expect(childTools.some((tool) => tool.name === 'agent')).toBe(false);
});

it('refuses arguments outside each form, committing nothing', async () => {
  const root = createTurn();
  for (const args of [
    { to: 'teammate', message: 'hi' },
    { task_id: '  ', message: 'hi' },
    { task_id: 'task_x', message: '   ' },
  ]) {
    const responses = await execute(root, call(args));
    expect(JSON.stringify(responses)).toContain('Hosted send_message');
  }
  const child = createTurn(1, PARENT_LINEAGE());
  for (const args of [
    { to: 'leader', message: 'hi' },
    { task_id: 'task_x', message: 'hi' },
  ]) {
    const responses = await execute(child, call(args));
    expect(JSON.stringify(responses)).toContain('Hosted send_message');
  }
  expect(messages()).toHaveLength(0);
});

it('queues a message to a running child without taking the mount', async () => {
  const taskId = await launchChild();
  const turn = createTurn();
  const responses = await execute(
    turn,
    call({ task_id: taskId, message: 'also check the tests' }),
  );
  expect(JSON.stringify(responses)).toContain('Message queued for delivery');
  expect(JSON.stringify(responses)).toContain(taskId);
  expect(broker.acquire).not.toHaveBeenCalled();
  expect(messages()).toEqual([
    expect.objectContaining({
      direction: 'outbound',
      route: 'to_child',
      childRunId: 'prompt:call-0',
      senderSessionId: sessionKey.sessionId,
    }),
  ]);
  // A re-driven batch of the same turn names the same message again.
  await execute(
    createTurn(),
    call({ task_id: taskId, message: 'also check the tests' }),
  );
  expect(messages()).toHaveLength(1);
});

it('continues a completed child and answers the new task id', async () => {
  const taskId = await launchChild();
  await children.dispatchStarted('prompt:call-0', {
    dispatchId: 'dispatch-1',
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach('prompt:call-0', randomUUID());
  await children.settleCompleted('prompt:call-0', {
    result: Buffer.from('clean'),
    receipt: Buffer.from('{}'),
  });
  const responses = await execute(
    createTurn(),
    call({ task_id: taskId, message: 'now fix the tests' }),
  );
  const continued = children.taskIdOf('prompt:call-1');
  expect(JSON.stringify(responses)).toContain(`continued it as ${continued}`);
  expect(children.record('prompt:call-1')).toMatchObject({
    predecessorChildRunId: 'prompt:call-0',
    completion: 'sent',
  });
  expect(messages()).toHaveLength(0);
});

it('answers an unknown task with an error and commits nothing', async () => {
  const responses = await execute(
    createTurn(),
    call({ task_id: 'task_missing', message: 'hello' }),
  );
  expect(JSON.stringify(responses)).toContain('No child agent task');
  expect(messages()).toHaveLength(0);
});

it('queues a child message to its parent', async () => {
  const lineage = PARENT_LINEAGE();
  const responses = await execute(
    createTurn(1, lineage),
    call({ to: 'parent', message: 'which branch?' }),
  );
  expect(JSON.stringify(responses)).toContain(
    'Message queued for delivery to the parent agent',
  );
  expect(messages()).toEqual([
    expect.objectContaining({
      direction: 'outbound',
      route: 'to_parent',
      childRunId: lineage.parentChildRunId,
      targetSessionId: null,
    }),
  ]);
});

it.each(['child', 'task', 'member', 'broadcast'] as const)(
  'refuses encoded overflow on the %s lane before routing (#14062)',
  async (lane) => {
    const taskId = lane === 'task' ? await launchChild() : undefined;
    const teams =
      lane === 'member' || lane === 'broadcast'
        ? new HostedTeamSession(
            { authority: session.authority, resources: session.resources },
            sessionKey,
          )
        : undefined;
    const turn = createTurn(
      lane === 'child' ? 1 : 0,
      lane === 'child' ? PARENT_LINEAGE() : undefined,
      'prompt',
      teams,
    );
    const target =
      lane === 'task'
        ? { task_id: taskId }
        : { to: lane === 'child' ? 'parent' : lane === 'member' ? 'bob' : '*' };
    const responses = await execute(
      turn,
      call({ ...target, message: '"\\\n\u0001中😀'.repeat(3000) }, 'dense'),
    );
    expect(responses[0].functionResponse).toMatchObject({
      id: 'dense',
      name: 'send_message',
    });
    expect(JSON.stringify(responses)).toContain(
      'Hosted send_message exceeds the 65536-byte inline Session Store limit once encoded (byte_limit); shorten the message or other arguments and retry.',
    );
    expect(messages()).toHaveLength(0);
    expect(
      session.authority.extensionRecordsInDomain('child_run'),
    ).toHaveLength(lane === 'task' ? 1 : 0);
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
    if (lane === 'child') {
      const retry = await execute(
        turn,
        call({ to: 'parent', message: 'shorter' }, 'retry'),
      );
      expect(JSON.stringify(retry)).toContain('queued for delivery');
      expect(messages()).toHaveLength(1);
    }
  },
);

it('keeps ordinary tool input overflow fatal (#14062)', async () => {
  await expect(
    execute(
      createTurn(),
      call(
        { file_path: 'note', content: '"'.repeat(20_000) },
        'write',
        'write_file',
      ),
    ),
  ).rejects.toThrow(
    'Hosted tool input exceeds the inline Session Store limit.',
  );
  expect(broker.acquire).not.toHaveBeenCalled();
});

it.each([65_536, 65_537])(
  'uses the real encoder at the %i-byte boundary (#14062)',
  async (bytes) => {
    const turn = createTurn(1, PARENT_LINEAGE());
    const encoder = turn as unknown as {
      encodeToolInput(payload: { toolName: string; input: unknown }): {
        inputBytes: Buffer;
      };
    };
    const overhead = encoder.encodeToolInput({
      toolName: 'send_message',
      input: { to: 'parent', message: '' },
    }).inputBytes.length;
    const encode = vi.spyOn(encoder, 'encodeToolInput');
    const responses = await execute(
      turn,
      call({ to: 'parent', message: 'x'.repeat(bytes - overhead) }),
    );
    expect(encode).toHaveBeenCalledOnce();
    if (bytes === 65_536) {
      expect(encode.mock.results[0].value.inputBytes).toHaveLength(bytes);
      expect(JSON.stringify(responses)).toContain('queued for delivery');
      expect(messages()).toHaveLength(1);
    } else {
      expect(encode.mock.results[0].type).toBe('throw');
      expect(JSON.stringify(responses)).toContain('once encoded (byte_limit)');
      expect(messages()).toHaveLength(0);
    }
  },
);

it.each(['assistant', 'tool_result'] as const)(
  'requires recovery when the overflow %s cannot commit (#14062)',
  async (failedType) => {
    const write = session.sink.write.bind(session.sink);
    const writes = vi
      .spyOn(session.sink, 'write')
      .mockImplementation((record) => {
        if (record.type === failedType) throw new Error('Store unavailable');
        return write(record);
      });
    await expect(
      execute(
        createTurn(1, PARENT_LINEAGE()),
        call({ to: 'parent', message: '"'.repeat(20_000) }),
      ),
    ).rejects.toBeInstanceOf(HostedToolRecoveryRequiredError);
    expect(writes.mock.calls.map(([record]) => record.type)).toEqual(
      failedType === 'assistant' ? ['assistant'] : ['assistant', 'tool_result'],
    );
    expect((await session.sink.project()).map((record) => record.type)).toEqual(
      failedType === 'assistant' ? [] : ['assistant'],
    );
    expect(messages()).toHaveLength(0);
  },
);

it.each(['to', 'task_id'] as const)(
  'identifies oversized %s arguments when the message is short (#14062)',
  async (recipientKey) => {
    const teams =
      recipientKey === 'to'
        ? new HostedTeamSession(
            { authority: session.authority, resources: session.resources },
            sessionKey,
          )
        : undefined;
    const responses = await execute(
      createTurn(0, undefined, 'prompt', teams),
      call(
        { [recipientKey]: '"'.repeat(20_000), message: 'hi' },
        'recipient-dense',
      ),
    );
    expect(responses[0].functionResponse).toMatchObject({
      id: 'recipient-dense',
      name: 'send_message',
      response: {
        error: expect.stringContaining(
          'shorten the message or other arguments',
        ),
      },
    });
    expect(messages()).toHaveLength(0);
    expect(broker.acquire).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
  },
);

it('runs a launch and a message in one batch without the mount', async () => {
  const taskId = await launchChild();
  const turn = createTurn();
  const responses = await execute(
    turn,
    call({ task_id: taskId, message: 'heads up' }, 'call-1'),
    call(
      { description: 'second', prompt: 'work', run_in_background: true },
      'call-2',
      'agent',
    ),
  );
  expect(JSON.stringify(responses)).toContain('Message queued');
  expect(JSON.stringify(responses)).toContain('started in the background');
  expect(broker.acquire).not.toHaveBeenCalled();
});

it("answers a store refusal but fails the call on the store's own faults", async () => {
  const taskId = await launchChild();
  const send = vi.spyOn(children, 'sendToChild');
  send.mockRejectedValueOnce(
    new ManagedSessionRecordError('The Session is closing.'),
  );
  const refused = await execute(
    createTurn(),
    call({ task_id: taskId, message: 'refused' }, 'call-1'),
  );
  expect(JSON.stringify(refused)).toContain(
    'The message was refused: The Session is closing.',
  );
  // A fault whose commit may still land is never told to the model as a
  // message that was not sent: the turn fails into recovery instead.
  send.mockRejectedValueOnce(
    new ManagedSessionStoreTransportError('store unreachable'),
  );
  await expect(
    execute(createTurn(), call({ task_id: taskId, message: 'x' }, 'call-2')),
  ).rejects.toThrow('requires recovery');
});
