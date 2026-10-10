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
  HookEventName,
  HookType,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import type { ManagedHookDescriptor } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import { HostedHookSession } from './hosted-hook-session.js';
import {
  HostedWorkspaceToolTurn,
  HOSTED_AGENT_TOOL,
  HOSTED_CHILD_MOUNT_REFUSALS,
} from './hosted-workspace-tool-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

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
  hookControl: vi.fn(),
  authorizeLifecycle: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./hosted-workspace-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hosted-workspace-broker.js')>()),
  HostedWorkspaceBroker: class {
    readonly runtimeSessionId = 'prompt';
    runtime = {
      bindingId: 'binding',
      generation: '1',
      workspaceGeneration: '1',
    };
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
    hookControl = broker.hookControl;
    authorizeLifecycle = broker.authorizeLifecycle;
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

function createTurn(
  depth = 0,
  hookEvents?: string[],
  promptName = 'prompt',
  hooksMountHeld = false,
  hooksSession?: HostedHookSession,
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
      ...(hookEvents
        ? {
            hooks: {
              broker: new (HostedWorkspaceBroker as unknown as new (
                ...args: unknown[]
              ) => HostedWorkspaceBroker)(
                { baseUrl: 'http://127.0.0.1:1', token: 'test' },
                sessionKey,
                'hook-owner',
              ),
              mountHeld: hooksMountHeld,
              ensureReady: () => Promise.resolve(),
              acquire: () => Promise.resolve(),
              refresh: () => Promise.resolve(),
              tools: () => [],
              toolInput: () => undefined,
              fire: (eventName: string) => {
                hookEvents.push(eventName);
                return Promise.resolve([]);
              },
              close: () => Promise.resolve(),
            } as unknown as import('./hosted-hook-session.js').HostedHookSession,
          }
        : {}),
      ...(hooksSession ? { hooks: hooksSession } : {}),
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
    broker.authorizeLifecycle,
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

// R1-8: a prompt inside the generic inline budget but past the launch
// envelope's own bound is a model-correctable argument error — the
// refusal the admission contract names, never a recovery-blocked Turn.
it('answers an over-size prompt with the byte_limit refusal, not recovery', async () => {
  const turn = createTurn();
  const responses = await executeAgent(
    turn,
    call({
      description: 'audit',
      prompt: 'p'.repeat(33 * 1024),
      run_in_background: true,
    }),
  );
  expect(JSON.stringify(responses)).toContain('byte_limit');
  expect(JSON.stringify(responses)).not.toContain('audit-started');
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
  // An agent-only batch never takes the mount: a turn that would mount
  // against its own Session is exactly the deadlock a shared Workspace
  // creates between the waiting parent and the child's first tool call.
  expect(broker.acquire).not.toHaveBeenCalled();
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

// R1-61: an accepted result whose tool_result envelope passes the inline
// bound still must answer — the parent folds it to the bound with the
// truncation marker instead of entering recovery.
it('degrades an oversized foreground answer to its truncation marker', async () => {
  messageFitsInline.mockImplementation(
    (_type, parts, _model) => JSON.stringify(parts).length < 65536,
  );
  const turn = createTurn();
  const childRunId = 'prompt:call-1';
  const driving = (async () => {
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
      result: Buffer.from('r'.repeat(64 * 1024), 'utf8'),
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
  expect(JSON.stringify(responses)).toContain(
    'truncated: the full result is on the acceptance record',
  );
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

// The batch sibling of the same rule: an abandoned foreground wait hands
// control back to the batch loop, which used to admit every call queued
// behind it. After the abort, the loop's next admission must refuse —
// the first child stands documented, the queued one never started.
it('a cancelled turn never admits children queued behind its abandoned wait', async () => {
  const turn = createTurn();
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 200);
  const batch = await turn.execute(
    [
      call(
        {
          description: 'first child',
          prompt: 'review a',
          run_in_background: false,
        },
        'call-1',
      ),
      call(
        {
          description: 'second child',
          prompt: 'review b',
          run_in_background: false,
        },
        'call-2',
      ),
    ],
    [
      {
        functionCall: {
          id: 'call-1',
          name: 'agent',
          args: {
            description: 'first child',
            prompt: 'review a',
            run_in_background: false,
          },
        },
      },
      {
        functionCall: {
          id: 'call-2',
          name: 'agent',
          args: {
            description: 'second child',
            prompt: 'review b',
            run_in_background: false,
          },
        },
      },
    ],
    'model',
    abort.signal,
  );
  const text = JSON.stringify(batch);
  expect(text).toContain('cancelled');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    1,
  );
  expect(children.record('prompt:call-2')).toBeUndefined();
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

// The same replay behind a full quota: counting the replayed child
// against `count_limit` would refuse the launch it is already running —
// quotas gate new children, and `children.admit` always had the replay
// answer.
it('replays an existing background child past a full quota', async () => {
  const turn = createTurn();
  const responses = (await executeAgent(
    turn,
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: true,
    }),
  )) as Part[];
  expect(JSON.stringify(responses)).toContain('started in the background');
  for (const seed of ['seed-b', 'seed-c', 'seed-d']) {
    await children.admit({
      childRunId: `prompt:${seed}`,
      ownerScopeId: sessionKey.sessionId,
      rootSessionId: sessionKey.sessionId,
      completion: 'sent',
      description: `seed ${seed}`,
      prompt: 'seed',
      definition: {
        definitionId: 'hosted-agent/hosted-workspace-shell/1',
        definitionRevision: 1,
        definitionDigest: session.authority.sessionHeader.definitionRef.digest,
      },
      workingDirectory: '.',
      executionCallId: `prompt:${seed}`,
    });
  }
  const replays = (await executeAgent(
    createTurn(),
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: true,
    }),
  )) as Part[];
  expect(JSON.stringify(replays)).toContain('started in the background');
  expect(JSON.stringify(replays)).not.toContain('count_limit');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    4,
  );
});

// A refused background launch on a Session-owned mount: the Hook catalog
// (or an MCP owner) releases only at Session close, so the ordinary
// background workaround would park the child on workspace_busy until its
// deadline — refuse at admission instead.
it('refuses a background agent while the Session owner holds the mount', async () => {
  const turn = createTurn(0, [], 'prompt', true);
  const responses = (await executeAgent(
    turn,
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: true,
    }),
  )) as Part[];
  expect(JSON.stringify(responses)).toContain(
    HOSTED_CHILD_MOUNT_REFUSALS.sessionOwner,
  );
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

// The wake-turn id already embeds its commissioning run id
// (`<childRunId>:accept:notify`); using it verbatim as the launch base
// grows one suffix per chained hop into the 128-char lineage bound. The
// derived key is a bounded digest of the same stable name — every hop
// stays at 17 chars plus the call id.
it('bounds chained background launches from wake turns', async () => {
  const wakeOne = createTurn(0, undefined, 'root-run:accept:notify');
  await executeAgent(
    wakeOne,
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: true,
    }),
  );
  const hopOne = session.authority.extensionRecordsInDomain('child_run')[0];
  expect(hopOne?.recordId).toMatch(/^[0-9a-f]{16}:call-1$/);
  const wakeTwo = createTurn(0, undefined, `${hopOne?.recordId}:accept:notify`);
  await executeAgent(
    wakeTwo,
    call(
      {
        description: 'second hop',
        prompt: 'review the second change',
        run_in_background: true,
      },
      'call-9',
    ),
  );
  const ids = session.authority
    .extensionRecordsInDomain('child_run')
    .map((record) => record.recordId);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toMatch(/^[0-9a-f]{16}:call-9$/);
  expect(ids.every((id) => id.length <= 48)).toBe(true);
});

it('refuses a foreground agent call that shares its batch with a non-agent tool', async () => {
  const turn = createTurn();
  // A sibling tool would hold the Workspace mount for exactly the wait a
  // foreground answer needs — a deadlock, not a refusal, by accident-order.
  const batch = await turn.execute(
    [
      call(
        {
          description: 'audit the diff',
          prompt: 'review the change',
          run_in_background: false,
        },
        'call-1',
      ),
      (() => {
        const shell = call({ description: 'noop', prompt: 'noop' }, 'call-2');
        shell.name = 'run_shell_command';
        shell.args = { command: 'echo ok' };
        return shell;
      })(),
    ],
    [
      {
        functionCall: {
          id: 'x',
          name: 'agent',
          args: { description: 'd', prompt: 'p', run_in_background: false },
        },
      },
      {
        functionCall: {
          id: 'y',
          name: 'run_shell_command',
          args: { command: 'echo ok' },
        },
      },
    ],
    'model',
    new AbortController().signal,
  );
  expect(JSON.stringify(batch)).toContain('cannot share a batch');
  expect(JSON.stringify(batch)).not.toContain('audit-started');
});

it('admits a batch of only agent calls, foregrounded or queued', async () => {
  const turn = createTurn();
  const responses = await executeAgent(
    turn,
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: true,
    }),
  );
  expect(JSON.stringify(responses)).not.toContain('cannot share a batch');
  expect(broker.acquire).not.toHaveBeenCalled();
});

const mountRefusal = HOSTED_CHILD_MOUNT_REFUSALS.sessionOwner;

async function restoredHooks(
  descriptor: Pick<ManagedHookDescriptor, 'eventName' | 'config'> &
    Partial<ManagedHookDescriptor>,
): Promise<HostedHookSession> {
  const pin = {
    catalogId: 'deployment',
    catalogRevision: 1,
    definitionDigest: 'a'.repeat(64),
  };
  broker.hookControl.mockImplementation(async (operation) => ({
    operationId: operation.operationId,
    state: 'settled',
    ...(operation.kind === 'hook-catalog'
      ? {
          catalog: {
            ...pin,
            hooks: [
              {
                hookId: 'result',
                sequential: false,
                async: false,
                failClosed: true,
                onceKey: null,
                ...descriptor,
              },
            ],
          },
        }
      : {
          result: {
            success: true,
            outcome: 'success',
            duration: 1,
            output: {},
          },
        }),
  }));
  const options = { baseUrl: 'http://127.0.0.1:1', token: 'test' };
  const initial = new HostedHookSession(options, session, pin);
  await initial.ensureReady();
  await initial.close();
  const restored = new HostedHookSession(options, session, pin);
  await restored.ensureReady();
  expect(restored.mountHeld).toBe(false);
  return restored;
}

const resultEvents = [
  HookEventName.PostToolUse,
  HookEventName.PostToolUseFailure,
  HookEventName.PostToolBatch,
];

it.each(
  resultEvents.flatMap((eventName) =>
    [false, true].map((background) => ({ eventName, background })),
  ),
)(
  'refuses restored $eventName command Hooks before child admission (background=$background)',
  async ({ eventName, background }) => {
    const hooks = await restoredHooks({
      eventName,
      config: { type: 'command' },
    });
    const turn = createTurn(0, undefined, 'prompt', false, hooks);
    try {
      const result = await executeAgent(
        turn,
        call({
          description: 'audit',
          prompt: 'review',
          run_in_background: background,
        }),
      );
      expect(JSON.stringify(result)).toContain(mountRefusal);
      expect(JSON.stringify(result)).not.toContain('run it in the background');
      expect(JSON.stringify(result)).not.toContain('fresh turn');
      expect(
        session.authority.extensionRecordsInDomain('child_run'),
      ).toHaveLength(0);
    } finally {
      await turn.finish();
      await hooks.close();
    }
  },
);

// The type/eligibility filter and the event filter are orthogonal, so the
// controls exercise the five ineligible shapes on one event and the event
// filter on the single off-event row. The refusal side above already sweeps
// all three result events.
const admissionControls: Array<
  Pick<ManagedHookDescriptor, 'eventName' | 'config'> &
    Partial<ManagedHookDescriptor>
> = [
  {
    eventName: HookEventName.PostToolUse,
    config: { type: 'http' as const },
  },
  {
    eventName: HookEventName.PostToolUse,
    config: { type: 'function' as const },
  },
  {
    eventName: HookEventName.PostToolUse,
    config: { type: HookType.Prompt, prompt: 'check' },
  },
  {
    eventName: HookEventName.PostToolUse,
    config: { type: 'command' as const },
    enabled: false,
  },
  {
    eventName: HookEventName.PostToolUse,
    config: { type: 'command' as const },
    sourceTrusted: false,
  },
  { eventName: HookEventName.Stop, config: { type: 'command' } },
];

it.each([false, true])(
  'admits a child after restoring a consumed once Hook (background=%s)',
  async (background) => {
    const original = await restoredHooks({
      eventName: HookEventName.PostToolUse,
      config: { type: 'command' },
      onceKey: 'result-once',
    });
    const hooks = new HostedHookSession(
      { baseUrl: 'http://127.0.0.1:1', token: 'test' },
      session,
      original.getCatalog()!,
    );
    const turn = createTurn(0, undefined, 'prompt', false, hooks);
    try {
      expect(original.hasMountableToolResultHooks).toBe(true);
      await original.fire(
        HookEventName.PostToolUse,
        'seed-once',
        { tool_name: 'agent', tool_use_id: 'seed-once' },
        new AbortController().signal,
      );
      expect(
        broker.hookControl.mock.calls.filter(
          ([operation]) => operation.kind === 'hook-execute',
        ),
      ).toHaveLength(1);
      await original.close();
      await hooks.ensureReady();
      expect(hooks.mountHeld).toBe(false);
      const result = executeAgent(
        turn,
        call({
          description: 'audit',
          prompt: 'review',
          run_in_background: background,
        }),
      );
      if (!background) {
        await vi.waitFor(() =>
          expect(children.record('prompt:call-1')).toBeDefined(),
        );
        await children.settleFailed('prompt:call-1', {
          stopReason: 'creation_failed',
          reason: null,
          started: false,
        });
      }
      expect(JSON.stringify(await result)).not.toContain(mountRefusal);
      expect(children.record('prompt:call-1')).toBeDefined();
      expect(
        broker.hookControl.mock.calls.filter(
          ([operation]) => operation.kind === 'hook-execute',
        ),
      ).toHaveLength(1);
    } finally {
      await turn.finish();
      await original.close();
      await hooks.close();
    }
  },
);

it.each(
  admissionControls.flatMap((descriptor) =>
    [false, true].map((background) => ({ descriptor, background })),
  ),
)(
  'admits result-Hook controls %# (background=$background)',
  async ({ descriptor, background }) => {
    const hooks = await restoredHooks(descriptor);
    const turn = createTurn(0, undefined, 'prompt', false, hooks);
    turn.setPromptHookRunner(async (hookConfig, eventName) => ({
      hookConfig,
      eventName,
      success: true,
      duration: 1,
      output: {},
    }));
    try {
      const result = executeAgent(
        turn,
        call({
          description: 'audit',
          prompt: 'review',
          run_in_background: background,
        }),
      );
      if (!background) {
        await vi.waitFor(() =>
          expect(children.record('prompt:call-1')).toBeDefined(),
        );
        await children.settleFailed('prompt:call-1', {
          stopReason: 'creation_failed',
          reason: null,
          started: false,
        });
      }
      expect(JSON.stringify(await result)).not.toContain(mountRefusal);
      expect(children.record('prompt:call-1')).toBeDefined();
    } finally {
      await turn.finish();
      await hooks.close();
    }
  },
);

// The Turn-owned arm the Session-owner refusal must not swallow. A
// Turn-owned mount releases at this Turn's finish, so its background and
// fresh-turn advice is real, unlike the Session-scoped hold tested below.
it('refuses a foreground agent call while this Turn holds the mount', async () => {
  const turn = createTurn();
  await turn.resumeCommittedResults(new AbortController().signal);
  const refused = await executeAgent(
    turn,
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: false,
    }),
  );
  expect(JSON.stringify(refused)).toContain(HOSTED_CHILD_MOUNT_REFUSALS.turn);
  expect(JSON.stringify(refused)).not.toContain(mountRefusal);
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

// Pins the arm order the comment at the Turn-owned arm depends on. With both
// holds live, the Session-scoped arm must answer: a Session-owned mount
// survives the Turn, so the Turn arm's background and fresh-turn advice
// cannot release it and would be dead advice. Swapping the arms keeps this
// refusing, but with the wrong remedy.
it('answers a foreground child with the Session refusal when both holds are live', async () => {
  const turn = createTurnWithOwnerMount('hooks', true);
  await turn.resumeCommittedResults(new AbortController().signal);
  const refused = await executeAgent(
    turn,
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: false,
    }),
  );
  expect(JSON.stringify(refused)).toContain(mountRefusal);
  expect(JSON.stringify(refused)).not.toContain(
    HOSTED_CHILD_MOUNT_REFUSALS.turn,
  );
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

// The 1292-refusal must key off the Session's actual mount owners, not
// only the turn's own `acquired` flag: the Hook catalog or MCP owner can
// retain the mount until their Session-scoped close, and an agent-only
// foreground batch then still blocks the child on that mount.
it('refuses a foreground agent call while a Session owner holds the mount', async () => {
  for (const owner of ['hooks', 'mcp'] as const) {
    const turn = createTurnWithOwnerMount(owner, true);
    const refused = await executeAgent(
      turn,
      call({
        description: 'audit the diff',
        prompt: 'review the change',
        run_in_background: false,
      }),
    );
    expect(JSON.stringify(refused)).toContain(mountRefusal);
    expect(JSON.stringify(refused)).not.toContain('audit-started');
  }
  // The same Session owners without the hold admit the batch.
  const unheld = createTurnWithOwnerMount('hooks', false);
  const driving = (async () => {
    const childRunId = 'prompt:call-1';
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
  const admitted = (
    await Promise.all([
      executeAgent(
        unheld,
        call(
          {
            description: 'audit the diff',
            prompt: 'review the change',
            run_in_background: false,
          },
          'call-1',
        ),
      ),
      driving,
    ])
  )[0];
  expect(JSON.stringify(admitted)).not.toContain(mountRefusal);
});

// R1-62: an admitted agent launch dispatches like any executed call —
// the agent path bypasses the Broker pipeline that would have written
// its tool.intent, so PostToolUse must fire for it, not only PreToolUse.
it('fires PostToolUse for an admitted agent launch', async () => {
  const events: string[] = [];
  const turn = createTurnWithOwnerMount('hooks', false, undefined, events);
  await executeAgent(
    turn,
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: true,
    }),
  );
  expect(events).toContain('PreToolUse');
  expect(events).toContain('PostToolUse');
});

// R1-62's recovery arm: a resumed committed result never re-drives the
// launch, and a reconstructed turn's in-memory dispatch set starts empty
// — the durable child_run record is the dispatch evidence that survives.
it('fires PostToolUse on resumed results through the durable launch record', async () => {
  const firstEvents: string[] = [];
  const first = createTurn(0, firstEvents);
  const saved = await executeAgent(
    first,
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: true,
    }),
  );
  expect(firstEvents).toContain('PostToolUse');
  const recoveredEvents: string[] = [];
  const recovered = createTurn(0, recoveredEvents);
  await recovered.resumeHookResults(
    saved,
    'model',
    new AbortController().signal,
  );
  expect(recoveredEvents).toContain('PostToolUse');
});

// The same arm on a wake turn: the launcher's collapsed key is the only
// name the record carries, so a resumed wake turn reading the verbatim
// prompt id would find nothing — a shared derivation points both at the
// same name. Without it, PostToolUse vanishes silently for wake turns.
it('fires PostToolUse on resumed results of a wake-turn launch', async () => {
  const firstEvents: string[] = [];
  const first = createTurn(0, firstEvents, 'root-run:accept:notify');
  const saved = await executeAgent(
    first,
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: true,
    }),
  );
  expect(firstEvents).toContain('PostToolUse');
  const recoveredEvents: string[] = [];
  const recovered = createTurn(0, recoveredEvents, 'root-run:accept:notify');
  await recovered.resumeHookResults(
    saved,
    'model',
    new AbortController().signal,
  );
  expect(recoveredEvents).toContain('PostToolUse');
});

// The window between the admission-time check and the PreToolUse fire:
// a restored command Hook acquires and retains the mount inside fire(),
// and the revalidation must still refuse the launch even when the Hook
// changed none of the call's arguments.
it('refuses a foreground agent call whose PreToolUse Hook took the mount', async () => {
  const turn = createTurnWithOwnerMount('hooks', false, (hook) => {
    hook.mountHeld = true;
  });
  const refused = await executeAgent(
    turn,
    call({
      description: 'audit the diff',
      prompt: 'review the change',
      run_in_background: false,
    }),
  );
  expect(JSON.stringify(refused)).toContain(mountRefusal);
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

function createTurnWithOwnerMount(
  owner: 'hooks' | 'mcp',
  held: boolean,
  onFire?: (sessionOwner: { mountHeld: boolean }) => void,
  fireEvents?: string[],
): HostedWorkspaceToolTurn {
  const ownerBroker = new (HostedWorkspaceBroker as unknown as new (
    ...args: unknown[]
  ) => HostedWorkspaceBroker)(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    sessionKey,
    'owner',
  );
  const sessionOwner = {
    broker: ownerBroker,
    mountHeld: held,
    ensureReady: () => Promise.resolve(),
    acquire: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    tools: () => [],
    toolInput: () => undefined,
    fire: (eventName: string) => {
      fireEvents?.push(eventName);
      onFire?.(sessionOwner);
      return Promise.resolve([]);
    },
    close: () => Promise.resolve(),
  };
  return new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    createManagedHarnessHandle(session),
    'prompt',
    async () => randomUUID(),
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
        depth: 0,
        queueConsumption: (childRunId) => consumption.push(childRunId),
      },
      ...(owner === 'hooks'
        ? {
            hooks:
              sessionOwner as unknown as import('./hosted-hook-session.js').HostedHookSession,
          }
        : {
            mcp: sessionOwner as unknown as import('./hosted-mcp-session.js').HostedMcpSession,
          }),
    },
  );
}
