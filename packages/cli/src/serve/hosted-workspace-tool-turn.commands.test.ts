/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Part } from '@google/genai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { sessionCommandId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-operations.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import {
  HostedSessionCommandSession,
  SESSION_COMMAND_LEADER_UNANSWERING_TEXT,
  sessionCommandEvidenceText,
} from './hosted-session-command-session.js';
import {
  HostedSessionMessageSession,
  type HostedSessionLineage,
} from './hosted-session-message-session.js';
import { hostedPromptKey, teamMemberPreamble } from './hosted-member-chain.js';

// H4e-b3: a member Session's board tools ride the command channel. The
// suite runs the real funnel chain — the park checkpoint, the outbound
// entry, and the reply drive by the relay — and never the lead's
// `execute`, which the funnel suite owns. The Broker is mocked as in the
// sibling suites: the turn's constructor warms it, and a command batch
// takes the mount only when a sibling needs it.
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

const PARENT = randomUUID();
const LEAF_RUN = 'run-leaf';

let rootDir: string;
let session: ManagedSession;
let children: HostedChildAgentSession;
let commands: HostedSessionCommandSession;
let sessionKey: { tenantId: string; workspaceId: string; sessionId: string };
const lineage: HostedSessionLineage = {
  parentSessionId: PARENT,
  parentChildRunId: LEAF_RUN,
};

const messageFitsInline = vi.fn<
  ConstructorParameters<typeof HostedWorkspaceToolTurn>[5]
>(() => true);

function call(
  args: Record<string, unknown>,
  callId: string,
  name: string,
): ToolCallRequestInfo {
  return {
    name,
    callId,
    args,
    isClientInitiated: false,
    prompt_id: 'prompt',
  } as ToolCallRequestInfo;
}

function createTurn(promptName = 'prompt'): HostedWorkspaceToolTurn {
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
        cwd: rootDir,
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
        depth: 1,
        queueConsumption: () => undefined,
      },
      messages: new HostedSessionMessageSession(
        { authority: session.authority, resources: session.resources },
        sessionKey,
        children,
        lineage,
      ),
      commands,
    },
  );
}

async function execute(
  turn: HostedWorkspaceToolTurn,
  batch: ToolCallRequestInfo[],
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

function commandIdOf(callId: string, promptName = 'prompt'): string {
  return sessionCommandId({
    senderSessionId: sessionKey.sessionId,
    promptKey: hostedPromptKey(promptName),
    callId,
  });
}

/** The run's first input, accepted the way the launch route commits it. */
async function seedFirstInput(text: string): Promise<void> {
  // The admission content mirrors the shape the real launch committer
  // writes: an OpenAI message-content array, not a bare {text} map.
  const contentRef = await session.resources.publish(
    'managed-input',
    Buffer.from(JSON.stringify([{ type: 'text', text }]), 'utf8'),
  );
  const admissionRef = await session.resources.publish(
    'managed-admission',
    Buffer.from('{}', 'utf8'),
  );
  await session.authority.submitInput(
    {
      operation: 'submitInput',
      commandId: 'first-input',
      sessionKey,
      contentDigest: createHash('sha256')
        .update(JSON.stringify({ text }))
        .digest('hex'),
    },
    {
      inputId: 'first-input',
      turnId: 'first-input',
      source: 'test',
      contentRef,
      deadline: null,
      admissionRef,
      wakeReason: 'input',
    },
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
  rootDir = await mkdtemp(path.join(tmpdir(), 'hosted-command-turn-'));
  sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: rootDir,
    sessionKey,
  });
  session = await openManagedSession({
    runtimeBaseDir: rootDir,
    cwd: rootDir,
    transcriptPath: path.join(rootDir, 'transcript.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from('{}'),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from('{}'),
      ),
      createdBy: 'test',
    },
  });
  children = new HostedChildAgentSession(
    { authority: session.authority, resources: session.resources },
    sessionKey,
  );
  commands = new HostedSessionCommandSession(
    { authority: session.authority, resources: session.resources },
    sessionKey,
    children,
    lineage,
  );
  // A live turn always holds the harness's before_model checkpoint from
  // its start; commit it here so the command arms meet the same durable
  // basis the real driver provides.
  await createManagedHarnessHandle(session).ensureCheckpoint();
});

afterEach(async () => {
  vi.useRealTimers();
  await session?.close();
  await rm(rootDir, { recursive: true, force: true });
});

function texts(parts: Part[]): string {
  // Refusal parts are functionResponse-shaped, so assert on the whole
  // serialization rather than on a text field that never exists.
  return JSON.stringify(parts);
}

it('declares the member board tools behind the member preamble of a launch', async () => {
  await seedFirstInput(
    `[triage the diff]\n\n${teamMemberPreamble({ name: 'alice', teamName: 'review' })}fix the board`,
  );
  const names = (
    await createTurn().declarations(new AbortController().signal)
  ).map((tool) => tool.name);
  expect(names).toContain('task_list');
  expect(names).toContain('task_create');
  expect(names).toContain('task_update');
});

it('declares the member board tools behind the continuation-form preamble', async () => {
  await seedFirstInput(
    `earlier work happened.\n\nYour next instruction:\n${teamMemberPreamble({ name: 'alice', teamName: 'review' })}wrap up`,
  );
  const names = (
    await createTurn().declarations(new AbortController().signal)
  ).map((tool) => tool.name);
  expect(names).toContain('task_list');
});

it('leaves the member board tools undeclared without the preamble', async () => {
  await seedFirstInput('fix the fence');
  const names = (
    await createTurn().declarations(new AbortController().signal)
  ).map((tool) => tool.name);
  expect(names).not.toContain('task_list');
  expect(names).not.toContain('task_create');
  expect(names).not.toContain('task_update');
});

it('refuses a command sharing its batch with Workspace or Runtime work', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) + 'board first',
  );
  const parts = await execute(createTurn(), [
    call({ subject: 'x', description: 'y' }, 'call-c1', 'task_create'),
    call({ command: 'echo hi' }, 'call-c2', 'run_shell_command'),
  ]);
  const text = texts(parts);
  expect(text).toContain(
    'cannot share a batch with Workspace or Runtime calls',
  );
  expect(parts).toHaveLength(2);
  // The batch died at validation: no command checkpoint, no outbox entry.
  expect(commands.command(commandIdOf('call-c1'))).toBeUndefined();
});

it('parks on the command checkpoint, answers from the reply, and marks it consumed', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'read the board',
  );
  const turn = createTurn();
  const running = execute(turn, [
    call({ status: 'pending' }, 'call-list-1', 'task_list'),
  ]);
  const commandId = commandIdOf('call-list-1');
  await vi.waitFor(() => {
    expect(commands.command(commandId)).toBeDefined();
  });
  // The checkpoint named the batch before the outbox commit ever ran.
  const authority = await session.authority.harnessRunAuthorization();
  if (authority.status !== 'runnable')
    throw new Error(`expected runnable, got ${authority.status}`);
  expect(authority.checkpoint.continuation.phase).toBe('await_command');
  expect(authority.checkpoint.commandWait?.runs).toHaveLength(1);
  expect(authority.checkpoint.commandWait?.runs[0]?.commandId).toBe(commandId);
  await commands.handover(commandId, PARENT);
  await commands.answered(commandId, {
    outcome: 'answered',
    text: '#1 pending: ship the fix',
  });
  const parts = await running;
  expect(texts(parts)).toContain('#1 pending: ship the fix');
  expect(commands.command(commandId)?.run.delivery?.state).toBe('consumed');
  const settled = await session.authority.harnessRunAuthorization();
  if (settled.status !== 'runnable')
    throw new Error(`expected runnable, got ${settled.status}`);
  expect(settled.checkpoint.continuation.phase).toBe('model_output_committed');
  expect(settled.checkpoint.commandWait?.runs.every((run) => run.folded)).toBe(
    true,
  );
});

it('answers a never-handed command as not sent when the wait bound ends', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  const turn = createTurn();
  const running = execute(turn, [
    call({ subject: 'x', description: 'y' }, 'call-cx', 'task_create'),
  ]);
  const commandId = commandIdOf('call-cx');
  await vi.waitFor(
    () => {
      expect(commands.command(commandId)).toBeDefined();
    },
    { timeout: 10_000 },
  );
  vi.setSystemTime(Date.now() + 121_000);
  const parts = await running;
  expect(texts(parts)).toContain('was not sent and nothing happened');
  expect(commands.command(commandId)?.run.delivery?.state).toBe('cancelled');
});

it('answers a handed command as unknown past the bound and locks the batch after it', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) + 'write twice',
  );
  const turn = createTurn();
  const running = execute(turn, [
    call({ subject: 'x', description: 'y' }, 'call-cw', 'task_create'),
    call({ status: 'pending' }, 'call-lw', 'task_list'),
  ]);
  const commandId = commandIdOf('call-cw');
  await vi.waitFor(
    () => {
      expect(commands.command(commandId)).toBeDefined();
    },
    { timeout: 10_000 },
  );
  await commands.handover(commandId, PARENT);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 121_000);
  const parts = await running;
  const text = texts(parts);
  expect(text).toContain('reached the leader, but its reply did not arrive');
  expect(text).toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(commandId)?.run.delivery?.state).toBe('unknown');
  // The later call never minted an outbox entry of its own.
  expect(commands.command(commandIdOf('call-lw'))).toBeUndefined();
});

// The checkpoint names the whole batch, so an owner that dies between
// the park commit and its first outbound leaves a run with no record.
// The recovered wait answers it as not sent and folds — never tries to
// settle a record that does not exist.
it('on resume folds a checkpointed call whose outbound never committed, as not sent', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const commandId = commandIdOf('call-lost');
  const harness = createManagedHarnessHandle(session);
  const argsRef = await session.resources.publish(
    'managed-command-args',
    Buffer.from(JSON.stringify({ subject: 'x', description: 'y' }), 'utf8'),
  );
  await harness.commitAwaitCommand(
    [
      {
        commandId,
        functionCallId: 'call-lost',
        toolName: 'task_create',
        modelMessageId: 'assistant-lost',
        folded: false,
      },
    ],
    { turnId: 'prompt', promptId: 'prompt' },
    {
      holdsWorkspaceMount: false,
      attempt: { attemptId: 'assistant-lost', routeRef: argsRef },
    },
  );
  expect(commands.command(commandId)).toBeUndefined();
  const parked = await session.authority.harnessRunAuthorization();
  if (parked.status !== 'runnable')
    throw new Error(`expected runnable, got ${parked.status}`);
  expect(parked.checkpoint.continuation.phase).toBe('await_command');
  const turn = createTurn();
  await expect(
    turn.resumeCommandWaitRuns(
      parked.checkpoint.commandWait?.runs ?? [],
      false,
      'model',
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
  // The not-sent answer is journaled under the call's own id — word for
  // word the live arm's planned answer (decision 14).
  const projected = await session.sink.project();
  const parts = projected
    .filter(
      (entry) =>
        entry.daemonPromptId === 'prompt' && entry.type === 'tool_result',
    )
    .flatMap((entry) => entry.message?.parts ?? []);
  expect(JSON.stringify(parts)).toContain('call-lost');
  expect(JSON.stringify(parts)).toContain('was not sent and nothing happened');
  const settled = await session.authority.harnessRunAuthorization();
  if (settled.status !== 'runnable')
    throw new Error(`expected runnable, got ${settled.status}`);
  expect(settled.checkpoint.continuation.phase).toBe('model_output_committed');
  // Nothing settled a record: none exists, and that is the point.
  expect(commands.command(commandId)).toBeUndefined();
});

// The cancelled-signal arm of the same wait: a cancelled recovery must
// not fall into the settle arm for a record that does not exist.
it('on resume folds a checkpointed call whose outbound never committed, as not sent, with the recovery cancelled', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const commandId = commandIdOf('call-lost');
  const harness = createManagedHarnessHandle(session);
  const argsRef = await session.resources.publish(
    'managed-command-args',
    Buffer.from(JSON.stringify({ subject: 'x', description: 'y' }), 'utf8'),
  );
  await harness.commitAwaitCommand(
    [
      {
        commandId,
        functionCallId: 'call-lost',
        toolName: 'task_create',
        modelMessageId: 'assistant-lost',
        folded: false,
      },
    ],
    { turnId: 'prompt', promptId: 'prompt' },
    {
      holdsWorkspaceMount: false,
      attempt: { attemptId: 'assistant-lost', routeRef: argsRef },
    },
  );
  const parked = await session.authority.harnessRunAuthorization();
  if (parked.status !== 'runnable')
    throw new Error(`expected runnable, got ${parked.status}`);
  const turn = createTurn();
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    turn.resumeCommandWaitRuns(
      parked.checkpoint.commandWait?.runs ?? [],
      false,
      'model',
      aborted.signal,
    ),
  ).resolves.toBeUndefined();
  const projected = await session.sink.project();
  const parts = projected
    .filter(
      (entry) =>
        entry.daemonPromptId === 'prompt' && entry.type === 'tool_result',
    )
    .flatMap((entry) => entry.message?.parts ?? []);
  expect(JSON.stringify(parts)).toContain('call-lost');
  expect(JSON.stringify(parts)).toContain('was not sent and nothing happened');
  const settled = await session.authority.harnessRunAuthorization();
  if (settled.status !== 'runnable')
    throw new Error(`expected runnable, got ${settled.status}`);
  expect(settled.checkpoint.commandWait?.runs.every((run) => run.folded)).toBe(
    true,
  );
  expect(commands.command(commandId)).toBeUndefined();
});

// Decision 4's lock is durable: once one command of the Turn timed out
// the fold carries the stamp, so a replacement owner of the same prompt
// refuses the next command at once — and re-stamps the fresh group, so
// the lock outlives every owner.
it('keeps a timed-out Turn locked across owners', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const turn = createTurn();
  const running = execute(turn, [
    call({ subject: 'x', description: 'y' }, 'call-live', 'task_create'),
  ]);
  const commandId = commandIdOf('call-live');
  await vi.waitFor(
    () => {
      expect(commands.command(commandId)).toBeDefined();
    },
    { timeout: 10_000 },
  );
  await commands.handover(commandId, PARENT);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 121_000);
  await running;
  expect(commands.command(commandId)?.run.delivery?.state).toBe('unknown');
  vi.useRealTimers();
  const stamped = await session.authority.harnessRunAuthorization();
  if (stamped.status !== 'runnable')
    throw new Error(`expected runnable, got ${stamped.status}`);
  expect(stamped.checkpoint.commandWait?.timedOut).toBe(true);

  // The replacement owner: the same prompt, a fresh Turn.
  const restarted = createTurn();
  const parts = await execute(restarted, [
    call({ subject: 'z', description: 'w' }, 'call-after', 'task_create'),
  ]);
  expect(texts(parts)).toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(commandIdOf('call-after'))).toBeUndefined();
  const restamped = await session.authority.harnessRunAuthorization();
  if (restamped.status !== 'runnable')
    throw new Error(`expected runnable, got ${restamped.status}`);
  expect(restamped.checkpoint.commandWait?.timedOut).toBe(true);

  // And the owner after that, from the re-stamped group alone.
  const next = createTurn();
  const again = await execute(next, [
    call({ status: 'pending' }, 'call-final', 'task_list'),
  ]);
  expect(texts(again)).toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(commandIdOf('call-final'))).toBeUndefined();
});

// The crash window between the timeout answer and the fold that would
// stamp the group: the dead owner's result committed, the fold never
// landed, and the checkpoint still says timedOut=false. The takeover
// re-arms from the journaled answer itself — never mints an outbound.
it('re-arms the timeout lock from the journaled answer when the fold never landed', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const commandId = commandIdOf('call-crash');
  await commands.runCommand({
    commandId,
    kind: 'board_write',
    args: { subject: 'x', description: 'y' },
    executionCallId: 'call-crash',
    closing: false,
  });
  await commands.handover(commandId, PARENT);
  await commands.settle(commandId, 'unknown');
  const argsRef = await session.resources.publish(
    'managed-command-args',
    Buffer.from(JSON.stringify({ subject: 'x', description: 'y' }), 'utf8'),
  );
  const harness = createManagedHarnessHandle(session);
  await harness.commitAwaitCommand(
    [
      {
        commandId,
        functionCallId: 'call-crash',
        toolName: 'task_create',
        modelMessageId: 'assistant-crash',
        folded: false,
      },
    ],
    { turnId: 'prompt', promptId: 'prompt' },
    {
      holdsWorkspaceMount: false,
      attempt: { attemptId: 'assistant-crash', routeRef: argsRef },
    },
  );
  // The dead owner's timeout answer, committed before the fold that
  // never landed (decision 14's accepting text, word for word).
  await session.sink.write({
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: sessionKey.sessionId,
    timestamp: new Date().toISOString(),
    model: 'model',
    type: 'tool_result',
    cwd: rootDir,
    version: 'test',
    daemonPromptId: 'prompt',
    message: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'call-crash',
            name: 'task_create',
            response: {
              error: { message: sessionCommandEvidenceText('accepting') },
            },
          },
        },
      ],
    },
  });
  await harness.resolveAwaitCommand(commandId);
  const crashstate = await session.authority.harnessRunAuthorization();
  if (crashstate.status !== 'runnable')
    throw new Error(`expected runnable, got ${crashstate.status}`);
  expect(crashstate.checkpoint.commandWait?.timedOut).toBe(false);

  const restarted = createTurn();
  const parts = await execute(restarted, [
    call({ subject: 'z', description: 'w' }, 'call-after', 'task_create'),
  ]);
  expect(texts(parts)).toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(commandIdOf('call-after'))).toBeUndefined();
  const restamped = await session.authority.harnessRunAuthorization();
  if (restamped.status !== 'runnable')
    throw new Error(`expected runnable, got ${restamped.status}`);
  expect(restamped.checkpoint.commandWait?.timedOut).toBe(true);
});

// A budget refusal is a normal local answer, so it owes the parked wait
// its fold: a durable wait left behind turns the Turn's next call into a
// recovery fault instead of the same local refusal.
it('folds the parked wait on a budget refusal, so the next call refuses the same way', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board forever',
  );
  // Mint the per-run budget by hand: a direct count of outbound records
  // is the rule's own evidence.
  for (let index = 0; index < 256; index += 1) {
    await commands.runCommand({
      commandId: commandIdOf(`budget-seed-${index}`),
      kind: 'board_read',
      args: { filter: 'all' },
      executionCallId: `budget-seed-${index}`,
      closing: false,
    });
  }
  const parts = await execute(createTurn(), [
    call({ subject: 'x', description: 'y' }, 'call-over', 'task_create'),
  ]);
  expect(texts(parts)).toContain('budget_exhausted');
  const folded = await session.authority.harnessRunAuthorization();
  if (folded.status !== 'runnable')
    throw new Error(`expected runnable, got ${folded.status}`);
  expect(folded.checkpoint.continuation.phase).toBe('model_output_committed');
  // The Turn's next call meets the same local refusal, never a recovery
  // fault from its own durable wait.
  const again = await execute(createTurn(), [
    call({ subject: 'x', description: 'y' }, 'call-over-2', 'task_create'),
  ]);
  expect(texts(again)).toContain('budget_exhausted');
}, 60_000);
