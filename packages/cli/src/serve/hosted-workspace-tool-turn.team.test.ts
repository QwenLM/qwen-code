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
import { parseTeamState } from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import { teamLifecycleBody } from '@qwen-code/qwen-code-core/managed-runtime/managed-team-operations.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  HostedWorkspaceToolTurn,
  HOSTED_AGENT_TOOL,
  HOSTED_AGENT_TOOL_FOR_TEAMS,
} from './hosted-workspace-tool-turn.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import type { HostedHookSession } from './hosted-hook-session.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { HostedTeamSession } from './hosted-team-session.js';
import { HOSTED_TEAM_TOOL_NAMES } from './hosted-team-tools.js';

// H4e-b1: the two team domains are not enabled for submission yet. The
// flag lifts exactly their domain gate, as the H4e-a suites do, so this
// suite runs the lead's team runtime ahead of enablement.
const enablement = vi.hoisted(() => ({ teams: true }));
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
          enablement.teams &&
          (domain === 'team_state' || domain === 'team_task')
        )
          return;
        actual.assertManagedSessionDomainEnabled(domain);
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
let teams: HostedTeamSession;
let sessionKey: { tenantId: string; workspaceId: string; sessionId: string };

const messageFitsInline = vi.fn<
  ConstructorParameters<typeof HostedWorkspaceToolTurn>[5]
>(() => true);

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

function createTurn(depth = 0, hookEvents?: string[]): HostedWorkspaceToolTurn {
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
    {
      profile: 'hosted-workspace-shell/1',
      childAgents: {
        funnel: children,
        depth,
        queueConsumption: () => undefined,
        teams,
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
            } as unknown as HostedHookSession,
          }
        : {}),
    },
  );
}

/** Runs one batch and answers each call's result text, in call order. */
async function run(
  calls: ToolCallRequestInfo[],
  turn = createTurn(),
): Promise<string[]> {
  const responses: Part[] = await turn.execute(
    calls,
    calls.map((each) => ({
      functionCall: { id: each.callId, name: each.name, args: each.args },
    })),
    'model',
    new AbortController().signal,
  );
  return calls.map((each) =>
    JSON.stringify(
      responses.find((part) => part.functionResponse?.id === each.callId)
        ?.functionResponse?.response,
    ),
  );
}

async function one(
  name: string,
  args: Record<string, unknown>,
  callId: string,
): Promise<string> {
  return (await run([call(name, args, callId)]))[0]!;
}

function team() {
  return teams.openTeam();
}

async function createTeam(): Promise<void> {
  expect(
    await one('team_create', { team_name: 'Review Team!' }, 'team-1'),
  ).toContain('Team \\"review-team\\" created.');
}

async function spawn(name: string, callId: string): Promise<string> {
  return one(
    'agent',
    { description: `work for ${name}`, prompt: 'do the work', name },
    callId,
  );
}

async function finishChild(
  childRunId: string,
  outcome: 'completed' | 'failed',
): Promise<void> {
  if (outcome === 'failed') {
    await children.settleFailed(childRunId, {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    return;
  }
  await children.dispatchStarted(childRunId, {
    dispatchId: `dispatch-${childRunId}`,
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach(childRunId, randomUUID());
  await children.settleCompleted(childRunId, {
    result: Buffer.from('all clean', 'utf8'),
    receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  enablement.teams = true;
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
  teams = new HostedTeamSession(store, sessionKey);
});

afterEach(async () => {
  await session?.close();
  await rm(root, { recursive: true, force: true });
});

it('declares the team tools and the agent name only while both team domains are enabled', async () => {
  const declared = (
    await createTurn().declarations(new AbortController().signal)
  ).map((tool) => tool.name);
  expect(declared).toEqual(expect.arrayContaining([...HOSTED_TEAM_TOOL_NAMES]));
  expect(
    (await createTurn().declarations(new AbortController().signal)).find(
      (tool) => tool.name === 'agent',
    ),
  ).toBe(HOSTED_AGENT_TOOL_FOR_TEAMS);
  // A member's own Session sees neither.
  const child = (
    await createTurn(1).declarations(new AbortController().signal)
  ).map((tool) => tool.name);
  expect(child).not.toContain('team_create');
  expect(child).not.toContain('agent');
  enablement.teams = false;
  const closed = await createTurn().declarations(new AbortController().signal);
  expect(closed.map((tool) => tool.name)).not.toContain('team_create');
  expect(closed.find((tool) => tool.name === 'agent')).toBe(HOSTED_AGENT_TOOL);
  expect(await spawn('alice', 'call-1')).toContain(
    'unsupported argument \\"name\\"',
  );
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

it('creates one team, refuses a second, and answers a replayed create from its record', async () => {
  await createTeam();
  expect(team()).toMatchObject({
    teamId: 'prompt:team-1',
    name: 'review-team',
    leadSessionId: sessionKey.sessionId,
    lifecycle: 'active',
    members: [],
  });
  expect(await one('team_create', { team_name: 'other' }, 'team-2')).toContain(
    'A team is already active. Delete it before creating a new one.',
  );
  // The same call again: its committed command answers, nothing opens.
  expect(
    await one('team_create', { team_name: 'Review Team!' }, 'team-1'),
  ).toContain('created');
  expect(session.authority.extensionRecordsInDomain('team_state')).toHaveLength(
    1,
  );
  expect(await one('team_create', { team_name: '!!!' }, 'team-3')).toContain(
    'Team name is required.',
  );
  // Team tools never take the Workspace mount.
  expect(broker.acquire).not.toHaveBeenCalled();
});

it('spawns a named teammate as a background child that joins the roster', async () => {
  await createTeam();
  const answer = await spawn('Alice', 'call-2');
  expect(answer).toContain('Teammate \\"alice\\" started in the background');
  expect(children.record('prompt:call-2')).toMatchObject({
    completion: 'sent',
  });
  expect(team()!.members).toEqual([
    { name: 'alice', childRunId: 'prompt:call-2', planModeRequired: false },
  ]);
  expect(team()!.membershipRevision).toBe(2);
  expect(broker.acquire).not.toHaveBeenCalled();
});

it('refuses a teammate without a team, with a taken or reserved name, in the foreground, or beside a team change', async () => {
  expect(await spawn('alice', 'call-1')).toContain(
    'No active team. Create one with team_create first',
  );
  await createTeam();
  expect(await spawn('leader', 'call-2')).toContain(
    '\\"leader\\" is reserved for the team leader.',
  );
  expect(
    await one(
      'agent',
      {
        description: 'work',
        prompt: 'do it',
        name: 'alice',
        run_in_background: false,
      },
      'call-3',
    ),
  ).toContain('cannot be false for a named teammate');
  await spawn('alice', 'call-4');
  expect(await spawn('alice', 'call-5')).toContain(
    'A teammate named \\"alice\\" already exists in this team',
  );
  const twins = await run([
    call('agent', { description: 'a', prompt: 'p', name: 'bob' }, 'call-6'),
    call('agent', { description: 'b', prompt: 'p', name: 'Bob' }, 'call-7'),
  ]);
  expect(twins[0]).toContain('Teammate names in one batch must be distinct');
  const mixed = await run([
    call('team_delete', {}, 'call-8'),
    call('agent', { description: 'a', prompt: 'p', name: 'carol' }, 'call-9'),
  ]);
  expect(mixed[1]).toContain('cannot also create or delete the team');
  // Only alice launched: every refusal committed nothing.
  expect(
    session.authority
      .extensionRecordsInDomain('child_run')
      .map((entry) => (entry.record as { childRunId: string }).childRunId),
  ).toEqual(['prompt:call-4']);
  expect(team()!.members.map((member) => member.name)).toEqual(['alice']);
});

it('finishes a join a crash interrupted, and leaves an ended run off the roster', async () => {
  await createTeam();
  const launch = (childRunId: string, name: string) =>
    children.admit({
      childRunId,
      ownerScopeId: sessionKey.sessionId,
      rootSessionId: sessionKey.sessionId,
      completion: 'sent',
      description: `work for ${name}`,
      prompt: 'do the work',
      definition: {
        definitionId: 'hosted-agent/hosted-workspace-shell/1',
        definitionRevision: 1,
        definitionDigest: session.authority.sessionHeader.definitionRef.digest,
      },
      workingDirectory: '.',
      executionCallId: childRunId,
    });
  // The launch committed, then the Session stopped before the join.
  await launch('prompt:call-2', 'alice');
  expect(team()!.members).toEqual([]);
  expect(await spawn('alice', 'call-2')).toContain(
    'Teammate \\"alice\\" started',
  );
  expect(team()!.members.map((member) => member.childRunId)).toEqual([
    'prompt:call-2',
  ]);
  // Replayed again, the join stays one and the answer stays the same.
  expect(await spawn('alice', 'call-2')).toContain(
    'Teammate \\"alice\\" started',
  );
  expect(team()!.membershipRevision).toBe(2);
  // A run that ended before its join never joins, and its name stays free.
  await launch('prompt:call-3', 'bob');
  await finishChild('prompt:call-3', 'failed');
  // It sends no notification, so its launch answers the failure.
  expect(await spawn('bob', 'call-3')).toContain(
    'Child agent run failed (creation_failed) before it could join the team as \\"bob\\"',
  );
  expect(team()!.members.map((member) => member.name)).toEqual(['alice']);
});

it("labels a teammate's result notification with its name", async () => {
  await createTeam();
  await spawn('alice', 'call-2');
  await finishChild('prompt:call-2', 'completed');
  await children.accept('prompt:call-2', {
    notification: { description: 'work for alice' },
  });
  const input = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .filter((event) => event.kind === 'input.accepted')
    .at(-1)!;
  const text = (
    await session.resources.read(
      input.payload['contentRef'] as unknown as ManagedSessionDurableRef,
    )
  ).toString('utf8');
  expect(text).toContain('<teammate>alice</teammate>');
  expect(text).toContain('Teammate \\"alice\\" finished');
});

it('keeps a board with numbers, owners, dependencies and the roster', async () => {
  await createTeam();
  await spawn('alice', 'call-2');
  expect(
    await one(
      'task_create',
      { subject: 'Audit', description: 'audit the diff' },
      'call-3',
    ),
  ).toContain('Task #1 created: \\"Audit\\"');
  expect(
    await one(
      'task_create',
      { subject: 'Fix', description: 'fix it' },
      'call-4',
    ),
  ).toContain('Task #2 created');
  expect(
    await one('task_update', { taskId: '#2', addBlockedBy: ['1'] }, 'call-5'),
  ).toContain('Task #2 updated');
  const list = await one('task_list', {}, 'call-6');
  expect(list).toContain('#1 [pending] @unassigned — Audit');
  expect(list).toContain('#2 [pending] @unassigned — Fix (blocked by #1)');
  expect(list).toContain('- alice: running');
  expect(
    await one('task_update', { taskId: '1', status: 'in_progress' }, 'call-7'),
  ).toContain('without an owner');
  expect(
    await one(
      'task_update',
      { taskId: '1', status: 'in_progress', owner: 'alice' },
      'call-8',
    ),
  ).toContain('The teammate was not notified');
  expect(
    await one('task_update', { taskId: '1', owner: 'carol' }, 'call-9'),
  ).toContain('no teammate by that name');
  expect(
    await one('task_update', { taskId: '1', addBlockedBy: ['2'] }, 'call-10'),
  ).toContain('dependency cycle');
  expect(
    await one('task_update', { taskId: '1', addBlocks: ['1'] }, 'call-11'),
  ).toContain('cannot block or be blocked by itself');
  expect(await one('task_update', { taskId: '9' }, 'call-12')).toContain(
    'Task #9 not found.',
  );
  await one('task_update', { taskId: '1', status: 'completed' }, 'call-13');
  // A completed blocker no longer blocks, with no write to its dependent.
  expect(await one('task_list', {}, 'call-14')).toContain(
    '#2 [pending] @unassigned — Fix\\n',
  );
  await one(
    'task_update',
    { taskId: '2', metadata: { a: 1, b: 2 } },
    'call-15',
  );
  await one('task_update', { taskId: '2', metadata: { a: null } }, 'call-16');
  const second = teams.task('prompt:team-1#2')!;
  expect(await teams.readJson(second.metadataRef!)).toEqual({ b: 2 });
  expect(
    await one('task_update', { taskId: '2', status: 'deleted' }, 'call-17'),
  ).toContain('Task #2 deleted.');
  // A number is never reused.
  expect(
    await one('task_create', { subject: 'Next', description: 'n' }, 'call-18'),
  ).toContain('Task #3 created');
  expect(broker.acquire).not.toHaveBeenCalled();
});

it('keeps an owner after its teammate ends, and refuses assigning an ended teammate', async () => {
  await createTeam();
  await spawn('alice', 'call-2');
  await one('task_create', { subject: 'A', description: 'a' }, 'call-3');
  await one('task_create', { subject: 'B', description: 'b' }, 'call-4');
  await one(
    'task_update',
    { taskId: '1', status: 'in_progress', owner: 'alice' },
    'call-5',
  );
  await finishChild('prompt:call-2', 'completed');
  expect(
    await one(
      'task_update',
      { taskId: '1', status: 'completed', owner: 'alice' },
      'call-6',
    ),
  ).toContain('Task #1 updated (status: completed, owner: alice)');
  expect(
    await one('task_update', { taskId: '2', owner: 'alice' }, 'call-7'),
  ).toContain("that teammate's run has ended");
  expect(await one('task_list', {}, 'call-8')).toContain('- alice: completed');
});

it('answers a replayed task_create with the number it already took', async () => {
  await createTeam();
  await one('task_create', { subject: 'A', description: 'a' }, 'call-2');
  await one('task_create', { subject: 'B', description: 'b' }, 'call-3');
  expect(
    await one('task_create', { subject: 'A', description: 'a' }, 'call-2'),
  ).toContain('Task #1 created');
  expect(teams.tasksOf(team()!.teamId)).toHaveLength(2);
});

it('finishes a task_update a crash interrupted, adding no edge twice', async () => {
  await createTeam();
  for (const [index, subject] of ['A', 'B', 'C'].entries())
    await one(
      'task_create',
      { subject, description: subject },
      `task-${index}`,
    );
  const ids = ['1', '2', '3'].map((each) => `prompt:team-1#${each}`);
  // The first two steps of call-9 committed before the Session stopped.
  await teams.updateTasks('prompt:call-9', [
    { taskId: ids[0]!, change: {} },
    { taskId: ids[1]!, change: { addBlockedBy: [ids[0]!] } },
  ]);
  expect(
    await one('task_update', { taskId: '1', addBlocks: ['2', '3'] }, 'call-9'),
  ).toContain('Task #1 updated');
  expect(teams.task(ids[1]!)!.blockedBy).toEqual([ids[0]]);
  expect(teams.task(ids[2]!)!.blockedBy).toEqual([ids[0]]);
  const revisions = () =>
    ids.map(
      (each) => session.authority.extensionRecord('team_task', each)!.revision,
    );
  const before = revisions();
  await one('task_update', { taskId: '1', addBlocks: ['2', '3'] }, 'call-9');
  expect(revisions()).toEqual(before);
});

it('deletes a team only once no teammate runs, and replays the delete', async () => {
  await createTeam();
  await spawn('alice', 'call-2');
  expect(await one('team_delete', {}, 'call-3')).toContain(
    'still has running members: alice',
  );
  expect(team()!.lifecycle).toBe('active');
  await finishChild('prompt:call-2', 'completed');
  expect(await one('team_delete', {}, 'call-4')).toContain(
    'Team \\"review-team\\" deleted.',
  );
  const record = () =>
    session.authority.extensionRecord('team_state', 'prompt:team-1')!;
  expect(parseTeamState(record().record).lifecycle).toBe('deleted');
  const revision = record().revision;
  expect(await one('team_delete', {}, 'call-4')).toContain('deleted.');
  expect(record().revision).toBe(revision);
  expect(await one('team_delete', {}, 'call-5')).toContain(
    'No active team to delete.',
  );
  // With the old team deleted, a new one may open.
  expect(await one('team_create', { team_name: 'next' }, 'call-6')).toContain(
    'created',
  );
});

it('refuses an edge to a task the board does not hold', async () => {
  await createTeam();
  await one('task_create', { subject: 'A', description: 'a' }, 'call-2');
  expect(
    await one('task_update', { taskId: '1', addBlockedBy: ['7'] }, 'call-3'),
  ).toContain('referenced task(s) #7 not found.');
  expect(
    await one('task_update', { taskId: '1', addBlocks: ['8'] }, 'call-4'),
  ).toContain('referenced task(s) #8 not found.');
  expect(teams.task('prompt:team-1#1')!.blockedBy).toEqual([]);
});

it('replays a task_update whose content a replay would publish anew', async () => {
  await createTeam();
  await one('task_create', { subject: 'A', description: 'a' }, 'call-2');
  const update = { taskId: '1', description: 'the full scope' };
  expect(await one('task_update', update, 'call-3')).toContain(
    'Task #1 updated',
  );
  const revision = () =>
    session.authority.extensionRecord('team_task', 'prompt:team-1#1')!.revision;
  const before = revision();
  // The replay publishes the description again under a new reference;
  // the committed command answers, and no revision is rebuilt from it.
  expect(await one('task_update', update, 'call-3')).toContain(
    'Task #1 updated',
  );
  expect(revision()).toBe(before);
  expect(
    await teams.readText(teams.task('prompt:team-1#1')!.descriptionRef),
  ).toBe('the full scope');
});

it('refuses a cycle that runs through a deleted task, as the record rule does', async () => {
  await createTeam();
  for (const [index, subject] of ['A', 'B', 'D'].entries())
    await one(
      'task_create',
      { subject, description: subject },
      `task-${index}`,
    );
  // #3 waits on #2 and #1 waits on #3; then #3 is deleted, edges intact.
  await one('task_update', { taskId: '3', addBlockedBy: ['2'] }, 'call-2');
  await one('task_update', { taskId: '1', addBlockedBy: ['3'] }, 'call-3');
  await one('task_update', { taskId: '3', status: 'deleted' }, 'call-4');
  expect(
    await one('task_update', { taskId: '2', addBlockedBy: ['1'] }, 'call-5'),
  ).toContain('dependency cycle');
  expect(teams.task('prompt:team-1#2')!.blockedBy).toEqual([]);
});

it('answers a launch whose run ended while it was joining, without blocking the turn', async () => {
  await createTeam();
  const commit = session.authority.commitExtensionRecord.bind(
    session.authority,
  );
  let raced = false;
  vi.spyOn(session.authority, 'commitExtensionRecord').mockImplementation(
    async (command, body, actor) => {
      // The relay's creation refusal lands between the join's check and
      // its commit; the authority then refuses the join.
      if (command.operation === 'joinTeam' && !raced) {
        raced = true;
        await finishChild('prompt:call-2', 'failed');
      }
      return commit(command, body, actor);
    },
  );
  expect(await spawn('alice', 'call-2')).toContain(
    'Child agent run failed (creation_failed) before it could join the team as \\"alice\\"',
  );
  expect(raced).toBe(true);
  expect(team()!.members).toEqual([]);
});

it('treats a blank optional argument as not given, as Legacy does', async () => {
  await createTeam();
  // A blank name is an ordinary child, never a refused teammate.
  const plain = await one(
    'agent',
    { description: 'work', prompt: 'do it', name: '' },
    'call-2',
  );
  expect(plain).toContain('started in the background');
  expect(plain).not.toContain('Teammate');
  expect(team()!.members).toEqual([]);
  expect(
    await one(
      'task_create',
      { subject: 'A', description: 'a', activeForm: '', metadata: null },
      'call-3',
    ),
  ).toContain('Task #1 created');
  expect(teams.task('prompt:team-1#1')).toMatchObject({
    activeForm: null,
    metadataRef: null,
  });
  expect(
    await one(
      'task_update',
      { taskId: '1', subject: '', status: '', metadata: null },
      'call-4',
    ),
  ).toContain('Task #1 updated (status: pending)');
  expect(teams.task('prompt:team-1#1')!.subject).toBe('A');
  // A null owner is not given; `""` stays the unassign.
  await one('task_update', { taskId: '1', owner: 'leader' }, 'call-4b');
  expect(
    await one('task_update', { taskId: '1', owner: null }, 'call-4c'),
  ).toContain('owner: leader');
  expect(
    await one('task_update', { taskId: '1', owner: '' }, 'call-4d'),
  ).not.toContain('owner:');
  expect(
    await one('task_list', { owner: '', blockedBy: ' ', status: '' }, 'call-5'),
  ).toContain('#1 [pending] @unassigned — A');
  // With teams on, `name` is no legacy argument any more.
  const legacy = await one(
    'agent',
    { description: 'work', prompt: 'do it', model: 'fast' },
    'call-6',
  );
  expect(legacy).toContain('unsupported argument \\"model\\"');
  expect(legacy).not.toContain('isolation, name,');
});

it('filters task_list by open blockers only', async () => {
  await createTeam();
  await one('task_create', { subject: 'A', description: 'a' }, 'call-2');
  await one('task_create', { subject: 'B', description: 'b' }, 'call-3');
  await one('task_update', { taskId: '2', addBlockedBy: ['1'] }, 'call-4');
  expect(await one('task_list', { blockedBy: '#1' }, 'call-5')).toContain(
    '#2 [pending] @unassigned — B (blocked by #1)',
  );
  await one('task_update', { taskId: '1', status: 'completed' }, 'call-6');
  expect(await one('task_list', { blockedBy: '1' }, 'call-7')).toContain(
    'No tasks found.',
  );
});

it('refuses a foreground child beside a team tool with the reason that applies', async () => {
  await createTeam();
  const answers = await run([
    call('task_list', {}, 'call-2'),
    call(
      'agent',
      { description: 'a', prompt: 'p', run_in_background: false },
      'call-3',
    ),
  ]);
  expect(answers[1]).toContain('cannot share a batch with a team tool');
  expect(answers[1]).not.toContain('Workspace mount');
});

it('caps a task at 64 blockers in either direction', async () => {
  await createTeam();
  for (let number = 1; number <= 67; number++)
    await one(
      'task_create',
      { subject: `T${number}`, description: 'd' },
      `make-${number}`,
    );
  const sixtyFour = Array.from({ length: 64 }, (_, index) => `${index + 2}`);
  expect(
    await one('task_update', { taskId: '1', addBlockedBy: sixtyFour }, 'up-1'),
  ).toContain('Task #1 updated');
  expect(
    await one('task_update', { taskId: '1', addBlockedBy: ['66'] }, 'up-2'),
  ).toContain(
    'task #1 would be blocked by more than 64 tasks (completed and deleted blockers stay on a task and count).',
  );
  expect(
    await one('task_update', { taskId: '67', addBlocks: ['1'] }, 'up-3'),
  ).toContain('task #1 would be blocked by more than 64 tasks');
  expect(teams.task('prompt:team-1#1')!.blockedBy).toHaveLength(64);
});

it('keeps a team an interrupted delete left closing closed to new work', async () => {
  await createTeam();
  await one('task_create', { subject: 'A', description: 'a' }, 'call-2');
  await session.authority.commitExtensionRecord(
    {
      operation: 'closeTeam',
      commandId: 'prompt:dead:closing',
      sessionKey,
      contentDigest: 'a'.repeat(64),
    },
    { domain: 'team_state', record: teamLifecycleBody(team()!, 'closing') },
    { class: 'trusted_entry' },
  );
  expect(
    await one('task_create', { subject: 'B', description: 'b' }, 'call-3'),
  ).toContain('is being deleted and takes no new tasks');
  expect(await spawn('alice', 'call-4')).toContain(
    'is being deleted and takes no new members',
  );
  expect(await one('team_create', { team_name: 'next' }, 'call-5')).toContain(
    'Team \\"review-team\\" is still being deleted',
  );
  expect(
    await one('task_update', { taskId: '1', status: 'completed' }, 'call-6'),
  ).toContain('Task #1 updated');
  expect(await one('team_delete', {}, 'call-7')).toContain('deleted.');
  expect(teams.team('prompt:team-1')!.lifecycle).toBe('deleted');
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    0,
  );
});

it('admits at most ten teammates', async () => {
  await createTeam();
  for (let number = 1; number <= 10; number++) {
    expect(await spawn(`m${number}`, `spawn-${number}`)).toContain('started');
    await finishChild(`prompt:spawn-${number}`, 'completed');
  }
  expect(await spawn('m11', 'spawn-11')).toContain(
    'Maximum number of teammates (10) reached.',
  );
  expect(team()!.members).toHaveLength(10);
  expect(session.authority.extensionRecordsInDomain('child_run')).toHaveLength(
    10,
  );
});

it('fires PostToolUse on a resumed team result that answered without an error', async () => {
  await createTeam();
  const firstEvents: string[] = [];
  const created = call(
    'task_create',
    { subject: 'A', description: 'a' },
    'call-2',
  );
  const saved = await createTurn(0, firstEvents).execute(
    [created],
    [
      {
        functionCall: { id: 'call-2', name: 'task_create', args: created.args },
      },
    ],
    'model',
    new AbortController().signal,
  );
  expect(firstEvents).toContain('PostToolUse');
  // A reconstructed turn starts with an empty dispatch set: the committed
  // command is the evidence that survives.
  const recoveredEvents: string[] = [];
  await createTurn(0, recoveredEvents).resumeHookResults(
    saved,
    'model',
    new AbortController().signal,
  );
  expect(recoveredEvents).toContain('PostToolUse');
  // A read commits nothing: its error-free answer is the evidence.
  const listed = call('task_list', {}, 'call-3');
  const listing = await createTurn(0, []).execute(
    [listed],
    [{ functionCall: { id: 'call-3', name: 'task_list', args: {} } }],
    'model',
    new AbortController().signal,
  );
  const listEvents: string[] = [];
  await createTurn(0, listEvents).resumeHookResults(
    listing,
    'model',
    new AbortController().signal,
  );
  expect(listEvents).toContain('PostToolUse');
  // A refused call never ran, so its resume fires no PostToolUse.
  const refused = await createTurn(0, []).execute(
    [call('task_update', { taskId: '9' }, 'call-4')],
    [
      {
        functionCall: {
          id: 'call-4',
          name: 'task_update',
          args: { taskId: '9' },
        },
      },
    ],
    'model',
    new AbortController().signal,
  );
  const refusedEvents: string[] = [];
  await createTurn(0, refusedEvents).resumeHookResults(
    refused,
    'model',
    new AbortController().signal,
  );
  expect(refusedEvents).not.toContain('PostToolUse');
  expect(refusedEvents).not.toContain('PostToolUseFailure');
});

it('answers a replayed task delete as deleted', async () => {
  await createTeam();
  await one('task_create', { subject: 'A', description: 'a' }, 'call-2');
  const remove = { taskId: '1', status: 'deleted' };
  expect(await one('task_update', remove, 'call-3')).toContain(
    'Task #1 deleted.',
  );
  expect(await one('task_update', remove, 'call-3')).toContain(
    'Task #1 deleted.',
  );
  expect(await one('task_update', remove, 'call-4')).toContain(
    'Task #1 not found.',
  );
});

it('merges a metadata key named __proto__ as plain data', async () => {
  await createTeam();
  await one(
    'task_create',
    { subject: 'A', description: 'a', metadata: { a: 1 } },
    'call-2',
  );
  await one(
    'task_update',
    { taskId: '1', metadata: JSON.parse('{"__proto__":{"x":1},"b":2}') },
    'call-3',
  );
  const merged = await teams.readJson(
    teams.task('prompt:team-1#1')!.metadataRef!,
  );
  expect(Object.keys(merged)).toEqual(['a', '__proto__', 'b']);
  expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
});

it('answers a launch whose run was cancelled while it was joining with that end', async () => {
  await createTeam();
  const commit = session.authority.commitExtensionRecord.bind(
    session.authority,
  );
  let raced = false;
  vi.spyOn(session.authority, 'commitExtensionRecord').mockImplementation(
    async (command, body, actor) => {
      if (command.operation === 'joinTeam' && !raced) {
        raced = true;
        await children.settleCancelled('prompt:call-2', { started: false });
      }
      return commit(command, body, actor);
    },
  );
  expect(await spawn('alice', 'call-2')).toContain('Child agent run cancelled');
  expect(team()!.members).toEqual([]);
});
