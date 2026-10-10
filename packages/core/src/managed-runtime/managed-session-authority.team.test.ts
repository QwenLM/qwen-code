/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import {
  LocalManagedSessionAuthority,
  ManagedSessionConflictError,
} from './managed-session-authority.js';
import {
  childAttachBody,
  childDispatchBody,
  childLaunchBody,
  childSettleCompletedBody,
} from './managed-child-operations.js';
import { type ChildAgentRun } from './managed-child-run-record.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import {
  type ManagedSessionDomain,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';
import { type TeamMember } from './managed-team-record.js';

// H4e-a: the four team domains are registered and checked but not enabled
// for submission. The flags below lift the domain gate for them (and the
// shell kind gate for one planting), so the suite runs the commit and
// rebuild paths ahead of enablement.
const enablement = vi.hoisted(() => ({ teams: true, shellKind: false }));

vi.mock('./managed-session-records.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-session-records.js')>();
  return {
    ...actual,
    assertManagedSessionDomainEnabled: (domain: string) => {
      if (!(domain.startsWith('team_') && enablement.teams)) {
        actual.assertManagedSessionDomainEnabled(
          domain as Parameters<
            typeof actual.assertManagedSessionDomainEnabled
          >[0],
        );
      }
    },
    assertManagedSessionChildRunKindEnabled: (kind: string) => {
      if (!(kind === 'shell' && enablement.shellKind)) {
        actual.assertManagedSessionChildRunKindEnabled(kind);
      }
    },
  };
});

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  enablement.teams = true;
  enablement.shellKind = false;
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};
const TEAM_DOMAINS = [
  'team_state',
  'team_task',
  'team_message',
  'team_plan',
] as const;

interface Harness {
  readonly runtimeBaseDir: string;
  readonly transcriptPath: string;
  readonly store: LocalManagedSessionResourceStore;
  commands: number;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-agent-'));
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(root, 'chats', `${sessionId}.jsonl`);
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  return {
    runtimeBaseDir,
    transcriptPath,
    store: LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    }),
    commands: 0,
  };
}

async function withAuthority<T>(
  harness: Harness,
  run: (authority: LocalManagedSessionAuthority) => Promise<T>,
  options: { create?: boolean } = {},
): Promise<T> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: harness.runtimeBaseDir,
    sessionId,
    transcriptPath: harness.transcriptPath,
  });
  try {
    const create =
      options.create === false
        ? undefined
        : {
            definitionRef: await harness.store.publish(
              'managed-definition',
              Buffer.from('{}', 'utf8'),
            ),
            rootSnapshotRef: await harness.store.publish(
              'managed-root',
              Buffer.from('{}', 'utf8'),
            ),
            createdBy: 'daemon',
          };
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources: harness.store,
      now: () => 1_000,
      ...(create === undefined ? {} : { create }),
    });
    return await run(authority);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

const TRUSTED = { class: 'trusted_entry' } as const;

interface Refs {
  readonly input: ManagedSessionDurableRef;
  readonly result: ManagedSessionDurableRef;
  readonly receipt: ManagedSessionDurableRef;
  readonly content: ManagedSessionDurableRef;
}

async function publishRefs(harness: Harness): Promise<Refs> {
  return {
    input: await harness.store.publish(
      'managed-input',
      Buffer.from('{"prompt":"review the diff"}', 'utf8'),
    ),
    result: await harness.store.publish(
      'managed-child-result',
      Buffer.from('{"summary":"clean"}', 'utf8'),
    ),
    receipt: await harness.store.publish(
      'managed-runtime-receipt',
      Buffer.from('{"outcome":"settled"}', 'utf8'),
    ),
    content: await harness.store.publish(
      'managed-team-content',
      Buffer.from('check the tests too', 'utf8'),
    ),
  };
}

/** A child run's revisions, from launch to its settled result. */
function childLife(
  refs: Refs,
  childRunId: string,
  childSessionId = `session-${childRunId}`,
): ChildAgentRun[] {
  const launched = childLaunchBody({
    childRunId,
    ownerScopeId: 'scope-main',
    rootSessionId: sessionId,
    completion: 'sent',
    inputRef: refs.input,
    workspaceMode: 'shared',
    workingDirectory: '.',
    executionCallId: `call-${childRunId}`,
    definition: {
      definitionId: 'agent-def-1',
      definitionRevision: 1,
      definitionDigest: 'f'.repeat(64),
    },
  });
  const dispatched = childDispatchBody(launched, {
    dispatchId: `dispatch-${childRunId}`,
    runtime: { runtimeBindingId: 'binding-1', generation: '1' },
  });
  const attached = childAttachBody(dispatched, { childSessionId });
  const settled = childSettleCompletedBody(attached, {
    resultRef: refs.result,
    terminalReceiptRef: refs.receipt,
  });
  return [launched, dispatched, attached, settled];
}

function commit(
  harness: Harness,
  authority: LocalManagedSessionAuthority,
  domain: ManagedSessionDomain,
  record: unknown,
) {
  harness.commands += 1;
  return authority.commitExtensionRecord(
    {
      operation: 'commitTeamRecord',
      commandId: `command-${harness.commands}`,
      sessionKey,
      contentDigest: 'd'.repeat(64),
    },
    { domain, record },
    TRUSTED,
  );
}

/** Commits the first `count` revisions of a child run. */
async function commitChild(
  harness: Harness,
  authority: LocalManagedSessionAuthority,
  life: readonly ChildAgentRun[],
  count: number,
): Promise<void> {
  for (const record of life.slice(0, count)) {
    await commit(harness, authority, 'child_run', record);
  }
}

function logical(state: string) {
  return {
    state,
    reason: null,
    definition: null,
    executionCallId: null,
    effectId: null,
    dispatchId: null,
    deliveryId: null,
    execution: null,
    runtime: null,
    delivery: null,
  };
}

const ALICE: TeamMember = {
  name: 'alice',
  childRunId: 'run-1',
  planModeRequired: false,
};
const BOB: TeamMember = {
  name: 'bob',
  childRunId: 'run-2',
  planModeRequired: true,
};

function team(
  members: readonly TeamMember[],
  lifecycle = 'active',
  overrides: Record<string, unknown> = {},
) {
  return {
    teamId: 'team-1',
    name: 'review-team',
    leadSessionId: sessionId,
    lifecycle,
    membershipRevision: members.length + 1,
    members,
    run: logical(lifecycle === 'deleted' ? 'cancelled' : 'admitted'),
    ...overrides,
  };
}

function task(refs: Refs, overrides: Record<string, unknown> = {}) {
  const status = (overrides['status'] as string | undefined) ?? 'pending';
  return {
    teamId: 'team-1',
    taskId: 'task-1',
    number: 1,
    subject: 'Audit the diff',
    descriptionRef: refs.content,
    activeForm: null,
    metadataRef: null,
    owner: null,
    status,
    blockedBy: [],
    run: logical(status === 'deleted' ? 'cancelled' : 'admitted'),
    ...overrides,
  };
}

function message(
  refs: Refs,
  state = 'planned',
  overrides: Record<string, unknown> = {},
) {
  const accepted = state === 'accepted' || state === 'consumed';
  return {
    teamId: 'team-1',
    messageId: 'message-1',
    kind: 'message',
    from: 'leader',
    to: 'alice',
    contentRef: refs.content,
    contentDigest: refs.content.digest,
    targetSessionId: state === 'planned' ? null : 'session-run-1',
    inputId: accepted ? 'message-1:input' : null,
    run: {
      ...logical('settled'),
      executionCallId: 'call-send-1',
      delivery: { target: 'session', state },
    },
    ...overrides,
  };
}

function plan(refs: Refs, overrides: Record<string, unknown> = {}) {
  return {
    teamId: 'team-1',
    requestId: 'request-1',
    member: 'bob',
    planRevision: 1,
    planRef: refs.content,
    decision: null,
    feedbackRef: null,
    run: logical('waiting'),
    ...overrides,
  };
}

/** A team with alice and bob, both attached and running. */
async function staffed(
  harness: Harness,
  authority: LocalManagedSessionAuthority,
  refs: Refs,
): Promise<void> {
  await commitChild(harness, authority, childLife(refs, 'run-1'), 3);
  await commitChild(harness, authority, childLife(refs, 'run-2'), 3);
  await commit(harness, authority, 'team_state', team([]));
  await commit(harness, authority, 'team_state', team([ALICE]));
  await commit(harness, authority, 'team_state', team([ALICE, BOB]));
}

async function publishedBodies(
  harness: Harness,
  domain: string,
): Promise<number> {
  try {
    return (
      await fs.readdir(
        path.join(
          harness.runtimeBaseDir,
          'resources',
          sessionId,
          `managed-${domain}`,
        ),
      )
    ).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

describe('managed session authority team records (H4e)', () => {
  it('refuses every team domain while it is disabled, publishing nothing', async () => {
    enablement.teams = false;
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const records = {
      team_state: team([]),
      team_task: task(refs),
      team_message: message(refs),
      team_plan: plan(refs),
    };
    await withAuthority(harness, async (authority) => {
      for (const domain of TEAM_DOMAINS) {
        await expect(
          commit(harness, authority, domain, records[domain]),
        ).rejects.toThrow(
          `domain ${domain} is registered but not enabled for submission.`,
        );
        expect(await publishedBodies(harness, domain)).toBe(0);
      }
    });
  });

  it('chains a team, its board, its mailbox and a plan, and rebuilds them', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const done = task(refs, { status: 'completed', owner: 'leader' });
    const claimed = task(refs, {
      taskId: 'task-2',
      number: 2,
      blockedBy: ['task-1'],
      owner: 'alice',
      status: 'in_progress',
    });
    const reported = message(refs, 'accepting', {
      messageId: 'message-2',
      from: 'alice',
      to: 'leader',
      targetSessionId: sessionId,
    });
    const approved = plan(refs, {
      decision: 'approved',
      run: logical('settled'),
    });
    await withAuthority(harness, async (authority) => {
      await staffed(harness, authority, refs);
      await commit(harness, authority, 'team_task', task(refs));
      await commit(harness, authority, 'team_task', {
        ...claimed,
        owner: null,
        status: 'pending',
      });
      await commit(harness, authority, 'team_task', claimed);
      await commit(harness, authority, 'team_task', done);
      for (const state of ['planned', 'accepting', 'accepted', 'consumed']) {
        await commit(harness, authority, 'team_message', message(refs, state));
      }
      await commit(harness, authority, 'team_message', {
        ...reported,
        targetSessionId: null,
        run: {
          ...reported.run,
          delivery: { target: 'session', state: 'planned' },
        },
      });
      await commit(harness, authority, 'team_message', reported);
      await commit(harness, authority, 'team_plan', plan(refs));
      const decided = await commit(harness, authority, 'team_plan', approved);
      expect(decided).toMatchObject({
        domain: 'team_plan',
        recordId: 'request-1',
        taskId: null,
        revision: 2,
      });
      await commit(
        harness,
        authority,
        'team_state',
        team([ALICE, BOB], 'closing'),
      );
      await commit(
        harness,
        authority,
        'team_state',
        team([ALICE, BOB], 'deleted'),
      );
    });
    await withAuthority(
      harness,
      async (authority) => {
        const expected: Array<[ManagedSessionDomain, string, number, unknown]> =
          [
            ['team_state', 'team-1', 5, team([ALICE, BOB], 'deleted')],
            ['team_task', 'task-1', 2, done],
            ['team_task', 'task-2', 2, claimed],
            ['team_message', 'message-1', 4, message(refs, 'consumed')],
            ['team_message', 'message-2', 2, reported],
            ['team_plan', 'request-1', 2, approved],
          ];
        for (const [domain, recordId, revision, record] of expected) {
          expect(authority.extensionRecord(domain, recordId)).toMatchObject({
            revision,
            record,
            task: null,
          });
        }
      },
      { create: false },
    );
  });

  it('refuses a team that another Session leads', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await expect(
        commit(
          harness,
          authority,
          'team_state',
          team([], 'active', { leadSessionId: 'session-other' }),
        ),
      ).rejects.toThrow('Team must be led by this Session.');
      expect(await publishedBodies(harness, 'team_state')).toBe(0);
    });
  });

  it('admits a member only as a live child Session run of this Session', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const refusal =
      'Team member must join as a child Session run of this Session that has not ended.';
    await withAuthority(harness, async (authority) => {
      await commit(harness, authority, 'team_state', team([]));
      await expect(
        commit(harness, authority, 'team_state', team([ALICE])),
      ).rejects.toThrow(refusal);
      enablement.shellKind = true;
      await commit(harness, authority, 'child_run', {
        kind: 'shell',
        shellId: 'shell-1',
        ownerScopeId: 'scope-main',
        commandRef: refs.input,
        startReceiptRef: null,
        outputRef: null,
        stopReason: null,
        stopRequested: false,
        exitCode: null,
        exitSignal: null,
        run: {
          ...logical('admitted'),
          executionCallId: 'call-shell-1',
          execution: 'intent',
        },
      });
      await expect(
        commit(
          harness,
          authority,
          'team_state',
          team([{ ...ALICE, childRunId: 'shell-1' }]),
        ),
      ).rejects.toThrow(refusal);
      await commitChild(harness, authority, childLife(refs, 'run-1'), 4);
      await expect(
        commit(harness, authority, 'team_state', team([ALICE])),
      ).rejects.toThrow(refusal);
      // A run that only launched is live: it may join before it attaches.
      await commitChild(harness, authority, childLife(refs, 'run-2'), 1);
      await commit(
        harness,
        authority,
        'team_state',
        team([{ ...BOB, name: 'alice' }]),
      );
    });
  });

  it('keeps a member that already joined after its run ends', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await staffed(harness, authority, refs);
      await commit(
        harness,
        authority,
        'child_run',
        childLife(refs, 'run-1')[3],
      );
      await commit(
        harness,
        authority,
        'team_state',
        team([ALICE, BOB], 'closing'),
      );
    });
  });

  it('keeps each child run in one team, even after that team is deleted', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const other = (members: readonly TeamMember[], lifecycle = 'active') =>
      team(members, lifecycle, { teamId: 'team-2', name: 'other-team' });
    await withAuthority(harness, async (authority) => {
      await staffed(harness, authority, refs);
      await commit(harness, authority, 'team_state', other([]));
      await expect(
        commit(harness, authority, 'team_state', other([BOB])),
      ).rejects.toThrow(
        "Team member's child run must belong to no other team.",
      );
      await commit(
        harness,
        authority,
        'team_state',
        team([ALICE, BOB], 'closing'),
      );
      await commit(
        harness,
        authority,
        'team_state',
        team([ALICE, BOB], 'deleted'),
      );
      await expect(
        commit(
          harness,
          authority,
          'team_state',
          other([{ ...BOB, name: 'robert' }]),
        ),
      ).rejects.toThrow(
        "Team member's child run must belong to no other team.",
      );
    });
  });

  it('opens team records only in an active team, and lets open ones drain', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const refusal = 'Team record must open in an active team of this Session.';
    await withAuthority(harness, async (authority) => {
      for (const [domain, record] of [
        ['team_task', task(refs)],
        ['team_message', message(refs)],
        ['team_plan', plan(refs)],
      ] as const) {
        await expect(
          commit(harness, authority, domain, record),
        ).rejects.toThrow(refusal);
      }
      await staffed(harness, authority, refs);
      await commit(harness, authority, 'team_message', message(refs));
      await commit(harness, authority, 'team_task', task(refs));
      await commit(harness, authority, 'team_plan', plan(refs));
      await commit(
        harness,
        authority,
        'team_state',
        team([ALICE, BOB], 'closing'),
      );
      for (const [domain, record] of [
        ['team_task', task(refs, { taskId: 'task-2', number: 2 })],
        ['team_message', message(refs, 'planned', { messageId: 'message-2' })],
        ['team_plan', plan(refs, { requestId: 'request-2' })],
      ] as const) {
        await expect(
          commit(harness, authority, domain, record),
        ).rejects.toThrow(refusal);
      }
      await commit(
        harness,
        authority,
        'team_message',
        message(refs, 'accepting'),
      );
      await commit(
        harness,
        authority,
        'team_task',
        task(refs, { status: 'deleted' }),
      );
      await commit(
        harness,
        authority,
        'team_plan',
        plan(refs, { run: logical('cancelled') }),
      );
    });
  });

  it('keeps task numbers unique within a team', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await staffed(harness, authority, refs);
      await commit(
        harness,
        authority,
        'team_state',
        team([], 'active', {
          teamId: 'team-2',
          name: 'other-team',
        }),
      );
      await commit(harness, authority, 'team_task', task(refs));
      await commit(
        harness,
        authority,
        'team_task',
        task(refs, { taskId: 'task-1', status: 'deleted' }),
      );
      // A deleted task keeps its number.
      await expect(
        commit(
          harness,
          authority,
          'team_task',
          task(refs, { taskId: 'task-2' }),
        ),
      ).rejects.toThrow('Team task number must be unique in its team.');
      await commit(
        harness,
        authority,
        'team_task',
        task(refs, { taskId: 'task-2', teamId: 'team-2' }),
      );
    });
  });

  it('gives a task only to the leader or a member of its team', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const refusal =
      'Team task owner must be the leader or a member of its team.';
    await withAuthority(harness, async (authority) => {
      await staffed(harness, authority, refs);
      await expect(
        commit(harness, authority, 'team_task', task(refs, { owner: 'carol' })),
      ).rejects.toThrow(refusal);
      await commit(
        harness,
        authority,
        'team_task',
        task(refs, { owner: 'leader' }),
      );
      await commit(
        harness,
        authority,
        'team_task',
        task(refs, { owner: 'bob' }),
      );
      await expect(
        commit(harness, authority, 'team_task', task(refs, { owner: 'carol' })),
      ).rejects.toThrow(refusal);
      await commit(
        harness,
        authority,
        'team_task',
        task(refs, { owner: null }),
      );
    });
  });

  it('refuses a dependency outside the team or one that closes a cycle', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const at = (taskId: string, number: number, blockedBy: string[] = []) =>
      task(refs, { taskId, number, blockedBy });
    await withAuthority(harness, async (authority) => {
      await staffed(harness, authority, refs);
      await commit(
        harness,
        authority,
        'team_state',
        team([], 'active', {
          teamId: 'team-2',
          name: 'other-team',
        }),
      );
      await commit(
        harness,
        authority,
        'team_task',
        task(refs, { taskId: 'elsewhere', teamId: 'team-2' }),
      );
      await expect(
        commit(harness, authority, 'team_task', at('task-1', 1, ['missing'])),
      ).rejects.toThrow('Team task must be blocked only by tasks of its team.');
      await expect(
        commit(harness, authority, 'team_task', at('task-1', 1, ['elsewhere'])),
      ).rejects.toThrow('Team task must be blocked only by tasks of its team.');
      await commit(harness, authority, 'team_task', at('task-1', 1));
      await commit(
        harness,
        authority,
        'team_task',
        at('task-2', 2, ['task-1']),
      );
      await commit(
        harness,
        authority,
        'team_task',
        at('task-3', 3, ['task-2']),
      );
      await expect(
        commit(harness, authority, 'team_task', at('task-1', 1, ['task-3'])),
      ).rejects.toThrow('Team task dependencies must not form a cycle.');
      await expect(
        commit(harness, authority, 'team_task', at('task-1', 1, ['task-2'])),
      ).rejects.toThrow('Team task dependencies must not form a cycle.');
      // A second path to the same blocker is no cycle.
      await commit(
        harness,
        authority,
        'team_task',
        at('task-3', 3, ['task-2', 'task-1']),
      );
    });
  });

  it("routes a message only within the team and to its recipient's Session", async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const DAVE: TeamMember = {
      name: 'dave',
      childRunId: 'run-3',
      planModeRequired: false,
    };
    const routing =
      'Team message must travel between the leader and members of its team.';
    const targeting = 'Team message must target the Session of its recipient.';
    await withAuthority(harness, async (authority) => {
      await staffed(harness, authority, refs);
      await commitChild(harness, authority, childLife(refs, 'run-3'), 1);
      await commit(harness, authority, 'team_state', team([ALICE, BOB, DAVE]));
      await expect(
        commit(
          harness,
          authority,
          'team_message',
          message(refs, 'planned', {
            from: 'carol',
          }),
        ),
      ).rejects.toThrow(routing);
      await expect(
        commit(
          harness,
          authority,
          'team_message',
          message(refs, 'planned', {
            to: 'carol',
          }),
        ),
      ).rejects.toThrow(routing);
      await commit(harness, authority, 'team_message', message(refs));
      // A successor that readdresses the message to a stranger is refused
      // as the conflict it is, before anything looks its recipient up.
      const readdressed = commit(
        harness,
        authority,
        'team_message',
        message(refs, 'accepting', { to: 'carol' }),
      );
      await expect(readdressed).rejects.toBeInstanceOf(
        ManagedSessionConflictError,
      );
      await expect(readdressed).rejects.toThrow(routing);
      expect(
        authority.extensionRecord('team_message', 'message-1'),
      ).toMatchObject({ revision: 1, record: message(refs) });
      await expect(
        commit(
          harness,
          authority,
          'team_message',
          message(refs, 'accepting', {
            targetSessionId: 'session-run-2',
          }),
        ),
      ).rejects.toThrow(targeting);
      await commit(
        harness,
        authority,
        'team_message',
        message(refs, 'accepting'),
      );
      // dave's run has not attached, so a message to him stays planned.
      const toDave = (state: string, targetSessionId: string | null) =>
        message(refs, state, {
          messageId: 'message-2',
          from: 'alice',
          to: 'dave',
          targetSessionId,
        });
      await commit(harness, authority, 'team_message', toDave('planned', null));
      await expect(
        commit(
          harness,
          authority,
          'team_message',
          toDave('accepting', 'session-run-3'),
        ),
      ).rejects.toThrow(targeting);
      const toLeader = (targetSessionId: string | null, state = 'accepting') =>
        message(refs, state, {
          messageId: 'message-3',
          from: 'bob',
          to: 'leader',
          targetSessionId,
        });
      await commit(
        harness,
        authority,
        'team_message',
        toLeader(null, 'planned'),
      );
      await expect(
        commit(harness, authority, 'team_message', toLeader('session-run-2')),
      ).rejects.toThrow(targeting);
      await commit(harness, authority, 'team_message', toLeader(sessionId));
    });
  });

  it('takes a plan request only from a member that must plan', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const refusal =
      'Team plan must come from a member of its team that requires plan mode.';
    await withAuthority(harness, async (authority) => {
      await staffed(harness, authority, refs);
      await expect(
        commit(
          harness,
          authority,
          'team_plan',
          plan(refs, { member: 'alice' }),
        ),
      ).rejects.toThrow(refusal);
      await expect(
        commit(
          harness,
          authority,
          'team_plan',
          plan(refs, { member: 'carol' }),
        ),
      ).rejects.toThrow(refusal);
      await commit(harness, authority, 'team_plan', plan(refs));
    });
  });

  it('refuses a team record whose content this Session does not hold', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const missing = { ...refs.content, resourceId: 'never-published' };
    await withAuthority(harness, async (authority) => {
      await staffed(harness, authority, refs);
      for (const [domain, record] of [
        ['team_task', task(refs, { descriptionRef: missing })],
        ['team_task', task(refs, { metadataRef: missing })],
        ['team_message', message(refs, 'planned', { contentRef: missing })],
        ['team_plan', plan(refs, { planRef: missing })],
        [
          'team_plan',
          plan(refs, {
            decision: 'rejected',
            feedbackRef: missing,
            run: logical('settled'),
          }),
        ],
      ] as const) {
        await expect(
          commit(harness, authority, domain, record),
        ).rejects.toThrow('resource never-published is not present');
      }
    });
  });
});
