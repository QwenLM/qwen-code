/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const planGate = vi.hoisted(() => ({ enabled: false }));
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
        if (domain === 'team_plan' && planGate.enabled) return;
        actual.assertManagedSessionDomainEnabled(domain);
      },
    };
  },
);
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { sessionCommandId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-operations.js';
import { MANAGED_SESSION_COMMAND_LIMITS } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-record.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { ManagedSessionAppendUnsettledError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  isChildSessionRun,
  parseChildRun,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { parseSessionMessage } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-record.js';
import { sessionMessageInputId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-operations.js';
import {
  HostedChildAgentSession,
  type HostedChildAgentStore,
} from './hosted-child-agent-session.js';
import {
  HostedSessionCommandSession,
  SessionCommandBlockedError,
  SessionCommandRefusalError,
} from './hosted-session-command-session.js';
import {
  HostedSessionMessageSession,
  memberMessageContent,
} from './hosted-session-message-session.js';
import { memberMessageId } from './hosted-member-chain.js';
import { HostedTeamSession } from './hosted-team-session.js';

// H4e-b3: `session_command` is enabled for real, so this suite drives the
// funnel with no enablement mock. The member side only needs its own
// lineage Session; the lead side additionally needs the member's run
// launched and attached in its own journal — that binding is what the
// inbound lineage rule proves.

const roots: string[] = [];
const sessions: ManagedSession[] = [];
const PARENT = randomUUID();
const CHILD = randomUUID();
const LEAF_RUN = 'run-1';

afterEach(async () => {
  planGate.enabled = false;
  for (const session of sessions.splice(0)) await session.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function open(sessionId: string): Promise<ManagedSession> {
  const root = await mkdtemp(path.join(tmpdir(), 'hosted-command-'));
  roots.push(root);
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId,
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId,
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
  sessions.push(session);
  return session;
}

interface Side {
  readonly session: ManagedSession;
  readonly children: HostedChildAgentSession;
  readonly commands: HostedSessionCommandSession;
}

async function side(
  sessionId: string,
  lineage?: { parentSessionId: string; parentChildRunId: string },
): Promise<Side> {
  const session = await open(sessionId);
  const store = { authority: session.authority, resources: session.resources };
  const key = session.authority.sessionHeader.sessionKey;
  const children = new HostedChildAgentSession(store, key);
  return {
    session,
    children,
    commands: new HostedSessionCommandSession(store, key, children, lineage),
  };
}

async function memberSide(): Promise<Side> {
  return side(CHILD, {
    parentSessionId: PARENT,
    parentChildRunId: LEAF_RUN,
  });
}

/**
 * A member side whose next extension commit lands durably but reports an
 * unknown outcome: the record is withheld from the authority's view until
 * `settlePendingAppend()` applies it, exactly the landed-with-lost-ack shape
 * a retry must settle before reading replay state.
 */
async function lostAckMemberSide(): Promise<{
  readonly member: Side;
  armNextCommit(): void;
  publications(kind: string): number;
}> {
  const session = await open(CHILD);
  let pending:
    | Parameters<typeof session.authority.commitExtensionRecord>
    | undefined;
  let armed = false;
  const published: string[] = [];
  const publish = async (kind: string, bytes: Buffer) => {
    const ref = await session.resources.publish(kind, bytes);
    published.push(kind);
    return ref;
  };
  const resources = new Proxy(session.resources, {
    get(target, prop) {
      if (prop === 'publish') return publish;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const authority = new Proxy(session.authority, {
    get(target, prop) {
      if (prop === 'settlePendingAppend') {
        return async () => {
          const next = pending;
          pending = undefined;
          if (next !== undefined) await target.commitExtensionRecord(...next);
        };
      }
      if (prop === 'commitExtensionRecord') {
        return async (
          ...args: Parameters<typeof target.commitExtensionRecord>
        ) => {
          if (armed) {
            armed = false;
            pending = args;
            throw new ManagedSessionAppendUnsettledError(
              new Error('acknowledgement lost after the append landed'),
            );
          }
          return target.commitExtensionRecord(...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = {
    authority: authority as unknown as HostedChildAgentStore['authority'],
    resources: resources as unknown as HostedChildAgentStore['resources'],
  };
  const key = session.authority.sessionHeader.sessionKey;
  const children = new HostedChildAgentSession(store, key);
  return {
    member: {
      session,
      children,
      commands: new HostedSessionCommandSession(store, key, children, {
        parentSessionId: PARENT,
        parentChildRunId: LEAF_RUN,
      }),
    },
    armNextCommit: () => {
      armed = true;
    },
    publications: (kind) => published.filter((entry) => entry === kind).length,
  };
}

const DEFINITION = {
  definitionId: 'hosted-agent/hosted-workspace-shell/1',
  definitionRevision: 1,
  definitionDigest: 'f'.repeat(64),
};

async function leadSideSetup(): Promise<Side> {
  const lead = await side(PARENT, undefined);
  // The member's run in the lead's own journal, attached — an attached
  // child Session run that the inbound lineage rule can prove the
  // sender against.
  await lead.children.admit({
    completion: 'sent',
    childRunId: LEAF_RUN,
    ownerScopeId: PARENT,
    rootSessionId: PARENT,
    description: 'audit the diff',
    prompt: 'review the change',
    definition: DEFINITION,
    workingDirectory: '.',
    workspaceMode: 'shared',
    executionCallId: LEAF_RUN,
  } as never);
  await lead.children.dispatchStarted(LEAF_RUN, {
    dispatchId: `dispatch-${LEAF_RUN}`,
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await lead.children.attach(LEAF_RUN, CHILD);
  return lead;
}

function commandIdOf(callId: string): string {
  return sessionCommandId({
    senderSessionId: CHILD,
    promptKey: 'prompt-1',
    callId,
  });
}

/** The lead with an open team and `bob` on it, running as LEAF_RUN. */
async function leadWithTeam(): Promise<
  Side & { readonly teams: HostedTeamSession }
> {
  const lead = await leadSideSetup();
  const teams = new HostedTeamSession(
    {
      authority: lead.session.authority,
      resources: lead.session.resources,
    },
    lead.session.authority.sessionHeader.sessionKey,
  );
  await teams.run('team_create', { team_name: 'Review' }, 'prompt:call-team');
  const member = teams.admitMember('bob');
  expect(await teams.join({ ...member, childRunId: LEAF_RUN })).toEqual({
    joined: true,
  });
  return { ...lead, teams };
}

/**
 * b3c: the lead with further named members admitted, joined and running.
 * Positions follow join order: `bob` is always position 1 (LEAF_RUN).
 */
async function leadWithMembers(
  names: readonly string[],
): Promise<Side & { readonly teams: HostedTeamSession }> {
  const lead = await leadWithTeam();
  for (const [index, name] of names.entries()) {
    const childRunId = `run-${name}`;
    const sessionId = randomUUID();
    await lead.children.admit({
      completion: 'sent',
      childRunId,
      ownerScopeId: PARENT,
      rootSessionId: PARENT,
      description: `work of ${name}`,
      prompt: 'help out',
      definition: DEFINITION,
      workingDirectory: '.',
      workspaceMode: 'shared',
      executionCallId: childRunId,
    } as never);
    await lead.children.dispatchStarted(childRunId, {
      dispatchId: `dispatch-${childRunId}`,
      runtime: { runtimeBindingId: `binding-${index + 2}`, generation: '1' },
    });
    await lead.children.attach(childRunId, sessionId);
    const member = lead.teams.admitMember(name);
    expect(await lead.teams.join({ ...member, childRunId })).toEqual({
      joined: true,
    });
  }
  return lead;
}

/** The `msgc_` id of one roster position's message of one command. */
function memberMessageIdOf(commandId: string, position: number): string {
  return memberMessageId({
    leadSessionId: PARENT,
    commandId,
    position,
  });
}

/** The lead's outbound messages to one member's run, parsed. */
function sentToHead(
  lead: Side,
  childRunId: string,
): ReadonlyArray<ReturnType<typeof parseSessionMessage>> {
  return lead.session.authority
    .extensionRecordsInDomain('session_message')
    .map((entry) => parseSessionMessage(entry.record))
    .filter(
      (message) =>
        message.direction === 'outbound' && message.childRunId === childRunId,
    );
}

/** The Session a child run attached as — the target its messages must name. */
function attachedSessionOf(lead: Side, childRunId: string): string {
  const record = lead.session.authority.extensionRecord(
    'child_run',
    childRunId,
  );
  const run = record === undefined ? undefined : parseChildRun(record.record);
  if (
    run === undefined ||
    !isChildSessionRun(run) ||
    run.childSessionId === null
  ) {
    throw new Error(`Child run ${childRunId} has not attached.`);
  }
  return run.childSessionId;
}

/** The lead's relay verbs for its own outbound messages (H4d-b). */
function leadRelay(lead: Side): HostedSessionMessageSession {
  return new HostedSessionMessageSession(
    {
      authority: lead.session.authority,
      resources: lead.session.resources,
    } as never,
    lead.session.authority.sessionHeader.sessionKey,
    lead.children,
    undefined,
  );
}

const TASK_LIST_ARGS = { status: 'pending' } as const;
const TASK_CREATE_ARGS = {
  subject: 'ship the fix',
  description: 'explain the change once',
} as const;
const TASK_UPDATE_ARGS = {
  taskId: '1',
  status: 'in_progress',
  owner: 'alice',
} as const;

describe('hosted-session-command-session funnel (H4e-b3)', () => {
  it('executes a plan submission and replays its real durable receipt', async () => {
    planGate.enabled = true;
    const lead = await leadSideSetup();
    const teams = new HostedTeamSession(
      { authority: lead.session.authority, resources: lead.session.resources },
      lead.session.authority.sessionHeader.sessionKey,
      lead.children,
    );
    await teams.run('team_create', { team_name: 'Review' }, 'create');
    await teams.join({
      ...teams.admitMember('bob'),
      childRunId: LEAF_RUN,
      planModeRequired: true,
    });
    const params = {
      commandId: commandIdOf('real-plan'),
      kind: 'plan_submit' as const,
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { plan: 'Read then edit' },
    };
    const original = await teams.submitPlan(
      params.commandId,
      LEAF_RUN,
      params.args.plan,
    );
    expect(await lead.commands.existingReply(params.commandId)).toBeUndefined();
    planGate.enabled = false;
    const reply = await lead.commands.execute(teams, params);
    expect(reply.outcome).toBe('answered');
    expect(JSON.stringify(reply)).toContain(original);
    expect(
      (
        await lead.commands.execute(teams, {
          ...params,
          commandId: commandIdOf('fresh-plan'),
        })
      ).outcome,
    ).toBe('refused');
    expect(
      lead.session.authority.extensionRecordsInDomain('team_plan'),
    ).toHaveLength(1);
    expect(await lead.commands.execute(teams, params)).toEqual(reply);
    expect(
      lead.session.authority.extensionRecordsInDomain('team_plan'),
    ).toHaveLength(1);
    expect(await lead.commands.existingReply(params.commandId)).toEqual(reply);
  });

  it('keeps a partial plan submission retryable across gate-off rollback', async () => {
    planGate.enabled = true;
    const lead = await leadSideSetup();
    const store = {
      authority: lead.session.authority,
      resources: lead.session.resources,
    };
    const key = lead.session.authority.sessionHeader.sessionKey;
    const teams = new HostedTeamSession(store, key, lead.children);
    await teams.run('team_create', { team_name: 'Review' }, 'create');
    await teams.join({
      ...teams.admitMember('bob'),
      childRunId: LEAF_RUN,
      planModeRequired: true,
    });
    await teams.submitPlan('original', LEAF_RUN, 'first');
    const params = {
      commandId: commandIdOf('replacement'),
      kind: 'plan_submit' as const,
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { plan: 'second' },
    };
    const interrupted = new HostedTeamSession(
      {
        ...store,
        authority: Object.create(store.authority, {
          commitExtensionRecord: {
            value: async (
              ...args: Parameters<typeof store.authority.commitExtensionRecord>
            ) => {
              const result = await store.authority.commitExtensionRecord(
                ...args,
              );
              if (
                args[0].commandId === `supersede:${params.commandId}:original`
              )
                throw new Error('cut after cancel');
              return result;
            },
          },
        }),
      },
      key,
      lead.children,
    );
    await expect(lead.commands.execute(interrupted, params)).rejects.toThrow(
      'cut after cancel',
    );
    await lead.children.settleCompleted(LEAF_RUN, {
      result: Buffer.from('done'),
      receipt: Buffer.from('{"outcome":"settled"}'),
    });
    planGate.enabled = false;
    await expect(lead.commands.execute(teams, params)).rejects.toBeInstanceOf(
      SessionCommandBlockedError,
    );
    expect(await lead.commands.existingReply(params.commandId)).toBeUndefined();
    expect(teams.plan(params.commandId)).toBeUndefined();
    planGate.enabled = true;
    expect(await lead.commands.execute(teams, params)).toMatchObject({
      outcome: 'answered',
    });
    expect(teams.plan(params.commandId)).toMatchObject({
      planRevision: 2,
      run: { state: 'waiting' },
    });
  });

  it.each(['waiting', 'cancelled', 'decided', 'other-run'] as const)(
    'accepts result notifications with only this run waiting plan: %s',
    async (state) => {
      planGate.enabled = true;
      const lead = await leadSideSetup();
      const teams = new HostedTeamSession(
        {
          authority: lead.session.authority,
          resources: lead.session.resources,
        },
        lead.session.authority.sessionHeader.sessionKey,
        lead.children,
      );
      await teams.run('team_create', { team_name: 'Review' }, 'create');
      await teams.join({
        ...teams.admitMember('bob'),
        childRunId: LEAF_RUN,
        planModeRequired: true,
      });
      const requestId = commandIdOf('notification-plan');
      expect(
        (
          await lead.commands.execute(teams, {
            commandId: requestId,
            kind: 'plan_submit',
            childRunId: LEAF_RUN,
            senderSessionId: CHILD,
            args: { plan: 'Review <special>' },
          })
        ).outcome,
      ).toBe('answered');
      await lead.children.settleCompleted(LEAF_RUN, {
        result: Buffer.from('done'),
        receipt: Buffer.from('{"outcome":"settled"}'),
      });
      if (state === 'cancelled')
        await teams.run('request_shutdown', { to: 'bob' }, 'stop');
      if (state === 'decided')
        await teams.run(
          'team_plan_approval',
          { request_id: requestId, action: 'approve' },
          'approve',
        );
      let notified = LEAF_RUN;
      if (state === 'other-run') {
        notified = 'other-run';
        await lead.children.admit({
          completion: 'sent',
          childRunId: notified,
          ownerScopeId: PARENT,
          rootSessionId: PARENT,
          description: 'other',
          prompt: 'other',
          definition: DEFINITION,
          workingDirectory: '.',
          workspaceMode: 'shared',
          executionCallId: notified,
        });
        await lead.children.dispatchStarted(notified, {
          dispatchId: 'other-dispatch',
          runtime: { runtimeBindingId: 'binding-1', generation: '1' },
        });
        await lead.children.attach(notified, 'other-session');
        await lead.children.settleCompleted(notified, {
          result: Buffer.from('done'),
          receipt: Buffer.from('{"outcome":"settled"}'),
        });
      }
      await lead.children.accept(notified, {
        notification: { description: 'audit' },
      });
      const input = lead.session.authority
        .readEvents({ afterSequence: 0, limit: 1024 })
        .find((event) => event.kind === 'input.accepted')!;
      const ref = (input.payload as Record<string, unknown>)[
        'contentRef'
      ] as Parameters<typeof lead.session.resources.read>[0];
      const text = (await lead.session.resources.read(ref)).toString('utf8');
      if (state === 'waiting') {
        expect(text).toContain(requestId);
        expect(text).toContain('Review &lt;special&gt;');
      } else expect(text).not.toContain(requestId);
    },
  );

  it.each([
    'planned',
    'accepting',
    'unknown',
    'accepted',
    'consumed',
    'refused',
    'cancelled',
    'rejected',
  ] as const)(
    'deduplicates plan submissions from persisted %s evidence',
    async (state) => {
      const member = await memberSide();
      const first = {
        commandId: commandIdOf('plan-first'),
        kind: 'plan_submit' as const,
        args: { plan: 'Read then edit' },
        executionCallId: 'plan-first',
        closing: false,
      };
      await member.commands.runCommand(first);
      if (
        [
          'accepting',
          'unknown',
          'accepted',
          'consumed',
          'refused',
          'rejected',
        ].includes(state)
      )
        await member.commands.handover(first.commandId, PARENT);
      if (state === 'unknown' || state === 'cancelled' || state === 'rejected')
        await member.commands.settle(first.commandId, state);
      if (state === 'accepted' || state === 'consumed' || state === 'refused')
        await member.commands.answered(first.commandId, {
          outcome: state === 'refused' ? 'refused' : 'answered',
          text: state,
        });
      if (state === 'consumed')
        await member.commands.commitConsumed(first.commandId);
      const restarted = new HostedSessionCommandSession(
        {
          authority: member.session.authority,
          resources: member.session.resources,
        },
        member.session.authority.sessionHeader.sessionKey,
        member.children,
        { parentSessionId: PARENT, parentChildRunId: LEAF_RUN },
      );
      await restarted.runCommand(first);
      const retry = restarted.runCommand({
        ...first,
        commandId: commandIdOf('plan-second'),
        executionCallId: 'plan-second',
      });
      if (['refused', 'cancelled', 'rejected'].includes(state))
        await expect(retry).resolves.toBeUndefined();
      else await expect(retry).rejects.toThrow(/already submitted a plan/);
    },
  );

  it('commits the outbound planned entry and replays an identical restatement', async () => {
    const member = await memberSide();
    const commandId = commandIdOf('call-1');
    await member.commands.runCommand({
      commandId,
      kind: 'board_write',
      args: TASK_UPDATE_ARGS,
      executionCallId: 'prompt-1:call-1',
      closing: false,
    });
    const committed = member.commands.commands().at(-1)!;
    expect(committed.direction).toBe('outbound');
    expect(committed.kind).toBe('board_write');
    expect(committed.childRunId).toBe(LEAF_RUN);
    expect(committed.senderSessionId).toBe(CHILD);
    expect(committed.targetSessionId).toBeNull();
    expect(committed.run.delivery?.state).toBe('planned');
    await member.commands.runCommand({
      commandId,
      kind: 'board_write',
      args: TASK_UPDATE_ARGS,
      executionCallId: 'prompt-1:call-1',
      closing: false,
    });
    expect(member.commands.commands()).toHaveLength(1);
    await expect(
      member.commands.runCommand({
        commandId,
        kind: 'board_write',
        args: { ...TASK_UPDATE_ARGS, status: 'completed' },
        executionCallId: 'prompt-1:call-1',
        closing: false,
      }),
    ).rejects.toThrow(ManagedSessionConflictError);
  });

  it('refuses a command from a Session without a lineage', async () => {
    const memberless = await side(CHILD, undefined);
    await expect(
      memberless.commands.runCommand({
        commandId: commandIdOf('call-2'),
        kind: 'board_read',
        args: TASK_LIST_ARGS,
        executionCallId: 'prompt-1:call-2',
        closing: false,
      }),
    ).rejects.toThrow(/Only a child Session can command its parent/);
  });

  it('refuses a command from a closing Session', async () => {
    const member = await memberSide();
    await expect(
      member.commands.runCommand({
        commandId: commandIdOf('call-3'),
        kind: 'board_read',
        args: TASK_LIST_ARGS,
        executionCallId: 'prompt-1:call-3',
        closing: true,
      }),
    ).rejects.toThrow(/closing and takes no more commands/);
  });

  it('refuses arguments over the byte bound with byte_limit', async () => {
    const member = await memberSide();
    await expect(
      member.commands.runCommand({
        commandId: commandIdOf('call-4'),
        kind: 'board_write',
        args: { subject: 'x'.repeat(64 * 1024) },
        executionCallId: 'prompt-1:call-4',
        closing: false,
      }),
    ).rejects.toThrow(/byte_limit/);
  });

  it('moves the entry through handover, answered and consumed, each replayable', async () => {
    const member = await memberSide();
    const commandId = commandIdOf('call-5');
    await member.commands.runCommand({
      commandId,
      kind: 'board_write',
      args: TASK_CREATE_ARGS,
      executionCallId: 'prompt-1:call-5',
      closing: false,
    });
    await member.commands.handover(commandId, PARENT);
    expect(member.commands.command(commandId)?.run.delivery?.state).toBe(
      'accepting',
    );
    await member.commands.handover(commandId, PARENT);
    await expect(
      member.commands.handover(commandId, randomUUID()),
    ).rejects.toThrow(ManagedSessionConflictError);

    const reply = {
      outcome: 'answered' as const,
      text: 'Task #1 created: "ship the fix"',
    };
    await member.commands.answered(commandId, reply);
    expect(member.commands.command(commandId)?.run.delivery?.state).toBe(
      'accepted',
    );
    await member.commands.answered(commandId, reply);
    await expect(
      member.commands.answered(commandId, {
        outcome: 'refused',
        text: 'no',
      }),
    ).rejects.toThrow(ManagedSessionConflictError);

    expect(await member.commands.readReply(commandId)).toEqual(reply);
    await member.commands.commitConsumed(commandId);
    expect(member.commands.command(commandId)?.run.delivery?.state).toBe(
      'consumed',
    );
  });

  it('settles a landed answered append before replay, so a lost-acknowledgement retry publishes once', async () => {
    const { member, armNextCommit, publications } = await lostAckMemberSide();
    const commandId = commandIdOf('call-lost-ack-answered');
    await member.commands.runCommand({
      commandId,
      kind: 'board_write',
      args: TASK_CREATE_ARGS,
      executionCallId: 'prompt-1:call-lost-ack-answered',
      closing: false,
    });
    await member.commands.handover(commandId, PARENT);
    const reply = {
      outcome: 'answered' as const,
      text: 'Task #1 created: "ship the fix"',
    };
    armNextCommit();
    await expect(member.commands.answered(commandId, reply)).rejects.toThrow(
      ManagedSessionAppendUnsettledError,
    );
    expect(member.commands.command(commandId)?.run.delivery?.state).toBe(
      'accepting',
    );
    await member.commands.answered(commandId, reply);
    expect(member.commands.command(commandId)?.run.delivery?.state).toBe(
      'accepted',
    );
    expect(publications('managed-command-reply')).toBe(1);
    expect(await member.commands.readReply(commandId)).toEqual(reply);
  });

  it('settles a landed outbound append before replay, so a lost-acknowledgement retry publishes once', async () => {
    const { member, armNextCommit, publications } = await lostAckMemberSide();
    const commandId = commandIdOf('call-lost-ack-sent');
    const params = {
      commandId,
      kind: 'board_write' as const,
      args: TASK_CREATE_ARGS,
      executionCallId: 'prompt-1:call-lost-ack-sent',
      closing: false,
    };
    armNextCommit();
    await expect(member.commands.runCommand(params)).rejects.toThrow(
      ManagedSessionAppendUnsettledError,
    );
    expect(member.commands.command(commandId)).toBeUndefined();
    await member.commands.runCommand(params);
    expect(member.commands.command(commandId)?.run.delivery?.state).toBe(
      'planned',
    );
    expect(publications('managed-command-args')).toBe(1);
  });

  it('settles only along the map: cancelled from planned, unknown and rejected from accepting', async () => {
    const member = await memberSide();
    const commandId = commandIdOf('call-6');
    await member.commands.runCommand({
      commandId,
      kind: 'board_read',
      args: TASK_LIST_ARGS,
      executionCallId: 'prompt-1:call-6',
      closing: false,
    });
    await member.commands.settle(commandId, 'cancelled');
    await expect(member.commands.handover(commandId, PARENT)).rejects.toThrow(
      ManagedSessionConflictError,
    );
    await expect(
      member.commands.answered(commandId, {
        outcome: 'answered',
        text: 'reached later',
      }),
    ).rejects.toThrow(ManagedSessionConflictError);

    const other = commandIdOf('call-7');
    await member.commands.runCommand({
      commandId: other,
      kind: 'board_write',
      args: TASK_CREATE_ARGS,
      executionCallId: 'prompt-1:call-7',
      closing: false,
    });
    await member.commands.handover(other, PARENT);
    await member.commands.settle(other, 'unknown');
    await member.commands.settle(other, 'rejected');
    const record = member.commands.command(other)!;
    expect(record.run.delivery?.state).toBe('rejected');
  });

  it('enforces the per-run command budget with budget_exhausted', async () => {
    const member = await memberSide();
    const commandId = commandIdOf('call-8');
    await member.commands.runCommand({
      commandId,
      kind: 'board_read',
      args: TASK_LIST_ARGS,
      executionCallId: 'prompt-1:call-8',
      closing: false,
    });
    // Mint 256 entries by hand: a direct count of outbound records is the
    // rule's own evidence, so the suite plants the history instead of
    // driving 256 funnels calls.
    for (let index = 0; index < 255; index += 1) {
      await member.commands.runCommand({
        commandId: `cmd_extra_${index}`,
        kind: 'board_read',
        args: TASK_LIST_ARGS,
        executionCallId: `prompt-1:call-extra-${index}`,
        closing: false,
      });
    }
    await expect(
      member.commands.runCommand({
        commandId: commandIdOf('call-9'),
        kind: 'board_read',
        args: TASK_LIST_ARGS,
        executionCallId: 'prompt-1:call-9',
        closing: false,
      }),
    ).rejects.toThrow(/budget_exhausted/);
  }, 30_000);

  it("commits the leader's receipt against an attached run and refetches its reply", async () => {
    const lead = await leadSideSetup();
    const commandId = commandIdOf('call-10');
    const reply = {
      outcome: 'answered' as const,
      text: 'Task #1 created: "ship the fix"',
    };
    await lead.commands.commitInboundReceipt({
      commandId,
      kind: 'board_write',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: TASK_CREATE_ARGS,
      reply,
    });
    expect(await lead.commands.existingReply(commandId)).toEqual(reply);
    // Restating the same receipt replays silently.
    await lead.commands.commitInboundReceipt({
      commandId,
      kind: 'board_write',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: TASK_CREATE_ARGS,
      reply,
    });
    expect(lead.commands.commands()).toHaveLength(1);
  });

  it('executes a board write, commits the receipt, and answers a re-execution from it', async () => {
    const lead = await leadWithTeam();
    const commandId = commandIdOf('call-11');
    const execute = () =>
      lead.commands.execute(lead.teams, {
        commandId,
        kind: 'board_write',
        childRunId: LEAF_RUN,
        senderSessionId: CHILD,
        args: TASK_CREATE_ARGS,
      });
    const first = await execute();
    expect(first).toEqual({
      outcome: 'answered',
      text: 'Task #1 created: "ship the fix"',
    });
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
    // The receipt is the whole answer: a re-execution writes nothing more.
    expect(await execute()).toEqual(first);
    expect(
      lead.session.authority.extensionRecordsInDomain('team_task'),
    ).toHaveLength(1);
  });

  it('executes a board update with a string task id and replays from it', async () => {
    const lead = await leadWithTeam();
    await lead.commands.execute(lead.teams, {
      commandId: commandIdOf('call-31'),
      kind: 'board_write',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: TASK_CREATE_ARGS,
    });
    const commandId = commandIdOf('call-32');
    const execute = () =>
      lead.commands.execute(lead.teams, {
        commandId,
        kind: 'board_write',
        childRunId: LEAF_RUN,
        senderSessionId: CHILD,
        // The member tool contract is a string id ("3" or "#3"): an
        // in-progress claim on the unowned task auto-claims her.
        args: { taskId: '1', status: 'in_progress' },
      });
    const first = await execute();
    expect(first).toEqual({
      outcome: 'answered',
      text: 'Task #1 updated (status: in_progress, owner: bob).',
    });
    expect(await execute()).toEqual(first);
    // The update revised the one task; a re-execution writes nothing more.
    expect(
      lead.session.authority.extensionRecordsInDomain('team_task'),
    ).toHaveLength(1);
  });

  it("rejects a command whose sender is not the run's attached Session", async () => {
    const lead = await leadWithTeam();
    await expect(
      lead.commands.execute(lead.teams, {
        commandId: commandIdOf('call-12'),
        kind: 'board_write',
        childRunId: LEAF_RUN,
        senderSessionId: randomUUID(),
        args: TASK_CREATE_ARGS,
      }),
    ).rejects.toThrow(SessionCommandRefusalError);
    expect(
      lead.session.authority.extensionRecordsInDomain('team_task'),
    ).toHaveLength(0);
  });

  it('blocks a command whose run has not attached yet, committing nothing', async () => {
    const lead = await leadWithTeam();
    // The relay's execute can outrun the control plane's attach commit:
    // the run exists pre-attach.
    await lead.children.admit({
      completion: 'sent',
      childRunId: 'run-late',
      ownerScopeId: PARENT,
      rootSessionId: PARENT,
      description: 'join late',
      prompt: 'join late',
      definition: DEFINITION,
      workingDirectory: '.',
      workspaceMode: 'shared',
      executionCallId: 'run-late',
    } as never);
    await lead.children.dispatchStarted('run-late', {
      dispatchId: 'dispatch-run-late',
      runtime: { runtimeBindingId: 'binding-late', generation: '1' },
    });
    const commandId = commandIdOf('call-17');
    await expect(
      lead.commands.execute(lead.teams, {
        commandId,
        kind: 'board_write',
        childRunId: 'run-late',
        senderSessionId: randomUUID(),
        args: TASK_CREATE_ARGS,
      }),
    ).rejects.toThrow(SessionCommandBlockedError);
    // A wait commits nothing: no receipt, no task.
    expect(lead.commands.command(commandId)).toBeUndefined();
    expect(
      lead.session.authority.extensionRecordsInDomain('team_task'),
    ).toHaveLength(0);
  });

  it('refuses a sender off the open team and commits the refused receipt', async () => {
    const lead = await leadWithTeam();
    const OUTSIDER = randomUUID();
    await lead.children.admit({
      completion: 'sent',
      childRunId: 'run-outsider',
      ownerScopeId: PARENT,
      rootSessionId: PARENT,
      description: 'watch the wall',
      prompt: 'watch',
      definition: DEFINITION,
      workingDirectory: '.',
      workspaceMode: 'shared',
      executionCallId: 'run-outsider',
    } as never);
    await lead.children.dispatchStarted('run-outsider', {
      dispatchId: 'dispatch-run-outsider',
      runtime: { runtimeBindingId: 'binding-2', generation: '1' },
    });
    await lead.children.attach('run-outsider', OUTSIDER);
    const commandId = commandIdOf('call-13');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'board_write',
      childRunId: 'run-outsider',
      senderSessionId: OUTSIDER,
      args: TASK_CREATE_ARGS,
    });
    expect(reply).toEqual({
      outcome: 'refused',
      text: 'This Session is not a member of an open team.',
    });
    const receipt = lead.commands.command(commandId);
    expect(receipt?.direction).toBe('inbound');
    expect(receipt?.run.delivery?.state).toBe('consumed');
    expect(
      lead.session.authority.extensionRecordsInDomain('team_task'),
    ).toHaveLength(0);
  });

  it('refuses a member message from a sender off the open team (R1-6)', async () => {
    const lead = await leadWithMembers(['alice']);
    const OUTSIDER = randomUUID();
    await lead.children.admit({
      completion: 'sent',
      childRunId: 'run-outsider',
      ownerScopeId: PARENT,
      rootSessionId: PARENT,
      description: 'watch the wall',
      prompt: 'watch',
      definition: DEFINITION,
      workingDirectory: '.',
      workspaceMode: 'shared',
      executionCallId: 'run-outsider',
    } as never);
    await lead.children.dispatchStarted('run-outsider', {
      dispatchId: 'dispatch-run-outsider',
      runtime: { runtimeBindingId: 'binding-9', generation: '1' },
    });
    await lead.children.attach('run-outsider', OUTSIDER);
    const commandId = sessionCommandId({
      senderSessionId: OUTSIDER,
      promptKey: 'prompt-1',
      callId: 'call-msg-outsider',
    });
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: 'run-outsider',
      senderSessionId: OUTSIDER,
      args: { to: 'alice', message: 'hi' },
    });
    expect(reply).toEqual({
      outcome: 'refused',
      text: 'This Session is not a member of an open team.',
    });
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
    expect(sentToHead(lead, 'run-alice')).toHaveLength(0);
  });

  it('answers a board read for a running member without committing a receipt', async () => {
    const lead = await leadWithTeam();
    const commandId = commandIdOf('call-14');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'board_read',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: {},
    });
    expect(reply.outcome).toBe('answered');
    expect(reply.text).toContain('--- Team "review" members ---');
    expect(reply.text).toContain('bob: running');
    expect(lead.commands.command(commandId)).toBeUndefined();
  });

  it('refuses the kind a later batch owns and commits the refusal', async () => {
    const lead = await leadWithTeam();
    const commandId = commandIdOf('call-15');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'plan_submit',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { plan: 'wait for the review' },
    });
    expect(reply.outcome).toBe('refused');
    expect(reply.text).toContain('not accepted yet');
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
  });

  it('sends a member message to a running member and replays from the receipt', async () => {
    const lead = await leadWithMembers(['alice']);
    const commandId = commandIdOf('call-msg-1');
    const params = {
      commandId,
      kind: 'member_message' as const,
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', message: 'look at task 2' },
    };
    const reply = await lead.commands.execute(lead.teams, params);
    expect(reply).toEqual({
      outcome: 'answered',
      text: 'Message sent to alice.\n- alice: sent.',
    });
    const sent = sentToHead(lead, 'run-alice');
    expect(sent).toHaveLength(1);
    const message = sent[0]!;
    expect(message.messageId).toBe(memberMessageIdOf(commandId, 2));
    expect(message.direction).toBe('outbound');
    expect(message.run.delivery?.state).toBe('planned');
    expect(message.run.executionCallId).toBe(commandId);
    expect(
      (await lead.session.resources.read(message.contentRef!)).toString('utf8'),
    ).toBe('<member-message from="bob">\nlook at task 2\n</member-message>');
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
    const again = await lead.commands.execute(lead.teams, params);
    expect(again).toEqual(reply);
    expect(sentToHead(lead, 'run-alice')).toHaveLength(1);
  });

  it('rejects a re-sent member message id that carries different evidence (R1-6)', async () => {
    const lead = await leadWithMembers(['alice']);
    const commandId = commandIdOf('call-msg-dup');
    const route = {
      rootChildRunId: 'run-alice',
      content: Buffer.from(memberMessageContent('bob', 'sync at noon'), 'utf8'),
      messageId: memberMessageIdOf(commandId, 2),
      executionCallId: commandId,
    };
    await expect(lead.children.sendToRunningMember(route)).resolves.toEqual({
      kind: 'sent',
    });
    // Same id and bytes: the replay answers sent and sends nothing twice.
    await expect(lead.children.sendToRunningMember(route)).resolves.toEqual({
      kind: 'sent',
    });
    expect(sentToHead(lead, 'run-alice')).toHaveLength(1);
    await expect(
      lead.children.sendToRunningMember({
        ...route,
        content: Buffer.from(
          memberMessageContent('bob', 'sync at two'),
          'utf8',
        ),
      }),
    ).rejects.toThrow(ManagedSessionConflictError);
    expect(sentToHead(lead, 'run-alice')).toHaveLength(1);
  });

  it('sends a member message to the head of a continued member chain (R1-5)', async () => {
    const lead = await leadWithMembers(['alice']);
    await lead.children.settleCompleted('run-alice', {
      result: Buffer.from('done'),
      receipt: Buffer.from('{}'),
      messageCount: 0,
    });
    // The leader continues alice: the roster entry still roots at
    // run-alice, but the chain head is the continuation run.
    const continued = await lead.children.sendToChild({
      taskId: lead.children.taskIdOf('run-alice'),
      text: 'back to the board',
      messageId: 'msg_cont_1',
      continuationRunId: 'run-alice-2',
      executionCallId: 'cont-x',
      closing: false,
    });
    expect(continued.kind).toBe('continuation');
    const commandId = commandIdOf('call-msg-chain');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', message: 'sync' },
    });
    expect(reply).toEqual({
      outcome: 'answered',
      text: 'Message sent to alice.\n- alice: sent.',
    });
    const entry = lead.session.authority.extensionRecord(
      'session_message',
      memberMessageIdOf(commandId, 2),
    );
    expect(entry).toBeDefined();
    expect(parseSessionMessage(entry!.record).childRunId).toBe('run-alice-2');
  });

  it('fans a member message out with "*", the sender never a recipient', async () => {
    const lead = await leadWithMembers(['alice', 'carol']);
    const commandId = commandIdOf('call-msg-2');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: '*', message: 'sync at noon' },
    });
    expect(reply).toEqual({
      outcome: 'answered',
      text: 'Message sent to every other member of team "review".\n- alice: sent.\n- carol: sent.',
    });
    expect(sentToHead(lead, 'run-alice')).toHaveLength(1);
    expect(sentToHead(lead, 'run-carol')).toHaveLength(1);
    expect(sentToHead(lead, LEAF_RUN)).toHaveLength(0);
    expect(
      lead.session.authority.extensionRecordsInDomain('session_message'),
    ).toHaveLength(2);
  });

  it('reaches the members it can when a broadcast finds one finished (R1-7)', async () => {
    const lead = await leadWithMembers(['alice', 'carol']);
    await lead.children.settleCompleted('run-carol', {
      result: Buffer.from('done'),
      receipt: Buffer.from('{}'),
      messageCount: 0,
    });
    const commandId = commandIdOf('call-msg-partial');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: '*', message: 'sync at noon' },
    });
    expect(reply).toEqual({
      outcome: 'answered',
      text: 'Message sent to 1 of 2 other members of team "review":\n- alice: sent.\n- carol: not reached: it has finished; the leader may give it more work, a peer cannot.',
    });
    expect(sentToHead(lead, 'run-alice')).toHaveLength(1);
    expect(sentToHead(lead, 'run-carol')).toHaveLength(0);
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
  });

  it('names what a finished or ended recipient cannot take', async () => {
    const lead = await leadWithMembers(['alice', 'carol']);
    await lead.children.settleCompleted('run-alice', {
      result: Buffer.from('done'),
      receipt: Buffer.from('{}'),
      messageCount: 0,
    });
    await lead.children.settleCancelled('run-carol', { started: true });
    const commandId = commandIdOf('call-msg-3');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: '*', message: 'wrap up' },
    });
    expect(reply).toEqual({
      outcome: 'refused',
      text: 'The message reached no member of team "review":\n- alice: not reached: it has finished; the leader may give it more work, a peer cannot.\n- carol: not reached: it has ended.',
    });
    expect(
      lead.session.authority.extensionRecordsInDomain('session_message'),
    ).toHaveLength(0);
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
  });

  it('names what a stopping recipient cannot take', async () => {
    const lead = await leadWithMembers(['alice']);
    await lead.children.requestStop('run-alice');
    const commandId = commandIdOf('call-msg-stop');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', message: 'one last thing' },
    });
    expect(reply).toEqual({
      outcome: 'refused',
      text: 'The message was not sent:\n- alice: not reached: it is being stopped.',
    });
    expect(sentToHead(lead, 'run-alice')).toHaveLength(0);
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
  });

  it('names what a member that completed after a stop cannot take (R1-3)', async () => {
    const lead = await leadWithMembers(['alice']);
    await lead.children.requestStop('run-alice');
    await lead.children.settleCompleted('run-alice', {
      result: Buffer.from('done'),
      receipt: Buffer.from('{}'),
      messageCount: 0,
    });
    const commandId = commandIdOf('call-msg-stop-done');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', message: 'one last thing' },
    });
    expect(reply).toEqual({
      outcome: 'refused',
      text: 'The message was not sent:\n- alice: not reached: it completed after a stop was requested; for more work, the leader can launch a new member under a new name — a peer cannot reach it.',
    });
    expect(sentToHead(lead, 'run-alice')).toHaveLength(0);
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
  });

  it('refuses the stranger, the reserved names and the sender itself', async () => {
    const lead = await leadWithMembers(['alice']);
    for (const [to, text] of [
      ['zed', '"zed" is not a member of team "review". Members: bob, alice.'],
      [
        'leader',
        '"leader" is not a member of team "review". Members: bob, alice.',
      ],
      [
        'parent',
        '"parent" is not a member of team "review". Members: bob, alice.',
      ],
      ['bob', 'A member cannot send a message to itself.'],
    ] as const) {
      const reply = await lead.commands.execute(lead.teams, {
        commandId: commandIdOf(`call-msg-4-${to}`),
        kind: 'member_message',
        childRunId: LEAF_RUN,
        senderSessionId: CHILD,
        args: { to, message: 'hi' },
      });
      expect(reply).toEqual({ outcome: 'refused', text });
    }
    // An address that sanitizes to nothing quotes itself, never a roster
    // guess (R1-1).
    const wild = await lead.commands.execute(lead.teams, {
      commandId: commandIdOf('call-msg-4-wild'),
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: '***', message: 'hi' },
    });
    expect(wild.outcome).toBe('refused');
    expect(wild.text).toContain('sanitizes to an empty string');
    expect(wild.text).not.toContain(' is not a member');
    expect(
      lead.session.authority.extensionRecordsInDomain('session_message'),
    ).toHaveLength(0);
    const only = await leadWithTeam();
    const reply = await only.commands.execute(only.teams, {
      commandId: commandIdOf('call-msg-4-star'),
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: '*', message: 'hi' },
    });
    expect(reply).toEqual({
      outcome: 'refused',
      text: 'Team "review" has no other members to message.',
    });
  });

  it('refuses the argument shape and the byte bound', async () => {
    const lead = await leadWithMembers(['alice']);
    for (const args of [
      {},
      { to: 'alice' },
      { to: 'alice', message: '  ' },
      { to: '', message: 'hi' },
    ]) {
      const reply = await lead.commands.execute(lead.teams, {
        commandId: commandIdOf(`call-msg-5-${JSON.stringify(args)}`),
        kind: 'member_message',
        childRunId: LEAF_RUN,
        senderSessionId: CHILD,
        args,
      });
      expect(reply).toEqual({
        outcome: 'refused',
        text: 'A member message takes a nonempty "to" and "message".',
      });
    }
    const reply = await lead.commands.execute(lead.teams, {
      commandId: commandIdOf('call-msg-5-big'),
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', message: 'x'.repeat(33 * 1024) },
    });
    expect(reply.outcome).toBe('refused');
    expect(reply.text).toContain('byte_limit');
    // The raw address just fits the args envelope, but the stranger
    // refusal that quotes it outgrows the reply cap and must be cut (R1-1).
    const oversizedCommandId = commandIdOf('call-msg-5-long-to');
    const cut = await lead.commands.execute(lead.teams, {
      commandId: oversizedCommandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'a'.repeat(64 * 1024 - 32), message: 'hi' },
    });
    expect(cut.outcome).toBe('refused');
    expect(cut.text).toContain(
      'the reply grew past its size limit and was cut',
    );
    expect(Buffer.byteLength(JSON.stringify(cut), 'utf8')).toBeLessThanOrEqual(
      MANAGED_SESSION_COMMAND_LIMITS.maxReplyBytes,
    );
    expect(lead.commands.command(oversizedCommandId)?.direction).toBe(
      'inbound',
    );
    expect(
      lead.session.authority.extensionRecordsInDomain('session_message'),
    ).toHaveLength(0);
    // A legal-size address doubling through JSON must still answer its
    // refusal inside one storable receipt (R2-1).
    const escapedCommandId = commandIdOf('call-msg-5-escape');
    const escaped = await lead.commands.execute(lead.teams, {
      commandId: escapedCommandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'a\\'.repeat(21828), message: 'hi' },
    });
    expect(escaped.outcome).toBe('refused');
    expect(escaped.text).toContain(
      'the reply grew past its size limit and was cut',
    );
    expect(
      Buffer.byteLength(JSON.stringify(escaped), 'utf8'),
    ).toBeLessThanOrEqual(MANAGED_SESSION_COMMAND_LIMITS.maxReplyBytes);
    expect(lead.commands.command(escapedCommandId)?.direction).toBe('inbound');
    // The old receipt-store throw left existingReply empty; the replay
    // must now return the committed reply identically.
    await expect(
      lead.commands.execute(lead.teams, {
        commandId: escapedCommandId,
        kind: 'member_message',
        childRunId: LEAF_RUN,
        senderSessionId: CHILD,
        args: { to: 'a\\'.repeat(21828), message: 'hi' },
      }),
    ).resolves.toEqual(escaped);
  });

  it('probes the sends an earlier execution committed and sends only the rest', async () => {
    const lead = await leadWithMembers(['alice', 'carol']);
    const commandId = commandIdOf('call-msg-6');
    // A first execution died after sending to alice and before its receipt.
    await lead.children.sendToRunningMember({
      rootChildRunId: 'run-alice',
      content: Buffer.from(memberMessageContent('bob', 'sync at noon'), 'utf8'),
      messageId: memberMessageIdOf(commandId, 2),
      executionCallId: commandId,
    });
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: '*', message: 'sync at noon' },
    });
    expect(reply).toEqual({
      outcome: 'answered',
      text: 'Message sent to every other member of team "review".\n- alice: sent.\n- carol: sent.',
    });
    expect(sentToHead(lead, 'run-alice')).toHaveLength(1);
    expect(sentToHead(lead, 'run-carol')).toHaveLength(1);
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
  });

  it('reports the sends of a team that changed before re-execution', async () => {
    const lead = await leadWithMembers(['alice']);
    const commandId = commandIdOf('call-msg-7');
    await lead.children.sendToRunningMember({
      rootChildRunId: 'run-alice',
      content: Buffer.from(memberMessageContent('bob', 'hi'), 'utf8'),
      messageId: memberMessageIdOf(commandId, 2),
      executionCallId: commandId,
    });
    // The settlement holds while the message owes its handover (H4d-b):
    // hand it over and mark it accepted first.
    const relay = leadRelay(lead);
    const messageId = memberMessageIdOf(commandId, 2);
    await relay.handover(messageId, attachedSessionOf(lead, 'run-alice'));
    await relay.accepted(messageId, sessionMessageInputId(messageId));
    await lead.children.settleCompleted('run-alice', {
      result: Buffer.from('done'),
      receipt: Buffer.from('{}'),
      messageCount: 1,
    });
    await lead.children.settleCompleted(LEAF_RUN, {
      result: Buffer.from('done bob'),
      receipt: Buffer.from('{}'),
      messageCount: 0,
    });
    await lead.teams.run('team_delete', {}, 'prompt:delete-team');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: '*', message: 'hi' },
    });
    expect(reply).toEqual({
      outcome: 'answered',
      text: 'The message was sent to 1 member before its team changed; nothing more was sent.',
    });
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
  });

  it('bounds member messages beside the shared edge limits', async () => {
    const lead = await leadWithMembers(['alice']);
    // 4 member messages in flight on alice's head fill decision 8's sub-cap.
    for (let i = 0; i < 4; i += 1) {
      const route = await lead.children.sendToRunningMember({
        rootChildRunId: 'run-alice',
        content: Buffer.from(memberMessageContent('bob', `note ${i}`), 'utf8'),
        messageId: memberMessageIdOf(commandIdOf(`cap-4-${i}`), 2),
        executionCallId: commandIdOf(`cap-4-${i}`),
      });
      expect(route).toEqual({ kind: 'sent' });
    }
    const capped = await lead.commands.execute(lead.teams, {
      commandId: commandIdOf('cap-4-next'),
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', message: 'one more' },
    });
    expect(capped).toEqual({
      outcome: 'refused',
      text: 'The message was not sent:\n- alice: not reached: it has 4 member messages still on their way (count_limit); wait for them to arrive.',
    });
    // Drain the 4 member messages (accepted is not in flight any more),
    // then pile 8 plain H4d-b sends: the shared in-flight cap fires next.
    const relay = leadRelay(lead);
    for (let i = 0; i < 4; i += 1) {
      const messageId = memberMessageIdOf(commandIdOf(`cap-4-${i}`), 2);
      await relay.handover(messageId, attachedSessionOf(lead, 'run-alice'));
      await relay.accepted(messageId, sessionMessageInputId(messageId));
    }
    for (let i = 0; i < 8; i += 1) {
      await lead.children.sendToChild({
        taskId: lead.children.taskIdOf('run-alice'),
        text: `plain ${i}`,
        messageId: `msg_plain_${i}`,
        continuationRunId: `cont_plain_${i}`,
        executionCallId: `plain-${i}`,
        closing: false,
      });
    }
    const shared = await lead.commands.execute(lead.teams, {
      commandId: commandIdOf('cap-8-next'),
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', message: 'again' },
    });
    expect(shared).toEqual({
      outcome: 'refused',
      text: 'The message was not sent:\n- alice: not reached: it has 8 messages still on their way to it (count_limit); wait for them to arrive.',
    });
  });

  it('holds the 16-in-all member cap once the edge drained', async () => {
    const lead = await leadWithMembers(['alice']);
    const store = {
      authority: lead.session.authority,
      resources: lead.session.resources,
    };
    const messages = new HostedSessionMessageSession(
      store as never,
      lead.session.authority.sessionHeader.sessionKey,
      lead.children,
      undefined,
    );
    // 16 member messages land and their turns settle: in flight drains,
    // the per-run total still counts.
    for (let i = 0; i < 16; i += 1) {
      const messageId = memberMessageIdOf(commandIdOf(`cap-16-${i}`), 2);
      const route = await lead.children.sendToRunningMember({
        rootChildRunId: 'run-alice',
        content: Buffer.from(memberMessageContent('bob', `note ${i}`), 'utf8'),
        messageId,
        executionCallId: commandIdOf(`cap-16-${i}`),
      });
      expect(route).toEqual({ kind: 'sent' });
      await messages.handover(messageId, attachedSessionOf(lead, 'run-alice'));
      await messages.accepted(messageId, sessionMessageInputId(messageId));
      await messages.settle(messageId, 'consumed');
    }
    const reply = await lead.commands.execute(lead.teams, {
      commandId: commandIdOf('cap-16-next'),
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', message: 'one more' },
    });
    expect(reply).toEqual({
      outcome: 'refused',
      text: 'The message was not sent:\n- alice: not reached: it has received the 16 member messages one run may hold (budget_exhausted).',
    });
  });

  it("counts the lead's plain sends toward the run's 64-message budget (R1-6)", async () => {
    const lead = await leadWithMembers(['alice']);
    const relay = leadRelay(lead);
    // 64 plain sends fill H4d-b's per-run budget; each is accepted at
    // once, so the shared in-flight window never nears its 8.
    for (let i = 0; i < 64; i += 1) {
      const messageId = `msg_plain_${i}`;
      const route = await lead.children.sendToChild({
        taskId: lead.children.taskIdOf('run-alice'),
        text: `plain work ${i}`,
        messageId,
        continuationRunId: `cont_plain_${i}`,
        executionCallId: `plain-${i}`,
        closing: false,
      });
      expect(route.kind).toBe('message');
      await relay.handover(messageId, attachedSessionOf(lead, 'run-alice'));
      await relay.accepted(messageId, sessionMessageInputId(messageId));
    }
    const commandId = commandIdOf('cap-64-next');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', message: 'one more' },
    });
    expect(reply).toEqual({
      outcome: 'refused',
      text: 'The message was not sent:\n- alice: not reached: it has received its 64 messages (budget_exhausted).',
    });
    expect(
      lead.session.authority.extensionRecord(
        'session_message',
        memberMessageIdOf(commandId, 2),
      ),
    ).toBeUndefined();
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
  });

  it('counts only member messages toward the member in-flight sub-cap (R1-6)', async () => {
    const lead = await leadWithMembers(['alice']);
    // 4 plain sends occupy the shared window but not the msgc_ sub-cap.
    for (let i = 0; i < 4; i += 1) {
      await lead.children.sendToChild({
        taskId: lead.children.taskIdOf('run-alice'),
        text: `plain work ${i}`,
        messageId: `msg_plain_${i}`,
        continuationRunId: `cont_plain_${i}`,
        executionCallId: `plain-${i}`,
        closing: false,
      });
    }
    const reply = await lead.commands.execute(lead.teams, {
      commandId: commandIdOf('call-msg-prefix'),
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', message: 'one more' },
    });
    expect(reply).toEqual({
      outcome: 'answered',
      text: 'Message sent to alice.\n- alice: sent.',
    });
  });

  it("answers a re-execution from the command's own committed writes", async () => {
    const lead = await leadWithTeam();
    const commandId = commandIdOf('call-16');
    // Half-applied: the derived create landed before any receipt did.
    await lead.teams.memberTaskCreate(commandId, TASK_CREATE_ARGS);
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'board_write',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: TASK_CREATE_ARGS,
    });
    expect(reply).toEqual({
      outcome: 'answered',
      text: 'Task #1 created: "ship the fix"',
    });
    expect(
      lead.session.authority.extensionRecordsInDomain('team_task'),
    ).toHaveLength(1);
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
  });

  it('refuses a member message from a run that ended, with the fixed sentence (R1-6)', async () => {
    const lead = await leadWithMembers(['alice']);
    await lead.children.settleCompleted(LEAF_RUN, {
      result: Buffer.from('done', 'utf8'),
      receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
    });
    const commandId = commandIdOf('call-msg-ended');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', message: 'sync' },
    });
    expect(reply).toEqual({
      outcome: 'refused',
      text: 'Your run has ended or is being stopped; it takes no more team commands.',
    });
    expect(sentToHead(lead, 'run-alice')).toHaveLength(0);
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
  });

  it('refuses a fresh command from a run that ended, with the fixed sentence', async () => {
    const lead = await leadWithTeam();
    await lead.children.settleCompleted(LEAF_RUN, {
      result: Buffer.from('done', 'utf8'),
      receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
    });
    const reply = await lead.commands.execute(lead.teams, {
      commandId: commandIdOf('call-17'),
      kind: 'board_write',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: TASK_CREATE_ARGS,
    });
    expect(reply).toEqual({
      outcome: 'refused',
      text: 'Your run has ended or is being stopped; it takes no more team commands.',
    });
    expect(
      lead.session.authority.extensionRecordsInDomain('team_task'),
    ).toHaveLength(0);
  });
});
