/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Leases for outbound Host execution (plan P4).
 *
 * A managed Host reaches out; nothing reaches in. That means the daemon cannot
 * tell a Host that is thinking from one whose network died, so work it holds
 * has to become available again on its own. The danger in doing that is the
 * obvious one: the first Host comes back and writes its result over work a
 * second Host has since done.
 *
 * A lease is what makes reclaiming safe. Re-acquiring mints a new `leaseId`,
 * and every write is checked against both the id and the run attempt, so a
 * worker holding a stale lease is refused rather than believed. That check is
 * pure state, so it is settled here rather than waiting for two machines.
 *
 * This module owns the atomic pickup and result commit. HTTP only authenticates
 * the Host and carries these decisions across the network.
 */

import { createHash, randomBytes } from 'node:crypto';

import { createDebugLogger } from '../../utils/debugLogger.js';
import { assembleAgentPrompt } from './prompt.js';
import { rebookUndeliveredTriggersInTransaction } from './dispatcher.js';
import {
  isAgentAddressable,
  isAgentExecutableByHost,
  maxConcurrentRunsFor,
  readAgentHostsUnlocked,
  removeAgentHostUnlocked,
  withAgentStoreTransaction,
  type AgentStoreTransaction,
} from './store.js';
import {
  closeRunInTransaction,
  finishRunInTransaction,
  type RunCloseRequest,
} from './run-lifecycle.js';
import {
  hostOffersProgram,
  isThreadTerminal,
  threadPriorityRank,
  type RunLease,
  type Thread,
  type ThreadRun,
  type WorkspaceAgent,
} from './types.js';

const debug = createDebugLogger('WORKSPACE_AGENTS_HOST_LEASE');

type RunStep = NonNullable<NonNullable<ThreadRun['progress']>['steps']>[number];

/** As many steps as the local path keeps; a host cannot send more. */
const MAX_HOST_STEPS = 8;
const MAX_STEP_TEXT = 200;
const STEP_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'done',
  'failed',
]);

/**
 * Reads the tool steps a host reports. The host is outside the daemon's trust
 * boundary, so anything malformed or oversized is refused rather than trimmed.
 */
export function parseHostRunSteps(
  value: unknown,
): RunStep[] | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_HOST_STEPS) return 'invalid';
  const steps: RunStep[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return 'invalid';
    const { id, title, status } = entry as Record<string, unknown>;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > MAX_STEP_TEXT ||
      typeof title !== 'string' ||
      title.length > MAX_STEP_TEXT ||
      typeof status !== 'string' ||
      !STEP_STATUSES.has(status)
    ) {
      return 'invalid';
    }
    steps.push({ id, title, status: status as RunStep['status'] });
  }
  return steps;
}

/** Set on a run whose bound program no runtime it may use offers. */
export const AGENT_PROGRAM_UNAVAILABLE = 'agent_program_unavailable';

function boundProgram(agent: WorkspaceAgent) {
  return agent.execution?.mode === 'managed-host'
    ? agent.execution.provider
    : undefined;
}

/** Deliberately short. A dead Host should not hold work for long. */
export const DEFAULT_RUN_LEASE_MS = 60_000;

/** Error recorded on a run whose Host was removed while it held the lease. */
export const AGENT_HOST_REMOVED = 'agent_host_removed';

/**
 * Removes a Host: its secret stops authenticating, agents bound to it lose it,
 * and runs it holds end now rather than waiting on a machine that is gone.
 *
 * An agent whose only Host this was falls back to running locally — the other
 * choice, leaving it bound to nothing, would queue its work forever. Returned
 * so the caller can say which agents moved.
 */
export async function removeAgentHost(
  projectRoot: string,
  hostId: string,
): Promise<
  | { removed: false }
  | { removed: true; agentsMadeLocal: string[]; runsEnded: number }
> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    if (!(await removeAgentHostUnlocked(projectRoot, hostId))) {
      return { removed: false as const };
    }
    const agentsMadeLocal: string[] = [];
    let agentsChanged = false;
    const agents = (await transaction.readAgents()).map(
      (agent): WorkspaceAgent => {
        const execution = agent.execution;
        if (
          execution?.mode !== 'managed-host' ||
          !execution.hostIds.includes(hostId)
        ) {
          return agent;
        }
        agentsChanged = true;
        const hostIds = execution.hostIds.filter((id) => id !== hostId);
        if (hostIds.length > 0) {
          return { ...agent, execution: { ...execution, hostIds } };
        }
        agentsMadeLocal.push(agent.id);
        return { ...agent, execution: { mode: 'local' } };
      },
    );
    if (agentsChanged) await transaction.writeAgents(agents);
    let runsEnded = 0;
    const now = Date.now();
    for (const thread of (await transaction.listThreads()).threads) {
      for (const run of thread.runs) {
        if (
          run.lease?.hostId !== hostId ||
          (run.status !== 'running' &&
            run.status !== 'finishing' &&
            run.status !== 'cancelling')
        ) {
          continue;
        }
        runsEnded += 1;
        await finishRunInTransaction(transaction, {
          threadId: thread.id,
          runId: run.id,
          outcome:
            run.status === 'finishing'
              ? { status: 'completed', attempt: run.attempts }
              : {
                  status: 'failed',
                  attempt: run.attempts,
                  error: AGENT_HOST_REMOVED,
                  failureStage: 'host',
                },
          now,
        });
      }
    }
    return { removed: true as const, agentsMadeLocal, runsEnded };
  });
}

export type LeaseRefusal =
  | 'no_such_run'
  | 'not_leasable'
  | 'stale_lease'
  | 'attempt_moved_on';

export type LeaseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: LeaseRefusal };

export interface HostRunAssignment {
  agent: WorkspaceAgent;
  threadId: string;
  runId: string;
  attempt: number;
  prompt: string;
  contextThroughSequence: number;
  lease: RunLease;
}

export interface HostRunResult {
  threadId: string;
  runId: string;
  hostId: string;
  leaseId: string;
  attempt: number;
  status: 'completed' | 'failed' | 'cancelled';
  close?: RunCloseRequest;
  error?: string;
  /** Tokens this attempt spent, when the Host's program can measure them. */
  tokens?: number;
}

/** The usage round a Host's cumulative spend for an attempt is recorded under. */
const HOST_USAGE_ROUND = 1;

/**
 * Records a Host's cumulative spend for one attempt. Reports can arrive out of
 * order, so the ledger only moves up; without this a remote run was never
 * charged at all, and a tree could spend past its budget on another machine.
 */
function withHostUsage(
  usageByRound: ThreadRun['usageByRound'],
  attempt: number,
  tokens: number | undefined,
): ThreadRun['usageByRound'] {
  if (tokens === undefined) return usageByRound;
  const isEntry = (usage: ThreadRun['usageByRound'][number]) =>
    usage.attempt === attempt && usage.round === HOST_USAGE_ROUND;
  const recorded = usageByRound.find(isEntry)?.tokens ?? 0;
  if (tokens <= recorded) return usageByRound;
  return [
    ...usageByRound.filter((usage) => !isEntry(usage)),
    { attempt, round: HOST_USAGE_ROUND, tokens },
  ].sort((a, b) => a.attempt - b.attempt || a.round - b.round);
}

function liveLease(
  run: { lease?: RunLease },
  now: number,
): RunLease | undefined {
  const lease = run.lease;
  if (!lease) return undefined;
  return lease.expiresAt > now ? lease : undefined;
}

function withRun(
  thread: Thread,
  runId: string,
  update: (run: Thread['runs'][number]) => Thread['runs'][number],
): Thread {
  return {
    ...thread,
    runs: thread.runs.map((run) => (run.id === runId ? update(run) : run)),
  };
}

/**
 * Extend a hold the caller still legitimately has.
 *
 * A heartbeat, not a claim: it refuses an expired lease rather than reviving
 * it. Reviving would let a Host that was unreachable for longer than the window
 * carry on as though nothing happened, which is exactly the case the window
 * exists to notice.
 */
export async function renewRunLease(
  projectRoot: string,
  input: {
    threadId: string;
    runId: string;
    leaseId: string;
    hostId?: string;
    attempt?: number;
    ttlMs?: number;
  },
  now = Date.now(),
): Promise<LeaseResult<RunLease>> {
  const ttl = input.ttlMs ?? DEFAULT_RUN_LEASE_MS;
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const checked = await checkRunLeaseInTransaction(transaction, input, now);
    if (!checked.ok) return checked;
    if (input.hostId !== undefined && checked.value.hostId !== input.hostId) {
      return { ok: false, reason: 'stale_lease' as const };
    }
    const thread = await transaction.readThread(input.threadId);
    const run = thread?.runs.find((candidate) => candidate.id === input.runId);
    if (!thread || !run) return { ok: false, reason: 'no_such_run' as const };
    if (isThreadTerminal(thread.status) || run.status !== 'running') {
      return { ok: false, reason: 'not_leasable' as const };
    }
    const lease: RunLease = { ...checked.value, expiresAt: now + ttl };
    await transaction.writeThread(
      withRun(thread, input.runId, (target) => ({ ...target, lease })),
    );
    return { ok: true as const, value: lease };
  });
}

export async function reportHostRunProgress(
  projectRoot: string,
  input: {
    threadId: string;
    runId: string;
    hostId: string;
    leaseId: string;
    attempt: number;
    sequence: number;
    stage: string;
    detail: string;
    outputText?: string;
    thoughtText?: string;
    steps?: RunStep[];
    tokens?: number;
  },
) {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const now = Date.now();
    const checked = await checkRunLeaseInTransaction(transaction, input, now);
    if (!checked.ok) return checked;
    if (checked.value.hostId !== input.hostId) {
      return { ok: false, reason: 'stale_lease' as const };
    }
    const thread = await transaction.readThread(input.threadId);
    const run = thread?.runs.find((candidate) => candidate.id === input.runId);
    if (!thread || !run || run.status !== 'running') {
      return { ok: false, reason: 'not_leasable' as const };
    }
    const previous =
      run.progress?.attempt === input.attempt ? run.progress : undefined;
    if (previous && previous.sequence > input.sequence) return { ok: true };
    const steps =
      previous?.sequence === input.sequence
        ? previous.steps
        : (input.steps ?? previous?.steps);
    // A new object through `withRun`, like every other write in this module.
    // Mutating the run that `find` returned only reaches the store because
    // `writeThread` is handed that same reference; a copy-on-write transaction
    // layer would silently drop both the progress and the token accounting.
    await transaction.writeThread(
      withRun(thread, input.runId, (target) => ({
        ...target,
        progress: {
          attempt: input.attempt,
          sequence: input.sequence,
          receivedAt: now,
          activityAt:
            previous?.sequence === input.sequence ? previous.activityAt : now,
          stage:
            previous?.sequence === input.sequence
              ? previous.stage
              : input.stage,
          detail:
            previous?.sequence === input.sequence
              ? previous.detail
              : input.detail,
          outputText:
            previous?.sequence === input.sequence
              ? previous.outputText
              : (input.outputText ?? previous?.outputText),
          thoughtText:
            previous?.sequence === input.sequence
              ? previous.thoughtText
              : (input.thoughtText ?? previous?.thoughtText),
          ...(steps ? { steps } : {}),
        },
        usageByRound: withHostUsage(
          target.usageByRound,
          input.attempt,
          input.tokens,
        ),
      })),
    );
    return { ok: true };
  });
}

/**
 * Check whether a Host may write a result for this run, right now.
 *
 * Both halves matter and they fail differently. The `leaseId` catches a worker
 * whose hold was taken over; the attempt catches the subtler case where the run
 * was requeued and started again — possibly by the very same Host — so an id
 * from the previous attempt would otherwise still look current.
 */
export async function checkRunLeaseInTransaction(
  transaction: AgentStoreTransaction,
  input: {
    threadId: string;
    runId: string;
    leaseId: string;
    attempt?: number;
  },
  now = Date.now(),
): Promise<LeaseResult<RunLease>> {
  const thread = await transaction.readThread(input.threadId);
  const run = thread?.runs.find((candidate) => candidate.id === input.runId);
  if (!run) return { ok: false, reason: 'no_such_run' };
  if (input.attempt !== undefined && input.attempt !== run.attempts) {
    return { ok: false, reason: 'attempt_moved_on' };
  }
  const lease = run.lease;
  if (!lease || lease.leaseId !== input.leaseId) {
    return { ok: false, reason: 'stale_lease' };
  }
  if (lease.attempt !== run.attempts) {
    return { ok: false, reason: 'attempt_moved_on' };
  }
  if (lease.expiresAt <= now) return { ok: false, reason: 'stale_lease' };
  return { ok: true, value: lease };
}

function assignmentFor(
  transaction: AgentStoreTransaction,
  agent: WorkspaceAgent,
  thread: Thread,
  run: ThreadRun,
  roster: readonly WorkspaceAgent[],
): Omit<HostRunAssignment, 'lease'> {
  const prompt = assembleAgentPrompt({
    workspaceId: transaction.workspaceId,
    agent,
    thread,
    run,
    roster,
  });
  return {
    agent,
    threadId: thread.id,
    runId: run.id,
    attempt: run.attempts,
    prompt: prompt.text,
    contextThroughSequence: prompt.contextThroughSequence,
  };
}

/** Atomically claims the oldest run this Host is allowed to execute. */
export async function pickupRunForHost(
  projectRoot: string,
  hostId: string,
  now = Date.now(),
): Promise<HostRunAssignment | undefined> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const agents = await transaction.readAgents();
    const roster = agents.filter(isAgentAddressable);
    const placed = new Map(
      agents
        .filter((agent) => isAgentExecutableByHost(agent, hostId))
        .map((agent) => [agent.id, agent]),
    );
    if (placed.size === 0) return undefined;
    const listed = await transaction.listThreads();
    if (listed.unreadable.length > 0) {
      throw new Error(
        `Cannot pick up Agent work while thread records are unreadable: ${listed.unreadable.join(', ')}.`,
      );
    }

    // A run bound to a program this host lacks is left for a host that has
    // it. When none of its hosts has it, fail the run now: left queued it
    // would wait forever with nothing on screen saying why.
    const hosts = (await readAgentHostsUnlocked(projectRoot)).hosts;
    const self = hosts.find((host) => host.id === hostId);
    const runsHere = (agent: WorkspaceAgent) => {
      const program = boundProgram(agent);
      return (
        !program || (self !== undefined && hostOffersProgram(self, program))
      );
    };
    const runsNowhere = (agent: WorkspaceAgent) => {
      const program = boundProgram(agent);
      if (!program || agent.execution?.mode !== 'managed-host') return false;
      const hostIds = agent.execution.hostIds;
      return !hosts.some(
        (host) => hostIds.includes(host.id) && hostOffersProgram(host, program),
      );
    };
    let changedAny = false;
    for (const thread of listed.threads) {
      if (isThreadTerminal(thread.status)) continue;
      for (const run of thread.runs) {
        const agent = placed.get(run.agentId);
        if (run.status === 'finishing' && agent) {
          changedAny = true;
          await finishRunInTransaction(transaction, {
            threadId: thread.id,
            runId: run.id,
            outcome: { status: 'completed', attempt: run.attempts },
            now,
          });
          continue;
        }
        if (run.status === 'queued' && agent && runsNowhere(agent)) {
          changedAny = true;
          await finishRunInTransaction(transaction, {
            threadId: thread.id,
            runId: run.id,
            outcome: {
              status: 'failed',
              error: AGENT_PROGRAM_UNAVAILABLE,
              failureStage: 'pickup',
            },
            now,
          });
        }
      }
    }

    // Re-read after failing runs so a later write never restores them.
    const threads = changedAny
      ? (await transaction.listThreads()).threads
      : listed.threads;

    const held = threads
      .flatMap((thread) =>
        thread.runs.map((run) => ({
          thread,
          run,
          agent: placed.get(run.agentId),
        })),
      )
      .find(
        ({ thread, run, agent }) =>
          agent !== undefined &&
          // Same rule the dispatcher applies. A thread that went terminal
          // while a Host held it must not have that hold extended: the work
          // is over, and renewing would keep a worker busy on it.
          !isThreadTerminal(thread.status) &&
          run.status === 'running' &&
          run.lease?.hostId === hostId &&
          run.lease.attempt === run.attempts &&
          run.lease.expiresAt > now,
      );
    if (held?.agent && held.run.lease) {
      const attempt = held.run.attempts + 1;
      const assignment = assignmentFor(
        transaction,
        held.agent,
        held.thread,
        { ...held.run, attempts: attempt },
        roster,
      );
      const committed =
        held.thread.deliveryByAgent[held.run.agentId]
          ?.committedThroughSequence ?? 0;
      const delivered = held.thread.messages
        .filter(
          (message) =>
            message.sequence > committed &&
            message.sequence <= assignment.contextThroughSequence,
        )
        .map((message) => message.id);
      const lease = {
        ...held.run.lease,
        leaseId: randomBytes(16).toString('hex'),
        attempt,
        expiresAt: now + DEFAULT_RUN_LEASE_MS,
      };
      await transaction.writeThread(
        // The host restarted the turn, so its progress restarts too.
        withRun(held.thread, held.run.id, (run) => ({
          ...run,
          attempts: attempt,
          lease,
          progress: undefined,
          acceptedMessageIds: Array.from(
            new Set([...run.acceptedMessageIds, ...delivered]),
          ),
          contextThroughSequence: assignment.contextThroughSequence,
        })),
      );
      return {
        ...assignment,
        lease,
      };
    }

    const candidates = threads
      .flatMap((thread) =>
        thread.runs.map((run) => ({
          thread,
          run,
          agent: placed.get(run.agentId),
        })),
      )
      .filter(
        (
          candidate,
        ): candidate is {
          thread: Thread;
          run: ThreadRun;
          agent: WorkspaceAgent;
        } =>
          candidate.agent !== undefined &&
          runsHere(candidate.agent) &&
          !runsNowhere(candidate.agent) &&
          // The dispatcher's `selectCandidates` refuses terminal threads; this
          // is the second selection path and has to agree with it. Without
          // this a Host is handed work on a thread whose caller cancelled it
          // or whose owner marked it done — observed, not theorised: the audit
          // harness picked up such a run before this line existed.
          !isThreadTerminal(candidate.thread.status) &&
          ((candidate.run.status === 'queued' &&
            isAgentAddressable(candidate.agent)) ||
            (candidate.run.status === 'running' &&
              !liveLease(candidate.run, now))),
      )
      .sort(
        (a, b) =>
          threadPriorityRank(a.thread.priority) -
            threadPriorityRank(b.thread.priority) ||
          a.run.queueSequence - b.run.queueSequence,
      );

    const candidate = candidates.find(({ agent, run }) => {
      const occupied = threads.reduce(
        (count, thread) =>
          count +
          thread.runs.filter(
            (other) =>
              other.id !== run.id &&
              other.agentId === agent.id &&
              (other.status === 'running' ||
                other.status === 'finishing' ||
                other.status === 'cancelling') &&
              liveLease(other, now) !== undefined,
          ).length,
        0,
      );
      return occupied < maxConcurrentRunsFor(agent);
    });
    if (!candidate) return undefined;

    const run: ThreadRun =
      candidate.run.status === 'queued'
        ? {
            ...candidate.run,
            status: 'running',
            attempts: candidate.run.attempts + 1,
            startedAt: now,
          }
        : { ...candidate.run, attempts: candidate.run.attempts + 1 };
    const lease: RunLease = {
      hostId,
      leaseId: randomBytes(16).toString('hex'),
      attempt: run.attempts,
      acquiredAt: now,
      expiresAt: now + DEFAULT_RUN_LEASE_MS,
    };
    const prompt = assembleAgentPrompt({
      workspaceId: transaction.workspaceId,
      agent: candidate.agent,
      thread: candidate.thread,
      run,
      roster,
    });
    const committed =
      candidate.thread.deliveryByAgent[run.agentId]?.committedThroughSequence ??
      0;
    const delivered = candidate.thread.messages
      .filter(
        (message) =>
          message.sequence > committed &&
          message.sequence <= prompt.contextThroughSequence,
      )
      .map((message) => message.id);
    const nextRun = {
      ...run,
      lease,
      // A new holder counts its progress from 1; a higher sequence left by
      // the last one would hide every update it sends.
      progress: undefined,
      acceptedMessageIds: Array.from(
        new Set([...run.acceptedMessageIds, ...delivered]),
      ),
      contextThroughSequence: prompt.contextThroughSequence,
    };
    const stored = await transaction.writeThread(
      withRun(candidate.thread, run.id, () => nextRun),
    );
    return {
      ...assignmentFor(transaction, candidate.agent, stored, nextRun, roster),
      lease,
    };
  });
}

function hostResultDigest(input: HostRunResult): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.threadId,
        input.runId,
        input.hostId,
        input.attempt,
        input.leaseId,
        input.status,
        input.close?.kind,
        input.close?.kind === 'blocked'
          ? input.close.question
          : input.close?.kind === 'review'
            ? input.close.summary
            : undefined,
        input.error,
        input.tokens,
      ]),
    )
    .digest('hex');
}

/** Applies a Host result only while that exact attempt still owns the lease. */
export async function applyHostRunResult(
  projectRoot: string,
  input: HostRunResult,
  now = Date.now(),
): Promise<LeaseResult<{ thread: Thread; alreadyApplied: boolean }>> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const current = await transaction.readThread(input.threadId);
    const run = current?.runs.find((candidate) => candidate.id === input.runId);
    if (!current || !run) return { ok: false, reason: 'no_such_run' as const };
    if (
      (run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled') &&
      run.attempts === input.attempt &&
      run.lease?.attempt === input.attempt &&
      run.lease.hostId === input.hostId &&
      run.lease.leaseId === input.leaseId
    ) {
      if (
        !(await readAgentHostsUnlocked(projectRoot)).hosts.some(
          (host) => host.id === input.hostId,
        )
      ) {
        return { ok: false, reason: 'stale_lease' as const };
      }
      const receipt = run.hostResultReceipt;
      if (
        receipt?.attempt === input.attempt &&
        receipt.leaseId === input.leaseId
      ) {
        return receipt.digest === hostResultDigest(input)
          ? {
              ok: true as const,
              value: { thread: current, alreadyApplied: true },
            }
          : { ok: false, reason: 'stale_lease' as const };
      }
      // Terminal settlement ends this attempt's write authority, including
      // usageByRound, which threadTokens sums for tree budget enforcement.
      // Matching lease identity grants no writes, even before lease expiry.
      if (
        withHostUsage(run.usageByRound, input.attempt, input.tokens) !==
        run.usageByRound
      ) {
        debug.warn('Ignored post-terminal host usage report:', {
          threadId: current.id,
          runId: run.id,
          attempt: input.attempt,
          tokens: input.tokens,
        });
      }
      return { ok: false, reason: 'stale_lease' as const };
    }
    if (
      run.status === 'finishing' &&
      (input.status !== 'completed' ||
        (input.close !== undefined && run.closeKind !== input.close.kind))
    ) {
      return { ok: false, reason: 'not_leasable' as const };
    }
    const ownsFinishingRun =
      run.status === 'finishing' &&
      run.attempts === input.attempt &&
      run.lease?.attempt === input.attempt &&
      run.lease.hostId === input.hostId &&
      run.lease.leaseId === input.leaseId;
    if (!ownsFinishingRun) {
      const checked = await checkRunLeaseInTransaction(transaction, input, now);
      if (!checked.ok) return checked;
      if (checked.value.hostId !== input.hostId) {
        return { ok: false, reason: 'stale_lease' as const };
      }
    }

    await transaction.writeThread(
      withRun(current, run.id, (target) => ({
        ...target,
        consumedMessageIds: Array.from(
          new Set([...target.consumedMessageIds, ...target.acceptedMessageIds]),
        ),
        usageByRound: withHostUsage(
          target.usageByRound,
          input.attempt,
          input.tokens,
        ),
      })),
    );
    if (run.status === 'running') {
      await rebookUndeliveredTriggersInTransaction(
        transaction,
        current.id,
        run.id,
        run.attempts,
        now,
      );
    }
    if (
      run.status === 'running' &&
      input.status === 'completed' &&
      input.close
    ) {
      await closeRunInTransaction(transaction, {
        context: {
          workspaceId: transaction.workspaceId,
          agentId: run.agentId,
          threadId: current.id,
          rootThreadId: current.rootThreadId,
          runId: run.id,
          attempt: run.attempts,
        },
        request: input.close,
        now,
      });
    }
    const thread = await finishRunInTransaction(transaction, {
      threadId: input.threadId,
      runId: input.runId,
      outcome: {
        status: input.status,
        attempt: input.attempt,
        hostResultReceipt: {
          attempt: input.attempt,
          leaseId: input.leaseId,
          digest: hostResultDigest(input),
        },
        ...(input.error ? { error: input.error } : {}),
        ...(input.status === 'failed' ? { failureStage: 'execution' } : {}),
      },
      now,
    });
    return {
      ok: true as const,
      value: { thread, alreadyApplied: false },
    };
  });
}
