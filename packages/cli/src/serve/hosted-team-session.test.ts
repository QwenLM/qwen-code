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
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  parseTeamState,
  parseTeamTask,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import { answerCommittedTurnCalls } from './hosted-runtime-recovery.js';
import { HostedChildAgentSession } from './hosted-child-agent-session.js';
import { decodeChildLaunchEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import { HostedSessionMessageSession } from './hosted-session-message-session.js';
import {
  HostedChildChains,
  hostedOpenTeamChainMember,
} from './hosted-member-chain.js';
import { sessionMessageInputId } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-operations.js';
import {
  HostedTeamRefusal,
  HostedTeamSession,
  hostedTeamArgumentError,
  hostedTeamMembership,
  type HostedTeamStore,
} from './hosted-team-session.js';

let root: string;
let session: ManagedSession;
let children: HostedChildAgentSession;
let teams: HostedTeamSession;
let sessionKey: { tenantId: string; workspaceId: string; sessionId: string };

beforeEach(async () => {
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
  teams = new HostedTeamSession(store, sessionKey, children);
});

afterEach(async () => {
  planGate.enabled = false;
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
    workspaceMode: 'shared',
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

/** A team_delete stopped after it closed the team, before it deleted it. */
async function stopDeleteAtClosing(callKey: string): Promise<void> {
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
    children,
  );
  await expect(failing.run('team_delete', {}, callKey)).rejects.toThrow(
    'store unavailable',
  );
}

describe('team plans', () => {
  async function member() {
    planGate.enabled = true;
    await createTeam();
    const membership = teams.admitMember('alice');
    await launch('run-alice');
    await teams.join({
      ...membership,
      childRunId: 'run-alice',
      planModeRequired: true,
    });
  }

  it.each([true, false])(
    'recovers approval withdrawal with plan gate %s',
    async (enabled) => {
      await member();
      await teams.submitPlan('submit-1', 'run-alice', 'read');
      await children.settleFailed('run-alice', {
        stopReason: 'creation_failed',
        reason: null,
        started: false,
      });
      const args = { request_id: 'submit-1', action: 'approve' };
      for (const id of ['approval', 'unrelated']) {
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
                  id,
                  name: 'team_plan_approval',
                  args,
                },
              },
            ],
          },
        });
      }
      expect(
        await teams.run('team_plan_approval', args, 'prompt:approval'),
      ).toContain('Plan submit-1 was withdrawn');
      expect(teams.plan('submit-1')?.run.state).toBe('cancelled');
      planGate.enabled = enabled;
      const recovered = new HostedTeamSession(
        { authority: session.authority, resources: session.resources },
        sessionKey,
        children,
      );
      expect(
        await answerCommittedTurnCalls({
          session,
          sessionId: sessionKey.sessionId,
          cwd: root,
          promptId: 'prompt',
          children,
          teams: recovered,
        }),
      ).toBe(1);
      const answers = (await session.sink.project())
        .filter((entry) => entry.type === 'tool_result')
        .flatMap((entry) => entry.message?.parts ?? []);
      expect(JSON.stringify(answers)).toContain('Plan submit-1 was withdrawn');
      expect(JSON.stringify(answers)).not.toContain('never ran');
      expect(
        answers.some((part) => part.functionResponse?.id === 'unrelated'),
      ).toBe(false);
      expect(
        recovered.committedBy('team_plan_approval', 'prompt:approval'),
      ).toBe(true);
      expect(
        recovered.committedBy('team_plan_approval', 'prompt:unrelated'),
      ).toBe(false);
      expect(
        await recovered.planDecisionEvidence('prompt:unrelated'),
      ).toBeUndefined();
      expect(
        await recovered.run('team_plan_approval', args, 'prompt:approval'),
      ).toContain('Plan submit-1 was withdrawn');
    },
  );

  it('recognizes deletion withdrawal after another call closed the team', async () => {
    await member();
    await teams.submitPlan('submit-1', 'run-alice', 'read');
    await settle('run-alice');
    planGate.enabled = false;
    await stopDeleteAtClosing('first-delete');
    planGate.enabled = true;
    await stopDeleteAtClosing('second-delete');
    expect(teams.plan('submit-1')?.run.state).toBe('cancelled');
    expect(teams.committedBy('team_delete', 'second-delete')).toBe(true);
    expect(teams.committedBy('team_delete', 'unrelated')).toBe(false);
  });

  it('submits, reads, rejects and approves with call-keyed continuation evidence', async () => {
    await member();
    expect(
      await teams.submitPlan('submit-1', 'run-alice', 'Read <file>'),
    ).toContain('revision 1');
    expect(await teams.run('task_list', {}, 'list')).toContain(
      'request submit-1',
    );
    expect(await teams.showPlan('submit-1')).toContain('Read <file>');
    await expect(
      teams.run(
        'team_plan_approval',
        { request_id: 'submit-1', action: 'reject' },
        'reject',
      ),
    ).rejects.toThrow('run settles');
    expect(teams.plan('submit-1')?.run.state).toBe('waiting');
    await settle('run-alice');
    expect(
      await teams.run(
        'team_plan_approval',
        {
          request_id: 'submit-1',
          action: 'reject',
          message: 'revise <safely>',
        },
        'reject',
      ),
    ).toContain('member was continued');
    expect(teams.memberPlanMode(teams.membership('run-alice')!)).toBe(true);
    const rejected = decodeChildLaunchEnvelope(
      await session.resources.read(children.record('reject')!.inputRef),
    );
    expect(rejected.prompt).toContain('plan-mode="required"');
    expect(rejected.prompt).toContain('Read &lt;file&gt;');
    expect(rejected.prompt).toContain(
      '<feedback>revise &lt;safely&gt;</feedback>',
    );
    await teams.submitPlan('submit-2', 'reject', 'Read safely');
    await settle('reject');
    await teams.run(
      'team_plan_approval',
      { request_id: 'submit-2', action: 'approve' },
      'approve',
    );
    expect(teams.memberPlanMode(teams.membership('run-alice')!)).toBe(false);
    const approved = decodeChildLaunchEnvelope(
      await session.resources.read(children.record('approve')!.inputRef),
    );
    expect(approved.prompt).not.toContain('plan-mode="required"');
    expect(approved.prompt).toContain('<plan>\nRead safely\n</plan>');
    expect(await teams.planDecisionEvidence('unrelated')).toBeUndefined();
    expect(await teams.planDecisionEvidence('reject')).toContain('submit-1');
    expect(
      await teams.submitPlan('submit-1', 'run-alice', 'Read <file>'),
    ).toContain('revision 1');
  });

  it.each(['cut', 'settled', 'newer'] as const)(
    'recovers partial supersede: %s',
    async (scenario) => {
      await member();
      await teams.submitPlan('original', 'run-alice', 'first');
      const interrupted = new HostedTeamSession(
        {
          resources: session.resources,
          authority: Object.create(session.authority, {
            commitExtensionRecord: {
              value: async (
                ...args: Parameters<
                  HostedTeamStore['authority']['commitExtensionRecord']
                >
              ) => {
                const result = await session.authority.commitExtensionRecord(
                  ...args,
                );
                if (args[0].commandId === 'supersede:replacement:original') {
                  if (scenario === 'settled') await settle('run-alice');
                  else throw new Error('cut after cancel');
                }
                return result;
              },
            },
          }),
        },
        sessionKey,
        children,
      );
      if (scenario === 'settled') {
        expect(
          await interrupted.submitPlan('replacement', 'run-alice', 'second'),
        ).toContain('revision 2');
      } else {
        await expect(
          interrupted.submitPlan('replacement', 'run-alice', 'second'),
        ).rejects.toThrow('cut after cancel');
        await settle('run-alice');
        if (scenario === 'newer') {
          await children.sendToChild({
            taskId: children.taskIdOf('run-alice'),
            text: 'next',
            messageId: 'next',
            continuationRunId: 'next',
            executionCallId: 'next',
            closing: false,
          });
          await teams.submitPlan('newer', 'next', 'third');
          const newer = teams.plan('newer');
          await expect(
            teams.submitPlan('fresh-stale', 'run-alice', 'stale'),
          ).rejects.toThrow('Only the running');
          const answer = await teams.submitPlan(
            'replacement',
            'run-alice',
            'second',
          );
          expect(answer).toContain('superseded');
          expect(answer).not.toContain('decision arrives');
          expect(teams.plan('newer')).toEqual(newer);
          expect(
            teams
              .plans()
              .filter((plan) => plan.run.state === 'waiting')
              .map((plan) => plan.requestId),
          ).toEqual(['newer']);
          return;
        }
        expect(
          await teams.submitPlan('replacement', 'run-alice', 'second'),
        ).toContain('revision 2');
      }
      expect(teams.plan('original')?.run.state).toBe('cancelled');
      expect(teams.plan('replacement')?.run.state).toBe('waiting');
    },
  );

  it('refuses a fresh submission whose head changes while publishing without cancelling the newer plan', async () => {
    await member();
    await teams.submitPlan('original', 'run-alice', 'first');
    let raced = false;
    const racing = new HostedTeamSession(
      {
        authority: session.authority,
        resources: {
          ...session.resources,
          read: session.resources.read.bind(session.resources),
          publish: async (
            ...args: Parameters<typeof session.resources.publish>
          ) => {
            const result = await session.resources.publish(...args);
            if (!raced) {
              raced = true;
              await settle('run-alice');
              await children.sendToChild({
                taskId: children.taskIdOf('run-alice'),
                text: 'next',
                messageId: 'next',
                continuationRunId: 'next',
                executionCallId: 'next',
                closing: false,
              });
              await teams.submitPlan('newer', 'next', 'third');
            }
            return result;
          },
        },
      },
      sessionKey,
      children,
    );
    await expect(
      racing.submitPlan('stale', 'run-alice', 'second'),
    ).rejects.toThrow('no longer the running');
    expect(teams.plan('newer')).toMatchObject({
      planRevision: 2,
      run: { state: 'waiting' },
    });
    expect(teams.plan('stale')).toBeUndefined();
  });

  it('supersedes only from the current run and withdraws on finished-member shutdown', async () => {
    await member();
    await teams.submitPlan('submit-1', 'run-alice', 'first');
    await teams.submitPlan('submit-2', 'run-alice', 'second');
    expect(teams.plan('submit-1')?.run.state).toBe('cancelled');
    await settle('run-alice');
    await teams.run('request_shutdown', { to: 'alice' }, 'shutdown');
    expect(teams.plan('submit-2')?.run.state).toBe('cancelled');
    expect(await teams.submitPlan('submit-1', 'run-alice', 'first')).toContain(
      'revision 1',
    );
    expect(teams.plans()).toHaveLength(2);
  });

  it('preflights closing before settlement and recovers an undelivered decision', async () => {
    await member();
    await teams.submitPlan('submit-1', 'run-alice', 'read');
    await settle('run-alice');
    await expect(
      teams.run(
        'team_plan_approval',
        { request_id: 'submit-1', action: 'approve' },
        'closing',
        undefined,
        { closing: true },
      ),
    ).rejects.toThrow();
    expect(teams.plan('submit-1')?.run.state).toBe('waiting');
    const failing = new HostedTeamSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      {
        requestStop: children.requestStop.bind(children),
        sendToChild: async (params) =>
          params.preflight
            ? children.sendToChild(params)
            : { kind: 'refused', reason: 'capacity changed' },
      },
    );
    const answer = await failing.run(
      'team_plan_approval',
      { request_id: 'submit-1', action: 'approve' },
      'split',
    );
    expect(answer).toContain('submit-1');
    expect(answer).toContain('stopped before alice was continued');
    expect(answer).not.toContain('member was continued');
    expect(teams.plan('submit-1')?.decision).toBe('approved');
    expect(children.record('split')).toBeUndefined();
    expect(
      await teams.run(
        'team_plan_approval',
        { request_id: 'submit-1', action: 'approve' },
        'split',
      ),
    ).toBe(answer);
    expect(children.record('split')).toBeUndefined();
  });

  it('recovers a real never-started plan continuation without launching it again', async () => {
    await member();
    await teams.submitPlan('never-started-plan', 'run-alice', 'read');
    await settle('run-alice');
    const args = { request_id: 'never-started-plan', action: 'approve' };
    await teams.run('team_plan_approval', args, 'decision-run');
    await children.settleFailed('decision-run', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    expect(children.record('decision-run')?.run.execution).toBe(
      'not_started_proven',
    );
    const recovered = new HostedTeamSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      children,
    );
    const before = session.authority.extensionRecordsInDomain('child_run');
    const evidence = await recovered.planDecisionEvidence('decision-run');
    expect(evidence).toContain('continuation never started');
    expect(evidence).toContain('send_message');
    expect(evidence).toContain('request_id "never-started-plan"');
    expect(evidence).not.toContain('member was continued');
    expect(
      await recovered.run('team_plan_approval', args, 'decision-run'),
    ).toBe(evidence);
    expect(await recovered.planDecisionEvidence('unrelated')).toBeUndefined();
    expect(session.authority.extensionRecordsInDomain('child_run')).toEqual(
      before,
    );
    expect(await recovered.run('task_list', {}, 'list-recovered')).toContain(
      'never-started-plan',
    );
  });

  it('does not deliver a stale decision after the head changes following preflight', async () => {
    await member();
    await teams.submitPlan('race-plan', 'run-alice', 'read');
    await settle('run-alice');
    const racing = new HostedTeamSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      {
        requestStop: children.requestStop.bind(children),
        sendToChild: async (params) => {
          if (!params.preflight) {
            await children.sendToChild({
              taskId: children.taskIdOf('run-alice'),
              text: 'another instruction',
              messageId: 'race-message',
              continuationRunId: 'race-head',
              executionCallId: 'race-head',
              closing: false,
            });
            await settle('race-head');
          }
          return children.sendToChild(params);
        },
      },
    );
    const answer = await racing.run(
      'team_plan_approval',
      { request_id: 'race-plan', action: 'approve' },
      'stale',
    );
    expect(answer).toContain('stopped before alice was continued');
    expect(answer).not.toContain('member was continued');
    expect(children.record('race-head')).toBeDefined();
    expect(children.record('stale')).toBeUndefined();
    expect(
      session.authority.extensionRecordsInDomain('session_message'),
    ).toHaveLength(0);
    expect(teams.plan('race-plan')?.decision).toBe('approved');
  });

  it.each(['request_shutdown', 'team_delete'] as const)(
    'allows %s with historical waiting plans while the plan gate is off',
    async (tool) => {
      await member();
      await teams.submitPlan('historical', 'run-alice', 'read');
      if (tool === 'team_delete') await settle('run-alice');
      planGate.enabled = false;
      await expect(
        teams.run(
          tool,
          tool === 'request_shutdown' ? { to: 'alice' } : {},
          'cleanup',
        ),
      ).resolves.toContain(tool === 'request_shutdown' ? 'stopped' : 'deleted');
      expect(teams.plan('historical')?.run.state).toBe('waiting');
      await expect(
        teams.submitPlan('fresh', 'run-alice', 'new'),
      ).rejects.toThrow();
      planGate.enabled = true;
      const late = teams.run(
        'team_plan_approval',
        { request_id: 'historical', action: 'approve' },
        'late',
      );
      if (tool === 'team_delete')
        await expect(late).rejects.toThrow('not active');
      else await expect(late).resolves.toContain('withdrawn');
      expect(teams.plan('historical')?.decision).toBeNull();
      expect(children.record('late')).toBeUndefined();
    },
  );

  it('refuses gate-off shutdown of a completed member with a waiting plan without effects', async () => {
    await member();
    await teams.submitPlan('historical', 'run-alice', 'read');
    await settle('run-alice');
    const before = session.authority.extensionRecordsInDomain('child_run');
    planGate.enabled = false;
    expect(
      await refusal(teams.run('request_shutdown', { to: 'alice' }, 'rollback')),
    ).toContain('team_plan is disabled');
    expect(teams.plan('historical')?.run.state).toBe('waiting');
    expect(session.authority.extensionRecordsInDomain('child_run')).toEqual(
      before,
    );
    expect(teams.committedBy('request_shutdown', 'rollback')).toBe(false);
    planGate.enabled = true;
    await expect(
      teams.run(
        'team_plan_approval',
        { request_id: 'historical', action: 'approve' },
        'after-refusal',
      ),
    ).resolves.toContain('member was continued');
    expect(children.record('after-refusal')).toBeDefined();
  });

  it('refuses gate-off shutdown if normal completion outraces its stop', async () => {
    await member();
    await teams.submitPlan('race-shutdown-plan', 'run-alice', 'read');
    const racing = new HostedTeamSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      {
        requestStop: async () => {
          await settle('run-alice');
          throw new ManagedSessionConflictError('settlement won');
        },
      },
    );
    planGate.enabled = false;
    expect(
      await refusal(
        racing.run('request_shutdown', { to: 'alice' }, 'race-shutdown'),
      ),
    ).toContain('team_plan is disabled');
    expect(teams.plan('race-shutdown-plan')?.run.state).toBe('waiting');
    expect(children.record('run-alice')?.stopRequested).toBe(false);
    expect(racing.committedBy('request_shutdown', 'race-shutdown')).toBe(false);
  });

  it('recognizes only the shutdown call that durably withdrew a completed member plan', async () => {
    await member();
    await teams.submitPlan('historical', 'run-alice', 'read');
    await settle('run-alice');
    await teams.run('request_shutdown', { to: 'alice' }, 'withdraw-only');
    expect(
      session.authority.committedExtensionOperation(
        'commitChildRunRecord',
        'shutdown:withdraw-only',
      ),
    ).toBeUndefined();
    const recovered = new HostedTeamSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      children,
    );
    expect(recovered.committedBy('request_shutdown', 'withdraw-only')).toBe(
      true,
    );
    expect(recovered.committedBy('request_shutdown', 'unrelated')).toBe(false);
  });

  it('bounds escaped plans and feedback before writing', async () => {
    await member();
    await expect(
      teams.submitPlan('too-big', 'run-alice', '<'.repeat(7000)),
    ).rejects.toThrow('byte_limit');
    expect(teams.plans()).toHaveLength(0);
    expect(
      hostedTeamArgumentError('team_plan_approval', {
        request_id: 'x',
        action: 'approve',
        message: '界'.repeat(1366),
      }),
    ).toContain('4096');
  });

  it('names the escaped plan size and the room left, exact at the bound', async () => {
    await member();
    const sizes = (message: string) => {
      const found =
        /needs (\d+) bytes after XML and JSON escaping and (\d+) fit\./.exec(
          message,
        );
      expect(found).not.toBeNull();
      return { needed: Number(found![1]), available: Number(found![2]) };
    };
    // UTF-8 bytes once escaped: '<' is '&lt;' (4), '界' 3, '😀' 4 and the
    // newline JSON-encodes as '\n' (2) — 13, though only 9 UTF-16 units.
    const first = sizes(
      await refusal(
        teams.submitPlan('big-1', 'run-alice', '<界😀\n'.repeat(2000)),
      ),
    );
    expect(first.needed).toBe(2000 * 13);
    expect(first.available).toBeGreaterThan(0);
    expect(first.available).toBeLessThan(first.needed);
    expect(
      sizes(
        await refusal(
          teams.submitPlan(
            'big-2',
            'run-alice',
            'B'.repeat(first.available + 1),
          ),
        ),
      ),
    ).toEqual({ needed: first.available + 1, available: first.available });
    expect(teams.plans()).toHaveLength(0);
    await teams.submitPlan('fits', 'run-alice', 'B'.repeat(first.available));
    expect(teams.plan('fits')?.planRevision).toBe(1);
  });
});

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
    await stopDeleteAtClosing('prompt:del');
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
  // send_message reads the open-team answer; a result's label reads any team.
  it('finds a member among open teams until its team is deleted', async () => {
    await createTeam();
    await addMember('alice');
    await settle('run-alice');
    const records = () =>
      session.authority.extensionRecordsInDomain('team_state');
    // H4e-b2: the open-team answer reads the run's chain root.
    const openMember = () =>
      hostedOpenTeamChainMember(
        records(),
        new HostedChildChains(
          session.authority.extensionRecordsInDomain('child_run'),
        ),
        'run-alice',
      );
    const alice = { teamName: 'review', name: 'alice' };
    expect(openMember()).toMatchObject({ name: 'alice' });
    await stopDeleteAtClosing('prompt:del');
    expect(teams.openTeam()?.lifecycle).toBe('closing');
    expect(openMember()).toMatchObject({ name: 'alice' });
    await teams.run('team_delete', {}, 'prompt:del');
    expect(teams.openTeam()).toBeUndefined();
    expect(openMember()).toBeUndefined();
    expect(hostedTeamMembership(records(), 'run-alice')).toMatchObject(alice);
    expect(hostedTeamMembership(records(), 'run-bob')).toBeUndefined();
  });

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
    ).toBe(
      'Member "bob" has finished. If it already did this task\'s work, from its launch prompt or a message you sent it, set status "completed" with this owner once its report is in. Otherwise give it the work with send_message to "bob" first, which continues it, and then update the task in the same turn.',
    );
    const assigned = await teams.run(
      'task_update',
      { taskId: '1', status: 'in_progress', owner: 'Alice' },
      'prompt:u4',
    );
    expect(assigned).toContain(
      'Task #1 updated (status: in_progress, owner: alice).',
    );
    expect(assigned).toContain(
      '"alice" was not notified: task_update records the board only. If alice does not already have this work, give it with send_message to "alice".',
    );
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
    // Editing the open task keeps its ended owner; moving it to another
    // open status does not.
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', description: 'audit it again' },
        'prompt:edit',
      ),
    ).toBe('Task #1 updated (status: in_progress, owner: alice).');
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '2', status: 'pending' },
          'prompt:park',
        ),
      ),
    ).toContain('cannot keep task #2 open');
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
    // A new owner must be running unless the task stays completed, so
    // the completed task can be handed back to its finished member.
    await teams.run(
      'task_update',
      { taskId: '1', owner: 'leader' },
      'prompt:to-leader',
    );
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', owner: 'alice' },
        'prompt:back',
      ),
    ).toContain('Task #1 updated (status: completed, owner: alice).');
  });

  // The physical pass: a one-shot member finished before the lead's
  // assignment landed, so the board could never name it. A finished
  // member may be recorded on a task the call leaves completed; a member
  // that failed or was cancelled may not, and a new owner of an open task
  // must still be running.
  it('records a finished member on the task the call completes', async () => {
    await createTeam();
    await addMember('alice');
    await addMember('bob');
    await addMember('carol');
    for (const subject of ['audit', 'fix', 'ship'])
      await teams.run(
        'task_create',
        { subject, description: subject },
        `prompt:create-${subject}`,
      );
    await settle('run-alice');
    await children.settleFailed('run-bob', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'alice' },
          'prompt:open',
        ),
      ),
    ).toBe(
      'Member "alice" has finished. If it already did this task\'s work, from its launch prompt or a message you sent it, set status "completed" with this owner once its report is in. Otherwise give it the work with send_message to "alice" first, which continues it, and then update the task in the same turn.',
    );
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', status: 'completed', owner: 'alice' },
        'prompt:done',
      ),
    ).toBe('Task #1 updated (status: completed, owner: alice).');
    expect(
      parseTeamTask(
        session.authority.extensionRecord('team_task', 'prompt:call-team#1')!
          .record,
      ),
    ).toMatchObject({ status: 'completed', owner: 'alice' });
    // Reopening keeps the owner, so it is checked like a new one: the
    // finished member never lands on open work in two steps.
    for (const status of ['in_progress', 'pending'])
      expect(
        await refusal(
          teams.run(
            'task_update',
            { taskId: '1', status },
            `prompt:reopen-${status}`,
          ),
        ),
      ).toBe(
        'Member "alice" cannot keep task #1 open: it has finished. If it already did this task\'s work, from its launch prompt or a message you sent it, set status "completed" with this owner once its report is in. Otherwise give it the work with send_message to "alice" first, which continues it, and then update the task in the same turn, or set owner "" to unassign it.',
      );
    // Naming the same owner again is still keeping it.
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'alice' },
          'prompt:reopen-named',
        ),
      ),
    ).toContain('cannot keep task #1 open');
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', status: 'pending', owner: '' },
        'prompt:reopen-unassigned',
      ),
    ).toBe('Task #1 updated (status: pending).');
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '2', status: 'completed', owner: 'bob' },
          'prompt:failed',
        ),
      ),
    ).toBe(
      'Member "bob" has failed without completing a run, so it did not do this task\'s work. Record the member that did it, or "leader".',
    );
    await children.requestStop('run-carol');
    await children.settleCancelled('run-carol', { started: false });
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '2', status: 'completed', owner: 'carol' },
          'prompt:cancelled',
        ),
      ),
    ).toBe(
      'Member "carol" was cancelled without completing a run, so it did not do this task\'s work. Record the member that did it, or "leader".',
    );
    await teams.run(
      'task_update',
      { taskId: '3', status: 'completed' },
      'prompt:closed',
    );
    expect(
      await teams.run(
        'task_update',
        { taskId: '3', owner: 'alice' },
        'prompt:late',
      ),
    ).toBe('Task #3 updated (status: completed, owner: alice).');
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
      children,
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

  it('lists the board with filters and the roster with run states, stop reasons and reachable task ids', async () => {
    await createTeam();
    await addMember('alice');
    await addMember('bob');
    await addMember('carol');
    await addMember('dave');
    await settle('run-bob');
    await children.settleFailed('run-carol', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    await children.requestStop('run-dave');
    await children.settleCancelled('run-dave', { started: false });
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
        // A member that can still take work, running or continuable,
        // shows its chain head's task id (H4e-b2 decision 2).
        `alice: running — ${children.taskIdOf('run-alice')}`,
        `bob: completed — ${children.taskIdOf('run-bob')}`,
        // A failed run says why; a member the host never started reads
        // differently from one that failed its work.
        'carol: failed (creation_failed)',
        'dave: cancelled (stop_requested)',
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

  // A well-formed number with no task is a refusal, never a crash:
  // existence is proved before the ownership probe reads the task.
  it('refuses a well-formed addBlocks target that does not exist instead of crashing', async () => {
    await createTeam();
    await addMember('alice');
    await teams.run(
      'task_create',
      { subject: 'one', description: 'do one' },
      'prompt:t1',
    );
    expect(
      await refusal(
        teams.memberTaskUpdate('alice', 'cmd_missing', {
          taskId: '1',
          addBlocks: ['999'],
        }),
      ),
    ).toBe('Cannot update task #1: referenced task #999 not found.');
  });

  // A partially committed task_update replays its remaining places
  // against the board as it stands now: the leader legally made task 2
  // block task 1 after the subject place committed, so the replayed
  // edge would close a cycle — it rides the receipt, never the fault.
  it('replays the remaining addBlocks places against the board as it stands now', async () => {
    await createTeam();
    await addMember('alice');
    await teams.run(
      'task_create',
      { subject: 'one', description: 'do one' },
      'prompt:t1',
    );
    await teams.run(
      'task_create',
      { subject: 'two', description: 'do two' },
      'prompt:t2',
    );
    // The original call committed only the subject place.
    await teams.memberTaskUpdate('alice', 'cmd_board', {
      taskId: '1',
      subject: 'renamed',
    });
    await teams.run(
      'task_update',
      { taskId: '1', addBlockedBy: ['2'] },
      'prompt:leader-edge',
    );
    const result = await teams.memberTaskUpdate('alice', 'cmd_board', {
      taskId: '1',
      subject: 'renamed',
      addBlocks: ['2'],
    });
    expect(result).toContain('Not committed');
    expect(result).toContain('dependency cycle');
    const two = parseTeamTask(
      session.authority.extensionRecord('team_task', 'prompt:call-team#2')!
        .record,
    );
    expect(two.blockedBy).toHaveLength(0);
  });

  // The blocker-count limit follows the same replay rule: the remaining
  // place is validated against the current board, so a crowded target
  // gets its Not-committed entry instead of a fault escaping execute.
  it('replays a remaining addBlocks place by its blocker cap against the current board', async () => {
    await createTeam();
    await addMember('alice');
    await teams.run(
      'task_create',
      { subject: 'one', description: 'do one' },
      'prompt:t1',
    );
    await teams.run(
      'task_create',
      { subject: 'two', description: 'do two' },
      'prompt:t2',
    );
    // The original call committed only the subject place.
    await teams.memberTaskUpdate('alice', 'cmd_cap', {
      taskId: '1',
      subject: 'renamed',
    });
    // The leader filled task 2 with the maximum since: 64 blockers.
    const blockers: string[] = [];
    for (let index = 0; index < 64; index += 1) {
      const number = index + 3;
      blockers.push(`${number}`);
      await teams.run(
        'task_create',
        { subject: `filler-${number}`, description: 'f' },
        `prompt:cap-${number}`,
      );
    }
    await teams.run(
      'task_update',
      { taskId: '2', addBlockedBy: blockers },
      'prompt:cap-fill',
    );
    const result = await teams.memberTaskUpdate('alice', 'cmd_cap', {
      taskId: '1',
      subject: 'renamed',
      addBlocks: ['2'],
    });
    expect(result).toContain('Not committed');
    expect(result).toContain('would exceed 64 blockers');
    const two = parseTeamTask(
      session.authority.extensionRecord('team_task', 'prompt:call-team#2')!
        .record,
    );
    expect(two.blockedBy).toHaveLength(64);
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
    // The replaced session's funnel from beforeEach is closed with it, so
    // this one is rebuilt beside the reopened funnel, as the loader does.
    new HostedChildAgentSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
    ),
  );
  expect(session.authority.extensionRecordsInDomain('team_state')).toEqual(
    before,
  );
  expect(parseTeamState(before[0]!.record).members).toHaveLength(1);
  expect(await reopened.run('task_list', {}, 'prompt:list')).toContain(
    '#1 [pending] — audit',
  );
});

// H4e-b3a (decision 10): the lead stops a member with request_shutdown,
// committing the same stop an H4f cancel commits on the member's head, and
// team_delete's refusal points here until the stop settles.
describe('request_shutdown (H4e-b3a)', () => {
  it('validates its argument in the batch', () => {
    expect(hostedTeamArgumentError('request_shutdown', {})).toBe(
      'to must be a string.',
    );
    expect(
      hostedTeamArgumentError('request_shutdown', { to: 'alice', kind: 'x' }),
    ).toBe('Hosted request_shutdown received unsupported argument "kind".');
  });

  it('refuses no team, an empty name and a stranger', async () => {
    expect(
      await refusal(teams.run('request_shutdown', { to: 'alice' }, 'p:s')),
    ).toBe('No active team. Create a team first.');
    await createTeam();
    expect(
      await refusal(teams.run('request_shutdown', { to: '!' }, 'p:s')),
    ).toBe(
      'Teammate name "!" sanitizes to an empty string. Choose a name with at least one alphanumeric character.',
    );
    expect(
      await refusal(teams.run('request_shutdown', { to: 'bob' }, 'p:s')),
    ).toBe('"bob" is not a member of team "review".');
  });

  it('commits the H4f stop on a running head, then reads it on replay', async () => {
    await createTeam();
    await addMember('alice');
    expect(teams.committedBy('request_shutdown', 'p:stop')).toBe(false);
    expect(await teams.run('request_shutdown', { to: 'alice' }, 'p:stop')).toBe(
      'alice is being stopped. Delete the team once task_list shows it ended.',
    );
    expect(children.record('run-alice')!.stopRequested).toBe(true);
    expect(teams.committedBy('request_shutdown', 'p:stop')).toBe(true);
    // The stop evidence keys on the call, not the member: a call key that
    // never ran has committed nothing.
    expect(teams.committedBy('request_shutdown', 'p:other')).toBe(false);
    // A re-driven call answers its committed stop from the records.
    expect(await teams.run('request_shutdown', { to: 'alice' }, 'p:stop')).toBe(
      'alice is already being stopped. Delete the team once task_list shows it ended.',
    );
    // team_delete still waits for the stop to settle.
    expect(await refusal(teams.run('team_delete', {}, 'p:del'))).toContain(
      'still has running members',
    );
    await settle('run-alice');
    expect(await teams.run('team_delete', {}, 'p:del')).toBe(
      'Team "review" deleted.',
    );
  });

  it('says a continuation stopped before it attached may end without starting', async () => {
    await createTeam();
    await addMember('alice');
    await settle('run-alice');
    await children.sendToChild({
      taskId: children.taskIdOf('run-alice'),
      text: 'more work',
      messageId: 'msg_shut_more',
      continuationRunId: 'shut:more',
      executionCallId: 'shut:more',
      closing: false,
    });
    await children.requestStop('shut:more');
    expect(await teams.run('request_shutdown', { to: 'alice' }, 'p:stop')).toBe(
      'alice is already being stopped, before its latest continuation started: it may end without starting, and alice then goes back to its predecessor run. Check task_list once it settles; do not read the member as ended on this stop alone.',
    );
  });

  it('leaves a finished head untouched and says so', async () => {
    await createTeam();
    await addMember('alice');
    await settle('run-alice');
    expect(await teams.run('request_shutdown', { to: 'alice' }, 'p:stop')).toBe(
      'alice has finished: it takes no work unless you send it some, so nothing needed stopping. Its run was not touched.',
    );
    expect(children.record('run-alice')!.stopRequested).toBe(false);
  });

  it('names a head that completed after a stop was requested', async () => {
    await createTeam();
    await addMember('alice');
    await children.requestStop('run-alice');
    await settle('run-alice');
    expect(await teams.run('request_shutdown', { to: 'alice' }, 'p:stop')).toBe(
      'alice completed after a stop was requested; there is nothing left to stop.',
    );
  });

  it('names an ended member', async () => {
    await createTeam();
    await addMember('alice');
    await children.settleFailed('run-alice', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    expect(await teams.run('request_shutdown', { to: 'alice' }, 'p:stop')).toBe(
      'alice has failed; there is nothing left to stop.',
    );
  });

  it('does not credit a user cancel to a call that never ran', async () => {
    await createTeam();
    await addMember('alice');
    // The H4f user cancel commits its stop under the revision-shaped id.
    await children.requestStop('run-alice');
    expect(teams.committedBy('request_shutdown', 'p:new')).toBe(false);
    expect(await teams.run('request_shutdown', { to: 'alice' }, 'p:new')).toBe(
      'alice is already being stopped. Delete the team once task_list shows it ended.',
    );
    expect(teams.committedBy('request_shutdown', 'p:new')).toBe(false);
  });

  it('reads its keyed stop after the stopped continuation fell back', async () => {
    await createTeam();
    await addMember('alice');
    await settle('run-alice');
    await children.sendToChild({
      taskId: children.taskIdOf('run-alice'),
      text: 'more work',
      messageId: 'msg_shut_more',
      continuationRunId: 'shut:more',
      executionCallId: 'shut:more',
      closing: false,
    });
    expect(await teams.run('request_shutdown', { to: 'alice' }, 'p:stop')).toBe(
      'alice is being stopped. Delete the team once task_list shows it ended.',
    );
    // The stopped continuation never starts and the head falls back, yet
    // the keyed stop evidence still credits the call that requested it.
    await children.settleCancelled('shut:more', { started: false });
    expect(teams.committedBy('request_shutdown', 'p:stop')).toBe(true);
  });

  it('answers the settled head when its settlement outraced the stop', async () => {
    await createTeam();
    await addMember('alice');
    const racing = new HostedTeamSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      {
        requestStop: async (childRunId) => {
          // The settlement beat the stop commit to the head's revision.
          await settle(childRunId);
          throw new ManagedSessionConflictError('the revision raced');
        },
      },
    );
    expect(
      await racing.run('request_shutdown', { to: 'alice' }, 'p:stop'),
    ).toBe(
      'alice has finished: it takes no work unless you send it some, so nothing needed stopping. Its run was not touched.',
    );
    expect(racing.committedBy('request_shutdown', 'p:stop')).toBe(false);
  });

  it('refuses a stop on a lane that carries no child funnel', async () => {
    await createTeam();
    await addMember('alice');
    const funnelless = new HostedTeamSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
    );
    expect(
      await refusal(
        funnelless.run('request_shutdown', { to: 'alice' }, 'p:stop'),
      ),
    ).toBe('alice cannot be stopped from this Session.');
  });
});

// H4e-b2 decision 2: a member is its continuation chain; the roster names
// the chain's first run and the member reads as its head.
describe('members through their continuation chains', () => {
  /** A send that continues or messages a member's chain, keyed by a call. */
  function sendTo(childRunId: string, text: string, callKey: string) {
    return children.sendToChild({
      taskId: children.taskIdOf(childRunId),
      text,
      messageId: `msg_${callKey.replace(':', '_')}`,
      continuationRunId: callKey,
      executionCallId: callKey,
      closing: false,
    });
  }

  async function line(name: string): Promise<string> {
    const listing = await teams.run('task_list', {}, 'turn:list');
    return listing.split('\n').find((each) => each.startsWith(`${name}: `))!;
  }

  it('reads a member from its chain head, through a continuation that never started', async () => {
    await createTeam();
    await addMember('alice');
    await settle('run-alice');
    expect(await sendTo('run-alice', 'fix it', 'turn-1:c1')).toMatchObject({
      kind: 'continuation',
    });
    expect(teams.memberView('run-alice').head?.childRunId).toBe('turn-1:c1');
    expect(await line('alice')).toBe(
      `alice: running — ${children.taskIdOf('turn-1:c1')}`,
    );
    expect(
      await refusal(teams.run('team_delete', {}, 'turn:delete')),
    ).toContain('still has running members: alice');
    await settle('turn-1:c1');
    // The next continuation is committed and messaged, then never starts.
    await sendTo('run-alice', 'and the docs', 'turn-2:c2');
    expect(
      await sendTo('turn-2:c2', 'also the changelog', 'turn-2:m1'),
    ).toMatchObject({ kind: 'message' });
    await children.settleFailed('turn-2:c2', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    expect(teams.memberView('run-alice').head?.childRunId).toBe('turn-1:c1');
    expect(await line('alice')).toBe(
      `alice: completed — ${children.taskIdOf('turn-1:c1')} (its latest continuation never started (creation_failed), so the work it carried did not arrive, nor did 1 message sent to it)`,
    );
    await teams.run(
      'task_create',
      { subject: 'docs', description: 'docs' },
      'turn:create',
    );
    // The work the never-started continuation carried did not arrive, so
    // the refusal has no branch that skips the send — even in its Turn.
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'alice' },
          'turn-2:own',
          'turn-2:',
        ),
      ),
    ).toBe(
      'Member "alice" has finished, and its latest continuation never started (creation_failed), so the work it carried did not arrive, nor did 1 message sent to it. Send that work again with send_message to "alice"; 1 message sent to it also did not arrive; resend it only if its own send_message answer has not already asked you to resend it. Then update the task in the same turn.',
    );
  });

  it('shows stop requests and keeps a stopped member off open work', async () => {
    await createTeam();
    await addMember('bob');
    await teams.run(
      'task_create',
      { subject: 'audit', description: 'audit' },
      'turn:create',
    );
    await children.requestStop('run-bob');
    expect(await line('bob')).toBe('bob: running (stopping)');
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'bob' },
          'turn:own-stopping',
        ),
      ),
    ).toBe(
      'Member "bob" is being stopped and cannot own a task. Launch a new member for this work.',
    );
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'completed', owner: 'bob' },
          'turn:complete-stopping',
        ),
      ),
    ).toBe(
      'Member "bob" is being stopped and has not completed a run yet. Complete the task with this owner only after task_list shows its run completed; otherwise record the member that did it, or "leader".',
    );
    await settle('run-bob');
    expect(await line('bob')).toBe('bob: completed (stop requested)');
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'bob' },
          'turn:own-stopped',
        ),
      ),
    ).toBe(
      'Member "bob" completed after a stop was requested, so it cannot be continued. If it did this task\'s work, set status "completed" with this owner; otherwise launch a new member for it.',
    );
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', status: 'completed', owner: 'bob' },
        'turn:done',
      ),
    ).toBe('Task #1 updated (status: completed, owner: bob).');
  });

  it('records a member that this Turn gave work, by a continuation or a message', async () => {
    await createTeam();
    await addMember('alice');
    await addMember('bob');
    await settle('run-alice');
    for (const subject of ['fix', 'test'])
      await teams.run(
        'task_create',
        { subject, description: subject },
        `turn:create-${subject}`,
      );
    // A continuation from turn-1 gave alice work: it is recorded whether
    // the continuation still runs or has completed since.
    await sendTo('run-alice', 'fix #1', 'turn-1:c1');
    await settle('turn-1:c1');
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', status: 'in_progress', owner: 'alice' },
        'turn-1:own',
        'turn-1:',
      ),
    ).toContain(
      'Task #1 updated (status: in_progress, owner: alice). "alice" was not notified: task_update records the board only. A send_message earlier in this turn gave alice work; if it did not carry this task, give it with send_message to "alice".',
    );
    // A message from turn-1 to running bob, handed over and read: bob is
    // recorded after it completed.
    const messages = new HostedSessionMessageSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      children,
      undefined,
    );
    await sendTo('run-bob', 'test #2', 'turn-1:m1');
    await children.dispatchStarted('run-bob', {
      dispatchId: 'dispatch-run-bob',
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    });
    await children.attach('run-bob', 'session-run-bob');
    await messages.handover('msg_turn-1_m1', 'session-run-bob');
    await messages.accepted(
      'msg_turn-1_m1',
      sessionMessageInputId('msg_turn-1_m1'),
    );
    await children.settleCompleted('run-bob', {
      result: Buffer.from('done', 'utf8'),
      receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
      messageCount: 1,
    });
    expect(
      await teams.run(
        'task_update',
        { taskId: '2', status: 'in_progress', owner: 'bob' },
        'turn-1:own-bob',
        'turn-1:',
      ),
    ).toContain('Task #2 updated (status: in_progress, owner: bob).');
    // A later Turn gave neither any work: one conditional refusal, which
    // never claims which task a past send carried.
    await teams.run(
      'task_update',
      { taskId: '2', status: 'pending', owner: '' },
      'turn-2:park',
      'turn-2:',
    );
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '2', status: 'in_progress', owner: 'bob' },
          'turn-2:own-bob',
          'turn-2:',
        ),
      ),
    ).toBe(
      'Member "bob" has finished. If it already did this task\'s work, from its launch prompt or a message you sent it, set status "completed" with this owner once its report is in. Otherwise give it the work with send_message to "bob" first, which continues it, and then update the task in the same turn.',
    );
  });

  it('keeps a stopped member off open work even after this Turn gave it work', async () => {
    await createTeam();
    await addMember('alice');
    await settle('run-alice');
    await teams.run(
      'task_create',
      { subject: 'fix', description: 'fix' },
      'turn:create',
    );
    await sendTo('run-alice', 'fix #1', 'turn-1:c1');
    await children.requestStop('turn-1:c1');
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'alice' },
          'turn-1:own',
          'turn-1:',
        ),
      ),
    ).toBe(
      // Stopped before it attached, the continuation may still end without
      // starting, which hands alice back to her first run.
      'Member "alice" is being stopped before its latest continuation started. If that continuation ends without starting, the member can take work again: check task_list once it settles.',
    );
    await children.dispatchStarted('turn-1:c1', {
      dispatchId: 'dispatch-turn-1:c1',
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    });
    await children.attach('turn-1:c1', 'session-turn-1:c1');
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'alice' },
          'turn-1:own-attached',
          'turn-1:',
        ),
      ),
    ).toBe(
      'Member "alice" is being stopped and cannot own a task. Launch a new member for this work.',
    );
    await children.settleCompleted('turn-1:c1', {
      result: Buffer.from('done', 'utf8'),
      receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
    });
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'alice' },
          'turn-1:own-again',
          'turn-1:',
        ),
      ),
    ).toContain('completed after a stop was requested');
  });

  it('reports a restated owner whose continuation is settling', async () => {
    await createTeam();
    await addMember('alice');
    await settle('run-alice');
    await teams.run(
      'task_create',
      { subject: 'fix', description: 'fix' },
      'turn:create',
    );
    await sendTo('run-alice', 'fix #1', 'turn-1:c1');
    await teams.run(
      'task_update',
      { taskId: '1', status: 'in_progress', owner: 'alice' },
      'turn-1:own',
      'turn-1:',
    );
    await children.requestStop('turn-1:c1');
    expect(
      await teams.run(
        'task_update',
        {
          taskId: '1',
          status: 'in_progress',
          owner: 'alice',
          description: 'fix it now',
        },
        'turn-1:restate',
        'turn-1:',
      ),
    ).toBe(
      'Task #1 updated (status: in_progress, owner: alice). "alice" was not notified: task_update records the board only. alice\'s latest continuation is being stopped before it started; if it ends without starting, alice can take work again. Check task_list once it settles.',
    );
  });

  it('refreshes the owner state after an update commit waits', async () => {
    await createTeam();
    await addMember('alice');
    await teams.run(
      'task_create',
      { subject: 'fix', description: 'fix' },
      'turn:create',
    );
    let entered!: () => void;
    const commitEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = new HostedTeamSession(
      {
        resources: session.resources,
        authority: Object.create(session.authority, {
          commitExtensionRecord: {
            value: async (
              ...args: Parameters<
                HostedTeamStore['authority']['commitExtensionRecord']
              >
            ) => {
              if (args[0].operation === 'updateTeamTask') {
                entered();
                await commitReleased;
              }
              return session.authority.commitExtensionRecord(...args);
            },
          },
        }),
      },
      sessionKey,
      children,
    );
    const update = delayed.run(
      'task_update',
      { taskId: '1', status: 'in_progress', owner: 'alice' },
      'turn:assign',
      'turn:',
    );
    await commitEntered;
    await children.settleFailed('run-alice', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    release();
    expect(await update).toBe(
      'Task #1 updated (status: in_progress, owner: alice). "alice" was not notified: task_update records the board only. alice cannot take more work: it has failed.',
    );
  });

  it('keeps a finished owner on a task this Turn gave it work for', async () => {
    await createTeam();
    await addMember('alice');
    await teams.run(
      'task_create',
      { subject: 'fix', description: 'fix' },
      'turn:create',
    );
    await teams.run(
      'task_update',
      { taskId: '1', status: 'in_progress', owner: 'alice' },
      'turn:own',
    );
    await settle('run-alice');
    await sendTo('run-alice', 'and the tests', 'turn-3:c1');
    await settle('turn-3:c1');
    // Moving the kept owner's task to another open status: accepted in
    // the Turn that gave the work, refused in a later one.
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', status: 'pending' },
        'turn-3:park',
        'turn-3:',
      ),
    ).toContain('Task #1 updated (status: pending, owner: alice).');
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress' },
          'turn-4:resume',
          'turn-4:',
        ),
      ),
    ).toContain('cannot keep task #1 open: it has finished');
  });

  it('does not count a message of this Turn that was cancelled', async () => {
    await createTeam();
    await addMember('bob');
    await teams.run(
      'task_create',
      { subject: 'test', description: 'test' },
      'turn:create',
    );
    const messages = new HostedSessionMessageSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      children,
      undefined,
    );
    await sendTo('run-bob', 'test it', 'turn-1:m1');
    await messages.settle('msg_turn-1_m1', 'cancelled');
    await children.dispatchStarted('run-bob', {
      dispatchId: 'dispatch-run-bob',
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    });
    await children.attach('run-bob', 'session-run-bob');
    await children.settleCompleted('run-bob', {
      result: Buffer.from('done', 'utf8'),
      receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
      messageCount: 1,
    });
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'bob' },
          'turn-1:own',
          'turn-1:',
        ),
      ),
    ).toContain('Member "bob" has finished. If it already did');
  });

  it('does not count a message of this Turn that its target rejected', async () => {
    await createTeam();
    await addMember('bob');
    await teams.run(
      'task_create',
      { subject: 'test', description: 'test' },
      'turn:create',
    );
    const messages = new HostedSessionMessageSession(
      { authority: session.authority, resources: session.resources },
      sessionKey,
      children,
      undefined,
    );
    await sendTo('run-bob', 'test it', 'turn-1:m1');
    await children.dispatchStarted('run-bob', {
      dispatchId: 'dispatch-run-bob',
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    });
    await children.attach('run-bob', 'session-run-bob');
    await messages.handover('msg_turn-1_m1', 'session-run-bob');
    await messages.settle('msg_turn-1_m1', 'rejected');
    await children.settleCompleted('run-bob', {
      result: Buffer.from('done', 'utf8'),
      receipt: Buffer.from('{"outcome":"settled"}', 'utf8'),
      messageCount: 1,
    });
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'bob' },
          'turn-1:own',
          'turn-1:',
        ),
      ),
    ).toContain('Member "bob" has finished. If it already did');
  });

  it('does not count the launch of this Turn as work given', async () => {
    // Decision 7 counts sends: a member launched and finished in this Turn
    // did the work its launch prompt carried, which the lead records as
    // completed once the report is in.
    await createTeam();
    await addMember('carol', 'turn-1:carol');
    await settle('turn-1:carol');
    await teams.run(
      'task_create',
      { subject: 'test', description: 'test' },
      'turn:create',
    );
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'carol' },
          'turn-1:own',
          'turn-1:',
        ),
      ),
    ).toContain('Member "carol" has finished. If it already did');
  });

  it('records an ended member on the task the call completes when a run of its chain completed', async () => {
    // #13846 records who did the work: alice's first run did task #1, so a
    // later continuation that failed, or one being stopped, does not take
    // that away.
    await createTeam();
    await addMember('alice');
    await addMember('bob');
    for (const subject of ['audit', 'fix'])
      await teams.run(
        'task_create',
        { subject, description: subject },
        `turn:create-${subject}`,
      );
    await settle('run-alice');
    await settle('run-bob');
    await sendTo('run-alice', 'more', 'turn-1:c1');
    await children.dispatchStarted('turn-1:c1', {
      dispatchId: 'dispatch-turn-1:c1',
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    });
    await children.attach('turn-1:c1', 'session-turn-1:c1');
    await children.settleFailed('turn-1:c1', {
      stopReason: 'child_failed',
      reason: null,
      started: true,
    });
    expect(
      await teams.run(
        'task_update',
        { taskId: '1', status: 'completed', owner: 'alice' },
        'turn-2:done',
        'turn-2:',
      ),
    ).toBe('Task #1 updated (status: completed, owner: alice).');
    await sendTo('run-bob', 'more', 'turn-1:c2');
    await children.dispatchStarted('turn-1:c2', {
      dispatchId: 'dispatch-turn-1:c2',
      runtime: { runtimeBindingId: 'binding-1', generation: '1' },
    });
    await children.attach('turn-1:c2', 'session-turn-1:c2');
    await children.requestStop('turn-1:c2');
    expect(
      await teams.run(
        'task_update',
        { taskId: '2', status: 'completed', owner: 'bob' },
        'turn-2:done-bob',
        'turn-2:',
      ),
    ).toBe('Task #2 updated (status: completed, owner: bob).');
    // Open work still needs a member that can take it.
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress' },
          'turn-2:reopen',
          'turn-2:',
        ),
      ),
    ).toBe(
      'Member "alice" cannot keep task #1 open: it has failed. Launch a new member for this work, set owner "" to unassign it, or assign "leader".',
    );
  });

  it('answers an update that restates its owner by what the member can take', async () => {
    await createTeam();
    await addMember('alice');
    await addMember('bob');
    for (const subject of ['fix', 'test'])
      await teams.run(
        'task_create',
        { subject, description: subject },
        `turn:create-${subject}`,
      );
    await settle('run-alice');
    // The send and the owner land together, then the continuation never
    // starts: restating the owner is not checked again, so the answer must
    // not suggest the work may already be there.
    await sendTo('run-alice', 'fix #1', 'turn-1:c1');
    await teams.run(
      'task_update',
      { taskId: '1', status: 'in_progress', owner: 'alice' },
      'turn-1:own',
      'turn-1:',
    );
    await children.settleFailed('turn-1:c1', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    expect(
      await teams.run(
        'task_update',
        {
          taskId: '1',
          status: 'in_progress',
          owner: 'alice',
          description: 'fix it now',
        },
        'turn-1:restate',
        'turn-1:',
      ),
    ).toBe(
      'Task #1 updated (status: in_progress, owner: alice). "alice" was not notified: task_update records the board only. Its latest continuation never started (creation_failed), so the work it carried did not arrive. Send that work again with send_message to "alice".',
    );
    // A member that ended is never pointed to a send.
    await teams.run(
      'task_update',
      { taskId: '2', status: 'in_progress', owner: 'bob' },
      'turn-1:own-bob',
      'turn-1:',
    );
    await children.settleFailed('run-bob', {
      stopReason: 'creation_failed',
      reason: null,
      started: false,
    });
    expect(
      await teams.run(
        'task_update',
        { taskId: '2', owner: 'bob', description: 'test it now' },
        'turn-1:restate-bob',
        'turn-1:',
      ),
    ).toBe(
      'Task #2 updated (status: in_progress, owner: bob). "bob" was not notified: task_update records the board only. bob cannot take more work: it has failed.',
    );
  });

  it('counts only work given to the member itself', async () => {
    await createTeam();
    await addMember('alice');
    await addMember('bob');
    await teams.run(
      'task_create',
      { subject: 'fix', description: 'fix' },
      'turn:create',
    );
    await settle('run-alice');
    await settle('run-bob');
    // This Turn gave bob work, not alice.
    await sendTo('run-bob', 'fix #1', 'turn-1:c1');
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'alice' },
          'turn-1:own',
          'turn-1:',
        ),
      ),
    ).toContain('Member "alice" has finished. If it already did');
  });

  it('refuses team_delete while a member is being stopped', async () => {
    await createTeam();
    await addMember('alice');
    await children.requestStop('run-alice');
    expect(
      await refusal(teams.run('team_delete', {}, 'turn:delete')),
    ).toContain('still has running members: alice');
  });

  it('asks again for the work of a continuation a user cancelled before it started only if still wanted', async () => {
    await createTeam();
    await addMember('alice');
    await teams.run(
      'task_create',
      { subject: 'fix', description: 'fix' },
      'turn:create',
    );
    await settle('run-alice');
    await sendTo('run-alice', 'fix #1', 'turn-1:c1');
    await children.requestStop('turn-1:c1');
    await children.settleCancelled('turn-1:c1', { started: false });
    expect(await line('alice')).toBe(
      `alice: completed — ${children.taskIdOf('run-alice')} (its latest continuation was cancelled before it started (stop_requested), so the work it carried did not arrive)`,
    );
    expect(
      await refusal(
        teams.run(
          'task_update',
          { taskId: '1', status: 'in_progress', owner: 'alice' },
          'turn-2:own',
          'turn-2:',
        ),
      ),
    ).toBe(
      'Member "alice" has finished, and its latest continuation was cancelled before it started (stop_requested), so the work it carried did not arrive. If that work is still wanted, send it again with send_message to "alice". Then update the task in the same turn.',
    );
  });
});
