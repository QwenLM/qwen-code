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
  HOSTED_TEAM_AGENT_TOOL,
} from './hosted-workspace-tool-turn.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import {
  HOSTED_TEAM_TOOLS,
  HostedTeamSession,
  type HostedTeamStore,
} from './hosted-team-session.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';
import { settleInterruptedTurnRuntime } from './hosted-runtime-recovery.js';
import {
  HOSTED_APPROVAL_OPTIONS,
  HOSTED_TOOL_APPROVAL_POLICY,
} from './hosted-tool-approval.js';

// H4e-b1: team_state and team_task stay disabled until the physical
// acceptance pass, so the gate is lifted per test; with it closed the turn
// keeps the H4b surface exactly.
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
          !(
            (domain === 'team_state' && enablement.teamState) ||
            (domain === 'team_task' && enablement.teamTask)
          )
        )
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
        queueConsumption: () => undefined,
      },
      teams: options.funnel ?? teams,
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

it('keeps refusing name while the team domains are disabled', async () => {
  enablement.teamState = false;
  enablement.teamTask = false;
  const answer = await execute(createTurn(), [member('alice', 'call-1')]);
  expect(answer).toContain('unsupported argument');
  expect(answer).toContain('\\"name\\"');
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

it('completes a join that a crash between launch and join interrupted', async () => {
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

it('answers a launch whose run ended before the join with its failure', async () => {
  await execute(createTurn(), [
    call('team_create', { team_name: 'review' }, 'call-team'),
  ]);
  // The relay refuses the creation in the window between launch and join.
  const failingFirst = new HostedTeamSession(
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
              await children.settleFailed('prompt:call-alice', {
                stopReason: 'creation_failed',
                reason: null,
                started: false,
              });
            return session.authority.commitExtensionRecord(...args);
          },
        },
      }),
    },
    sessionKey,
  );
  const answer = await execute(createTurn({ funnel: failingFirst }), [
    member('alice', 'call-alice'),
  ]);
  expect(answer).toContain('ended (failed, creation_failed) before it joined');
  expect(answer).toContain('the name \\"alice\\" stays free');
  expect(roster()).toHaveLength(0);
});

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

it('answers an interrupted turn honestly for a team call that committed', async () => {
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
        Buffer.from(JSON.stringify([{ type: 'text', text: 'make a team' }])),
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
      parts: [
        {
          functionCall: {
            id: 'call-team',
            name: 'team_create',
            args: { team_name: 'review' },
          },
        },
        {
          functionCall: {
            id: 'call-task',
            name: 'task_create',
            args: { subject: 'audit', description: 'audit it' },
          },
        },
      ],
    },
  });
  // The team committed; the Harness then died asking about the next call.
  await teams.run('team_create', { team_name: 'review' }, 'prompt:call-team');
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
            createdAt: 1,
            expiresAt: 2,
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
  await settleInterruptedTurnRuntime({
    session,
    sessionId: sessionKey.sessionId,
    cwd: root,
    promptId: 'prompt',
    brokerOptions: undefined,
    toolProfile: true,
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
  expect(answers.get('call-team')).toContain(
    'committed its team change, in full or in part',
  );
  expect(answers.get('call-task')).toContain('The tool call never ran');
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
