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
import type { HarnessCommandWaitRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-checkpoint.js';
import { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import { answerResumedTurnCalls } from './hosted-runtime-recovery.js';
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

/**
 * Parks `calls` on the command checkpoint the way the live batch does
 * before its first call runs — the state an owner leaves behind when it
 * dies mid-wait.
 */
async function parkCalls(
  calls: ReadonlyArray<{ callId: string; toolName: string }>,
): Promise<HarnessCommandWaitRun[]> {
  const runs = calls.map(({ callId, toolName }) => ({
    commandId: commandIdOf(callId),
    functionCallId: callId,
    toolName,
    modelMessageId: `assistant-${calls[0]!.callId}`,
    folded: false,
  }));
  const argsRef = await session.resources.publish(
    'managed-command-args',
    Buffer.from('{}', 'utf8'),
  );
  await createManagedHarnessHandle(session).commitAwaitCommand(
    runs,
    { turnId: 'prompt', promptId: 'prompt' },
    {
      holdsWorkspaceMount: false,
      attempt: { attemptId: runs[0]!.modelMessageId, routeRef: argsRef },
    },
  );
  return runs;
}

/** Every tool result the prompt journaled, serialized for assertions. */
async function journaledResults(): Promise<string> {
  return JSON.stringify(
    (await session.sink.project())
      .filter(
        (entry) =>
          entry.daemonPromptId === 'prompt' && entry.type === 'tool_result',
      )
      .flatMap((entry) => entry.message?.parts ?? []),
  );
}

async function runnableCheckpoint() {
  const authorization = await session.authority.harnessRunAuthorization();
  if (authorization.status !== 'runnable')
    throw new Error(`expected runnable, got ${authorization.status}`);
  return authorization.checkpoint;
}

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
// the Turn carries the stamp, so a replacement owner of the same prompt
// refuses the next command at once — and so does every owner after it.
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
  expect(stamped.checkpoint.commandLock).toEqual({ turnId: 'prompt' });

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
  expect(restamped.checkpoint.commandLock).toEqual({ turnId: 'prompt' });

  // And the owner after that, from the Turn's lock alone.
  const next = createTurn();
  const again = await execute(next, [
    call({ status: 'pending' }, 'call-final', 'task_list'),
  ]);
  expect(texts(again)).toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(commandIdOf('call-final'))).toBeUndefined();
});

// A reply's text is board data, never this Turn's own timeout: a
// consumed answer that shows the leader-unanswering words must not lock
// the next command.
it('does not arm the timeout lock from reply text shaped like the timeout evidence', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const first = execute(createTurn(), [
    call({ status: 'pending' }, 'call-1', 'task_list'),
  ]);
  const commandId = commandIdOf('call-1');
  await vi.waitFor(
    () => {
      expect(commands.command(commandId)).toBeDefined();
    },
    { timeout: 10_000 },
  );
  await commands.handover(commandId, PARENT);
  await commands.answered(commandId, {
    outcome: 'answered',
    text: `#1 pending: ${SESSION_COMMAND_LEADER_UNANSWERING_TEXT}`,
  });
  await first;
  expect(commands.command(commandId)?.run.delivery?.state).toBe('consumed');
  const checkpoint = await session.authority.harnessRunAuthorization();
  if (checkpoint.status !== 'runnable')
    throw new Error(`expected runnable, got ${checkpoint.status}`);
  expect(checkpoint.checkpoint.commandLock).toBeNull();

  // The next command mints an outbound like any fresh call of the Turn.
  const second = execute(createTurn(), [
    call({ subject: 'later', description: 'draft' }, 'call-2', 'task_create'),
  ]);
  const later = commandIdOf('call-2');
  await vi.waitFor(
    () => {
      expect(commands.command(later)).toBeDefined();
    },
    { timeout: 10_000 },
  );
  await commands.handover(later, PARENT);
  await commands.answered(later, {
    outcome: 'answered',
    text: 'Task #1 created: "later".',
  });
  const parts = await second;
  expect(texts(parts)).toContain('Task #1 created');
  expect(commands.command(later)?.run.delivery?.state).toBe('consumed');
});

// The durable lock rides the stamp, never a journaled text: a command
// recovered as not sent leaves planned evidence behind, and that
// evidence alone must not lock the Turn that follows.
it('does not arm the timeout lock from a not-sent journal answer', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const first = execute(createTurn(), [
    call({ subject: 'x', description: 'y' }, 'call-1', 'task_create'),
  ]);
  const commandId = commandIdOf('call-1');
  await vi.waitFor(
    () => {
      expect(commands.command(commandId)).toBeDefined();
    },
    { timeout: 10_000 },
  );
  // The caller never hands the wait out; the 2-minute arm is what this
  // Turn's next call has paid attention to, never the text it makes.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 121_000);
  await first;
  expect(commands.command(commandId)?.run.delivery?.state).toBe('cancelled');
  vi.useRealTimers();

  const checkpoint = await session.authority.harnessRunAuthorization();
  if (checkpoint.status !== 'runnable')
    throw new Error(`expected runnable, got ${checkpoint.status}`);
  // The wait ended on the stamped Turn: the lock is what it should be.
  expect(checkpoint.checkpoint.commandLock).toEqual({ turnId: 'prompt' });

  // A takeover of this Turn re-arms from the stamp, and refuses the next
  // call — even though the journaled text alone would never prove it.
  const restarted = createTurn();
  const parts = await execute(restarted, [
    call({ subject: 'again', description: 'w' }, 'call-2', 'task_create'),
  ]);
  expect(texts(parts)).toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(commandIdOf('call-2'))).toBeUndefined();
});

// Decision 4 stamps the lock at detection, before the timed-out call
// settles: an owner that dies in between leaves the lock on and the
// entry still planned. The recovered wait answers that call by its
// journal — cancelled, so the relay can no longer deliver it — and never
// by the refusal meant for the Turn's later calls.
it('on resume settles a timed-out planned call by its journal, never by the lock', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const [run] = await parkCalls([
    { callId: 'call-cut', toolName: 'task_create' },
  ]);
  await commands.runCommand({
    commandId: run!.commandId,
    kind: 'board_write',
    args: { subject: 'x', description: 'y' },
    executionCallId: 'call-cut',
    closing: false,
  });
  await createManagedHarnessHandle(session).markCommandWaitTimeout();
  expect(commands.command(run!.commandId)?.run.delivery?.state).toBe('planned');

  await createTurn().resumeCommandWaitRuns(
    [run!],
    false,
    'model',
    new AbortController().signal,
  );
  const answered = await journaledResults();
  expect(answered).toContain('was not sent and nothing happened');
  expect(answered).not.toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(run!.commandId)?.run.delivery?.state).toBe(
    'cancelled',
  );
  // The relay can no longer hand over a command whose wait has ended.
  await expect(commands.handover(run!.commandId, PARENT)).rejects.toThrow(
    /cannot be handed/,
  );
  const settled = await runnableCheckpoint();
  expect(settled.continuation.phase).toBe('model_output_committed');
  expect(settled.commandLock).toEqual({ turnId: 'prompt' });
  // The lock still holds for the Turn's next call.
  const next = await execute(createTurn(), [
    call({ status: 'pending' }, 'call-next', 'task_list'),
  ]);
  expect(texts(next)).toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(commandIdOf('call-next'))).toBeUndefined();
});

it('on resume settles a timed-out handed-over call as unknown, never by the lock', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const [run] = await parkCalls([
    { callId: 'call-cut', toolName: 'task_create' },
  ]);
  await commands.runCommand({
    commandId: run!.commandId,
    kind: 'board_write',
    args: { subject: 'x', description: 'y' },
    executionCallId: 'call-cut',
    closing: false,
  });
  await commands.handover(run!.commandId, PARENT);
  await createManagedHarnessHandle(session).markCommandWaitTimeout();

  await createTurn().resumeCommandWaitRuns(
    [run!],
    false,
    'model',
    new AbortController().signal,
  );
  const answered = await journaledResults();
  expect(answered).toContain(
    'reached the leader, but its reply did not arrive',
  );
  expect(answered).not.toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(run!.commandId)?.run.delivery?.state).toBe('unknown');
  expect((await runnableCheckpoint()).continuation.phase).toBe(
    'model_output_committed',
  );
});

// The owner died after the settle but before the call's own answer: the
// journal already says unknown, and that evidence is the call's answer.
it('on resume answers a timed-out call settled before its answer from the settled state', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const [run] = await parkCalls([
    { callId: 'call-cut', toolName: 'task_create' },
  ]);
  await commands.runCommand({
    commandId: run!.commandId,
    kind: 'board_write',
    args: { subject: 'x', description: 'y' },
    executionCallId: 'call-cut',
    closing: false,
  });
  await commands.handover(run!.commandId, PARENT);
  await createManagedHarnessHandle(session).markCommandWaitTimeout();
  await commands.settle(run!.commandId, 'unknown');

  await createTurn().resumeCommandWaitRuns(
    [run!],
    false,
    'model',
    new AbortController().signal,
  );
  const answered = await journaledResults();
  expect(answered).toContain("The command's outcome is unknown");
  expect(answered).not.toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
});

// The owner settled and answered the timed-out call, then died before the
// fold; the relay's late reply moved the entry from unknown to accepted.
// The call read the unknown answer, never the reply, so recovery only
// folds it: a timed-out call is never consumed.
it('on resume never consumes a timed-out call that was answered before a late reply', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const [run] = await parkCalls([
    { callId: 'call-cut', toolName: 'task_create' },
  ]);
  await commands.runCommand({
    commandId: run!.commandId,
    kind: 'board_write',
    args: { subject: 'x', description: 'y' },
    executionCallId: 'call-cut',
    closing: false,
  });
  await commands.handover(run!.commandId, PARENT);
  await createManagedHarnessHandle(session).markCommandWaitTimeout();
  await commands.settle(run!.commandId, 'unknown');
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
            id: 'call-cut',
            name: 'task_create',
            response: { error: sessionCommandEvidenceText('accepting') },
          },
        },
      ],
    },
  });
  await commands.answered(run!.commandId, {
    outcome: 'answered',
    text: 'Task #1 created: "x".',
  });
  expect(commands.command(run!.commandId)?.run.delivery?.state).toBe(
    'accepted',
  );

  await createTurn().resumeCommandWaitRuns(
    [run!],
    false,
    'model',
    new AbortController().signal,
  );
  expect(commands.command(run!.commandId)?.run.delivery?.state).toBe(
    'accepted',
  );
  const answered = await journaledResults();
  expect(answered).not.toContain('Task #1 created');
  expect((await runnableCheckpoint()).continuation.phase).toBe(
    'model_output_committed',
  );
});

// In one batch the timed-out call answers by its journal while the call
// the lock refused before it sent anything answers the fixed text, as
// the live arm would have.
it('on resume answers a locked batch call that never sent with the leader-unanswering text', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board twice',
  );
  const runs = await parkCalls([
    { callId: 'call-cut', toolName: 'task_create' },
    { callId: 'call-held', toolName: 'task_list' },
  ]);
  await commands.runCommand({
    commandId: runs[0]!.commandId,
    kind: 'board_write',
    args: { subject: 'x', description: 'y' },
    executionCallId: 'call-cut',
    closing: false,
  });
  await commands.handover(runs[0]!.commandId, PARENT);
  await createManagedHarnessHandle(session).markCommandWaitTimeout();

  await createTurn().resumeCommandWaitRuns(
    runs,
    false,
    'model',
    new AbortController().signal,
  );
  const results = (await session.sink.project())
    .filter(
      (entry) =>
        entry.daemonPromptId === 'prompt' && entry.type === 'tool_result',
    )
    .map((entry) => JSON.stringify(entry.message?.parts ?? []));
  const cut = results.find((each) => each.includes('call-cut'));
  const held = results.find((each) => each.includes('call-held'));
  expect(cut).toContain('reached the leader, but its reply did not arrive');
  expect(held).toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(runs[1]!.commandId)).toBeUndefined();
});

// A re-driven batch names the timed-out call again: its outbound exists,
// so the lock does not speak for it — its journal does.
it('answers a re-driven timed-out call by its journal under the lock', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const first = execute(createTurn(), [
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
  await first;
  vi.useRealTimers();
  expect(commands.command(commandId)?.run.delivery?.state).toBe('unknown');

  const again = await execute(createTurn(), [
    call({ subject: 'x', description: 'y' }, 'call-live', 'task_create'),
  ]);
  expect(texts(again)).toContain("The command's outcome is unknown");
  expect(texts(again)).not.toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
});

// The lock is the Turn's, never the wait group's: the Turn's next batch
// parks a fresh group before its refusal folds, and an owner that dies
// in that window must not leave the Turn unlocked.
it("keeps the Turn locked when the owner dies between the next batch's park and its refusal", async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const first = execute(createTurn(), [
    call({ subject: 'x', description: 'y' }, 'call-live', 'task_create'),
  ]);
  const commandId = commandIdOf('call-live');
  await vi.waitFor(
    () => {
      expect(commands.command(commandId)).toBeDefined();
    },
    { timeout: 10_000 },
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 121_000);
  await first;
  vi.useRealTimers();

  const runs = await parkCalls([
    { callId: 'call-parked', toolName: 'task_list' },
  ]);
  expect((await runnableCheckpoint()).commandLock).toEqual({
    turnId: 'prompt',
  });
  await createTurn().resumeCommandWaitRuns(
    runs,
    false,
    'model',
    new AbortController().signal,
  );
  expect(await journaledResults()).toContain(
    SESSION_COMMAND_LEADER_UNANSWERING_TEXT,
  );
  expect(commands.command(runs[0]!.commandId)).toBeUndefined();
  const next = await execute(createTurn(), [
    call({ status: 'pending' }, 'call-next', 'task_list'),
  ]);
  expect(texts(next)).toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(commandIdOf('call-next'))).toBeUndefined();
});

// Ordinary Runtime work of the same Turn clears the wait group; a
// takeover after it must still find the Turn locked.
it('keeps the Turn locked across Runtime work and a takeover after it', async () => {
  await seedFirstInput(
    teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
      'write the board',
  );
  const first = execute(createTurn(), [
    call({ subject: 'x', description: 'y' }, 'call-live', 'task_create'),
  ]);
  const commandId = commandIdOf('call-live');
  await vi.waitFor(
    () => {
      expect(commands.command(commandId)).toBeDefined();
    },
    { timeout: 10_000 },
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 121_000);
  await first;
  vi.useRealTimers();

  const routeRef = await session.resources.publish(
    'managed-route',
    Buffer.from('{"model":"model"}', 'utf8'),
  );
  await createManagedHarnessHandle(session).commitAwaitRuntime({
    functionCallId: 'call-read',
    toolName: 'read_file',
    executionCallId: 'ex-read',
    invocationBindingId: 'bind-read',
    capabilityVersion: 'cap-1',
    policyVersion: 'pol-1',
    mediaVersion: null,
    modelMessageId: 'assistant-read',
    partIndex: 0,
    ordinal: 0,
    inputDigest: createHash('sha256').update('{}').digest('hex'),
    progressCursor: null,
    attemptId: 'assistant-read',
    routeRef,
  });
  expect((await runnableCheckpoint()).commandWait).toBeNull();
  await session.replaceActivation();
  const successor = createManagedHarnessHandle(session);
  await successor.resolveAwaitRuntime('ex-read', routeRef);
  await successor.consumeRuntimeResults();
  expect((await runnableCheckpoint()).commandLock).toEqual({
    turnId: 'prompt',
  });

  const next = await execute(createTurn(), [
    call({ status: 'pending' }, 'call-next', 'task_list'),
  ]);
  expect(texts(next)).toContain(SESSION_COMMAND_LEADER_UNANSWERING_TEXT);
  expect(commands.command(commandIdOf('call-next'))).toBeUndefined();
});

// The load routes answer an interrupted Turn's owed calls before they
// read its round. A member's board call shares the team tools' names,
// but once its outbound committed it is a command: its journal answers
// it — cancelled, so the relay can no longer deliver it — never the
// "never ran" text a team call that committed nothing gets.
it.each([
  ['planned', 'was not sent and nothing happened', 'cancelled'],
  ['accepting', 'reached the leader, but its reply did not arrive', 'unknown'],
] as const)(
  'answers an interrupted %s member command by its journal on a resumed load',
  async (handedOver, text, settled) => {
    await seedFirstInput(
      teamMemberPreamble({ name: 'alice', teamName: 'review' }) +
        'write the board',
    );
    const args = { subject: 'x', description: 'y' };
    await session.sink.write({
      uuid: 'assistant-cut',
      parentUuid: null,
      sessionId: sessionKey.sessionId,
      timestamp: new Date().toISOString(),
      model: 'model',
      type: 'assistant',
      cwd: rootDir,
      version: 'test',
      daemonPromptId: 'prompt',
      message: {
        role: 'model',
        parts: [
          { functionCall: { id: 'call-cut', name: 'task_create', args } },
        ],
      },
    });
    const commandId = commandIdOf('call-cut');
    await commands.runCommand({
      commandId,
      kind: 'board_write',
      args,
      executionCallId: 'call-cut',
      closing: false,
    });
    if (handedOver === 'accepting') await commands.handover(commandId, PARENT);

    const answered = await answerResumedTurnCalls({
      session,
      sessionId: sessionKey.sessionId,
      cwd: rootDir,
      promptId: 'prompt',
      children,
      commands,
    });
    expect(answered).toBe(1);
    const results = await journaledResults();
    expect(results).toContain(text);
    expect(results).not.toContain('The tool call never ran');
    expect(commands.command(commandId)?.run.delivery?.state).toBe(settled);
    // Replayed, the answer stays single.
    await answerResumedTurnCalls({
      session,
      sessionId: sessionKey.sessionId,
      cwd: rootDir,
      promptId: 'prompt',
      children,
      commands,
    });
    expect(
      (await session.sink.project()).filter(
        (entry) =>
          entry.daemonPromptId === 'prompt' && entry.type === 'tool_result',
      ),
    ).toHaveLength(1);
  },
);

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
