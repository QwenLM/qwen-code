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
  HOSTED_TEAM_AGENT_TOOL,
  HOSTED_TEAM_AGENT_WORKTREE_TOOL,
} from './hosted-workspace-tool-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import {
  HOSTED_TEAM_TOOLS,
  HostedTeamSession,
  type HostedTeamStore,
} from './hosted-team-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { HostedSessionMessageSession } from './hosted-session-message-session.js';
import { settleInterruptedTurnRuntime } from './hosted-runtime-recovery.js';
import {
  HOSTED_APPROVAL_OPTIONS,
  HOSTED_TOOL_APPROVAL_POLICY,
  HostedApprovalWaiters,
  resolveHostedAction,
} from './hosted-tool-approval.js';

// H4e-b1: team_state and team_task are enabled, so the flags close the
// real gate per test; with either closed the turn keeps the H4b surface
// exactly, which is what a rollback of the enablement restores.
const enablement = vi.hoisted(() => ({ teamState: true, teamTask: true }));
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
    messages?: boolean;
  } = {},
): HostedWorkspaceToolTurn {
  const hookEvents = options.hookEvents;
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
    () => true,
    undefined,
    { resources: session.resources, assertWritable: async () => undefined },
    undefined,
    {
      profile: 'hosted-workspace-shell/1',
      childAgents: {
        funnel: children,
        depth: options.depth ?? 0,
        childWorkspaces: options.childWorkspaces === true,
        queueConsumption: () => undefined,
      },
      teams: options.funnel ?? teams,
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

function roster() {
  return session.authority
    .extensionRecordsInDomain('team_state')
    .flatMap((entry) => parseTeamState(entry.record).members);
}

beforeEach(async () => {
  enablement.teamState = true;
  enablement.teamTask = true;
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
  teams = new HostedTeamSession(store, sessionKey);
});

afterEach(async () => {
  await session?.close();
  await rm(root, { recursive: true, force: true });
});

it('declares the team tools only beside the root Agent tool, behind both gates', async () => {
  const signal = new AbortController().signal;
  const names = async (turn: HostedWorkspaceToolTurn) =>
    (await turn.declarations(signal)).map((tool) => tool.name);
  const team = [
    'team_create',
    'team_delete',
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
  expect(answer).toContain('cannot share a batch with a non-agent tool');
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

// #13822 continues a finished child as a new run, which the roster would
// not name: a member hears from the lead while it runs and is never
// continued (H4e-b2).
it('messages a running member and refuses to continue a finished one', async () => {
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
  expect(
    await execute(turn, [
      call('send_message', { to: 'bob', message: 'hi' }, 'call-by-name'),
    ]),
  ).toContain('a team member is addressed by the task id task_list shows');
  await children.dispatchStarted('prompt:call-alice', {
    dispatchId: 'dispatch-1',
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach('prompt:call-alice', 'session-alice');
  await children.settleCompleted('prompt:call-alice', {
    result: Buffer.from('all clean', 'utf8'),
    receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
  });
  const refused = await execute(turn, [
    call(
      'send_message',
      { task_id: alice, message: 'now fix them' },
      'call-more',
    ),
  ]);
  expect(refused).toContain(
    'ran as \\"alice\\" of team \\"review\\" and has finished; a member of an open team cannot be continued yet',
  );
  expect(children.record('prompt:call-more')).toBeUndefined();
  const listing = await execute(turn, [call('task_list', {}, 'call-list')]);
  expect(listing).toContain(`alice: completed — ${alice}`);
  expect(listing).toContain(`bob: running — ${bob}`);
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

// Once its team is deleted, nothing reads the roster for a former member,
// so it continues as a plain child.
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
