/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../../config/storage.js';
import { createAssignedThread, postMessage } from './thread-actions.js';
import { finishRunInTransaction } from './run-lifecycle.js';
import {
  AGENT_HOST_REMOVED,
  AGENT_PROGRAM_UNAVAILABLE,
  DEFAULT_RUN_LEASE_MS,
  applyHostRunResult,
  parseHostRunSteps,
  pickupRunForHost,
  removeAgentHost,
  renewRunLease,
  reportHostRunProgress,
} from './host-lease.js';
import {
  authenticateAgentHost,
  getAgentsFilePath,
  getAgentHostsFilePath,
  readAgentHosts,
  heartbeatAgentHost,
  createThread,
  enrollAgentHost,
  issueAgentHostEnrollment,
  readThread,
  readWorkspaceAgents,
  updateWorkspaceAgents,
  withAgentStoreTransaction,
  writeThread,
} from './store.js';
import {
  AGENT_PROGRAM_LABELS,
  type AgentProgram,
  type ThreadRun,
  type WorkspaceAgent,
} from './types.js';

const renameFailure = vi.hoisted(() => ({
  path: undefined as string | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (args[1] === renameFailure.path)
        throw new Error('binding write failed');
      return actual.rename(...args);
    },
  };
});

const PROJECT_ROOT = '/host-lease-test';
const T0 = 1_000_000;

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'host-lease-test-'));
  Storage.setRuntimeBaseDir(runtimeDir);
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

async function host(name: string, programs: AgentProgram[]) {
  return (await enroll(name, programs)).id;
}

async function enroll(name: string, programs: AgentProgram[]) {
  const { token } = await issueAgentHostEnrollment(PROJECT_ROOT);
  const { host: enrolled, secret } = await enrollAgentHost(PROJECT_ROOT, {
    token,
    name,
    workspaceCwd: `/work/${name}`,
    providers: programs.map((program) => AGENT_PROGRAM_LABELS[program]),
  });
  return { id: enrolled.id, secret };
}

async function placeAgent(hostIds: string[], provider?: AgentProgram) {
  const agent: WorkspaceAgent = {
    id: 'ag_remote',
    name: 'remote',
    createdAt: 1,
    execution: {
      mode: 'managed-host',
      hostIds,
      ...(provider ? { provider } : {}),
    },
  };
  await updateWorkspaceAgents(PROJECT_ROOT, () => [agent]);
  return agent;
}

function queuedRun(): ThreadRun {
  return {
    id: 'rn_1',
    agentId: 'ag_remote',
    status: 'queued',
    triggerMessageIds: [],
    acceptedMessageIds: [],
    consumedMessageIds: [],
    usageByRound: [],
    queueSequence: 1,
    queuedAt: T0,
    attempts: 0,
  };
}

async function seedQueued(): Promise<string> {
  const created = await createThread(PROJECT_ROOT, { title: 'Build it' });
  await writeThread(PROJECT_ROOT, {
    ...created,
    status: 'in_progress',
    runs: [queuedRun()],
  });
  return created.id;
}

describe('pickupRunForHost', () => {
  it('consumes follow-ups included when replaying a held lease', async () => {
    const mine = await host('mine', ['qwen']);
    const agent = await placeAgent([mine]);
    const { thread: created } = await createAssignedThread(PROJECT_ROOT, {
      title: 'Inspect both requests',
      assignee: agent,
      message: 'Inspect the initial request.',
    });
    const threadId = created.id;
    const first = (await pickupRunForHost(PROJECT_ROOT, mine, T0))!;
    const followup = await postMessage(PROJECT_ROOT, threadId, {
      from: 'user',
      text: '@remote Also inspect the follow-up.',
    });
    expect(followup.outcomes[0]?.decision.kind).toBe('coalesce');

    const replay = (await pickupRunForHost(PROJECT_ROOT, mine, T0 + 1))!;
    expect(replay.lease.leaseId).not.toBe(first.lease.leaseId);
    expect(replay.attempt).toBe(first.attempt + 1);
    expect(replay.prompt).toContain('Also inspect the follow-up.');
    expect(
      await applyHostRunResult(
        PROJECT_ROOT,
        {
          threadId,
          runId: replay.runId,
          hostId: mine,
          leaseId: replay.lease.leaseId,
          attempt: replay.attempt,
          status: 'completed',
          close: { kind: 'review', summary: 'Both requests inspected.' },
        },
        T0 + 2,
      ),
    ).toMatchObject({ ok: true });

    const thread = (await readThread(PROJECT_ROOT, threadId))!;
    expect(thread.runs).toHaveLength(1);
    expect(thread.runs[0]?.consumedMessageIds).toContain(followup.message.id);
    expect(thread.deliveryByAgent['ag_remote']?.committedThroughSequence).toBe(
      replay.contextThroughSequence,
    );
  });

  it('leases a queued run to its host only, starting a new attempt', async () => {
    const mine = await host('mine', ['qwen']);
    const other = await host('other', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();

    await expect(pickupRunForHost(PROJECT_ROOT, other, T0)).resolves.toBe(
      undefined,
    );
    const assignment = await pickupRunForHost(PROJECT_ROOT, mine, T0);

    expect(assignment).toMatchObject({ threadId, runId: 'rn_1', attempt: 1 });
    expect(assignment?.lease).toMatchObject({
      hostId: mine,
      attempt: 1,
      expiresAt: T0 + DEFAULT_RUN_LEASE_MS,
    });
    const run = (await readThread(PROJECT_ROOT, threadId))?.runs[0];
    expect(run).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('leaves a run for a host that has its program', async () => {
    const qwenOnly = await host('qwen-only', ['qwen']);
    const withCodex = await host('with-codex', ['qwen', 'codex']);
    await placeAgent([qwenOnly, withCodex], 'codex');
    await seedQueued();

    await expect(pickupRunForHost(PROJECT_ROOT, qwenOnly, T0)).resolves.toBe(
      undefined,
    );
    await expect(
      pickupRunForHost(PROJECT_ROOT, withCodex, T0),
    ).resolves.toMatchObject({ runId: 'rn_1' });
  });

  it('fails a run no host of its agent can run, instead of leaving it queued', async () => {
    const qwenOnly = await host('qwen-only', ['qwen']);
    await placeAgent([qwenOnly], 'codex');
    const threadId = await seedQueued();

    await expect(pickupRunForHost(PROJECT_ROOT, qwenOnly, T0)).resolves.toBe(
      undefined,
    );
    const run = (await readThread(PROJECT_ROOT, threadId))?.runs[0];
    expect(run).toMatchObject({
      status: 'failed',
      error: AGENT_PROGRAM_UNAVAILABLE,
    });
  });
});

describe('leases', () => {
  it.each(['same host restart', 'expired lease takeover'])(
    'charges each execution after %s and rejects the old result',
    async (replay) => {
      const firstHost = await host('first', ['qwen']);
      const secondHost = await host('second', ['qwen']);
      await placeAgent([firstHost, secondHost]);
      const threadId = await seedQueued();
      const startedAt = Date.now();
      const first = (await pickupRunForHost(
        PROJECT_ROOT,
        firstHost,
        startedAt,
      ))!;
      const firstIdentity = {
        threadId,
        runId: first.runId,
        hostId: firstHost,
        leaseId: first.lease.leaseId,
        attempt: first.attempt,
      };
      await expect(
        reportHostRunProgress(PROJECT_ROOT, {
          ...firstIdentity,
          sequence: 1,
          stage: 'thinking',
          detail: '',
          tokens: 1_050,
        }),
      ).resolves.toEqual({ ok: true });
      const at =
        startedAt +
        (replay === 'same host restart' ? 1 : DEFAULT_RUN_LEASE_MS + 1);
      const next = (await pickupRunForHost(
        PROJECT_ROOT,
        replay === 'same host restart' ? firstHost : secondHost,
        at,
      ))!;
      expect(next.attempt).toBe(first.attempt + 1);
      const result = {
        status: 'completed' as const,
        close: { kind: 'review' as const, summary: 'Marker read.' },
        tokens: 1_050,
      };
      const reclaimed = await readThread(PROJECT_ROOT, threadId);
      await expect(
        applyHostRunResult(PROJECT_ROOT, { ...firstIdentity, ...result }, at),
      ).resolves.toMatchObject({ ok: false });
      expect(await readThread(PROJECT_ROOT, threadId)).toEqual(reclaimed);
      await expect(
        applyHostRunResult(
          PROJECT_ROOT,
          {
            ...firstIdentity,
            hostId: next.lease.hostId,
            leaseId: next.lease.leaseId,
            attempt: next.attempt,
            ...result,
          },
          at,
        ),
      ).resolves.toMatchObject({ ok: true });
      const thread = (await readThread(PROJECT_ROOT, threadId))!;
      const run = thread.runs[0];
      expect(run.usageByRound.map((usage) => usage.tokens)).toEqual([
        1_050, 1_050,
      ]);
      expect(thread.tokensUsed).toBe(2_100);
    },
  );

  it('will not revive an expired lease', async () => {
    const mine = await host('mine', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();
    const assignment = (await pickupRunForHost(PROJECT_ROOT, mine, T0))!;

    const late = T0 + DEFAULT_RUN_LEASE_MS + 1;
    await expect(
      renewRunLease(
        PROJECT_ROOT,
        { threadId, runId: 'rn_1', leaseId: assignment.lease.leaseId },
        late,
      ),
    ).resolves.toEqual({ ok: false, reason: 'stale_lease' });
  });

  it('refuses a late result once the run was leased again', async () => {
    const mine = await host('mine', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();
    const first = (await pickupRunForHost(PROJECT_ROOT, mine, T0))!;
    const later = T0 + DEFAULT_RUN_LEASE_MS + 1;
    const second = (await pickupRunForHost(PROJECT_ROOT, mine, later))!;
    expect(second.lease.leaseId).not.toBe(first.lease.leaseId);

    await expect(
      applyHostRunResult(
        PROJECT_ROOT,
        {
          threadId,
          runId: 'rn_1',
          hostId: mine,
          leaseId: first.lease.leaseId,
          attempt: first.attempt,
          status: 'completed',
        },
        later + 1,
      ),
    ).resolves.toEqual({ ok: false, reason: 'attempt_moved_on' });
  });

  it('requeues a follow-up that a failed Host turn never received', async () => {
    const mine = await host('mine', ['qwen']);
    const agent = await placeAgent([mine]);
    const { thread: created } = await createAssignedThread(PROJECT_ROOT, {
      title: 'Inspect requests',
      assignee: agent,
      message: 'Inspect the initial request.',
    });
    const assignment = (await pickupRunForHost(PROJECT_ROOT, mine, T0))!;
    const followup = await postMessage(PROJECT_ROOT, created.id, {
      from: 'user',
      text: '@remote Also inspect the follow-up.',
    });

    await applyHostRunResult(
      PROJECT_ROOT,
      {
        threadId: created.id,
        runId: assignment.runId,
        hostId: mine,
        leaseId: assignment.lease.leaseId,
        attempt: assignment.attempt,
        status: 'failed',
        error: 'Host execution failed.',
      },
      T0 + 1,
    );

    const thread = (await readThread(PROJECT_ROOT, created.id))!;
    const successor = thread.runs.find((run) => run.status === 'queued');
    expect(successor?.triggerMessageIds).toContain(followup.message.id);
    expect(
      thread.messages
        .find((message) => message.id === followup.message.id)
        ?.outcomes.find((outcome) => outcome.targetAgentId === agent.id)?.runId,
    ).toBe(successor?.id);
  });
});

describe('Host result receipts', () => {
  it.each([0, 1_050])(
    'recognizes only an accepted exact retry with %i tokens',
    async (tokens) => {
      const mine = await host('mine', ['qwen']);
      await placeAgent([mine]);
      const threadId = await seedQueued();
      const assignment = (await pickupRunForHost(PROJECT_ROOT, mine, T0))!;
      const input = {
        threadId,
        runId: assignment.runId,
        hostId: mine,
        leaseId: assignment.lease.leaseId,
        attempt: assignment.attempt,
        status: 'completed' as const,
        close: { kind: 'review' as const, summary: 'Accepted answer.' },
        tokens,
      };
      await expect(
        applyHostRunResult(PROJECT_ROOT, input, T0 + 1),
      ).resolves.toMatchObject({
        ok: true,
        value: { alreadyApplied: false },
      });
      const accepted = (await readThread(PROJECT_ROOT, threadId))!;
      expect(accepted.tokensUsed).toBe(tokens);
      expect(accepted.runs[0].hostResultReceipt).toMatchObject({
        attempt: assignment.attempt,
        leaseId: assignment.lease.leaseId,
      });
      await expect(
        applyHostRunResult(
          PROJECT_ROOT,
          {
            ...input,
            close: { summary: input.close.summary, kind: input.close.kind },
          },
          T0 + DEFAULT_RUN_LEASE_MS + 1,
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { alreadyApplied: true },
      });
      await expect(
        applyHostRunResult(
          PROJECT_ROOT,
          {
            ...input,
            close: { kind: 'review', summary: 'Different answer.' },
            tokens: tokens + 1,
          },
          T0 + DEFAULT_RUN_LEASE_MS + 2,
        ),
      ).resolves.toEqual({ ok: false, reason: 'stale_lease' });
      expect(await readThread(PROJECT_ROOT, threadId)).toEqual(accepted);
    },
  );

  it('refuses a retry that differs in any one receipt term', async () => {
    const mine = await host('mine', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();
    const assignment = (await pickupRunForHost(PROJECT_ROOT, mine, T0))!;
    const input = {
      threadId,
      runId: assignment.runId,
      hostId: mine,
      leaseId: assignment.lease.leaseId,
      attempt: assignment.attempt,
      status: 'completed' as const,
      close: { kind: 'review' as const, summary: 'Accepted answer.' },
      tokens: 1_050,
    };
    await expect(
      applyHostRunResult(PROJECT_ROOT, input, T0 + 1),
    ).resolves.toMatchObject({ ok: true, value: { alreadyApplied: false } });
    const accepted = (await readThread(PROJECT_ROOT, threadId))!;
    // One field per re-post. The identity fields are matched before the digest
    // is compared, so these are the terms only the digest can tell apart.
    const variants = [
      { ...input, status: 'failed' as const },
      { ...input, error: 'Different error.' },
      { ...input, tokens: 1_051 },
      { ...input, close: { kind: 'review' as const, summary: 'Different.' } },
      {
        ...input,
        close: { kind: 'blocked' as const, question: input.close.summary },
      },
    ];
    for (const variant of variants) {
      await expect(
        applyHostRunResult(
          PROJECT_ROOT,
          variant,
          T0 + DEFAULT_RUN_LEASE_MS + 2,
        ),
      ).resolves.toEqual({ ok: false, reason: 'stale_lease' });
      expect(await readThread(PROJECT_ROOT, threadId)).toEqual(accepted);
    }
  });

  it('acks no receipt for a result that a cancellation discarded', async () => {
    const mine = await host('mine', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();
    const assignment = (await pickupRunForHost(PROJECT_ROOT, mine, T0))!;
    const input = {
      threadId,
      runId: assignment.runId,
      hostId: mine,
      leaseId: assignment.lease.leaseId,
      attempt: assignment.attempt,
      status: 'completed' as const,
      close: { kind: 'review' as const, summary: 'Never posted.' },
      tokens: 1_050,
    };
    // A cancel keeps the lease, so the Host's result still arrives inside its
    // window. Settlement overrides the status to `cancelled` and the closing
    // tool is skipped, because only a `running` run posts its answer, so the
    // summary never reaches the thread.
    await withAgentStoreTransaction(PROJECT_ROOT, async (transaction) => {
      const current = (await transaction.readThread(threadId))!;
      await transaction.writeThread({
        ...current,
        runs: current.runs.map((run) => ({ ...run, status: 'cancelling' })),
      });
    });

    await expect(
      applyHostRunResult(PROJECT_ROOT, input, T0 + 1),
    ).resolves.toMatchObject({ ok: true, value: { alreadyApplied: false } });
    const cancelled = (await readThread(PROJECT_ROOT, threadId))!;
    expect(cancelled.runs[0]?.status).toBe('cancelled');
    expect(cancelled.runs[0]?.hostResultReceipt).toBeUndefined();
    expect(cancelled.messages.map((message) => message.text)).not.toContain(
      'Never posted.',
    );

    // An exact re-post is the retry a Host makes when the first response was
    // lost. It must not be told its discarded answer was applied.
    await expect(
      applyHostRunResult(PROJECT_ROOT, input, T0 + 2),
    ).resolves.toEqual({ ok: false, reason: 'stale_lease' });
    expect((await readThread(PROJECT_ROOT, threadId))?.tokensUsed).toBe(1_050);
  });

  it.each(['recovery', 'cancellation'] as const)(
    'refuses late usage after %s without moving the ledger',
    async (reason) => {
      const mine = await host('mine', ['qwen']);
      await placeAgent([mine]);
      const parent = await createThread(PROJECT_ROOT, { title: 'Parent' });
      const child = await createThread(PROJECT_ROOT, {
        title: 'Child',
        parentThreadId: parent.id,
      });
      await writeThread(PROJECT_ROOT, {
        ...child,
        status: 'in_progress',
        runs: [queuedRun()],
      });
      const now = Date.now();
      const assignment = (await pickupRunForHost(PROJECT_ROOT, mine, now))!;
      const identity = {
        threadId: child.id,
        runId: assignment.runId,
        hostId: mine,
        leaseId: assignment.lease.leaseId,
        attempt: assignment.attempt,
      };
      await reportHostRunProgress(PROJECT_ROOT, {
        ...identity,
        sequence: 1,
        stage: 'thinking',
        detail: '',
        tokens: 100,
      });
      const terminal = await withAgentStoreTransaction(
        PROJECT_ROOT,
        async (transaction) => {
          if (reason === 'cancellation') {
            const current = (await transaction.readThread(child.id))!;
            await transaction.writeThread({
              ...current,
              runs: current.runs.map((run) => ({
                ...run,
                status: 'cancelling',
              })),
            });
          }
          return finishRunInTransaction(transaction, {
            threadId: child.id,
            runId: assignment.runId,
            outcome: {
              status: 'failed',
              attempt: assignment.attempt,
              error: 'Recovery expired.',
              failureStage: 'recovery',
            },
            now: assignment.lease.expiresAt + 2 * DEFAULT_RUN_LEASE_MS,
          });
        },
      );
      expect(terminal.outbox).toHaveLength(1);
      const input = {
        ...identity,
        status: 'completed' as const,
        close: { kind: 'review' as const, summary: 'Must not appear.' },
        tokens: 1_050,
      };
      // Settlement ends the attempt's write authority over spend too: not even
      // the transport's maximum admissible count may move `tokensUsed`, which
      // is what tree budget enforcement reads to cancel unrelated live runs.
      for (const tokens of [1_050, 900, 1_000_000_000]) {
        await expect(
          applyHostRunResult(
            PROJECT_ROOT,
            { ...input, tokens },
            assignment.lease.expiresAt + 2 * DEFAULT_RUN_LEASE_MS + 1,
          ),
        ).resolves.toEqual({ ok: false, reason: 'stale_lease' });
        expect(await readThread(PROJECT_ROOT, child.id)).toEqual(terminal);
      }
    },
  );

  it('does not account a result after its Host was removed', async () => {
    const mine = await host('mine', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();
    const assignment = (await pickupRunForHost(PROJECT_ROOT, mine, T0))!;
    await removeAgentHost(PROJECT_ROOT, mine);
    const removed = await readThread(PROJECT_ROOT, threadId);
    await expect(
      applyHostRunResult(
        PROJECT_ROOT,
        {
          threadId,
          runId: assignment.runId,
          hostId: mine,
          leaseId: assignment.lease.leaseId,
          attempt: assignment.attempt,
          status: 'completed',
          tokens: 1_050,
        },
        T0 + 1,
      ),
    ).resolves.toEqual({ ok: false, reason: 'stale_lease' });
    expect(await readThread(PROJECT_ROOT, threadId)).toEqual(removed);
  });
});

describe('host progress steps', () => {
  it('refuses oversized or malformed step lists from a host', () => {
    const step = { id: 's', title: 'Read a.ts', status: 'done' };
    expect(parseHostRunSteps(undefined)).toBeUndefined();
    expect(parseHostRunSteps([step])).toEqual([step]);
    expect(parseHostRunSteps(Array(9).fill(step))).toBe('invalid');
    expect(parseHostRunSteps([{ ...step, status: 'pending' }])).toBe('invalid');
    expect(parseHostRunSteps([{ ...step, title: 'x'.repeat(201) }])).toBe(
      'invalid',
    );
  });

  it('stores the steps a host reports with its progress', async () => {
    const mine = await host('mine', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();
    const assignment = (await pickupRunForHost(PROJECT_ROOT, mine))!;
    const steps: NonNullable<NonNullable<ThreadRun['progress']>['steps']> = [
      { id: 's1', title: 'Shell: npm test', status: 'running' },
    ];

    await expect(
      reportHostRunProgress(PROJECT_ROOT, {
        threadId,
        runId: 'rn_1',
        hostId: mine,
        leaseId: assignment.lease.leaseId,
        attempt: assignment.attempt,
        sequence: 2,
        stage: 'tool',
        detail: 'Shell: npm test',
        steps,
      }),
    ).resolves.toEqual({ ok: true });
    const run = (await readThread(PROJECT_ROOT, threadId))?.runs[0];
    expect(run?.progress?.steps).toEqual(steps);
  });

  it('charges the spend a host reports, and never lowers it', async () => {
    // A remote run used to be charged nothing, so a tree could spend past its
    // budget on another machine without admission or the running check seeing
    // it.
    const mine = await host('mine', ['qwen']);
    await placeAgent([mine]);
    const threadId = await seedQueued();
    const assignment = (await pickupRunForHost(PROJECT_ROOT, mine))!;
    const report = (sequence: number, tokens: number) =>
      reportHostRunProgress(PROJECT_ROOT, {
        threadId,
        runId: 'rn_1',
        hostId: mine,
        leaseId: assignment.lease.leaseId,
        attempt: assignment.attempt,
        sequence,
        stage: 'responding',
        detail: '',
        tokens,
      });

    await report(2, 1_200);
    await report(3, 900);
    let run = (await readThread(PROJECT_ROOT, threadId))?.runs[0];
    expect(run?.usageByRound).toEqual([
      { attempt: assignment.attempt, round: 1, tokens: 1_200 },
    ]);

    await applyHostRunResult(PROJECT_ROOT, {
      threadId,
      runId: 'rn_1',
      hostId: mine,
      leaseId: assignment.lease.leaseId,
      attempt: assignment.attempt,
      status: 'completed',
      close: { kind: 'review', summary: 'done' },
      tokens: 2_000,
    });
    run = (await readThread(PROJECT_ROOT, threadId))?.runs[0];
    expect(run?.status).toBe('completed');
    expect(run?.usageByRound).toEqual([
      { attempt: assignment.attempt, round: 1, tokens: 2_000 },
    ]);
  });
});

describe('removeAgentHost', () => {
  it('revokes the host, unbinds its agents and ends the run it held', async () => {
    const lost = await enroll('lost', ['qwen']);
    await placeAgent([lost.id]);
    const threadId = await seedQueued();
    await pickupRunForHost(PROJECT_ROOT, lost.id, T0);

    await expect(removeAgentHost(PROJECT_ROOT, lost.id)).resolves.toEqual({
      removed: true,
      agentsMadeLocal: ['ag_remote'],
      runsEnded: 1,
    });

    await expect(
      authenticateAgentHost(PROJECT_ROOT, lost.id, lost.secret),
    ).resolves.toBeUndefined();
    const [agent] = await readWorkspaceAgents(PROJECT_ROOT);
    expect(agent?.execution).toEqual({ mode: 'local' });
    const run = (await readThread(PROJECT_ROOT, threadId))?.runs[0];
    expect(run).toMatchObject({ status: 'failed', error: AGENT_HOST_REMOVED });
    await expect(removeAgentHost(PROJECT_ROOT, lost.id)).resolves.toEqual({
      removed: false,
    });
  });

  it('keeps an agent on its remaining hosts', async () => {
    const lost = await host('lost', ['qwen']);
    const kept = await host('kept', ['qwen']);
    await placeAgent([lost, kept]);

    await expect(removeAgentHost(PROJECT_ROOT, lost)).resolves.toMatchObject({
      removed: true,
      agentsMadeLocal: [],
    });
    const [agent] = await readWorkspaceAgents(PROJECT_ROOT);
    expect(agent?.execution).toEqual({ mode: 'managed-host', hostIds: [kept] });
  });
});

describe('explicit Agent Host replacement', () => {
  it('migrates only selected bindings, settles old runs and refuses old credentials and late results', async () => {
    const old = await enroll('worker', ['qwen']);
    const sibling = await enroll('worker', ['qwen']);
    await placeAgent([old.id, sibling.id], 'qwen');
    const runningId = await seedQueued();
    const assignment = (await pickupRunForHost(PROJECT_ROOT, old.id, T0))!;
    const finishing = await createThread(PROJECT_ROOT, {
      title: 'Already finishing',
    });
    await writeThread(PROJECT_ROOT, {
      ...finishing,
      runs: [
        {
          ...assignmentToRun(assignment),
          id: 'rn_finishing',
          status: 'finishing',
          closeKind: 'review',
        },
      ],
    });
    const { token } = await issueAgentHostEnrollment(PROJECT_ROOT, old.id);
    await expect(
      heartbeatAgentHost(PROJECT_ROOT, old.id, old.secret, {
        workspaceCwd: '/work/worker',
        providers: ['Qwen Code ACP'],
        enrollmentToken: token,
      }),
    ).rejects.toThrow('Agent Host replacement requires enrollment.');
    const replacement = await enrollAgentHost(PROJECT_ROOT, {
      token,
      name: 'worker',
      workspaceCwd: '/work/worker',
      providers: ['Qwen Code ACP'],
    });
    expect(replacement.host.id).not.toBe(old.id);
    expect((await readWorkspaceAgents(PROJECT_ROOT))[0]?.execution).toEqual({
      mode: 'managed-host',
      hostIds: [replacement.host.id, sibling.id],
      provider: 'qwen',
    });
    expect((await readThread(PROJECT_ROOT, runningId))?.runs[0]).toMatchObject({
      status: 'failed',
      error: AGENT_HOST_REMOVED,
    });
    expect(
      (await readThread(PROJECT_ROOT, finishing.id))?.runs[0]?.status,
    ).toBe('completed');
    expect(
      (await readAgentHosts(PROJECT_ROOT)).map((entry) => entry.id).sort(),
    ).toEqual([sibling.id, replacement.host.id].sort());
    await expect(
      authenticateAgentHost(PROJECT_ROOT, old.id, old.secret),
    ).resolves.toBeUndefined();
    await expect(
      authenticateAgentHost(PROJECT_ROOT, sibling.id, sibling.secret),
    ).resolves.toMatchObject({ id: sibling.id });
    await expect(
      authenticateAgentHost(
        PROJECT_ROOT,
        replacement.host.id,
        replacement.secret,
      ),
    ).resolves.toMatchObject({ id: replacement.host.id });
    expect(
      (
        await applyHostRunResult(PROJECT_ROOT, {
          threadId: runningId,
          runId: assignment.runId,
          hostId: old.id,
          leaseId: assignment.lease.leaseId,
          attempt: assignment.attempt,
          status: 'completed',
        })
      ).ok,
    ).toBe(false);
    await expect(
      enrollAgentHost(PROJECT_ROOT, {
        token,
        name: 'replay',
        workspaceCwd: '/work/worker',
        providers: ['Qwen Code ACP'],
      }),
    ).rejects.toThrow('Invalid or expired');
  });

  it('fails closed for missing, foreign and invalid replacement targets or tokens', async () => {
    const old = await enroll('old', ['qwen']);
    await expect(
      issueAgentHostEnrollment('/another-workspace', old.id),
    ).rejects.toThrow('not found');
    const { token } = await issueAgentHostEnrollment(PROJECT_ROOT, old.id);
    await expect(
      enrollAgentHost(PROJECT_ROOT, {
        token: 'wrong-token',
        name: 'new',
        workspaceCwd: '/work/new',
        providers: ['Qwen Code ACP'],
      }),
    ).rejects.toThrow('Invalid or expired');
    expect(
      (await readAgentHosts(PROJECT_ROOT)).map((entry) => entry.id),
    ).toEqual([old.id]);
    await removeAgentHost(PROJECT_ROOT, old.id);
    await expect(
      enrollAgentHost(PROJECT_ROOT, {
        token,
        name: 'new',
        workspaceCwd: '/work/new',
        providers: ['Qwen Code ACP'],
      }),
    ).rejects.toThrow('not found');
  });

  it('refreshes an expired interrupted replacement without losing its staged identity or bindings', async () => {
    const old = await enroll('old', ['qwen']);
    await placeAgent([old.id]);
    const { token } = await issueAgentHostEnrollment(PROJECT_ROOT, old.id);
    renameFailure.path = getAgentsFilePath(PROJECT_ROOT);
    const input = {
      token,
      name: 'new',
      workspaceCwd: '/work/new',
      providers: ['Qwen Code ACP'],
    };
    try {
      await expect(enrollAgentHost(PROJECT_ROOT, input)).rejects.toThrow(
        'binding write failed',
      );
    } finally {
      renameFailure.path = undefined;
    }
    const staged = (await readAgentHosts(PROJECT_ROOT)).find(
      (entry) => entry.id !== old.id,
    )!;
    const registryPath = getAgentHostsFilePath(PROJECT_ROOT);
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    registry.enrollment.expiresAt = Date.now() - 1;
    await fs.writeFile(registryPath, JSON.stringify(registry));
    await expect(enrollAgentHost(PROJECT_ROOT, input)).rejects.toThrow(
      'Invalid or expired',
    );
    await expect(issueAgentHostEnrollment(PROJECT_ROOT)).rejects.toThrow(
      `select "old" (${old.id}) in Runtimes, choose Replace`,
    );
    await expect(removeAgentHost(PROJECT_ROOT, old.id)).rejects.toThrow(
      `select "old" (${old.id}) in Runtimes, choose Replace`,
    );
    const refreshed = await issueAgentHostEnrollment(PROJECT_ROOT, old.id);
    expect(refreshed.replacementHostId).toBe(staged.id);
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
    await expect(enrollAgentHost(PROJECT_ROOT, input)).rejects.toThrow(
      'Invalid or expired',
    );
    const replacement = await enrollAgentHost(PROJECT_ROOT, {
      ...input,
      token: refreshed.token,
    });
    expect(replacement.host.id).toBe(staged.id);
    expect(
      (await readAgentHosts(PROJECT_ROOT)).map((entry) => entry.id),
    ).toEqual([staged.id]);
    expect((await readWorkspaceAgents(PROJECT_ROOT))[0]?.execution).toEqual({
      mode: 'managed-host',
      hostIds: [staged.id],
    });
  });
});

function assignmentToRun(
  assignment: NonNullable<Awaited<ReturnType<typeof pickupRunForHost>>>,
): ThreadRun {
  return {
    ...queuedRun(),
    id: assignment.runId,
    status: 'running',
    attempts: assignment.attempt,
    lease: assignment.lease,
  };
}
