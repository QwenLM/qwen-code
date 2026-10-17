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
import { managedExtensionRecordKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-projection.js';
import {
  MANAGED_CHILD_LIMITS,
  decodeWorkflowLaunchEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  HOSTED_CHILD_MOUNT_REFUSALS,
  HostedWorkspaceToolTurn,
  HOSTED_WORKFLOW_TOOL,
  workflowDefinitionPin,
} from './hosted-workspace-tool-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

// #13803: the kind gate admits `workflow` for real, so the suite runs
// without an enablement mock except where a test proves the unlisted
// refusal; that case narrows the gate for `workflow` alone.
const gateDown = vi.hoisted(() => ({ workflow: false }));
vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js')
      >();
    return {
      ...actual,
      assertManagedSessionChildRunKindEnabled: (kind: string) => {
        if (kind === 'workflow' && gateDown.workflow) {
          actual.assertManagedSessionChildRunKindEnabled('unlisted-kind');
          return;
        }
        actual.assertManagedSessionChildRunKindEnabled(kind);
      },
    };
  },
);

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

const SCRIPT =
  'export const meta = { name: "audit", description: "audit things" };\nreturn { answer: args.x + 1 };';

function call(
  args: Record<string, unknown>,
  callId = 'call-1',
): ToolCallRequestInfo {
  return {
    name: 'workflow',
    callId,
    args,
    isClientInitiated: false,
    prompt_id: 'prompt',
  } as ToolCallRequestInfo;
}

function createTurn(
  depth = 0,
  hooksMountHeld = false,
  harness?: ReturnType<typeof createManagedHarnessHandle>,
): HostedWorkspaceToolTurn {
  return new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    harness ?? createManagedHarnessHandle(session),
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
    {
      profile: 'hosted-workspace-shell/1',
      childAgents: {
        funnel: children,
        depth,
        queueConsumption: (childRunId) => consumption.push(childRunId),
      },
      ...(hooksMountHeld
        ? {
            hooks: {
              broker: new (HostedWorkspaceBroker as unknown as new (
                ...args: unknown[]
              ) => HostedWorkspaceBroker)(
                { baseUrl: 'http://127.0.0.1:1', token: 'test' },
                sessionKey,
                'hook-owner',
              ),
              mountHeld: true,
              ensureReady: () => Promise.resolve(),
              acquire: () => Promise.resolve(),
              refresh: () => Promise.resolve(),
              tools: () => [],
              toolInput: () => undefined,
              fire: () => Promise.resolve([]),
              close: () => Promise.resolve(),
            } as unknown as import('./hosted-hook-session.js').HostedHookSession,
          }
        : {}),
    },
  );
}

async function executeWorkflow(
  turn: HostedWorkspaceToolTurn,
  workflowCall: ToolCallRequestInfo,
  signal = new AbortController().signal,
): Promise<Part[]> {
  return turn.execute(
    [workflowCall],
    [
      {
        functionCall: {
          id: workflowCall.callId,
          name: 'workflow',
          args: workflowCall.args,
        },
      },
    ],
    'model',
    signal,
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  gateDown.workflow = false;
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
  root = await mkdtemp(path.join(tmpdir(), 'hosted-workflow-turn-'));
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
  // A live turn always holds the harness's before_model checkpoint from
  // its start; commit it here so the tool arms meet the same durable
  // basis the real driver provides.
  await createManagedHarnessHandle(session).ensureCheckpoint();
  consumption = [];
});

afterEach(async () => {
  await session?.close();
  await rm(root, { recursive: true, force: true });
});

it('pins the launch definition from the script, name over meta or unnamed', () => {
  const named = workflowDefinitionPin(SCRIPT);
  expect(named.definitionId).toBe('workflow/audit');
  expect(named.definitionRevision).toBe(1);
  expect(named.definitionDigest).toBe(
    createHash('sha256').update(SCRIPT, 'utf8').digest('hex'),
  );
  const renamed = workflowDefinitionPin(`${SCRIPT} // touch`);
  expect(renamed.definitionDigest).not.toBe(named.definitionDigest);
  expect(workflowDefinitionPin('return 1;').definitionId).toBe(
    'workflow/unnamed',
  );
  expect(
    workflowDefinitionPin(
      'export const meta = { name: "NOT-A-NAME", description: "x" }; return 1;',
    ).definitionId,
  ).toBe('workflow/unnamed');
});

it('declares the workflow tool at the root and hides it from a child Session', async () => {
  const rootTurn = createTurn(0);
  const rootTools = await rootTurn.declarations(new AbortController().signal);
  expect(rootTools.some((tool) => tool.name === 'workflow')).toBe(true);
  expect(HOSTED_WORKFLOW_TOOL.parametersJsonSchema).toMatchObject({
    required: ['script'],
    additionalProperties: false,
  });
  const childTools = await createTurn(1).declarations(
    new AbortController().signal,
  );
  expect(childTools.some((tool) => tool.name === 'workflow')).toBe(false);
});

it('refuses the declaration and the call while the kind is unlisted', async () => {
  gateDown.workflow = true;
  const turn = createTurn();
  const tools = await turn.declarations(new AbortController().signal);
  expect(tools.some((tool) => tool.name === 'workflow')).toBe(false);
  // The profile never advertises an unlisted kind, so the call is refused
  // at the declaration layer exactly like any undeclared tool.
  await expect(executeWorkflow(turn, call({ script: SCRIPT }))).rejects.toThrow(
    'Hosted Workspace profile refused a tool call.',
  );
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

it('refuses the reference arguments as a named follow-up scope', async () => {
  for (const arg of ['name', 'scriptPath', 'resumeFromRunId', 'sourceRef']) {
    const responses = await executeWorkflow(
      createTurn(),
      call({ script: SCRIPT, [arg]: 'x' }),
    );
    expect(JSON.stringify(responses)).toContain('unsupported argument');
    expect(JSON.stringify(responses)).toContain(`\\"${arg}\\"`);
    expect(JSON.stringify(responses)).toContain('reference follow-up');
  }
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

it('refuses a script whose masked source calls workflow() as a nested launch', async () => {
  for (const source of [
    "return await workflow('x');",
    "return await workflow({ scriptPath: '.qwen/workflows/x.js' });",
  ]) {
    const responses = await executeWorkflow(
      createTurn(),
      call({ script: source }),
    );
    expect(JSON.stringify(responses)).toContain('script is invalid');
    expect(JSON.stringify(responses)).toContain('workflow() on line 1');
    expect(JSON.stringify(responses)).toContain('reference follow-up');
  }
  // The same text inside a string or a comment is not a call: only the
  // launch the pin never examined is refused.
  const admitted = await executeWorkflow(
    createTurn(),
    call({
      script: 'const label = "workflow(x)"; /* workflow(x) */ return 1;',
    }),
  );
  expect(JSON.stringify(admitted)).toContain('Workflow child started');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    1,
  );
});

// #13858 R4-4: the child's agents carry no tools and use nothing on the
// Harness host; a literal host-bound agent() option would fail the whole
// run after a launch slot was spent, so admission refuses it up front.
it('refuses a script whose agent() passes a host-bound option before any record commits', async () => {
  for (const [source, option] of [
    ["return await agent('scan', { tools: ['read_file'] });", 'tools'],
    ["return await agent('scan', { agentType: 'Explore' });", 'agentType'],
  ] as const) {
    const responses = await executeWorkflow(
      createTurn(),
      call({ script: source }),
    );
    expect(JSON.stringify(responses)).toContain(
      `agent() on line 1 passes ${option}`,
    );
    expect(JSON.stringify(responses)).toContain('text-only agents');
  }
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
  // A text-only agent() with the options that still apply is admitted.
  const admitted = await executeWorkflow(
    createTurn(),
    call({
      script: "return await agent('scan', { model: 'm', effort: 'high' });",
    }),
  );
  expect(JSON.stringify(admitted)).toContain('Workflow child started');
});

it('refuses the foreground workflow launch and rejects the sibling batch while a Workspace mount is at stake', async () => {
  // A Session-scoped hold (here the Hook catalog's) blocks foreground and
  // background alike and is answered by the Session-owner arm.
  const foreground = await executeWorkflow(
    createTurn(0, true),
    call({ script: SCRIPT, run_in_background: false }),
  );
  expect(JSON.stringify(foreground)).toContain(
    HOSTED_CHILD_MOUNT_REFUSALS.sessionOwner,
  );
  const background = await executeWorkflow(
    createTurn(0, true),
    call({ script: SCRIPT, run_in_background: true }),
  );
  expect(JSON.stringify(background)).toContain(
    HOSTED_CHILD_MOUNT_REFUSALS.sessionOwner,
  );
  // A Turn-owned hold refuses only the foreground launch, naming the Turn:
  // its background advice is real because this hold releases at finish.
  const turnHeld = createTurn();
  (turnHeld as unknown as { acquired: boolean }).acquired = true;
  const turnRefused = await executeWorkflow(
    turnHeld,
    call({ script: SCRIPT, run_in_background: false }),
  );
  expect(JSON.stringify(turnRefused)).toContain(
    HOSTED_CHILD_MOUNT_REFUSALS.turn,
  );
  expect(JSON.stringify(turnRefused)).not.toContain(
    HOSTED_CHILD_MOUNT_REFUSALS.sessionOwner,
  );
  // ...and the background launch it advises is really admitted under the
  // same Turn-owned hold (#13858 R2-8).
  const turnBackground = await executeWorkflow(
    turnHeld,
    call({ script: SCRIPT, run_in_background: true }, 'wf-bg'),
  );
  expect(JSON.stringify(turnBackground)).toContain('Workflow child started');
  // Foreground share a batch with a non-child tool call: no mount-arm —
  // the sibling still wedges the foreground child's single-mount world.
  const turn = createTurn();
  const answer = await turn.execute(
    [
      {
        name: 'workflow',
        callId: 'wf-fg',
        args: { script: SCRIPT, run_in_background: false },
        isClientInitiated: false,
        prompt_id: 'prompt',
      } as ToolCallRequestInfo,
      {
        name: 'run_shell_command',
        callId: 'sh-1',
        args: { command: 'echo x' },
        isClientInitiated: false,
        prompt_id: 'prompt',
      } as ToolCallRequestInfo,
    ],
    [
      {
        functionCall: {
          id: 'wf-fg',
          name: 'workflow',
          args: { script: SCRIPT, run_in_background: false },
        },
      },
      {
        functionCall: {
          id: 'sh-1',
          name: 'run_shell_command',
          args: { command: 'echo x' },
        },
      },
    ],
    'model',
    new AbortController().signal,
  );
  expect(JSON.stringify(answer)).toContain(
    'cannot share a batch with a tool other than agent or workflow',
  );
  // Only the advised background launch above ever committed.
  expect(
    session.authority
      .extensionRecordsInDomain('child_run')
      .map((entry) => entry.recordId),
  ).toEqual(['prompt:wf-bg']);
});

it('admits a batch of a foreground child agent beside a background workflow', async () => {
  const turn = createTurn();
  const childRunId = 'prompt:agent-1';
  // Drive the foreground agent's full lifecycle so the batch completes:
  // the turn's own wait is the standard settled-then-accepted arm — without
  // it the foreground agent parks in awaitChildToolResult and the batch
  // never returns.
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
      result: Buffer.from('agent answer', 'utf8'),
      receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
    });
    await children.accept(childRunId);
  })();
  const agentCall: ToolCallRequestInfo = {
    name: 'agent',
    callId: 'agent-1',
    args: { description: 'audit', prompt: 'review', run_in_background: false },
    isClientInitiated: false,
    prompt_id: 'prompt',
  } as ToolCallRequestInfo;
  const responses = (
    await Promise.all([
      turn.execute(
        [call({ script: SCRIPT }, 'wf-1'), agentCall],
        [
          {
            functionCall: {
              id: 'wf-1',
              name: 'workflow',
              args: { script: SCRIPT },
            },
          },
          {
            functionCall: {
              id: 'agent-1',
              name: 'agent',
              args: {
                description: 'audit',
                prompt: 'review',
                run_in_background: false,
              },
            },
          },
        ],
        'model',
        new AbortController().signal,
      ),
      driving,
    ])
  )[0];
  // The agent arm's own exemption names `workflow` as an admissible
  // sibling — without it the foreground agent would refuse with the batch
  // refusal naming only `agent` as admissible.
  expect(JSON.stringify(responses)).not.toContain('cannot share a batch');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    2,
  );
});

it('answers an aborted half-batch: the first launch commits, the aborted second is refused by the admission cancel guard and never minted', async () => {
  const turn = createTurn();
  const controller = new AbortController();
  // The abort must arrive between admissions — early enough for the second
  // workflow arm's own `if (signal.aborted)` guard to fire, late enough to
  // keep the first launch's commit. Aborting as the first admission's
  // commit returns draws that line deterministically: the batch admits its
  // launches one after another (#13858 R2-3; a polling timer raced it).
  const admitWorkflow = children.admitWorkflow.bind(children);
  const admitted = vi
    .spyOn(children, 'admitWorkflow')
    .mockImplementation(async (params) => {
      const launched = await admitWorkflow(params);
      controller.abort();
      return launched;
    });
  const responses = (
    await Promise.all([
      turn.execute(
        [
          call({ script: SCRIPT, run_in_background: true }, 'wf-1'),
          call({ script: SCRIPT, run_in_background: true }, 'wf-2'),
        ],
        [
          {
            functionCall: {
              id: 'wf-1',
              name: 'workflow',
              args: { script: SCRIPT, run_in_background: true },
            },
          },
          {
            functionCall: {
              id: 'wf-2',
              name: 'workflow',
              args: { script: SCRIPT, run_in_background: true },
            },
          },
        ],
        'model',
        controller.signal,
      ),
    ])
  )[0];
  expect(admitted).toHaveBeenCalledTimes(1);
  admitted.mockRestore();
  // The aborted admission answers the second call with the cancel text —
  // and mints no second record; the first had already landed.
  expect(JSON.stringify(responses)).toContain('Workflow child started');
  expect(JSON.stringify(responses)).toContain(
    'The turn was cancelled before this workflow was admitted.',
  );
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    1,
  );
});

it('replays a workflow launch without minting a second child or double-spending the scope count', async () => {
  const turn = createTurn();
  const first = await executeWorkflow(turn, call({ script: SCRIPT }, 'wf-1'));
  expect(JSON.stringify(first)).toContain('started');
  const replayed = await executeWorkflow(
    turn,
    call({ script: SCRIPT }, 'wf-1'),
  );
  expect(JSON.stringify(replayed)).toContain('started');
  // The replay guard at the launch admission moves the quota checks below
  // `children.record(childRunId) === undefined`, so a re-driven batch names
  // the same record without minting a second one.
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    1,
  );
});

// H4c: the lifetime launch budget is kind-blind: the committed history of
// child_agent runs counts against the workflow budget too.
it('refuses a workflow launch past the spent launch budget of the scope', async () => {
  for (
    let index = 0;
    index < MANAGED_CHILD_LIMITS.maxLaunchesPerScope - 1;
    index++
  ) {
    const childRunId = `prompt:seed-${index}`;
    await children.admit({
      childRunId,
      ownerScopeId: sessionKey.sessionId,
      rootSessionId: sessionKey.sessionId,
      completion: 'sent',
      description: `seed ${index}`,
      prompt: 'seed',
      definition: {
        definitionId: 'hosted-agent/hosted-workspace-shell/1',
        definitionRevision: 1,
        definitionDigest: session.authority.sessionHeader.definitionRef.digest,
      },
      workspaceMode: 'shared',
      workingDirectory: '.',
      executionCallId: childRunId,
    });
    await children.settleCancelled(childRunId, { started: false });
  }
  const last = await executeWorkflow(
    createTurn(),
    call({ script: SCRIPT }, 'call-last'),
  );
  expect(JSON.stringify(last)).toContain('started');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    MANAGED_CHILD_LIMITS.maxLaunchesPerScope,
  );
  for (const turn of [createTurn(), createTurn()]) {
    const refused = await executeWorkflow(
      turn,
      call({ script: SCRIPT }, 'call-over'),
    );
    expect(JSON.stringify(refused)).toContain('budget_exhausted');
    expect(
      session.authority.extensionRecordsInDomain('child_run'),
    ).toHaveLength(MANAGED_CHILD_LIMITS.maxLaunchesPerScope);
  }
});

it('refuses malformed background flags, empty and unstartable scripts', async () => {
  const malformed = await executeWorkflow(
    createTurn(),
    call({ script: SCRIPT, run_in_background: 'maybe' }),
  );
  expect(JSON.stringify(malformed)).toContain(
    'run_in_background must be a boolean',
  );
  const empty = await executeWorkflow(createTurn(), call({ script: '  ' }));
  expect(JSON.stringify(empty)).toContain('requires a nonempty script');
  const broken = await executeWorkflow(
    createTurn(),
    call({ script: 'const x: number = 1;' }),
  );
  expect(JSON.stringify(broken)).toContain('script is invalid');
  const nondeterministic = await executeWorkflow(
    createTurn(),
    call({ script: 'return Date.now();' }),
  );
  expect(JSON.stringify(nondeterministic)).toContain('script is invalid');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

it('answers an over-size envelope with the byte_limit refusal, not recovery', async () => {
  // A short script whose args carry the bytes: only the launch envelope's
  // own bound can refuse it (the script bound never fires), and the args
  // are three-byte characters, under the bound counted as UTF-16 units but
  // over it in UTF-8 bytes (#13858 R2-8).
  const blob = '界'.repeat(11 * 1024);
  expect(blob.length).toBeLessThan(32 * 1024);
  const responses = await executeWorkflow(
    createTurn(),
    call({ script: SCRIPT, args: { blob }, run_in_background: true }),
  );
  expect(JSON.stringify(responses)).toContain(
    'Hosted workflow refused this launch (byte_limit).',
  );
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

// #13858 R1-3/R4-6: the Java digest substrate renders every finite double
// the way JSON.stringify does — subnormals included (5e-324 is the value
// the real stack once looped on, R1-7) — so the launch admits them.
it('admits subnormal args, which both digest substrates render alike', async () => {
  const responses = await executeWorkflow(
    createTurn(),
    call({ script: SCRIPT, args: { v: 5e-324, nested: [1e-320, 1.5e-308] } }),
  );
  expect(JSON.stringify(responses)).toContain('Workflow child started');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    1,
  );
});

// #13858 R3-6/R2-11: args sit one level under the tool input the protocol
// digest walks, so the walk refuses exactly where that digest would throw:
// 63 levels under args commit, 64 refuse with the model-correctable text.
it('refuses args nested past what the launch can commit, at the digest bound', async () => {
  const deep = (levels: number): unknown =>
    levels === 0 ? 1 : [deep(levels - 1)];
  const admitted = await executeWorkflow(
    createTurn(),
    call({ script: SCRIPT, args: deep(63) }),
  );
  expect(JSON.stringify(admitted)).toContain('Workflow child started');
  const refused = await executeWorkflow(
    createTurn(),
    call({ script: SCRIPT, args: { v: deep(63) } }),
  );
  expect(JSON.stringify(refused)).toContain(
    'Hosted workflow args nest more than 63 levels deep, past what the launch can commit (depth_limit).',
  );
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    1,
  );
});

it('answers a protocol-ceiling call with a per-call refusal, not a wedged Turn (D1)', async () => {
  // A non-finite number (a model's 1e999) passes the admission walk but
  // has no canonical form: the digest used to throw out of
  // prepareRequests and take the whole parent Turn down
  // (hosted_turn_failed, R2-12); now it is the call's own refusal and
  // nothing is committed.
  const responses = await executeWorkflow(
    createTurn(),
    call({ script: SCRIPT, args: { v: Number.POSITIVE_INFINITY } }),
  );
  expect(JSON.stringify(responses)).toContain(
    'Hosted tool input cannot commit as protocol evidence',
  );
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

// #13858 R2-12: a script under the 32 KiB bound whose escapes double past
// the inline limit once encoded, and a script over the bound alike, answer
// a model-correctable byte_limit refusal instead of failing the Turn.
it('refuses an escape-dense or oversize script per call once its encoding passes the inline limit', async () => {
  // Every `\"` pair is two source bytes that each cost four once the input
  // is JSON-encoded twice for the Session Store.
  const dense = 'return "' + '\\"'.repeat(9000) + '";';
  expect(Buffer.byteLength(dense, 'utf8')).toBeLessThan(32 * 1024);
  const responses = await executeWorkflow(
    createTurn(),
    call({ script: dense }),
  );
  expect(JSON.stringify(responses)).toContain(
    'exceed the 65536-byte inline Session Store limit once encoded (byte_limit)',
  );
  const oversize = `return ${JSON.stringify('"'.repeat(40 * 1024))};`;
  const over = await executeWorkflow(createTurn(), call({ script: oversize }));
  expect(JSON.stringify(over)).toContain(
    `Hosted workflow script exceeds ${32 * 1024} bytes (byte_limit).`,
  );
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

it('commits a pinned workflow launch and names it in the answer', async () => {
  const turn = createTurn();
  const responses = await executeWorkflow(
    turn,
    call({ script: SCRIPT, args: { x: 1 } }),
  );
  const childRunId = `prompt:call-1`;
  const record = children.record(childRunId)!;
  // K1+K3: the chain opens as a workflow with the script-derived pin on
  // revision 1 — the pin's digest equals the envelope script's own.
  expect(record).toMatchObject({
    kind: 'workflow',
    completion: 'sent',
    childSessionId: null,
    depth: 1,
    workspaceMode: 'shared',
    run: {
      state: 'admitted',
      execution: 'intent',
      definition: workflowDefinitionPin(SCRIPT),
      delivery: { target: 'session', state: 'planned' },
    },
  });
  const envelope = decodeWorkflowLaunchEnvelope(
    await session.resources.read(record.inputRef),
  );
  expect(envelope).toEqual({
    definition: workflowDefinitionPin(SCRIPT),
    script: SCRIPT,
    args: { x: 1 },
  });
  expect(envelope.definition.definitionDigest).toBe(
    createHash('sha256').update(envelope.script, 'utf8').digest('hex'),
  );
  const taskId = `task_${managedExtensionRecordKey(sessionKey.sessionId, 'child_run', childRunId)}`;
  expect(JSON.stringify(responses)).toContain('Workflow child started');
  expect(JSON.stringify(responses)).toContain(taskId);
  expect(session.authority.taskViews()).toMatchObject([
    { kind: 'workflow', definitionRevision: 1 },
  ]);
  expect(broker.acquire).not.toHaveBeenCalled();
});

it('spends the same concurrency and budget a child agent does', async () => {
  const turn = createTurn();
  // Three child agents plus two workflow launches cross the per-scope cap
  // of four, whichever kind arrives fifth.
  for (let index = 0; index < 3; index++) {
    await turn.execute(
      [
        {
          name: 'agent',
          callId: `agent-${index}`,
          args: { description: `a${index}`, prompt: `p${index}` },
          isClientInitiated: false,
          prompt_id: 'prompt',
        } as ToolCallRequestInfo,
      ],
      [
        {
          functionCall: {
            id: `agent-${index}`,
            name: 'agent',
            args: { description: `a${index}`, prompt: `p${index}` },
          },
        },
      ],
      'model',
      new AbortController().signal,
    );
  }
  await executeWorkflow(turn, call({ script: SCRIPT }, 'call-4'));
  const refused = await executeWorkflow(
    turn,
    call({ script: SCRIPT }, 'call-5'),
  );
  expect(JSON.stringify(refused)).toContain('count_limit');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    4,
  );
  // Quotas gate NEW children only: re-driving the already-committed
  // launch at the full cap names its record instead of refusing it
  // (#13858 R4-8) — the re-driven batch of a restarted Harness.
  const replayed = await executeWorkflow(
    createTurn(),
    call({ script: SCRIPT }, 'call-4'),
  );
  expect(JSON.stringify(replayed)).toContain('Workflow child started');
  expect(JSON.stringify(replayed)).not.toContain('count_limit');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    4,
  );
});

it('admits a mixed one-batch launch of a background workflow and a child agent', async () => {
  const turn = createTurn();
  const agentCall: ToolCallRequestInfo = {
    name: 'agent',
    callId: 'agent-1',
    args: { description: 'audit', prompt: 'review' },
    isClientInitiated: false,
    prompt_id: 'prompt',
  } as ToolCallRequestInfo;
  const responses = await turn.execute(
    [call({ script: SCRIPT, run_in_background: true }, 'wf-1'), agentCall],
    [
      {
        functionCall: {
          id: 'wf-1',
          name: 'workflow',
          args: { script: SCRIPT, run_in_background: true },
        },
      },
      {
        functionCall: {
          id: 'agent-1',
          name: 'agent',
          args: { description: 'audit', prompt: 'review' },
        },
      },
    ],
    'model',
    new AbortController().signal,
  );
  // #13803: neither launch takes the Workspace mount, so a sibling child
  // launch never shares the batch-refusal the foreground mount arms carry.
  expect(JSON.stringify(responses)).not.toContain('cannot share a batch');
  expect(children.record('prompt:wf-1')).toMatchObject({ kind: 'workflow' });
  expect(children.record('prompt:agent-1')).toMatchObject({
    kind: 'child_agent',
  });
});

it('answers the tool arm from the committed acceptance, accepting it', async () => {
  const turn = createTurn();
  const childRunId = `prompt:call-1`;
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
      result: Buffer.from('workflow answer 2', 'utf8'),
      receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
    });
    await children.accept(childRunId);
  })();
  const responses = (
    await Promise.all([
      executeWorkflow(
        turn,
        call({ script: SCRIPT, args: { x: 1 }, run_in_background: false }),
      ),
      driving,
    ])
  )[0];
  expect(JSON.stringify(responses)).toContain('workflow answer 2');
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

it('answers a failed workflow child as an ended run, never a wait forever', async () => {
  const turn = createTurn();
  const childRunId = `prompt:call-1`;
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
    await children.settleFailed(childRunId, {
      stopReason: 'child_failed',
      reason: null,
      started: true,
    });
  })();
  const responses = (
    await Promise.all([
      executeWorkflow(turn, call({ script: SCRIPT, run_in_background: false })),
      driving,
    ])
  )[0];
  // The label pins which kind ended: a bare 'workflow' match would read the
  // tool's own serialized name instead of the run-over answer.
  expect(JSON.stringify(responses)).toContain('Workflow child');
  expect(JSON.stringify(responses)).toContain('child_failed');
});

it('answers a recovery-blocked workflow child as an ended run, never a wait forever', async () => {
  const harness = createManagedHarnessHandle(session);
  const resolveAwait = vi.spyOn(harness, 'resolveAwaitAgent');
  const turn = createTurn(0, false, harness);
  const childRunId = `prompt:call-1`;
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
    await children.settleRecoveryBlocked(childRunId, {
      reason: 'runtime_lost',
    });
  })();
  const responses = (
    await Promise.all([
      executeWorkflow(turn, call({ script: SCRIPT, run_in_background: false })),
      driving,
    ])
  )[0];
  // The blocked child ends the wait with its own honest line — the wait
  // returns in bounded time and the await checkpoint resolves.
  expect(JSON.stringify(responses)).toContain('Workflow child');
  expect(JSON.stringify(responses)).toContain('recovery blocked');
  expect(JSON.stringify(responses)).toContain('outcome unknown');
  expect(resolveAwait).toHaveBeenCalledWith(childRunId);
});

it('parks the foreground workflow wait before it waits, exactly as the agent arm', async () => {
  const harness = createManagedHarnessHandle(session);
  const commitAwaitAgent = vi.spyOn(harness, 'commitAwaitAgent');
  const turn = createTurn(0, false, harness);
  const childRunId = `prompt:call-1`;
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
      result: Buffer.from('workflow answer 2', 'utf8'),
      receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
    });
    await children.accept(childRunId);
  })();
  const responses = (
    await Promise.all([
      executeWorkflow(turn, call({ script: SCRIPT, run_in_background: false })),
      driving,
    ])
  )[0];
  expect(JSON.stringify(responses)).toContain('workflow answer 2');
  // The durable wait (#13708) the agent arm parks: a Harness restart while
  // the parent waits must re-enter the wait from this checkpoint, not
  // decline the Turn with unresolved_after_settle.
  expect(commitAwaitAgent).toHaveBeenCalledWith(
    [
      {
        childRunId,
        functionCallId: 'call-1',
        toolName: 'workflow',
        modelMessageId: expect.any(String),
        consumed: false,
      },
    ],
    { turnId: 'prompt', promptId: 'prompt' },
    { attemptId: expect.any(String), routeRef: expect.anything() },
  );
});
