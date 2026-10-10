/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  parseTeamState,
  parseTeamTask,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import {
  HostedTeamRefusal,
  HostedTeamSession,
  hostedTeamArgumentError,
  type HostedTeamStore,
} from './hosted-team-session.js';

// H4e-b1: team_state and team_task are registered but not enabled for
// submission until the physical acceptance pass, so this suite lifts the
// domain gate for the team domains only, as the H4e-a authority suite does.
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
        if (!(domain.startsWith('team_') && enablement.teams))
          actual.assertManagedSessionDomainEnabled(domain);
      },
    };
  },
);

let root: string;
let session: ManagedSession;
let children: HostedChildAgentSession;
let teams: HostedTeamSession;
let sessionKey: { tenantId: string; workspaceId: string; sessionId: string };

beforeEach(async () => {
  enablement.teams = true;
  root = await mkdtemp(path.join(tmpdir(), 'hosted-team-'));
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

async function launch(childRunId: string): Promise<void> {
  await children.admit({
    childRunId,
    ownerScopeId: sessionKey.sessionId,
    rootSessionId: sessionKey.sessionId,
    completion: 'sent',
    description: 'audit',
    prompt: 'review the change',
    definition: {
      definitionId: 'hosted-agent/test',
      definitionRevision: 1,
      definitionDigest: session.authority.sessionHeader.definitionRef.digest,
    },
    workingDirectory: '.',
    executionCallId: childRunId,
  });
}

async function settle(childRunId: string): Promise<void> {
  await children.dispatchStarted(childRunId, {
    dispatchId: `dispatch-${childRunId}`,
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  await children.attach(childRunId, `session-${childRunId}`);
  await children.settleCompleted(childRunId, {
    result: Buffer.from('done', 'utf8'),
    receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
  });
}

async function refusal(work: Promise<unknown>): Promise<string> {
  const error = await work.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(HostedTeamRefusal);
  return (error as Error).message;
}

async function createTeam(callKey = 'prompt:call-team'): Promise<void> {
  await teams.run('team_create', { team_name: 'Review' }, callKey);
}

/** A member launched and joined, as the agent tool does it. */
async function addMember(name: string, childRunId = `run-${name}`) {
  const member = teams.admitMember(name);
  await launch(childRunId);
  expect(await teams.join({ ...member, childRunId })).toEqual({
    joined: true,
  });
}

function revisions(domain: 'team_state' | 'team_task', recordId: string) {
  return session.authority.extensionRecord(domain, recordId)?.revision;
}

describe('team lifecycle', () => {
  it('opens one team named in the Legacy form, keyed by its call', async () => {
    expect(
      await teams.run(
        'team_create',
        { team_name: 'Code Review!' },
        'prompt:call-1',
      ),
    ).toBe('Team "code-review" created.');
    expect(teams.team('prompt:call-1')).toMatchObject({
      name: 'code-review',
      leadSessionId: sessionKey.sessionId,
      lifecycle: 'active',
      members: [],
    });
    // The replay of the same call finds its team instead of a second one.
    expect(
      await teams.run(
        'team_create',
        { team_name: 'Code Review!' },
        'prompt:call-1',
      ),
    ).toBe('Team "code-review" created.');
    expect(
      session.authority.extensionRecordsInDomain('team_state'),
    ).toHaveLength(1);
    expect(
      await refusal(
        teams.run('team_create', { team_name: 'other' }, 'prompt:call-2'),
      ),
    ).toBe('A team is already active. Delete it before creating a new one.');
    expect(
      await refusal(
        teams.run('team_create', { team_name: '!!!' }, 'prompt:call-3'),
      ),
    ).toBe('Team name is required.');
  });

  it('refuses team_delete while a member runs, then closes and deletes', async () => {
    await createTeam();
    await addMember('alice');
    expect(
      await refusal(teams.run('team_delete', {}, 'prompt:del-1')),
    ).toContain('still has running members: alice');
    expect(teams.openTeam()?.lifecycle).toBe('active');
    await settle('run-alice');
    expect(await teams.run('team_delete', {}, 'prompt:del-2')).toBe(
      'Team "review" deleted.',
    );
    const deleted = teams.team('prompt:call-team')!;
    expect(deleted).toMatchObject({ lifecycle: 'deleted' });
    expect(deleted.run.state).toBe('cancelled');
    // Opening, join, closing, deleted.
    expect(revisions('team_state', 'prompt:call-team')).toBe(4);
    expect(teams.openTeam()).toBeUndefined();
    // The replay answers what its call committed; another call finds no team.
    expect(await teams.run('team_delete', {}, 'prompt:del-2')).toBe(
      'Team "review" deleted.',
    );
    expect(revisions('team_state', 'prompt:call-team')).toBe(4);
    expect(await refusal(teams.run('team_delete', {}, 'prompt:del-3'))).toBe(
      'No active team to delete.',
    );
    await teams.run('team_create', { team_name: 'next' }, 'prompt:call-next');
    expect(teams.openTeam()?.name).toBe('next');
  });

  it('finishes a team that a stopped team_delete left closing', async () => {
    await createTeam();
    const store = {
      authority: session.authority,
      resources: session.resources,
    } as HostedTeamStore;
    const failing = new HostedTeamSession(
      {
        ...store,
        authority: Object.create(session.authority, {
          commitExtensionRecord: {
            value: async (
              ...args: Parameters<
                HostedTeamStore['authority']['commitExtensionRecord']
              >
            ) => {
              if (args[0].commandId.endsWith(':deleted'))
                throw new Error('store unavailable');
              return session.authority.commitExtensionRecord(...args);
            },
          },
        }),
      },
      sessionKey,
    );
    await expect(failing.run('team_delete', {}, 'prompt:del')).rejects.toThrow(
      'store unavailable',
    );
    expect(teams.openTeam()?.lifecycle).toBe('closing');
    expect(teams.admitMember.bind(teams, 'bob')).toThrow(/closing/);
    // A later team_delete finishes it, and that call's replay answers so.
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await teams.run('team_delete', {}, 'prompt:del-later')).toBe(
        'Team "review" deleted.',
      );
    expect(revisions('team_state', 'prompt:call-team')).toBe(3);
    // The stopped call's own replay finds the team it closed now deleted.
    expect(await teams.run('team_delete', {}, 'prompt:del')).toBe(
      'Team "review" deleted.',
    );
    expect(revisions('team_state', 'prompt:call-team')).toBe(3);
  });
});

describe('members', () => {
  it('admits a member only into an active team, by a free sanitized name', async () => {
    expect(() => teams.admitMember('alice')).toThrow(/team_create first/);
    await createTeam();
    expect(teams.admitMember('Alice Smith')).toEqual({
      teamId: 'prompt:call-team',
      teamName: 'review',
      name: 'alice-smith',
    });
    expect(() => teams.admitMember('Leader')).toThrow(/reserved/);
    expect(() => teams.admitMember('***')).toThrow(/empty string/);
    expect(() => teams.admitMember('a'.repeat(65))).toThrow(/64 characters/);
    await addMember('alice');
    expect(() => teams.admitMember('ALICE')).toThrow(
      'A teammate named "alice" already exists in this team (existing: alice). Choose a different name.',
    );
  });

  it('counts members over the team life against the cap of 10', async () => {
    await createTeam();
    for (let index = 0; index < 10; index++) {
      await addMember(`member-${index}`);
      await settle(`run-member-${index}`);
    }
    expect(() => teams.admitMember('eleventh')).toThrow(/already has 10/);
  });

  it('joins once, and a run that ended first never joins', async () => {
    await createTeam();
    await addMember('alice');
    expect(
      await teams.join({
        teamId: 'prompt:call-team',
        name: 'alice',
        childRunId: 'run-alice',
      }),
    ).toEqual({ joined: true });
    expect(revisions('team_state', 'prompt:call-team')).toBe(2);
    expect(teams.membership('run-alice')).toEqual({
      teamId: 'prompt:call-team',
      teamName: 'review',
      name: 'alice',
    });
    const member = teams.admitMember('bob');
    await launch('run-bob');
    await children.settleFailed('run-bob', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    const joined = await teams.join({ ...member, childRunId: 'run-bob' });
    expect('ended' in joined && joined.ended.stopReason).toBe(
      'creation_failed',
    );
    expect(teams.membership('run-bob')).toBeUndefined();
    expect(teams.admitMember('bob').name).toBe('bob');
  });
});

describe('the board', () => {
  it('numbers tasks one past the highest, deleted ones included', async () => {
    await createTeam();
    for (const subject of ['one', 'two', 'three'])
      await teams.run(
        'task_create',
        { subject, description: `do ${subject}` },
        `prompt:create-${subject}`,
      );
    expect(
      await teams.run(
        'task_update',
        { taskId: '#3', status: 'deleted' },
        'prompt:delete-3',
      ),
    ).toBe('Task #3 deleted.');
    expect(
      await teams.run(
        'task_create',
        { subject: 'four', description: 'do four', activeForm: 'Doing four' },
        'prompt:create-four',
      ),
    ).toBe('Task #4 created: "four"');
    // A replay answers the task it created, not a fifth one.
    expect(
      await teams.run(
        'task_create',
        { subject: 'four', description: 'do four', activeForm: 'Doing four' },
        'prompt:create-four',
      ),
    ).toBe('Task #4 created: "four"');
    const task = parseTeamTask(
      session.authority.extensionRecord('team_task', 'prompt:call-team#4')!
        .record,
    );
    expect(task).toMatchObject({ number: 4, activeForm: 'Doing four' });
    expect(
      JSON.parse(
        (await session.resources.read(task.descriptionRef)).toString('utf8'),
      ),
    ).toEqual({ text: 'do four' });
    expect(
      await refusal(
        teams.run('task_update', { taskId: '3', subject: 'x' }, 'prompt:u'),
      ),
    ).toBe('Task #3 not found.');
    expect(
      await refusal(teams.run('task_update', { taskId: 'three' }, 'prompt:u')),
    ).toBe('Invalid task ID "three". Task IDs must be positive integers.');
  });

  it('assigns owners among the leader and running members', async () => {
    await createTeam();
    await addMember('alice');
    await addMember('bob');
    await settle('run-bob');
    await teams.run(
      'task_create',
      { subject: 'audit', description: 'audit it' },
      'prompt:create',
    );
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress' },
          'prompt:u1',
        ),
      ),
    ).toContain('without an owner');
    expect(
      await refusal(
        teams.run('task_update', { taskId: '1', owner: 'carol' }, 'prompt:u2'),
      ),
    ).toContain('not a member');
    expect(
      await refusal(
        teams.run('task_update', { taskId: '1', owner: 'bob' }, 'prompt:u3'),
      ),
    ).toBe('Member "bob" has finished and cannot own a task.');
    const assigned = await teams.run(
      'task_update',
      { taskId: '1', status: 'in_progress', owner: 'Alice' },
      'prompt:u4',
    );
    expect(assigned).toContain(
      'Task #1 updated (status: in_progress, owner: alice).',
    );
    expect(assigned).toContain('"alice" was not notified');
    expect(
      await refusal(
        teams.run('task_update', { taskId: '1', owner: '' }, 'prompt:u5'),
      ),
    ).toContain('without an owner');
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', owner: 'leader' },
        'prompt:u6',
      ),
    ).toBe('Task #1 updated (status: in_progress, owner: leader).');
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', status: 'pending', owner: '' },
        'prompt:u7',
      ),
    ).toBe('Task #1 updated (status: pending).');
  });

  it('keeps an ended owner, so the lead completes, edits or deletes its task', async () => {
    await createTeam();
    await addMember('alice');
    for (const subject of ['audit', 'fix'])
      await teams.run(
        'task_create',
        { subject, description: subject },
        `prompt:create-${subject}`,
      );
    for (const taskId of ['1', '2'])
      await teams.run(
        'task_update',
        { taskId, status: 'in_progress', owner: 'alice' },
        `prompt:assign-${taskId}`,
      );
    await settle('run-alice');
    expect(
      await teams.run(
        'task_update',
        {
          taskId: '1',
          status: 'completed',
          subject: 'audited',
          owner: 'alice',
        },
        'prompt:done',
      ),
    ).toContain('Task #1 updated (status: completed, owner: alice).');
    expect(
      await teams.run(
        'task_update',
        { taskId: '2', status: 'deleted' },
        'prompt:drop',
      ),
    ).toBe('Task #2 deleted.');
    // Only a new owner must be running: handing the task back is refused.
    await teams.run(
      'task_update',
      { taskId: '1', owner: 'leader' },
      'prompt:to-leader',
    );
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', owner: 'alice' },
          'prompt:back',
        ),
      ),
    ).toBe('Member "alice" has finished and cannot own a task.');
  });

  it('commits no revision for an update that changes nothing', async () => {
    await createTeam();
    await teams.run(
      'task_create',
      { subject: 'audit', description: 'audit it' },
      'prompt:create',
    );
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', status: 'pending', subject: 'audit' },
        'prompt:same',
      ),
    ).toBe('Task #1 updated (status: pending).');
    expect(revisions('team_task', 'prompt:call-team#1')).toBe(1);
  });

  it('merges metadata by key and deletes a key set to null', async () => {
    await createTeam();
    await teams.run(
      'task_create',
      { subject: 'audit', description: 'audit it', metadata: { a: 1, b: 2 } },
      'prompt:create',
    );
    await teams.run(
      'task_update',
      {
        taskId: '1',
        // Parsed, as tool arguments are, so the unsafe keys are own keys.
        metadata: JSON.parse(
          '{"b":null,"c":3,"__proto__":{"x":1},"constructor":1,"prototype":2}',
        ),
      },
      'prompt:meta',
    );
    const task = () =>
      parseTeamTask(
        session.authority.extensionRecord('team_task', 'prompt:call-team#1')!
          .record,
      );
    expect(
      JSON.parse(
        (await session.resources.read(task().metadataRef!)).toString('utf8'),
      ),
    ).toEqual({ a: 1, c: 3 });
    await teams.run(
      'task_update',
      { taskId: '1', metadata: { a: null, c: null } },
      'prompt:meta-2',
    );
    expect(task().metadataRef).toBeNull();
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', metadata: { big: 'x'.repeat(33 * 1024) } },
          'prompt:meta-3',
        ),
      ),
    ).toMatch(/^Task metadata is too large \(\d+ bytes; max 32768\)\.$/);
  });

  it('stores each dependency once and derives what still blocks', async () => {
    await createTeam();
    for (const subject of ['one', 'two', 'three'])
      await teams.run(
        'task_create',
        { subject, description: subject },
        `prompt:create-${subject}`,
      );
    expect(
      await refusal(
        teams.run('task_update', { taskId: '1', addBlocks: ['1'] }, 'prompt:e'),
      ),
    ).toContain('cannot block or be blocked by itself');
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', addBlockedBy: ['7', '9'] },
          'prompt:e',
        ),
      ),
    ).toBe('Cannot update task #1: referenced tasks #7, #9 not found.');
    await teams.run(
      'task_update',
      { taskId: '1', addBlocks: ['2'], addBlockedBy: ['3'] },
      'prompt:edges',
    );
    expect(
      parseTeamTask(
        session.authority.extensionRecord('team_task', 'prompt:call-team#2')!
          .record,
      ).blockedBy,
    ).toEqual(['prompt:call-team#1']);
    expect(
      parseTeamTask(
        session.authority.extensionRecord('team_task', 'prompt:call-team#1')!
          .record,
      ).blockedBy,
    ).toEqual(['prompt:call-team#3']);
    expect(
      await refusal(
        teams.run('task_update', { taskId: '2', addBlocks: ['3'] }, 'prompt:c'),
      ),
    ).toBe(
      'Cannot update task #2: this would create a dependency cycle (#2 → #3 → #1 → #2).',
    );
    expect(await teams.run('task_list', {}, 'prompt:list')).toBe(
      [
        '#1 [pending] — one (blocked by #3)',
        '#2 [pending] — two (blocked by #1)',
        '#3 [pending] — three',
        '',
        '--- Team "review" members ---',
        'No members yet.',
      ].join('\n'),
    );
    const dependentRevision = revisions('team_task', 'prompt:call-team#2');
    await teams.run(
      'task_update',
      { taskId: '3', status: 'completed' },
      'prompt:done-3',
    );
    expect(
      await teams.run('task_list', { blockedBy: '#1' }, 'prompt:list'),
    ).toContain('#2 [pending] — two (blocked by #1)');
    await teams.run(
      'task_update',
      { taskId: '1', status: 'completed' },
      'prompt:done-1',
    );
    // Completing a blocker writes nothing to the task it blocked.
    expect(revisions('team_task', 'prompt:call-team#2')).toBe(
      dependentRevision,
    );
    expect(
      await teams.run('task_list', { blockedBy: '1' }, 'prompt:list'),
    ).toBe(
      [
        'No tasks found.',
        '',
        '--- Team "review" members ---',
        'No members yet.',
      ].join('\n'),
    );
  });

  it('refuses a dependency that would grow a task past 64 blockers', async () => {
    await createTeam();
    for (let index = 1; index <= 67; index++)
      await teams.run(
        'task_create',
        { subject: `task ${index}`, description: 'd' },
        `prompt:create-${index}`,
      );
    const first64 = Array.from({ length: 64 }, (_, index) => `${index + 2}`);
    await teams.run(
      'task_update',
      { taskId: '1', addBlockedBy: first64 },
      'prompt:full',
    );
    expect(
      await refusal(
        teams.run('task_update', { taskId: '1', addBlockedBy: ['66'] }, 'p:a'),
      ),
    ).toBe('Cannot update task #1: task #1 would have more than 64 blockers.');
    // The addBlocks arm grows the other task: refused before task #67
    // itself is revised.
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '67', status: 'completed', addBlocks: ['1'] },
          'p:b',
        ),
      ),
    ).toBe('Cannot update task #67: task #1 would have more than 64 blockers.');
    expect(revisions('team_task', 'prompt:call-team#67')).toBe(1);
    // An edge already stored is not counted twice.
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', addBlockedBy: ['2'] },
        'p:c',
      ),
    ).toContain('Task #1 updated');
  });

  it('finishes a call stopped part-way on replay without adding twice', async () => {
    await createTeam();
    for (const subject of ['one', 'two', 'three'])
      await teams.run(
        'task_create',
        { subject, description: subject },
        `prompt:create-${subject}`,
      );
    let commits = 0;
    const failing = new HostedTeamSession(
      {
        resources: session.resources,
        authority: Object.create(session.authority, {
          commitExtensionRecord: {
            value: async (
              ...args: Parameters<
                HostedTeamStore['authority']['commitExtensionRecord']
              >
            ) => {
              if (++commits === 2) throw new Error('store unavailable');
              return session.authority.commitExtensionRecord(...args);
            },
          },
        }),
      },
      sessionKey,
    );
    // The description is a fresh resource on every computation, so a replay
    // that rebuilt the committed revision would conflict under its command.
    const call = {
      taskId: '1',
      subject: 'first',
      description: 'do it first',
      addBlocks: ['2', '3'],
    };
    await expect(
      failing.run('task_update', call, 'prompt:edges'),
    ).rejects.toThrow('store unavailable');
    expect(revisions('team_task', 'prompt:call-team#1')).toBe(2);
    expect(revisions('team_task', 'prompt:call-team#2')).toBe(1);
    await teams.run('task_update', call, 'prompt:edges');
    await teams.run('task_update', call, 'prompt:edges');
    expect(revisions('team_task', 'prompt:call-team#1')).toBe(2);
    expect(revisions('team_task', 'prompt:call-team#2')).toBe(2);
    expect(revisions('team_task', 'prompt:call-team#3')).toBe(2);
    expect(
      parseTeamTask(
        session.authority.extensionRecord('team_task', 'prompt:call-team#3')!
          .record,
      ).blockedBy,
    ).toEqual(['prompt:call-team#1']);
  });

  it('lists the board with filters and the roster with run states', async () => {
    await createTeam();
    await addMember('alice');
    await addMember('bob');
    await settle('run-bob');
    await teams.run(
      'task_create',
      { subject: 'audit', description: 'a' },
      'prompt:c1',
    );
    await teams.run(
      'task_create',
      { subject: 'fix', description: 'f' },
      'prompt:c2',
    );
    await teams.run(
      'task_update',
      { taskId: '1', status: 'in_progress', owner: 'alice' },
      'prompt:u1',
    );
    expect(await teams.run('task_list', {}, 'prompt:l')).toBe(
      [
        '#1 [in_progress] @alice — audit',
        '#2 [pending] — fix',
        '',
        '--- Team "review" members ---',
        'alice: running',
        'bob: completed',
      ].join('\n'),
    );
    expect(
      await teams.run('task_list', { status: 'pending' }, 'prompt:l'),
    ).toMatch(/^#2 \[pending\] — fix\n/);
    expect(
      await teams.run('task_list', { owner: 'Alice' }, 'prompt:l'),
    ).toMatch(/^#1 \[in_progress\] @alice — audit\n/);
    expect(
      await refusal(teams.run('task_list', { owner: '***' }, 'prompt:l')),
    ).toContain('Cannot filter by owner');
  });

  it('opens new tasks only in an active team', async () => {
    expect(
      await refusal(
        teams.run('task_create', { subject: 's', description: 'd' }, 'p:1'),
      ),
    ).toBe('No active team. Create a team first.');
    expect(await refusal(teams.run('task_list', {}, 'p:2'))).toBe(
      'No active team. Create a team first.',
    );
  });
});

describe('argument shapes', () => {
  it('names the first malformed argument of each tool', () => {
    expect(hostedTeamArgumentError('team_create', { team_name: 'a' })).toBe(
      undefined,
    );
    expect(hostedTeamArgumentError('team_create', { description: 'x' })).toBe(
      'Hosted team_create received unsupported argument "description".',
    );
    expect(hostedTeamArgumentError('team_delete', {})).toBeUndefined();
    expect(
      hostedTeamArgumentError('task_create', {
        subject: 'line\nbreak',
        description: 'd',
      }),
    ).toBe('subject must be one line of at most 200 characters.');
    expect(
      hostedTeamArgumentError('task_create', {
        subject: 's',
        description: 'd'.repeat(10_001),
      }),
    ).toContain('description must be a string');
    expect(
      hostedTeamArgumentError('task_create', {
        subject: 's',
        description: 'd',
        metadata: [],
      }),
    ).toBe('metadata must be an object.');
    expect(
      hostedTeamArgumentError('task_update', { taskId: '1', status: 'done' }),
    ).toContain('status must be one of');
    expect(
      hostedTeamArgumentError('task_update', { taskId: '1', addBlocks: '2' }),
    ).toContain('addBlocks must be an array');
    expect(hostedTeamArgumentError('task_update', { taskId: 1 })).toBe(
      'taskId must be a string.',
    );
    expect(
      hostedTeamArgumentError('task_list', { status: 'deleted' }),
    ).toContain('status must be pending');
  });
});

it('rebuilds the team and its board from a reopened journal', async () => {
  await createTeam();
  await addMember('alice');
  await teams.run(
    'task_create',
    { subject: 'audit', description: 'audit it' },
    'prompt:create',
  );
  const before = session.authority.extensionRecordsInDomain('team_state');
  await session.close();
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
  });
  const reopened = new HostedTeamSession(
    { authority: session.authority, resources: session.resources },
    sessionKey,
  );
  expect(session.authority.extensionRecordsInDomain('team_state')).toEqual(
    before,
  );
  expect(parseTeamState(before[0]!.record).members).toHaveLength(1);
  expect(await reopened.run('task_list', {}, 'prompt:list')).toContain(
    '#1 [pending] — audit',
  );
});
