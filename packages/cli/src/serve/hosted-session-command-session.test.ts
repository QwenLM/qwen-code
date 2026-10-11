/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { sessionCommandId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-command-operations.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import {
  HostedSessionCommandSession,
  SessionCommandBlockedError,
  SessionCommandRefusalError,
} from './hosted-session-command-session.js';
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
  });

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

  it('refuses the kinds a later batch owns and commits the refusal', async () => {
    const lead = await leadWithTeam();
    const commandId = commandIdOf('call-15');
    const reply = await lead.commands.execute(lead.teams, {
      commandId,
      kind: 'member_message',
      childRunId: LEAF_RUN,
      senderSessionId: CHILD,
      args: { to: 'alice', text: 'hi' },
    });
    expect(reply.outcome).toBe('refused');
    expect(reply.text).toContain('not accepted yet');
    expect(lead.commands.command(commandId)?.direction).toBe('inbound');
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
