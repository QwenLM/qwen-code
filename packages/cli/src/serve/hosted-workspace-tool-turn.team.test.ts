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
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { parseTeamState } from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  HostedWorkspaceToolTurn,
  HOSTED_AGENT_TOOL,
  HOSTED_AGENT_WORKTREE_TOOL,
  HOSTED_SEND_MESSAGE_TO_CHILD_TOOL,
  HOSTED_TEAM_AGENT_TOOL,
  HOSTED_TEAM_AGENT_WORKTREE_TOOL,
  HOSTED_TEAM_AGENT_SNAPSHOT_TOOL,
  HOSTED_TEAM_SEND_MESSAGE_TO_CHILD_TOOL,
  hostedTeamMessageInput,
} from './hosted-workspace-tool-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import {
  HOSTED_TEAM_TOOLS,
  HostedTeamSession,
  type HostedTeamStore,
} from './hosted-team-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { HostedSessionMessageSession } from './hosted-session-message-session.js';
import {
  broadcastMessageId,
  broadcastRunId,
  hostedCallKey,
  teamMemberPreamble,
} from './hosted-member-chain.js';
import { sessionMessageId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-operations.js';
import {
  answerCommittedTurnCalls,
  settleInterruptedTurnRuntime,
} from './hosted-runtime-recovery.js';
import { encodeChildLaunchEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import {
  HOSTED_APPROVAL_OPTIONS,
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  resolveHostedAction,
} from './hosted-tool-approval.js';

// H4e-b1: team_state and team_task are enabled, so the flags close the
// real gate per test; with either closed the turn keeps the H4b surface
// exactly, which is what a rollback of the enablement restores.
const enablement = vi.hoisted(() => ({
  teamState: true,
  teamTask: true,
  teamPlan: false,
}));
vi.mock(
  '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js')
      >();
    return {
      ...actual,
      assertManagedSessionDomainEnabled: (
        domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
      ) => {
        if (
          (domain === 'team_state' && !enablement.teamState) ||
          (domain === 'team_task' && !enablement.teamTask)
        )
          throw new actual.ManagedSessionRecordError(
            `domain ${domain} is registered but not enabled for submission.`,
          );
        if (domain === 'team_plan' && enablement.teamPlan) return;
        actual.assertManagedSessionDomainEnabled(domain);
      },
    };
  },
);

// The team and agent paths never dispatch through the Broker, but the
// turn's constructor warms it; acquire is watched to prove they never
// take the Workspace mount.
const broker = vi.hoisted(() => ({
  warm: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
}));
vi.mock('./hosted-workspace-broker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hosted-workspace-broker.js')>()),
  HostedWorkspaceBroker: class {
    readonly runtimeSessionId = 'prompt';
    warm = broker.warm;
    acquire = broker.acquire;
    release = broker.release;
  },
}));

let root: string;
let session: ManagedSession;
let children: HostedChildAgentSession;
let teams: HostedTeamSession;
let sessionKey: { tenantId: string; workspaceId: string; sessionId: string };

function call(
  name: string,
  args: Record<string, unknown>,
  callId: string,
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
  options: {
    depth?: number;
    hookEvents?: string[];
    funnel?: HostedTeamSession;
    childWorkspaces?: boolean;
    childSnapshots?: boolean;
    messages?: boolean;
    /** H4e-b2: another Turn of the same Session. */
    promptId?: string;
    /** H4e-b3a: this run's first input carried a plan-mode preamble. */
    memberPlanMode?: boolean;
  } = {},
): HostedWorkspaceToolTurn {
  const hookEvents = options.hookEvents;
  const promptId = options.promptId ?? 'prompt';
  return new HostedWorkspaceToolTurn(
    { baseUrl: 'http://127.0.0.1:1', token: 'test' },
    session,
    createManagedHarnessHandle(session),
    promptId,
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
        daemonPromptId: promptId,
        message: {
          role: type === 'assistant' ? 'model' : 'user',
          parts: messageParts,
        },
      });
      return uuid;
    },
    () => true,
    undefined,
    { resources: session.resources, assertWritable: async () => undefined },
    undefined,
    {
      profile: 'hosted-workspace-team-lead/1',
      childAgents: {
        funnel: children,
        depth: options.depth ?? 0,
        childWorkspaces: options.childWorkspaces === true,
        childSnapshots: options.childSnapshots === true,
        queueConsumption: () => undefined,
      },
      teams: options.funnel ?? teams,
      memberPlanMode: options.memberPlanMode === true,
      ...(options.messages
        ? {
            messages: new HostedSessionMessageSession(
              { authority: session.authority, resources: session.resources },
              sessionKey,
              children,
              undefined,
            ),
          }
        : {}),
      ...(hookEvents
        ? {
            hooks: {
              broker: new (HostedWorkspaceBroker as unknown as new (
                ...args: unknown[]
              ) => HostedWorkspaceBroker)(),
              mountHeld: false,
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
    },
  );
}

async function execute(
  turn: HostedWorkspaceToolTurn,
  calls: ToolCallRequestInfo[],
): Promise<string> {
  const responses: Part[] = await turn.execute(
    calls,
    calls.map((each) => ({
      functionCall: { id: each.callId, name: each.name, args: each.args },
    })),
    'model',
    new AbortController().signal,
  );
  return JSON.stringify(responses);
}

const member = (name: string, callId: string, extra = {}) =>
  call(
    'agent',
    {
      description: `${name} task`,
      prompt: 'review the change',
      name,
      ...extra,
    },
    callId,
  );

it('gates plan launch declarations and propagates the named member requirement', async () => {
  const signal = new AbortController().signal;
  expect(JSON.stringify(await createTurn().declarations(signal))).not.toContain(
    'plan_mode_required',
  );
  enablement.teamPlan = true;
  const tools = await createTurn().declarations(signal);
  expect(tools.map((tool) => tool.name)).toContain('team_plan_approval');
  expect(JSON.stringify(tools.find((tool) => tool.name === 'agent'))).toContain(
    'plan_mode_required',
  );
  await execute(createTurn(), [
    call('team_create', { team_name: 'review' }, 'create-plan-team'),
  ]);
  expect(
    await execute(createTurn(), [
      member('alice', 'launch-plan', { plan_mode_required: true }),
    ]),
  ).toContain('joined');
  expect(roster()[0]?.planModeRequired).toBe(true);
  const run = children.record(hostedCallKey('prompt', 'launch-plan'));
  expect(run).toBeDefined();
  const envelope = await session.resources.read(run!.inputRef);
  expect(envelope.toString()).toContain('plan-mode=');
  expect(
    await execute(createTurn(), [
      call(
        'agent',
        { description: 'plain', prompt: 'work', plan_mode_required: true },
        'plain-plan',
      ),
    ]),
  ).toContain('unsupported argument');
});

it.each([false, true])(
  'executes plan approval through the tool turn with closing=%s',
  async (closing) => {
    enablement.teamPlan = true;
    await execute(createTurn(), [
      call('team_create', { team_name: 'review' }, 'create'),
    ]);
    await execute(createTurn(), [
      member('alice', 'launch-plan', { plan_mode_required: true }),
    ]);
    const childRunId = hostedCallKey('prompt', 'launch-plan');
    await teams.submitPlan('submitted-plan', childRunId, 'Read the source');
    await children.dispatchStarted(childRunId, {
      dispatchId: 'dispatch-plan',
      runtime: { runtimeBindingId: 'binding', generation: '1' },
    });
    await children.attach(childRunId, 'alice-session');
    await children.settleCompleted(childRunId, {
      result: Buffer.from('plan ready'),
      receipt: Buffer.from('{"outcome":"settled"}'),
    });
    const activation = session.authority.currentActivation!;
    const context = closing
      ? vi
          .spyOn(session.authority, 'currentActivation', 'get')
          .mockReturnValue({ ...activation, phase: 'closing' })
      : undefined;
    try {
      const answer = await execute(createTurn(), [
        call(
          'team_plan_approval',
          { request_id: 'submitted-plan', action: 'approve' },
          'decide',
        ),
      ]);
      const continuation = children.record(hostedCallKey('prompt', 'decide'));
      if (closing) {
        expect(answer).toContain('closing');
        expect(teams.plan('submitted-plan')?.run.state).toBe('waiting');
        expect(continuation).toBeUndefined();
      } else {
        expect(answer).toContain('member was continued');
        expect(teams.plan('submitted-plan')?.decision).toBe('approved');
        expect(continuation?.predecessorChildRunId).toBe(childRunId);
        expect(continuation).toBeDefined();
        expect(
          session.authority.committedExtensionOperation(
            'decideTeamPlan',
            hostedCallKey('prompt', 'decide'),
          ),
        ).toBeDefined();
      }
    } finally {
      context?.mockRestore();
    }
  },
);

function roster() {
  return session.authority
    .extensionRecordsInDomain('team_state')
    .flatMap((entry) => parseTeamState(entry.record).members);
}

beforeEach(async () => {
  enablement.teamState = true;
  enablement.teamTask = true;
  enablement.teamPlan = false;
  vi.resetAllMocks();
  broker.warm.mockResolvedValue(undefined);
  broker.acquire.mockResolvedValue(undefined);
  broker.release.mockResolvedValue(undefined);
  root = await mkdtemp(path.join(tmpdir(), 'hosted-team-turn-'));
  sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
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
  const store = { authority: session.authority, resources: session.resources };
  children = new HostedChildAgentSession(store, sessionKey);
  teams = new HostedTeamSession(store, sessionKey, children);
});

afterEach(async () => {
  await session?.close();
  await rm(root, { recursive: true, force: true });
});

// H4e-b3a (decisions 5 and 9): a run whose first input carried the
// plan-mode attribute admits reads only; this build's refusal never names
// exit_plan_mode.
it('admits reads only in a plan-mode run, without naming exit_plan_mode', async () => {
  // messages: the arm needs send_message declared, alongside its reads.
  const planTurn = createTurn({ memberPlanMode: true, messages: true });
  const refusal = 'This run is in plan mode until the leader approves its plan';
  for (const denied of [
    call('write_file', { file_path: 'notes.md', content: 'x' }, 'call-1'),
    call('run_shell_command', { command: 'ls' }, 'call-2'),
    call('agent', { description: 'a', prompt: 'b' }, 'call-3'),
    call('team_create', { team_name: 'review' }, 'call-4'),
  ]) {
    const answer = await execute(planTurn, [denied]);
    expect(answer).toContain(refusal);
    expect(answer).not.toContain('exit_plan_mode');
  }
  // The reads stay admitted: their own answers never name plan mode.
  // (glob rides the same allowance, and only the search profiles declare
  // it — this profile's surface cannot exercise it either way.)
  for (const allowed of [
    call('send_message', {}, 'call-5'),
    call('read_file', {}, 'call-7'),
  ])
    expect(await execute(planTurn, [allowed])).not.toContain('plan mode');
});

it('declares the team tools only beside the root Agent tool, behind both gates', async () => {
  const signal = new AbortController().signal;
  const names = async (turn: HostedWorkspaceToolTurn) =>
    (await turn.declarations(signal)).map((tool) => tool.name);
  const team = [
    'team_create',
    'team_delete',
    'request_shutdown',
    'task_create',
    'task_update',
    'task_list',
  ];
  const tools = await createTurn().declarations(signal);
  expect(tools).toContain(HOSTED_TEAM_AGENT_TOOL);
  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(team));
  expect(HOSTED_TEAM_TOOLS.map((tool) => tool.name)).toEqual(team);
  expect(
    (
      HOSTED_TEAM_AGENT_TOOL.parametersJsonSchema as {
        properties: Record<string, unknown>;
      }
    ).properties['name'],
  ).toBeDefined();
  // A child Session sees neither the Agent tool nor the team.
  expect(await names(createTurn({ depth: 1 }))).not.toEqual(
    expect.arrayContaining(['agent']),
  );
  expect(
    (await names(createTurn({ depth: 1 }))).some((name) =>
      team.includes(name!),
    ),
  ).toBe(false);
  // Each domain gates the team on its own.
  for (const gate of ['teamState', 'teamTask'] as const) {
    enablement.teamState = gate !== 'teamState';
    enablement.teamTask = gate !== 'teamTask';
    const closed = await createTurn().declarations(signal);
    expect(closed).toContain(HOSTED_AGENT_TOOL);
    expect(closed.some((tool) => team.includes(tool.name!))).toBe(false);
  }
});

// #13753 I2: a host that serves child Workspaces adds isolation to the
// team's Agent tool too, and a member may run isolated like any child.
it('composes worktree isolation with team membership', async () => {
  const signal = new AbortController().signal;
  const capable = await createTurn({ childWorkspaces: true }).declarations(
    signal,
  );
  expect(capable).toContain(HOSTED_TEAM_AGENT_WORKTREE_TOOL);
  expect(capable).not.toContain(HOSTED_TEAM_AGENT_TOOL);
  enablement.teamState = false;
  expect(
    await createTurn({ childWorkspaces: true }).declarations(signal),
  ).toContain(HOSTED_AGENT_WORKTREE_TOOL);
  enablement.teamState = true;

  const plain = createTurn();
  await execute(plain, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  expect(
    await execute(plain, [
      member('bob', 'call-bob', { isolation: 'worktree' }),
    ]),
  ).toContain('(workspace_mode)');
  expect(children.record('prompt:call-bob')).toBeUndefined();
  expect(roster()).toEqual([]);

  const answer = await execute(createTurn({ childWorkspaces: true }), [
    member('alice', 'call-alice', { isolation: 'worktree' }),
  ]);
  expect(answer).toContain('joined team \\"review\\" as \\"alice\\"');
  expect(children.record('prompt:call-alice')).toMatchObject({
    workspaceMode: 'worktree',
    completion: 'sent',
  });
});

// #13753 I3: a member trades messages with its leader, which a snapshot
// cannot, so the team's snapshot declaration says so and a snapshot member
// is refused before anything commits; a plain snapshot child is not.
it('refuses a snapshot member and admits a plain snapshot child', async () => {
  const signal = new AbortController().signal;
  const capable = createTurn({ childWorkspaces: true, childSnapshots: true });
  expect(await capable.declarations(signal)).toContain(
    HOSTED_TEAM_AGENT_SNAPSHOT_TOOL,
  );
  // The snapshot flag counts only beside child Workspaces.
  const flagOnly = await createTurn({ childSnapshots: true }).declarations(
    signal,
  );
  expect(flagOnly).toContain(HOSTED_TEAM_AGENT_TOOL);
  expect(flagOnly).not.toContain(HOSTED_TEAM_AGENT_SNAPSHOT_TOOL);
  expect(HOSTED_TEAM_AGENT_SNAPSHOT_TOOL.description).toContain(
    'A team member (name) cannot run as a snapshot.',
  );
  await execute(capable, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  const refused = await execute(capable, [
    member('bob', 'call-bob', { isolation: 'snapshot' }),
  ]);
  expect(refused).toContain('Hosted team member cannot run as a snapshot');
  expect(refused).toContain(
    'with isolation \\"worktree\\" or without isolation, or launch the snapshot without name.',
  );
  expect(children.record('prompt:call-bob')).toBeUndefined();
  expect(roster()).toEqual([]);
  // The remedies name only the isolation the host serves, and a refusal on
  // either host commits nothing, exactly like the capable host's refusal.
  const worktreeOnly = await execute(createTurn({ childWorkspaces: true }), [
    member('bob', 'call-bob-worktree', { isolation: 'snapshot' }),
  ]);
  expect(worktreeOnly).toContain(
    'Launch the member with isolation \\"worktree\\" or without isolation.',
  );
  expect(worktreeOnly).not.toContain('snapshot without name');
  expect(children.record('prompt:call-bob-worktree')).toBeUndefined();
  expect(roster()).toEqual([]);
  expect(
    await execute(createTurn(), [
      member('bob', 'call-bob-shared', { isolation: 'snapshot' }),
    ]),
  ).toContain('Launch the member without isolation.');
  expect(children.record('prompt:call-bob-shared')).toBeUndefined();
  expect(roster()).toEqual([]);

  await execute(capable, [
    call(
      'agent',
      { description: 'reader', prompt: 'review', isolation: 'snapshot' },
      'call-reader',
    ),
  ]);
  expect(children.record('prompt:call-reader')).toMatchObject({
    workspaceMode: 'snapshot',
  });
  expect(roster()).toEqual([]);
  // Serving snapshots changes no default: a member naming no isolation
  // still joins, shared.
  expect(await execute(capable, [member('carol', 'call-carol')])).toContain(
    'joined team \\"review\\" as \\"carol\\"',
  );
  expect(children.record('prompt:call-carol')?.workspaceMode).toBe('shared');
  expect(roster()).toEqual([
    { name: 'carol', childRunId: 'prompt:call-carol', planModeRequired: false },
  ]);
});

// #13753 I3: a send to a running snapshot child is refused, and one after
// it completes continues it as a new snapshot, through both forms of
// send_message (the team's and the plain one).
it('continues a completed snapshot child through either send_message', async () => {
  for (const teamsOn of [true, false]) {
    enablement.teamState = teamsOn;
    enablement.teamTask = teamsOn;
    const turn = createTurn({
      childWorkspaces: true,
      childSnapshots: true,
      messages: true,
    });
    const launch = `call-reader-${teamsOn}`;
    await execute(turn, [
      call(
        'agent',
        { description: 'reader', prompt: 'review', isolation: 'snapshot' },
        launch,
      ),
    ]);
    const task = children.taskIdOf(`prompt:${launch}`);
    const running = await execute(turn, [
      call(
        'send_message',
        { task_id: task, message: 'more' },
        `run-${teamsOn}`,
      ),
    ]);
    expect(running).toContain('is a read-only snapshot');
    await finish(`prompt:${launch}`);
    await execute(turn, [
      call(
        'send_message',
        { task_id: task, message: 'more' },
        `more-${teamsOn}`,
      ),
    ]);
    expect(children.record(`prompt:more-${teamsOn}`)).toMatchObject({
      workspaceMode: 'snapshot',
      predecessorChildRunId: `prompt:${launch}`,
    });
  }
});

// With the team on, `name` is a supported argument, so the refusal of
// another legacy argument no longer lists it among them.
it('stops listing name as legacy once the team domains are enabled', async () => {
  const answer = await execute(createTurn(), [
    member('alice', 'call-1', { model: 'other' }),
  ]);
  expect(answer).toContain('unsupported argument \\"model\\"');
  expect(answer).toContain('working_dir, model and subagent_type');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

it('keeps refusing name while the team domains are disabled', async () => {
  enablement.teamState = false;
  enablement.teamTask = false;
  const answer = await execute(createTurn(), [member('alice', 'call-1')]);
  expect(answer).toContain('unsupported argument');
  expect(answer).toContain('\\"name\\"');
  expect(answer).toContain('working_dir, name, model');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

it('creates a team and spawns a named member without the Workspace mount', async () => {
  const turn = createTurn();
  expect(
    await execute(turn, [
      call('team_create', { team_name: 'Review' }, 'call-team'),
      call(
        'task_create',
        { subject: 'audit', description: 'audit it' },
        'call-task',
      ),
    ]),
  ).toContain('Task #1 created');
  const answer = await execute(turn, [member('Alice', 'call-alice')]);
  expect(answer).toContain('joined team \\"review\\" as \\"alice\\"');
  expect(children.record('prompt:call-alice')).toMatchObject({
    completion: 'sent',
  });
  expect(roster()).toEqual([
    { name: 'alice', childRunId: 'prompt:call-alice', planModeRequired: false },
  ]);
  expect(await execute(turn, [call('task_list', {}, 'call-list')])).toContain(
    'alice: running',
  );
  expect(broker.acquire).not.toHaveBeenCalled();
});

// A recovered foreground wait (#13708) answers every sibling it never
// reached as an agent call that never ran, so a foreground child keeps
// sharing its batch with agent calls only, team tools included.
it('keeps team tools out of a foreground child batch', async () => {
  const turn = createTurn();
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  const answer = await execute(turn, [
    call('task_list', {}, 'call-list'),
    call(
      'agent',
      { description: 'audit', prompt: 'review', run_in_background: false },
      'call-child',
    ),
  ]);
  expect(answer).toContain(
    'cannot share a batch with a tool other than agent or workflow',
  );
  expect(children.record('prompt:call-child')).toBeUndefined();
});

it('refuses a member without a team, committing nothing', async () => {
  const answer = await execute(createTurn(), [member('alice', 'call-1')]);
  expect(answer).toContain('Create one with team_create first');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

it('refuses a foreground member and the batch rules before anything runs', async () => {
  const turn = createTurn();
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  expect(
    await execute(turn, [
      member('alice', 'call-1', { run_in_background: false }),
    ]),
  ).toContain('always runs in the background');
  expect(
    await execute(turn, [member('alice', 'call-2'), member('ALICE', 'call-3')]),
  ).toContain('Two launches in one batch name the member \\"alice\\"');
  expect(
    await execute(turn, [
      call('team_delete', {}, 'call-4'),
      member('bob', 'call-5'),
    ]),
  ).toContain('cannot launch in the same batch as team_create or team_delete');
  expect(
    await execute(turn, [
      call(
        'agent',
        { description: 'audit', prompt: 'review', run_in_background: false },
        'call-6',
      ),
      member('carol', 'call-7'),
    ]),
  ).toContain('cannot launch in the same batch as a foreground child agent');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
  expect(teams.openTeam()?.lifecycle).toBe('active');
});

it('replays a named launch into its one child and one roster entry', async () => {
  await execute(createTurn(), [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(createTurn(), [member('alice', 'call-alice')]);
  const replayed = await execute(createTurn(), [member('alice', 'call-alice')]);
  expect(replayed).toContain('joined team \\"review\\" as \\"alice\\"');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    1,
  );
  expect(roster()).toHaveLength(1);
});

// No production path re-runs an executed call; this pins the funnel's own
// replay safety for a batch that would be driven again.
it('a re-driven named launch completes a join its first run lost', async () => {
  await execute(createTurn(), [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  const crashing = new HostedTeamSession(
    {
      resources: session.resources,
      authority: Object.create(session.authority, {
        commitExtensionRecord: {
          value: async (
            ...args: Parameters<
              HostedTeamStore['authority']['commitExtensionRecord']
            >
          ) => {
            if (args[0].commandId.endsWith(':join'))
              throw new Error('Harness stopped');
            return session.authority.commitExtensionRecord(...args);
          },
        },
      }),
    },
    sessionKey,
    children,
  );
  await expect(
    execute(createTurn({ funnel: crashing }), [member('alice', 'call-alice')]),
  ).rejects.toThrow();
  expect(children.record('prompt:call-alice')).toBeDefined();
  expect(roster()).toHaveLength(0);
  expect(
    await execute(createTurn(), [member('alice', 'call-alice')]),
  ).toContain('joined team');
  expect(roster()).toEqual([
    expect.objectContaining({ name: 'alice', childRunId: 'prompt:call-alice' }),
  ]);
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    1,
  );
});

it.each(['failed', 'finished'] as const)(
  'answers a launch whose run %s before the join, leaving the name free',
  async (outcome) => {
    await execute(createTurn(), [
      call('team_create', { team_name: 'review' }, 'call-team'),
    ]);
    // The relay ends the run in the window between launch and join.
    const childRunId = 'prompt:call-alice';
    const endFirst = new HostedTeamSession(
      {
        resources: session.resources,
        authority: Object.create(session.authority, {
          commitExtensionRecord: {
            value: async (
              ...args: Parameters<
                HostedTeamStore['authority']['commitExtensionRecord']
              >
            ) => {
              if (args[0].commandId.endsWith(':join')) {
                if (outcome === 'failed') {
                  await children.settleFailed(childRunId, {
                    stopReason: 'creation_failed',
                    reason: null,
                    started: false,
                  });
                } else {
                  await children.dispatchStarted(childRunId, {
                    dispatchId: 'dispatch-1',
                    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
                  });
                  await children.attach(childRunId, 'session-child');
                  await children.settleCompleted(childRunId, {
                    result: Buffer.from('done', 'utf8'),
                    receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
                  });
                }
              }
              return session.authority.commitExtensionRecord(...args);
            },
          },
        }),
      },
      sessionKey,
      children,
    );
    const answer = await execute(createTurn({ funnel: endFirst }), [
      member('alice', 'call-alice'),
    ]);
    expect(answer).toContain('the name \\"alice\\" stays free');
    if (outcome === 'failed') {
      expect(answer).toContain(
        'ended (failed, creation_failed) before it joined',
      );
      expect(answer).toContain('"error":');
    } else {
      expect(answer).toContain('finished before it joined');
      expect(answer).toContain('arrives as an ordinary notification');
      expect(answer).not.toContain('"error":');
    }
    expect(roster()).toHaveLength(0);
  },
);

it('labels a member result notification with its name', async () => {
  const turn = createTurn();
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  const childRunId = 'prompt:call-alice';
  await children.dispatchStarted(childRunId, {
    dispatchId: 'dispatch-1',
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach(childRunId, 'session-child');
  await children.settleCompleted(childRunId, {
    result: Buffer.from('all clean', 'utf8'),
    receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
  });
  await children.accept(childRunId, {
    notification: { description: 'alice task' },
  });
  const input = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .findLast((event) => event.kind === 'input.accepted')!;
  const text = JSON.parse(
    (
      await session.resources.read(
        assertManagedSessionDurableRef(input.payload['contentRef'], 'input'),
      )
    ).toString('utf8'),
  ).text as string;
  expect(text).toContain(
    '<kind>child_agent</kind>\n<teammate>alice</teammate>',
  );
  expect(text).toContain('all clean');
});

// A run keeps the label of the roster it joined: a result the relay accepts
// after its team was deleted still names its member.
it('keeps the label on a result accepted after its team was deleted', async () => {
  const turn = createTurn();
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  const childRunId = 'prompt:call-alice';
  await children.dispatchStarted(childRunId, {
    dispatchId: 'dispatch-1',
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach(childRunId, 'session-child');
  await children.settleCompleted(childRunId, {
    result: Buffer.from('all clean', 'utf8'),
    receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
  });
  expect(
    await execute(turn, [call('team_delete', {}, 'call-delete')]),
  ).toContain('deleted.');
  await children.accept(childRunId, {
    notification: { description: 'alice task' },
  });
  const input = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .findLast((event) => event.kind === 'input.accepted')!;
  const text = JSON.parse(
    (
      await session.resources.read(
        assertManagedSessionDurableRef(input.payload['contentRef'], 'input'),
      )
    ).toString('utf8'),
  ).text as string;
  expect(text).toContain(
    '<kind>child_agent</kind>\n<teammate>alice</teammate>',
  );
});

it('declares send_message with team addressing beside the team tools', async () => {
  const signal = new AbortController().signal;
  const tools = await createTurn({ messages: true }).declarations(signal);
  expect(tools.filter((tool) => tool.name === 'send_message')).toEqual([
    HOSTED_TEAM_SEND_MESSAGE_TO_CHILD_TOOL,
  ]);
  // H4e-b2 decisions 3 and 4: a member by name, every member with "*",
  // or a child by task id — exactly one of to and task_id.
  expect(HOSTED_TEAM_SEND_MESSAGE_TO_CHILD_TOOL.description).toContain(
    'to every member at once (to: "*")',
  );
  expect(HOSTED_TEAM_SEND_MESSAGE_TO_CHILD_TOOL.parametersJsonSchema).toEqual({
    type: 'object',
    properties: {
      to: expect.objectContaining({ type: 'string' }),
      task_id: expect.objectContaining({ type: 'string' }),
      message: (
        HOSTED_SEND_MESSAGE_TO_CHILD_TOOL.parametersJsonSchema as {
          properties: Record<string, unknown>;
        }
      ).properties['message'],
    },
    required: ['message'],
    additionalProperties: false,
  });
});

// #13841: an isolated member's result names its merge outcome beside its
// name, and team_delete counts it as running until its run settles, which
// for an isolated member follows the merge.
it('labels an isolated member with its merge outcome and waits for its settle', async () => {
  const turn = createTurn({ childWorkspaces: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [
    member('alice', 'call-alice', { isolation: 'worktree' }),
  ]);
  const childRunId = 'prompt:call-alice';
  await children.dispatchStarted(childRunId, {
    dispatchId: 'dispatch-1',
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach(childRunId, 'session-child');
  expect(
    await execute(turn, [call('team_delete', {}, 'call-delete-early')]),
  ).toContain('still has running members: alice');
  const childWorkspaceId = 'a'.repeat(32);
  await children.settleCompleted(childRunId, {
    result: Buffer.from('all clean', 'utf8'),
    receipt: Buffer.from(
      JSON.stringify({
        childSessionId: 'session-child',
        turnId: 'turn-1',
        status: 'completed',
        completedAt: 1,
        workspace: {
          mode: 'worktree',
          childWorkspaceId,
          outcome: 'conflicted',
          code: 'conflicted',
          conflictPaths: ['src/a.ts'],
          resultRef: `refs/qwen/child-workspaces/${childWorkspaceId}/result`,
        },
      }),
      'utf8',
    ),
  });
  await children.accept(childRunId, {
    notification: { description: 'alice task' },
  });
  const input = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .findLast((event) => event.kind === 'input.accepted')!;
  const text = JSON.parse(
    (
      await session.resources.read(
        assertManagedSessionDurableRef(input.payload['contentRef'], 'input'),
      )
    ).toString('utf8'),
  ).text as string;
  expect(text).toContain('<teammate>alice</teammate>');
  expect(text).toContain('<workspace>merge conflicted at');
  expect(text).toContain('all clean');
  expect(await execute(turn, [call('task_list', {}, 'call-list')])).toContain(
    'alice: completed',
  );
  expect(
    await execute(turn, [call('team_delete', {}, 'call-delete')]),
  ).toContain('Team \\"review\\" deleted.');
});

// #13822 continues a finished child as a new run; H4e-b2 lets the roster
// follow it, so a finished member of the active team is continued and
// stays the same member.
it('messages a running member and continues a finished one as the same member', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [member('bob', 'call-bob')]);
  const alice = children.taskIdOf('prompt:call-alice');
  const bob = children.taskIdOf('prompt:call-bob');
  expect(
    await execute(turn, [
      call(
        'send_message',
        { task_id: bob, message: 'also check the tests' },
        'call-note',
      ),
    ]),
  ).toContain('Message queued for delivery');
  // H4e-b2 decision 3: a name routes as its first run's task id does.
  expect(
    await execute(turn, [
      call('send_message', { to: 'Bob', message: 'hi' }, 'call-by-name'),
    ]),
  ).toContain(`Message queued for delivery to member \\"bob\\" (task ${bob}).`);
  await children.dispatchStarted('prompt:call-alice', {
    dispatchId: 'dispatch-1',
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach('prompt:call-alice', 'session-alice');
  await children.settleCompleted('prompt:call-alice', {
    result: Buffer.from('all clean', 'utf8'),
    receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
  });
  // H4e-b2 decision 2: a finished member of the active team is continued,
  // and the continuation opens its instruction with the member preamble.
  expect(
    await execute(turn, [
      call(
        'send_message',
        { task_id: alice, message: 'now fix them' },
        'call-more',
      ),
    ]),
  ).toContain('continued it as');
  const continued = children.record('prompt:call-more')!;
  expect(continued.predecessorChildRunId).toBe('prompt:call-alice');
  const envelope = JSON.parse(
    (await session.resources.read(continued.inputRef)).toString('utf8'),
  ) as { prompt: string };
  expect(envelope.prompt).toBe(
    `${teamMemberPreamble({ name: 'alice', teamName: 'review' })}now fix them`,
  );
  const listing = await execute(turn, [call('task_list', {}, 'call-list')]);
  // The member is its chain head: running, with the head's task id.
  expect(listing).toContain(
    `alice: running — ${children.taskIdOf('prompt:call-more')}\\nbob: running — ${bob}`,
  );
  // A plain child beside the team continues as before.
  await execute(turn, [
    call(
      'agent',
      { description: 'plain', prompt: 'look', run_in_background: true },
      'call-plain',
    ),
  ]);
  await children.dispatchStarted('prompt:call-plain', {
    dispatchId: 'dispatch-2',
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach('prompt:call-plain', 'session-plain');
  await children.settleCompleted('prompt:call-plain', {
    result: Buffer.from('seen', 'utf8'),
    receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
  });
  expect(
    await execute(turn, [
      call(
        'send_message',
        {
          task_id: children.taskIdOf('prompt:call-plain'),
          message: 'look again',
        },
        'call-plain-more',
      ),
    ]),
  ).toContain('continued it as');
  expect(children.record('prompt:call-plain-more')).toBeDefined();
});

// Once its team is deleted, no new work routes through its roster, so a
// former member continues as a plain child.
it('continues a former member once its team is deleted', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await children.dispatchStarted('prompt:call-alice', {
    dispatchId: 'dispatch-1',
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach('prompt:call-alice', 'session-alice');
  await children.settleCompleted('prompt:call-alice', {
    result: Buffer.from('all clean', 'utf8'),
    receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
  });
  expect(
    await execute(turn, [call('team_delete', {}, 'call-delete')]),
  ).toContain('deleted.');
  expect(
    await execute(turn, [
      call(
        'send_message',
        {
          task_id: children.taskIdOf('prompt:call-alice'),
          message: 'one more thing',
        },
        'call-more',
      ),
    ]),
  ).toContain('continued it as');
  expect(children.record('prompt:call-more')).toMatchObject({
    predecessorChildRunId: 'prompt:call-alice',
  });
});

it('answers an interrupted turn by what each journal-only call committed', async () => {
  // An earlier turn opened the team.
  await teams.run('team_create', { team_name: 'review' }, 'earlier:call-team');
  const authority = session.authority;
  const harness = createManagedHarnessHandle(session);
  await authority.submitInput(
    {
      operation: 'submitInput',
      commandId: 'prompt',
      sessionKey,
      contentDigest: 'd'.repeat(64),
    },
    {
      inputId: 'prompt',
      turnId: 'prompt',
      source: 'hosted-harness',
      contentRef: await session.resources.publish(
        'managed-input',
        Buffer.from(JSON.stringify([{ type: 'text', text: 'staff the team' }])),
      ),
      admissionRef: await session.resources.publish(
        'managed-admission',
        Buffer.from('{}'),
      ),
      deadline: null,
      wakeReason: 'input',
    },
  );
  await harness.ensureRunnable();
  const messageId = randomUUID();
  const calls = [
    call(
      'task_create',
      { subject: 'audit', description: 'audit it' },
      'call-task',
    ),
    member('alice', 'call-alice'),
    call('task_list', {}, 'call-list'),
  ];
  await session.sink.write({
    uuid: messageId,
    parentUuid: null,
    sessionId: sessionKey.sessionId,
    timestamp: new Date().toISOString(),
    model: 'model',
    type: 'assistant',
    cwd: root,
    version: 'test',
    daemonPromptId: 'prompt',
    message: {
      role: 'model',
      parts: calls.map((each) => ({
        functionCall: { id: each.callId, name: each.name, args: each.args },
      })),
    },
  });
  // The batch was approved (which binds the Turn), then ran until the
  // Harness died: the task and the member committed, no answer did.
  const inputRef = await session.resources.publish(
    'managed-tool-input',
    Buffer.from('{}'),
  );
  const requestId = `tool_approval_${'a'.repeat(32)}`;
  await harness.commitDurableWait(
    {
      requestId,
      kind: 'permission',
      source: 'tool_call',
      optionsRef: await session.resources.publish(
        'managed-action-options',
        Buffer.from(
          JSON.stringify({
            v: 1,
            requestId,
            turnId: 'prompt',
            functionCallId: 'call-task',
            toolName: 'task_create',
            policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
            inputRevision: 1,
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            options: HOSTED_APPROVAL_OPTIONS,
          }),
        ),
      ),
      inputRevision: '1',
      invocationRef: inputRef,
      attemptId: messageId,
      routeRef: inputRef,
    },
    { turnId: 'prompt', promptId: 'prompt' },
  );
  expect(
    await resolveHostedAction(session, new HostedApprovalWaiters(), requestId, {
      optionId: 'allow',
      inputRevision: authority.action(requestId)!.inputRevision,
      policyRevision: HOSTED_TOOL_APPROVAL_POLICY,
    }),
  ).toMatchObject({ status: 200 });
  await harness.resolveDurableWait();
  await teams.run(
    'task_create',
    { subject: 'audit', description: 'audit it' },
    'prompt:call-task',
  );
  const admitted = teams.admitMember('alice');
  await children.admit({
    childRunId: 'prompt:call-alice',
    ownerScopeId: sessionKey.sessionId,
    rootSessionId: sessionKey.sessionId,
    completion: 'sent',
    description: 'alice task',
    prompt: 'review the change',
    definition: {
      definitionId: 'hosted-agent/hosted-workspace-shell/1',
      definitionRevision: 1,
      definitionDigest: authority.sessionHeader.definitionRef.digest,
    },
    workspaceMode: 'shared',
    workingDirectory: '.',
    executionCallId: 'prompt:call-alice',
  });
  await teams.join({ ...admitted, childRunId: 'prompt:call-alice' });
  await settleInterruptedTurnRuntime({
    session,
    sessionId: sessionKey.sessionId,
    cwd: root,
    promptId: 'prompt',
    brokerOptions: undefined,
    toolProfile: true,
    children,
    teams,
  });
  const answers = new Map(
    (await session.sink.project())
      .filter((entry) => entry.type === 'tool_result')
      .flatMap((entry) => entry.message?.parts ?? [])
      .map((part) => [
        part.functionResponse?.id,
        JSON.stringify(part.functionResponse?.response),
      ]),
  );
  expect(answers.get('call-task')).toContain(
    'committed its team change, in full or in part',
  );
  expect(answers.get('call-alice')).toContain('started in the background');
  expect(answers.get('call-alice')).toContain(
    'joined team \\"review\\" as \\"alice\\"',
  );
  expect(answers.get('call-list')).toContain('The tool call never ran');
});

it('fires PostToolUse for a team tool that ran, never for one it refused', async () => {
  const events: string[] = [];
  await execute(createTurn({ hookEvents: events }), [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  expect(events).toContain('PostToolUse');
  events.length = 0;
  await execute(createTurn({ hookEvents: events }), [
    call('team_create', { team_name: 'other' }, 'call-other'),
  ]);
  expect(events).toContain('PreToolUse');
  expect(events).not.toContain('PostToolUse');
  expect(events).not.toContain('PostToolUseFailure');
});

// ---------------------------------------------------------------------
// H4e-b2: the lead's mailbox over Session messages
// (docs/design/2026-10-11-managed-agent-team-mailbox.md).

/** A child run that dispatched, attached and completed. */
async function finish(childRunId: string, result = 'done'): Promise<void> {
  await children.dispatchStarted(childRunId, {
    dispatchId: `dispatch-${childRunId}`,
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach(childRunId, `session-${childRunId}`);
  await children.settleCompleted(childRunId, {
    result: Buffer.from(result, 'utf8'),
    receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
  });
}

function recordCount(domain: 'child_run' | 'session_message'): number {
  return session.authority.extensionRecordsInDomain(domain).length;
}

async function launchPromptOf(childRunId: string): Promise<string> {
  const run = children.record(childRunId)!;
  return (
    JSON.parse(
      (await session.resources.read(run.inputRef)).toString('utf8'),
    ) as {
      prompt: string;
    }
  ).prompt;
}

it('admits the team form of send_message with exactly one recipient', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ message: 'hi' }, 'takes exactly one of to'],
    [
      { to: 'alice', task_id: 'task_x', message: 'hi' },
      'takes exactly one of to',
    ],
    [{ to: '  ', message: 'hi' }, '\\"to\\" must be a member name'],
    [
      { to: 'alice', summary: 'greeting', message: 'hi' },
      'unsupported argument \\"summary\\"',
    ],
  ];
  for (const [args, text] of cases)
    expect(
      await execute(turn, [call('send_message', args, `call-${text.length}`)]),
    ).toContain(text);
  // A broadcast reads the roster its batch leaves, so it never shares a
  // batch with a change to that roster.
  expect(
    await execute(turn, [
      member('alice', 'call-alice'),
      call('send_message', { to: ' * ', message: 'hi all' }, 'call-all'),
    ]),
  ).toContain(
    'cannot share a batch with team_create, team_delete or a member launch',
  );
  // The launch is refused on its own side too, whatever the order.
  expect(
    await execute(turn, [
      call('send_message', { to: '*', message: 'hi all' }, 'call-all-2'),
      member('alice', 'call-alice-2'),
    ]),
  ).toContain(
    'Hosted team member cannot launch in the same batch as send_message to \\"*\\"',
  );
  expect(roster()).toEqual([]);
});

it('encodes the input of a team send with its recipients first', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  // The encoded input is what an approval card and its 8 KiB preview show:
  // the recipient comes before a long message (H4e-b2 decision 3).
  const encode = vi.spyOn(
    turn as unknown as {
      encodeToolInput(payload: { toolName: string; input: unknown }): unknown;
    },
    'encodeToolInput',
  );
  await execute(turn, [
    call('send_message', { message: 'start', to: 'alice' }, 'call-hi'),
  ]);
  expect(
    encode.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.toolName === 'send_message')
      .map((payload) => Object.keys(payload.input as object)),
  ).toEqual([['to', 'message']]);
});

it('answers a broadcast that reached no member as an error', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await children.settleFailed('prompt:call-alice', {
    stopReason: 'creation_failed',
    reason: null,
    started: false,
  });
  const answer = await execute(turn, [
    call('send_message', { to: '*', message: 'hi all' }, 'call-all'),
  ]);
  expect(answer).toContain('"error":"The message reached no member:');
  expect(answer).toContain('- alice: not reached: Member \\"alice\\" ended');
});

it('addresses a member by name and refuses the leader, a stranger and no team', async () => {
  const turn = createTurn({ messages: true });
  expect(
    await execute(turn, [
      call('send_message', { to: 'alice', message: 'hi' }, 'call-none'),
    ]),
  ).toContain('No open team');
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  // A member launched earlier in the batch is resolved when the send runs.
  const answer = await execute(turn, [
    member('alice', 'call-alice'),
    call(
      'send_message',
      { to: 'Alice', message: 'start with docs' },
      'call-hi',
    ),
  ]);
  expect(answer).toContain(
    `Message queued for delivery to member \\"alice\\" (task ${children.taskIdOf('prompt:call-alice')})`,
  );
  expect(
    await execute(turn, [
      call('send_message', { to: 'leader', message: 'hi' }, 'call-self'),
    ]),
  ).toContain('You are the team leader');
  expect(
    await execute(turn, [
      call('send_message', { to: 'zed', message: 'hi' }, 'call-zed'),
    ]),
  ).toContain(
    '\\"zed\\" is not a member of team \\"review\\". Members: alice.',
  );
});

it('broadcasts to every member with mixed outcomes and replays without sending twice', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [member('bob', 'call-bob')]);
  await execute(turn, [member('carol', 'call-carol')]);
  await finish('prompt:call-bob');
  await children.settleFailed('prompt:call-carol', {
    stopReason: 'creation_failed',
    reason: null,
    started: false,
  });
  const answer = await execute(turn, [
    call('send_message', { to: '*', message: 'wrap up' }, 'call-all'),
  ]);
  expect(answer).toContain(
    'Message sent to 2 of 3 members of team \\"review\\"',
  );
  expect(answer).toContain(
    `- alice: queued for its running task ${children.taskIdOf('prompt:call-alice')}.`,
  );
  const bobRun = broadcastRunId('prompt', 'call-all', 2);
  expect(answer).toContain(
    `- bob: had completed; continued as task ${children.taskIdOf(bobRun)}`,
  );
  // A member's refusal names it and how to replace it (decision 3).
  expect(answer).toContain(
    '- carol: not reached: Member \\"carol\\" ended (failed: creation_failed) and cannot receive messages; for more work, launch a new member under a new name.',
  );
  // Each recipient has its own ids, in their own namespace.
  const aliceMessage = session.authority.extensionRecord(
    'session_message',
    broadcastMessageId({
      senderSessionId: sessionKey.sessionId,
      turnId: 'prompt',
      callId: 'call-all',
      position: 1,
    }),
  );
  expect(aliceMessage).toBeDefined();
  const continued = children.record(bobRun)!;
  expect(continued.predecessorChildRunId).toBe('prompt:call-bob');
  expect(continued.run.executionCallId).toBe('prompt:call-all');
  expect(await launchPromptOf(bobRun)).toBe(
    `${teamMemberPreamble({ name: 'bob', teamName: 'review' })}wrap up`,
  );
  // The replay finds every recipient's committed send and adds nothing.
  const before = [recordCount('child_run'), recordCount('session_message')];
  expect(
    await execute(createTurn({ messages: true }), [
      call('send_message', { to: '*', message: 'wrap up' }, 'call-all'),
    ]),
  ).toContain('Message sent to 2 of 3 members');
  expect([recordCount('child_run'), recordCount('session_message')]).toEqual(
    before,
  );
});

it('keeps broadcast ids apart from a plain call whose provider id equals them', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [
    call('send_message', { to: '*', message: 'one' }, 'call-all'),
  ]);
  const derivedRun = broadcastRunId('prompt', 'call-all', 1);
  const derivedMessage = broadcastMessageId({
    senderSessionId: sessionKey.sessionId,
    turnId: 'prompt',
    callId: 'call-all',
    position: 1,
  });
  const alice = children.taskIdOf('prompt:call-alice');
  const before = recordCount('session_message');
  for (const callId of [derivedRun, derivedMessage])
    expect(
      await execute(turn, [
        call('send_message', { task_id: alice, message: 'one' }, callId),
      ]),
    ).toContain('Message queued for delivery');
  expect(recordCount('session_message')).toBe(before + 2);
});

it('opens a member launch with its preamble inside the envelope bound', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  expect(await launchPromptOf('prompt:call-alice')).toBe(
    `${teamMemberPreamble({ name: 'alice', teamName: 'review' })}review the change`,
  );
  // The longest prompt that fits alone is refused once the preamble is in.
  const definition = {
    definitionId: 'hosted-agent/hosted-workspace-shell/1',
    definitionRevision: 1,
    definitionDigest: session.authority.sessionHeader.definitionRef.digest,
  };
  const fits = (length: number) => {
    try {
      encodeChildLaunchEnvelope({
        description: 'bob task',
        prompt: 'x'.repeat(length),
        definition,
      });
      return true;
    } catch {
      return false;
    }
  };
  let low = 0;
  let high = 64 * 1024;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  expect(
    await execute(turn, [
      call(
        'agent',
        { description: 'bob task', prompt: 'x'.repeat(low), name: 'bob' },
        'call-bob',
      ),
    ]),
  ).toContain('byte_limit');
  expect(children.record('prompt:call-bob')).toBeUndefined();
});

it('answers a replayed send by name after its team was deleted', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await finish('prompt:call-alice');
  expect(
    await execute(turn, [
      call('send_message', { to: 'alice', message: 'more' }, 'call-more'),
    ]),
  ).toContain('Member \\"alice\\" had completed; continued it as task');
  await finish('prompt:call-more');
  await execute(turn, [call('team_delete', {}, 'call-delete')]);
  // The committed send answers, as a plain child's: a former member's
  // continuation carries no label (decision 6).
  const replayed = await execute(createTurn({ messages: true }), [
    call('send_message', { to: 'alice', message: 'more' }, 'call-more'),
  ]);
  expect(replayed).toContain(
    `Child agent ${children.taskIdOf('prompt:call-alice')} had completed; continued it as ${children.taskIdOf('prompt:call-more')}`,
  );
  expect(replayed).not.toContain('labeled');
});

it('replays a broadcast after its team was deleted or replaced without sending again', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await finish('prompt:call-alice');
  await execute(turn, [
    call('send_message', { to: '*', message: 'wrap up' }, 'call-all'),
  ]);
  await finish(broadcastRunId('prompt', 'call-all', 1));
  await execute(turn, [call('team_delete', {}, 'call-delete')]);
  const replay = () =>
    execute(createTurn({ messages: true }), [
      call('send_message', { to: '*', message: 'wrap up' }, 'call-all'),
    ]);
  const before = [recordCount('child_run'), recordCount('session_message')];
  expect(await replay()).toContain(
    'The message was sent to 1 member before its team changed; nothing more was sent.\\n- alice: had completed; continued as task',
  );
  // A new team under the same name, whose roster the broadcast never read.
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team-2'),
  ]);
  await execute(turn, [member('bob', 'call-bob')]);
  const withBob = [recordCount('child_run'), recordCount('session_message')];
  expect(await replay()).toContain(
    'The message was sent to 1 member before its team changed; nothing more was sent.',
  );
  expect([recordCount('child_run'), recordCount('session_message')]).toEqual(
    withBob,
  );
  expect(withBob[1]).toBe(before[1]);
});

it('tells a replayed broadcast only of a continuation that came before its own', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await finish('prompt:call-alice');
  await execute(turn, [
    call('send_message', { to: '*', message: 'all' }, 'call-all'),
  ]);
  await finish(broadcastRunId('prompt', 'call-all', 1));
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'later' }, 'call-x'),
  ]);
  await children.settleFailed('prompt:call-x', {
    stopReason: 'creation_failed',
    reason: null,
    started: false,
  });
  // The later continuation never started, but it followed this broadcast's.
  const replayed = await execute(createTurn({ messages: true }), [
    call('send_message', { to: '*', message: 'all' }, 'call-all'),
  ]);
  expect(replayed).toContain('Message sent to every member');
  expect(replayed).not.toContain('previous continuation');
});

it('records the owner a send of this Turn gave work, even once it completed', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [
    call('task_create', { subject: 'fix', description: 'fix it' }, 'call-task'),
  ]);
  await finish('prompt:call-alice');
  // Two steps in one batch: the send continues alice, then the board
  // records her on the open task.
  const answer = await execute(turn, [
    call('send_message', { to: 'alice', message: 'fix #1' }, 'call-give'),
    call(
      'task_update',
      { taskId: '1', status: 'in_progress', owner: 'alice' },
      'call-own',
    ),
  ]);
  expect(answer).toContain(
    'Task #1 updated (status: in_progress, owner: alice).',
  );
  expect(answer).not.toContain('send_message to \\"alice\\" first');
  // The continuation can complete before the owner update lands; the
  // same Turn still records the work it gave.
  await finish('prompt:call-give');
  await execute(turn, [
    call(
      'task_update',
      { taskId: '1', status: 'pending', owner: '' },
      'call-park',
    ),
  ]);
  expect(
    await execute(turn, [
      call(
        'task_update',
        { taskId: '1', status: 'in_progress', owner: 'alice' },
        'call-own-again',
      ),
    ]),
  ).toContain('Task #1 updated (status: in_progress, owner: alice).');
  // A later Turn gave no work: the refusal is a condition, never a
  // claim about which task a past send carried.
  await execute(turn, [
    call(
      'task_update',
      { taskId: '1', status: 'pending', owner: '' },
      'call-park-2',
    ),
  ]);
  const later = await execute(
    createTurn({ messages: true, promptId: 'prompt-2' }),
    [
      call(
        'task_update',
        { taskId: '1', status: 'in_progress', owner: 'alice' },
        'call-later',
      ),
    ],
  );
  expect(later).toContain(
    'If it already did this task\'s work, from its launch prompt or a message you sent it, set status \\"completed\\" with this owner once its report is in. Otherwise give it the work with send_message to \\"alice\\" first',
  );
});

it('answers an interrupted broadcast recipient by recipient', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [member('bob', 'call-bob')]);
  await execute(turn, [member('carol', 'call-carol')]);
  await children.settleFailed('prompt:call-carol', {
    stopReason: 'creation_failed',
    reason: null,
    started: false,
  });
  // The broadcast reached alice, then its Harness died before bob and
  // before the answer: the journal holds the call, alice's message, and
  // no tool result. Carol had ended, so no send would reach her.
  await session.sink.write({
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: sessionKey.sessionId,
    timestamp: new Date().toISOString(),
    model: 'model',
    type: 'assistant',
    cwd: root,
    version: 'test',
    daemonPromptId: 'prompt',
    message: {
      role: 'model',
      // A hook rewrote the input that ran: recovery probes every position
      // whatever the journaled arguments say.
      parts: [
        {
          functionCall: {
            id: 'call-all',
            name: 'send_message',
            args: { to: 'alice', message: 'wrap up' },
          },
        },
      ],
    },
  });
  await children.sendToChild({
    taskId: children.taskIdOf('prompt:call-alice'),
    text: 'wrap up',
    messageId: broadcastMessageId({
      senderSessionId: sessionKey.sessionId,
      turnId: 'prompt',
      callId: 'call-all',
      position: 1,
    }),
    continuationRunId: broadcastRunId('prompt', 'call-all', 1),
    executionCallId: 'prompt:call-all',
    closing: false,
  });
  await answerCommittedTurnCalls({
    session,
    sessionId: sessionKey.sessionId,
    cwd: root,
    promptId: 'prompt',
    children,
    teams,
    messages: new HostedSessionMessageSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      children,
      undefined,
    ),
  });
  const answer = JSON.stringify(
    (await session.sink.project())
      .filter((entry) => entry.type === 'tool_result')
      .flatMap((entry) => entry.message?.parts ?? [])
      .find((part) => part.functionResponse?.id === 'call-all')
      ?.functionResponse?.response,
  );
  expect(answer).toContain(
    'The broadcast was interrupted after it was sent to 1 member; do not send it again to the members it reached.',
  );
  expect(answer).toContain('- alice: queued for its running task');
  expect(answer).toContain(
    'It did not reach: bob. Send to those members by name if they still need it.',
  );
  expect(answer).toContain(
    'It did not reach carol, which has ended and cannot take it.',
  );
});

it('answers an interrupted send by name whose continuation never started', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await finish('prompt:call-alice');
  await session.sink.write({
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: sessionKey.sessionId,
    timestamp: new Date().toISOString(),
    model: 'model',
    type: 'assistant',
    cwd: root,
    version: 'test',
    daemonPromptId: 'prompt',
    message: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'call-more',
            name: 'send_message',
            args: { to: 'alice', message: 'more' },
          },
        },
      ],
    },
  });
  // The send continued alice, then the Harness died before its answer, and
  // the continuation proved it never started: a failed child sends no
  // notification, so the recovered answer must say the message is lost.
  await children.sendToChild({
    taskId: children.taskIdOf('prompt:call-alice'),
    text: 'more',
    messageId: 'msg_unused',
    continuationRunId: 'prompt:call-more',
    executionCallId: 'prompt:call-more',
    closing: false,
  });
  await children.settleFailed('prompt:call-more', {
    stopReason: 'creation_failed',
    reason: null,
    started: false,
  });
  await answerCommittedTurnCalls({
    session,
    sessionId: sessionKey.sessionId,
    cwd: root,
    promptId: 'prompt',
    children,
    teams,
    messages: new HostedSessionMessageSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      children,
      undefined,
    ),
  });
  const answer = JSON.stringify(
    (await session.sink.project())
      .filter((entry) => entry.type === 'tool_result')
      .flatMap((entry) => entry.message?.parts ?? [])
      .find((part) => part.functionResponse?.id === 'call-more')
      ?.functionResponse?.response,
  );
  expect(answer).toContain(
    `Member \\"alice\\" had completed; continued it as task ${children.taskIdOf('prompt:call-more')}, which never started (creation_failed), so this message did not arrive. Send it again with send_message to \\"alice\\".`,
  );
});

it('names a continuation that never started and routes its task id from the member', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await finish('prompt:call-alice');
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'first' }, 'call-1'),
  ]);
  await children.settleFailed('prompt:call-1', {
    stopReason: 'creation_failed',
    reason: null,
    started: false,
  });
  // The next send continues the member again and says the previous
  // continuation never started.
  expect(
    await execute(turn, [
      call('send_message', { to: 'alice', message: 'again' }, 'call-2'),
    ]),
  ).toContain(
    'Its previous continuation never started (creation_failed), so the work it carried did not arrive; send that work again unless this message carries it.',
  );
  await children.settleFailed('prompt:call-2', {
    stopReason: 'creation_failed',
    reason: null,
    started: false,
  });
  expect(
    await execute(turn, [
      call('send_message', { to: '*', message: 'all' }, 'call-all'),
    ]),
  ).toContain('Its previous continuation never started (creation_failed)');
  await children.settleFailed(broadcastRunId('prompt', 'call-all', 1), {
    stopReason: 'creation_failed',
    reason: null,
    started: false,
  });
  // The never-started continuation's own task id still reaches the chain,
  // and a member addressed by task id is answered as one.
  const byId = await execute(turn, [
    call(
      'send_message',
      { task_id: children.taskIdOf('prompt:call-1'), message: 'by id' },
      'call-3',
    ),
  ]);
  expect(byId).toContain(
    'Member \\"alice\\" had completed; continued it as task',
  );
  expect(byId).toContain('Its result arrives labeled \\"alice\\".');
  expect(byId).toContain(
    'Its previous continuation never started (creation_failed)',
  );
  expect(children.record('prompt:call-3')?.predecessorChildRunId).toBe(
    'prompt:call-alice',
  );
  // A replay of the first send finds that its own continuation never
  // started, so it says the message did not arrive.
  expect(
    await execute(createTurn({ messages: true }), [
      call('send_message', { to: 'alice', message: 'first' }, 'call-1'),
    ]),
  ).toContain(
    `continued it as task ${children.taskIdOf('prompt:call-1')}, which never started (creation_failed), so this message did not arrive. Send it again with send_message to \\"alice\\".`,
  );
});

it('counts the messages a never-started continuation lost, and tells a cancelled one apart', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await finish('prompt:call-alice');
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'one' }, 'call-1'),
  ]);
  // The continuation has not started yet, so the next send is a message
  // queued for it.
  expect(
    await execute(turn, [
      call('send_message', { to: 'alice', message: 'two' }, 'call-2'),
    ]),
  ).toContain(
    `Message queued for delivery to member \\"alice\\" (task ${children.taskIdOf('prompt:call-1')}).`,
  );
  await children.settleFailed('prompt:call-1', {
    stopReason: 'creation_failed',
    reason: null,
    started: false,
  });
  expect(
    await execute(turn, [
      call('send_message', { to: 'alice', message: 'three' }, 'call-3'),
    ]),
  ).toContain(
    'Its previous continuation never started (creation_failed), so the work it carried did not arrive, nor did 1 message sent to it; send that work again unless this message carries it. 1 message sent to it also did not arrive; resend it only if its own send_message answer has not already asked you to resend it.',
  );
  // A replay of the queued message says it never arrived.
  expect(
    await execute(createTurn({ messages: true }), [
      call('send_message', { to: 'alice', message: 'two' }, 'call-2'),
    ]),
  ).toContain(
    `Message was queued for member \\"alice\\" as task ${children.taskIdOf('prompt:call-1')}, which never started (creation_failed), so this message did not arrive. Send it again with send_message to \\"alice\\".`,
  );
  // A continuation a user cancelled before it started is resent only if
  // its work is still wanted.
  await children.requestStop('prompt:call-3');
  await children.settleCancelled('prompt:call-3', { started: false });
  expect(
    await execute(turn, [
      call('send_message', { to: 'alice', message: 'four' }, 'call-4'),
    ]),
  ).toContain(
    'Its previous continuation was cancelled before it started (stop_requested), so the work it carried did not arrive; send that work again only if it is still wanted and this message does not carry it.',
  );
});

it('refuses a send by name to a stopping member and one stopped on request', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await children.requestStop('prompt:call-alice');
  expect(
    await execute(turn, [
      call('send_message', { to: 'alice', message: 'hi' }, 'call-1'),
    ]),
  ).toContain(
    'The message to member \\"alice\\" was refused: Member \\"alice\\" is being stopped and cannot receive messages.',
  );
  await finish('prompt:call-alice');
  expect(
    await execute(turn, [
      call('send_message', { to: 'alice', message: 'hi' }, 'call-2'),
    ]),
  ).toContain(
    'Member \\"alice\\" completed after a stop was requested and cannot receive messages; for more work, launch a new member under a new name.',
  );
  expect(children.record('prompt:call-2')).toBeUndefined();
});

it('indexes each of ten broadcast recipients once and reports the active cap', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  const names = [
    'alice',
    'bob',
    'carol',
    'dave',
    'erin',
    'frank',
    'grace',
    'heidi',
    'ivan',
    'judy',
  ];
  for (const name of names) {
    await execute(turn, [member(name, `call-${name}`)]);
    await finish(`prompt:call-${name}`);
  }
  const scans = vi.spyOn(session.authority, 'extensionRecordsInDomain');
  const answer = await execute(turn, [
    call('send_message', { to: '*', message: 'status?' }, 'call-all'),
  ]);
  expect(answer).toContain('Message sent to 4 of 10 members');
  expect(answer).toContain(
    '- erin: not reached: Hosted child agent refused to continue member \\"erin\\" (task',
  );
  expect(answer).toContain('(count_limit)');
  expect(
    scans.mock.calls.filter(([domain]) => domain === 'child_run'),
  ).toHaveLength(10);
});

it('puts the recipients of a team send first in its input', () => {
  expect(
    Object.keys(
      hostedTeamMessageInput({ message: 'x'.repeat(10_000), to: '*' }),
    ),
  ).toEqual(['to', 'message']);
  expect(
    Object.keys(hostedTeamMessageInput({ message: 'x', task_id: 'task_1' })),
  ).toEqual(['task_id', 'message']);
});

it('counts a committed broadcast as dispatched after a restart', async () => {
  const setup = createTurn({ messages: true });
  await execute(setup, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(setup, [member('alice', 'call-alice')]);
  const events: string[] = [];
  const broadcast = call(
    'send_message',
    { to: '*', message: 'hi' },
    'call-all',
  );
  const responses = await createTurn({
    messages: true,
    hookEvents: events,
  }).execute(
    [broadcast],
    [
      {
        functionCall: {
          id: 'call-all',
          name: 'send_message',
          args: broadcast.args,
        },
      },
    ],
    'model',
    new AbortController().signal,
  );
  expect(events).toContain('PostToolUse');
  events.length = 0;
  // A new turn object has no in-memory dispatch record: the committed
  // recipients are the evidence.
  await createTurn({ messages: true, hookEvents: events }).resumeHookResults(
    responses.filter((part) => part.functionResponse?.id === 'call-all'),
    'model',
    new AbortController().signal,
  );
  expect(events).toContain('PostToolUse');
});

/** A call the journal holds with no answer, as a dead Harness left it. */
async function journalCall(
  callId: string,
  args: Record<string, unknown>,
): Promise<void> {
  await session.sink.write({
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: sessionKey.sessionId,
    timestamp: new Date().toISOString(),
    model: 'model',
    type: 'assistant',
    cwd: root,
    version: 'test',
    daemonPromptId: 'prompt',
    message: {
      role: 'model',
      parts: [{ functionCall: { id: callId, name: 'send_message', args } }],
    },
  });
}

/** The answer recovery gives a journal-only call of the turn "prompt". */
async function recoveredAnswer(callId: string): Promise<string> {
  await answerCommittedTurnCalls({
    session,
    sessionId: sessionKey.sessionId,
    cwd: root,
    promptId: 'prompt',
    children,
    teams,
    messages: new HostedSessionMessageSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      children,
      undefined,
    ),
  });
  return JSON.stringify(
    (await session.sink.project())
      .filter((entry) => entry.type === 'tool_result')
      .flatMap((entry) => entry.message?.parts ?? [])
      .find((part) => part.functionResponse?.id === callId)?.functionResponse
      ?.response,
  );
}

const neverStarted = (childRunId: string) =>
  children.settleFailed(childRunId, {
    stopReason: 'creation_failed',
    reason: null,
    started: false,
  });

it('records the owner a send of a wake turn gave work', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [
    call('task_create', { subject: 'fix', description: 'fix it' }, 'call-task'),
  ]);
  await finish('prompt:call-alice');
  // The lead reads a result in a wake turn, whose call keys collapse its
  // prompt id to a digest; the owner rule reads the same keys.
  const wakePrompt = 'msg_result:message:accept:notify';
  const wake = createTurn({ messages: true, promptId: wakePrompt });
  expect(
    await execute(wake, [
      call('send_message', { to: 'alice', message: 'fix #1' }, 'call-give'),
      call(
        'task_update',
        { taskId: '1', status: 'in_progress', owner: 'alice' },
        'call-own',
      ),
    ]),
  ).toContain('Task #1 updated (status: in_progress, owner: alice).');
  const continued = hostedCallKey(wakePrompt, 'call-give');
  expect(children.record(continued)?.predecessorChildRunId).toBe(
    'prompt:call-alice',
  );
  await finish(continued);
  expect(
    await execute(wake, [
      call('task_update', { taskId: '1', status: 'pending' }, 'call-park'),
    ]),
  ).toContain('Task #1 updated (status: pending, owner: alice).');
  expect(
    await execute(createTurn({ messages: true, promptId: 'prompt-2' }), [
      call('task_update', { taskId: '1', status: 'in_progress' }, 'call-back'),
    ]),
  ).toContain('cannot keep task #1 open: it has finished');
});

it('replays a broadcast whose recipients never started as not reached', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [member('bob', 'call-bob')]);
  await finish('prompt:call-alice');
  await finish('prompt:call-bob');
  // alice waits in a continuation, so the broadcast queues a message for
  // it; bob is continued. Neither run ever starts.
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'first' }, 'call-a'),
  ]);
  expect(
    await execute(turn, [
      call('send_message', { to: '*', message: 'all' }, 'call-all'),
    ]),
  ).toContain('Message sent to every member');
  const bobRun = broadcastRunId('prompt', 'call-all', 2);
  await neverStarted('prompt:call-a');
  await neverStarted(bobRun);
  const before = [recordCount('child_run'), recordCount('session_message')];
  const replayed = await execute(createTurn({ messages: true }), [
    call('send_message', { to: '*', message: 'all' }, 'call-all'),
  ]);
  expect(replayed).toContain(
    'Message sent to 2 of 2 members of team \\"review\\", but it did not arrive at 2 of them. Send it by name only to a member whose line says it did not get it, that can still take messages, and still needs it.',
  );
  expect(replayed).toContain(
    `- alice: queued for task ${children.taskIdOf('prompt:call-a')}, which never started (creation_failed), so the message did not arrive.`,
  );
  expect(replayed).toContain(
    `- bob: had completed; continued as task ${children.taskIdOf(bobRun)}, which never started (creation_failed), so the message did not arrive.`,
  );
  expect([recordCount('child_run'), recordCount('session_message')]).toEqual(
    before,
  );
});

it('recovers an interrupted broadcast whose recipient never started as not reached', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [member('bob', 'call-bob')]);
  await finish('prompt:call-alice');
  await journalCall('call-all', { to: '*', message: 'wrap up' });
  await children.sendToChild({
    taskId: children.taskIdOf('prompt:call-alice'),
    text: 'wrap up',
    messageId: broadcastMessageId({
      senderSessionId: sessionKey.sessionId,
      turnId: 'prompt',
      callId: 'call-all',
      position: 1,
    }),
    continuationRunId: broadcastRunId('prompt', 'call-all', 1),
    executionCallId: 'prompt:call-all',
    closing: false,
  });
  await neverStarted(broadcastRunId('prompt', 'call-all', 1));
  const answer = await recoveredAnswer('call-all');
  expect(answer).toContain(
    'The broadcast was interrupted after it was sent to 1 member.\\n- alice: had completed; continued as task',
  );
  expect(answer).not.toContain('do not send it again');
  expect(answer).toContain(
    'It did not reach: alice, bob. Send to those members by name if they still need it.',
  );
});

it('recovers an interrupted broadcast after its team changed without naming the new roster', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await finish('prompt:call-alice');
  await children.sendToChild({
    taskId: children.taskIdOf('prompt:call-alice'),
    text: 'wrap up',
    messageId: broadcastMessageId({
      senderSessionId: sessionKey.sessionId,
      turnId: 'prompt',
      callId: 'call-all',
      position: 1,
    }),
    continuationRunId: broadcastRunId('prompt', 'call-all', 1),
    executionCallId: 'prompt:call-all',
    closing: false,
  });
  await finish(broadcastRunId('prompt', 'call-all', 1));
  await execute(turn, [call('team_delete', {}, 'call-delete')]);
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team-2'),
  ]);
  await execute(turn, [member('carol', 'call-carol')]);
  await journalCall('call-all', { to: '*', message: 'wrap up' });
  const answer = await recoveredAnswer('call-all');
  expect(answer).toContain(
    'The broadcast was interrupted after it was sent to 1 member; do not send it again to the members it reached. Its team has changed since, so nothing tells who else it was meant for.',
  );
  expect(answer).not.toContain('carol');
});

it('recovers an interrupted send by name to a running member with its name', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await journalCall('call-hi', { to: 'alice', message: 'hi' });
  await children.sendToChild({
    taskId: children.taskIdOf('prompt:call-alice'),
    text: 'hi',
    messageId: sessionMessageId({
      senderSessionId: sessionKey.sessionId,
      turnId: 'prompt',
      callId: 'call-hi',
    }),
    continuationRunId: 'prompt:call-hi',
    executionCallId: 'prompt:call-hi',
    closing: false,
  });
  expect(await recoveredAnswer('call-hi')).toContain(
    `Message queued for delivery to member \\"alice\\" (task ${children.taskIdOf('prompt:call-alice')}).`,
  );
});

it('sends a broadcast to no further member once its turn is cancelled', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  for (const name of ['alice', 'bob', 'carol'])
    await execute(turn, [member(name, `call-${name}`)]);
  const controller = new AbortController();
  const sendToChild = children.sendToChild.bind(children);
  const spy = vi
    .spyOn(children, 'sendToChild')
    .mockImplementation(async (params) => {
      const route = await sendToChild(params);
      controller.abort();
      return route;
    });
  const calls = [
    call('send_message', { to: '*', message: 'stop soon' }, 'call-all'),
  ];
  const answer = JSON.stringify(
    await createTurn({ messages: true }).execute(
      calls,
      calls.map((each) => ({
        functionCall: { id: each.callId, name: each.name, args: each.args },
      })),
      'model',
      controller.signal,
    ),
  );
  spy.mockRestore();
  expect(answer).toContain(
    'Message sent to 1 of 3 members of team \\"review\\"; the turn was cancelled before the rest.',
  );
  expect(answer).toContain('- bob: not sent: the turn was cancelled.');
  expect(answer).toContain('- carol: not sent: the turn was cancelled.');
  expect(recordCount('session_message')).toBe(1);
});

it('replays committed broadcast positions before honoring an aborted signal', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  for (const name of ['alice', 'bob', 'carol'])
    await execute(turn, [member(name, `call-${name}`)]);
  const broadcast = call(
    'send_message',
    { to: '*', message: 'stop soon' },
    'call-all',
  );
  await children.sendToChild({
    taskId: children.taskIdOf('prompt:call-alice'),
    text: 'stop soon',
    messageId: broadcastMessageId({
      senderSessionId: sessionKey.sessionId,
      turnId: 'prompt',
      callId: 'call-all',
      position: 1,
    }),
    continuationRunId: broadcastRunId('prompt', 'call-all', 1),
    executionCallId: 'prompt:call-all',
    closing: false,
  });
  const controller = new AbortController();
  controller.abort();
  const scans = vi.spyOn(session.authority, 'extensionRecordsInDomain');
  let text = '';
  await (
    turn as unknown as {
      acceptTeamMessage(
        request: { call: ToolCallRequestInfo },
        to: string,
        message: string,
        answer: (value: string, failed: boolean) => Promise<Part[]>,
        signal: AbortSignal,
      ): Promise<Part[]>;
    }
  ).acceptTeamMessage(
    { call: broadcast },
    '*',
    'stop soon',
    async (value) => {
      text = value;
      return [];
    },
    controller.signal,
  );
  expect(text).toContain('- alice: queued for its running task');
  expect(text).toContain('- bob: not sent: the turn was cancelled.');
  expect(text).toContain('- carol: not sent: the turn was cancelled.');
  expect(
    scans.mock.calls.filter(([domain]) => domain === 'child_run'),
  ).toHaveLength(1);
});

it('answers a replayed send whose continuation was cancelled before it started', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await finish('prompt:call-alice');
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'first' }, 'call-1'),
  ]);
  await neverStarted('prompt:call-1');
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'second' }, 'call-2'),
  ]);
  await children.requestStop('prompt:call-2');
  await children.settleCancelled('prompt:call-2', { started: false });
  // Neither arrived: the resend asked for carries the earlier work too.
  expect(
    await execute(createTurn({ messages: true }), [
      call('send_message', { to: 'alice', message: 'second' }, 'call-2'),
    ]),
  ).toContain(
    `continued it as task ${children.taskIdOf('prompt:call-2')}, which was cancelled before it started (stop_requested), so this message did not arrive. If it is still wanted, send it again with send_message to \\"alice\\". Its previous continuation never started (creation_failed), so the work it carried did not arrive; send that work again unless your resend of this message carries it.`,
  );
});

it('notes a never-started continuation only on the continuation after it', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await finish('prompt:call-alice');
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'one' }, 'call-1'),
  ]);
  await neverStarted('prompt:call-1');
  expect(
    await execute(turn, [
      call('send_message', { to: 'alice', message: 'two' }, 'call-2'),
    ]),
  ).toContain('Its previous continuation never started');
  // A message to that newer continuation follows no never-started run.
  const queued = await execute(turn, [
    call('send_message', { to: 'alice', message: 'three' }, 'call-3'),
  ]);
  expect(queued).toContain(
    `Message queued for delivery to member \\"alice\\" (task ${children.taskIdOf('prompt:call-2')}).`,
  );
  expect(queued).not.toContain('previous continuation');
});

it('answers a replayed message to a member that never started as ended', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'hi' }, 'call-hi'),
  ]);
  await neverStarted('prompt:call-alice');
  expect(
    await execute(createTurn({ messages: true }), [
      call('send_message', { to: 'alice', message: 'hi' }, 'call-hi'),
    ]),
  ).toContain(
    `Message was queued for member \\"alice\\" as task ${children.taskIdOf('prompt:call-alice')}, which never started (creation_failed), so this message did not arrive. Member \\"alice\\" has ended; for more work, launch a new member under a new name.`,
  );
});

it('marks a never-started launch as ended in a replayed broadcast', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [
    call('send_message', { to: '*', message: 'hi' }, 'call-all'),
  ]);
  await neverStarted('prompt:call-alice');
  const replayed = await execute(createTurn({ messages: true }), [
    call('send_message', { to: '*', message: 'hi' }, 'call-all'),
  ]);
  expect(replayed).toContain(
    'which never started (creation_failed), so the message did not arrive. Member \\"alice\\" has ended and takes no messages.',
  );
  expect(replayed).toContain(
    'Send it by name only to a member whose line says it did not get it, that can still take messages, and still needs it.',
  );
});

/** A member that took a message and then was stopped, as H4f does it. */
async function stopAttached(childRunId: string): Promise<void> {
  await children.dispatchStarted(childRunId, {
    dispatchId: `dispatch-${childRunId}`,
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach(childRunId, `session-${childRunId}`);
  await children.requestStop(childRunId);
  await children.settleCancelled(childRunId, {
    started: true,
    childSessionId: `session-${childRunId}`,
  });
}

const relay = () =>
  new HostedSessionMessageSession(
    { authority: session.authority, resources: session.resources },
    sessionKey,
    children,
    undefined,
  );

for (const outcome of ['cancelled', 'rejected'] as const)
  it(`recovers a broadcast whose message to a started member was ${outcome} as not reached`, async () => {
    const turn = createTurn({ messages: true });
    await execute(turn, [
      call('team_create', { team_name: 'review' }, 'call-team'),
    ]);
    await execute(turn, [member('alice', 'call-alice')]);
    await execute(turn, [member('bob', 'call-bob')]);
    await journalCall('call-all', { to: '*', message: 'wrap up' });
    // The broadcast queued its message for running alice, then the Harness
    // died before bob and before the answer.
    const messageId = broadcastMessageId({
      senderSessionId: sessionKey.sessionId,
      turnId: 'prompt',
      callId: 'call-all',
      position: 1,
    });
    await children.sendToChild({
      taskId: children.taskIdOf('prompt:call-alice'),
      text: 'wrap up',
      messageId,
      continuationRunId: broadcastRunId('prompt', 'call-all', 1),
      executionCallId: 'prompt:call-all',
      closing: false,
    });
    // alice was stopped before the message was read, so the relay ended
    // its delivery with no receipt.
    if (outcome === 'rejected') {
      await children.dispatchStarted('prompt:call-alice', {
        dispatchId: 'dispatch-prompt:call-alice',
        runtime: { runtimeBindingId: 'binding-1', generation: '1' },
      });
      await children.attach('prompt:call-alice', 'session-prompt:call-alice');
      await relay().handover(messageId, 'session-prompt:call-alice');
      await relay().settle(messageId, 'rejected');
      await children.requestStop('prompt:call-alice');
      await children.settleCancelled('prompt:call-alice', {
        started: true,
        childSessionId: 'session-prompt:call-alice',
      });
    } else {
      await relay().settle(messageId, 'cancelled');
      await stopAttached('prompt:call-alice');
    }
    const answer = await recoveredAnswer('call-all');
    expect(answer).toContain(
      `The broadcast was interrupted after it was sent to 1 member.\\n- alice: queued for task ${children.taskIdOf('prompt:call-alice')}, but its delivery was ${outcome}, so the message did not arrive.`,
    );
    expect(answer).not.toContain('do not send it again');
    expect(answer).toContain(
      'It did not reach: bob. Send to those members by name if they still need it.',
    );
    expect(answer).toContain(
      'It did not reach alice, which has ended and cannot take it.',
    );
  });

it('separates a settling member and an unconfirmed delivery in broadcast recovery', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [member('bob', 'call-bob')]);
  await children.dispatchStarted('prompt:call-bob', {
    dispatchId: 'dispatch-prompt:call-bob',
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach('prompt:call-bob', 'session-prompt:call-bob');
  await finish('prompt:call-alice');
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'work' }, 'call-work'),
  ]);
  await children.requestStop('prompt:call-work');
  await journalCall('call-all', { to: '*', message: 'wrap up' });
  const messageId = broadcastMessageId({
    senderSessionId: sessionKey.sessionId,
    turnId: 'prompt',
    callId: 'call-all',
    position: 2,
  });
  await children.sendToChild({
    taskId: children.taskIdOf('prompt:call-bob'),
    text: 'wrap up',
    messageId,
    continuationRunId: broadcastRunId('prompt', 'call-all', 2),
    executionCallId: 'prompt:call-all',
    closing: false,
  });
  await relay().handover(messageId, 'session-prompt:call-bob');
  await relay().settle(messageId, 'unknown');
  const answer = await recoveredAnswer('call-all');
  expect(answer).toContain(
    'It did not reach alice, whose latest continuation is being stopped before starting. Check task_list after it settles; if it ends without starting, send by name if still needed.',
  );
  expect(answer).toContain(
    'Delivery to bob could not be confirmed. Check with that member before sending it again.',
  );
  expect(answer).not.toContain('It did not reach: bob');
});

it('answers a replayed send by name whose message was cancelled', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'hi' }, 'call-hi'),
  ]);
  await relay().settle(
    sessionMessageId({
      senderSessionId: sessionKey.sessionId,
      turnId: 'prompt',
      callId: 'call-hi',
    }),
    'cancelled',
  );
  await stopAttached('prompt:call-alice');
  expect(
    await execute(createTurn({ messages: true }), [
      call('send_message', { to: 'alice', message: 'hi' }, 'call-hi'),
    ]),
  ).toContain(
    `Message was queued for member \\"alice\\" (task ${children.taskIdOf('prompt:call-alice')}), but its delivery was cancelled, so it did not arrive. Member \\"alice\\" has ended; for more work, launch a new member under a new name.`,
  );
});

it('recovers a send by task id to a plain child whose message was cancelled', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call(
      'agent',
      { description: 'plain task', prompt: 'review the change' },
      'call-plain',
    ),
  ]);
  await journalCall('call-hi', {
    task_id: children.taskIdOf('prompt:call-plain'),
    message: 'hi',
  });
  const messageId = sessionMessageId({
    senderSessionId: sessionKey.sessionId,
    turnId: 'prompt',
    callId: 'call-hi',
  });
  await children.sendToChild({
    taskId: children.taskIdOf('prompt:call-plain'),
    text: 'hi',
    messageId,
    continuationRunId: 'prompt:call-hi',
    executionCallId: 'prompt:call-hi',
    closing: false,
  });
  await relay().settle(messageId, 'cancelled');
  await stopAttached('prompt:call-plain');
  expect(await recoveredAnswer('call-hi')).toContain(
    `Message was queued for child agent ${children.taskIdOf('prompt:call-plain')}, but its delivery was cancelled, so it did not arrive. That child agent has ended; launch a new agent for this work if it is still needed.`,
  );
});

const sendToKey = (callId: string) =>
  sessionMessageId({
    senderSessionId: sessionKey.sessionId,
    turnId: 'prompt',
    callId,
  });

it('answers a replayed send whose message failed by what a resend would meet', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [member('bob', 'call-bob')]);
  const replay = (callId: string, to: string, message: string) =>
    execute(createTurn({ messages: true }), [
      call('send_message', { to, message }, callId),
    ]);
  // alice still runs: her message's delivery failed, so it is sent again.
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'one' }, 'call-a'),
  ]);
  await relay().settle(sendToKey('call-a'), 'cancelled');
  expect(await replay('call-a', 'alice', 'one')).toContain(
    'but its delivery was cancelled, so it did not arrive. Send it again with send_message to \\"alice\\" if it is still needed.',
  );
  await children.requestStop('prompt:call-alice');
  expect(await replay('call-a', 'alice', 'one')).toContain(
    'but its delivery was cancelled, so it did not arrive. Member \\"alice\\" is being stopped; for more work after it ends, launch a new member under a new name.',
  );
  // bob failed while his message was still waiting for its handover: the
  // relay will cancel it, so the answer already reads it so.
  await execute(turn, [
    call('send_message', { to: 'bob', message: 'two' }, 'call-b'),
  ]);
  await children.dispatchStarted('prompt:call-bob', {
    dispatchId: 'dispatch-prompt:call-bob',
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach('prompt:call-bob', 'session-prompt:call-bob');
  await children.settleFailed('prompt:call-bob', {
    stopReason: 'child_failed',
    reason: null,
    started: true,
  });
  expect(await replay('call-b', 'bob', 'two')).toContain(
    'but its delivery was cancelled, so it did not arrive. Member \\"bob\\" has ended; for more work, launch a new member under a new name.',
  );
});

it('answers an unconfirmed message without presenting it as delivered or asking for a resend', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await children.dispatchStarted('prompt:call-alice', {
    dispatchId: 'dispatch-prompt:call-alice',
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach('prompt:call-alice', 'session-prompt:call-alice');
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'one' }, 'call-a'),
  ]);
  await relay().handover(sendToKey('call-a'), 'session-prompt:call-alice');
  await relay().settle(sendToKey('call-a'), 'unknown');
  const replayed = await execute(createTurn({ messages: true }), [
    call('send_message', { to: 'alice', message: 'one' }, 'call-a'),
  ]);
  expect(replayed).toContain(
    'but its delivery could not be confirmed. Check with member \\"alice\\" before sending it again.',
  );
  expect(replayed).not.toContain('so it did not arrive');
});

it('answers a message to a continuation stopped before it started as settling', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await finish('prompt:call-alice');
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'work' }, 'call-1'),
  ]);
  await execute(turn, [
    call('send_message', { to: 'alice', message: 'more' }, 'call-2'),
  ]);
  await children.requestStop('prompt:call-1');
  expect(
    await execute(createTurn({ messages: true }), [
      call('send_message', { to: 'alice', message: 'more' }, 'call-2'),
    ]),
  ).toContain(
    'but its delivery was cancelled, so it did not arrive. Its latest continuation is being stopped before it started; if that continuation ends without starting, send it again with send_message to \\"alice\\" if it is still needed.',
  );
});

it('replays a broadcast whose message to a member failed as not arrived there', async () => {
  const turn = createTurn({ messages: true });
  await execute(turn, [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  await execute(turn, [member('alice', 'call-alice')]);
  await execute(turn, [member('bob', 'call-bob')]);
  await execute(turn, [
    call('send_message', { to: '*', message: 'all' }, 'call-all'),
  ]);
  await relay().settle(
    broadcastMessageId({
      senderSessionId: sessionKey.sessionId,
      turnId: 'prompt',
      callId: 'call-all',
      position: 1,
    }),
    'cancelled',
  );
  await stopAttached('prompt:call-alice');
  const replayed = await execute(createTurn({ messages: true }), [
    call('send_message', { to: '*', message: 'all' }, 'call-all'),
  ]);
  expect(replayed).toContain(
    'Message sent to 2 of 2 members of team \\"review\\", but it did not arrive at 1 of them.',
  );
  expect(replayed).toContain(
    `- alice: queued for task ${children.taskIdOf('prompt:call-alice')}, but its delivery was cancelled, so the message did not arrive. It has ended and takes no messages.`,
  );
  expect(replayed).toContain(
    `- bob: queued for its running task ${children.taskIdOf('prompt:call-bob')}.`,
  );
});
