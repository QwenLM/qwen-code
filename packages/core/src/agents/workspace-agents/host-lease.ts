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

import { randomBytes } from 'node:crypto';

import { assembleAgentPrompt } from './prompt.js';
import {
  isAgentAddressable,
  isAgentExecutableByHost,
  maxConcurrentRunsFor,
  withAgentStoreTransaction,
  type AgentStoreTransaction,
} from './store.js';
import {
  closeRunInTransaction,
  finishRunInTransaction,
  type RunCloseRequest,
} from './run-lifecycle.js';
import {
  threadPriorityRank,
  type RunLease,
  type Thread,
  type ThreadRun,
  type WorkspaceAgent,
} from './types.js';

/** Deliberately short. A dead Host should not hold work for long. */
export const DEFAULT_RUN_LEASE_MS = 60_000;

export type LeaseRefusal =
  | 'no_such_run'
  | 'not_leasable'
  | 'held_by_other_host'
  | 'stale_lease'
  | 'attempt_moved_on';

export type LeaseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: LeaseRefusal };

export interface HostRunAssignment {
  workspaceId: string;
  agent: WorkspaceAgent;
  threadId: string;
  rootThreadId: string;
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
 * Hand one run to one Host for a bounded time.
 *
 * Refuses while another Host's lease is live, and does not extend that Host's
 * hold by being asked — a lease is a promise about a window, not about a
 * worker, so a second Host asking must not shorten or lengthen the first's.
 */
export async function acquireRunLease(
  projectRoot: string,
  input: {
    threadId: string;
    runId: string;
    hostId: string;
    ttlMs?: number;
  },
  now = Date.now(),
): Promise<LeaseResult<RunLease>> {
  const ttl = input.ttlMs ?? DEFAULT_RUN_LEASE_MS;
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(input.threadId);
    if (!thread) return { ok: false, reason: 'no_such_run' as const };
    const run = thread.runs.find((candidate) => candidate.id === input.runId);
    if (!run) return { ok: false, reason: 'no_such_run' as const };
    // Only work that is waiting or in flight can be leased. A terminal run
    // handed to a Host would have it do work whose result nothing will accept.
    if (
      run.status !== 'queued' &&
      run.status !== 'running' &&
      run.status !== 'finishing'
    ) {
      return { ok: false, reason: 'not_leasable' as const };
    }
    const held = liveLease(run, now);
    if (held && held.hostId !== input.hostId) {
      return { ok: false, reason: 'held_by_other_host' as const };
    }
    const lease: RunLease = {
      hostId: input.hostId,
      // A fresh id even when the same Host re-acquires: the point of the id is
      // to identify one hold, and reusing it would let a request issued under
      // the previous hold be accepted under this one.
      leaseId: randomBytes(16).toString('hex'),
      attempt: run.attempts,
      expiresAt: now + ttl,
      acquiredAt: now,
    };
    await transaction.writeThread(
      withRun(thread, input.runId, (target) => ({ ...target, lease })),
    );
    return { ok: true as const, value: lease };
  });
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
    ttlMs?: number;
  },
  now = Date.now(),
): Promise<LeaseResult<RunLease>> {
  const ttl = input.ttlMs ?? DEFAULT_RUN_LEASE_MS;
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(input.threadId);
    const run = thread?.runs.find((candidate) => candidate.id === input.runId);
    if (!thread || !run) return { ok: false, reason: 'no_such_run' as const };
    const held = liveLease(run, now);
    if (!held || held.leaseId !== input.leaseId) {
      return { ok: false, reason: 'stale_lease' as const };
    }
    if (held.attempt !== run.attempts) {
      return { ok: false, reason: 'attempt_moved_on' as const };
    }
    const lease: RunLease = { ...held, expiresAt: now + ttl };
    await transaction.writeThread(
      withRun(thread, input.runId, (target) => ({ ...target, lease })),
    );
    return { ok: true as const, value: lease };
  });
}

/**
 * Check whether a Host may write a result for this run, right now.
 *
 * Both halves matter and they fail differently. The `leaseId` catches a worker
 * whose hold was taken over; the attempt catches the subtler case where the run
 * was requeued and started again — possibly by the very same Host — so an id
 * from the previous attempt would otherwise still look current.
 *
 * Returning a verdict rather than performing the write keeps the decision
 * testable apart from whatever the transport does with it, and keeps this
 * module out of the business of what a result contains.
 */
export async function checkRunLease(
  projectRoot: string,
  input: {
    threadId: string;
    runId: string;
    leaseId: string;
    attempt?: number;
  },
  now = Date.now(),
): Promise<LeaseResult<RunLease>> {
  return withAgentStoreTransaction(projectRoot, (transaction) =>
    checkRunLeaseInTransaction(transaction, input, now),
  );
}

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
    workspaceId: transaction.workspaceId,
    agent,
    threadId: thread.id,
    rootThreadId: thread.rootThreadId,
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
    const { threads, unreadable } = await transaction.listThreads();
    if (unreadable.length > 0) {
      throw new Error(
        `Cannot pick up Agent work while thread records are unreadable: ${unreadable.join(', ')}.`,
      );
    }

    const held = threads
      .flatMap((thread) =>
        thread.runs.map((run) => ({
          thread,
          run,
          agent: placed.get(run.agentId),
        })),
      )
      .find(
        ({ run, agent }) =>
          agent !== undefined &&
          run.status === 'running' &&
          run.lease?.hostId === hostId &&
          run.lease.attempt === run.attempts &&
          run.lease.expiresAt > now,
      );
    if (held?.agent && held.run.lease) {
      const lease = {
        ...held.run.lease,
        expiresAt: now + DEFAULT_RUN_LEASE_MS,
      };
      const stored = await transaction.writeThread(
        withRun(held.thread, held.run.id, (run) => ({ ...run, lease })),
      );
      const run = stored.runs.find(
        (candidate) => candidate.id === held.run.id,
      )!;
      return {
        ...assignmentFor(transaction, held.agent, stored, run, roster),
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
        : candidate.run;
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
      return {
        ok: true as const,
        value: { thread: current, alreadyApplied: true },
      };
    }
    const checked = await checkRunLeaseInTransaction(transaction, input, now);
    if (!checked.ok) return checked;
    if (checked.value.hostId !== input.hostId) {
      return { ok: false, reason: 'stale_lease' as const };
    }

    await transaction.writeThread(
      withRun(current, run.id, (target) => ({
        ...target,
        consumedMessageIds: Array.from(
          new Set([...target.consumedMessageIds, ...target.acceptedMessageIds]),
        ),
      })),
    );
    if (
      run.status === 'finishing' &&
      (input.status !== 'completed' ||
        (input.close !== undefined && run.closeKind !== input.close.kind))
    ) {
      return { ok: false, reason: 'not_leasable' as const };
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

/**
 * Give a lease back without waiting for it to lapse.
 *
 * A Host that knows it is stopping should say so — waiting out the window
 * leaves work idle for no reason. Refuses a lease the caller does not hold, so
 * one Host cannot free another's work.
 */
export async function releaseRunLease(
  projectRoot: string,
  input: { threadId: string; runId: string; leaseId: string },
): Promise<LeaseResult<true>> {
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const thread = await transaction.readThread(input.threadId);
    const run = thread?.runs.find((candidate) => candidate.id === input.runId);
    if (!thread || !run) return { ok: false, reason: 'no_such_run' as const };
    if (!run.lease || run.lease.leaseId !== input.leaseId) {
      return { ok: false, reason: 'stale_lease' as const };
    }
    await transaction.writeThread(
      withRun(thread, input.runId, ({ lease: _dropped, ...rest }) => rest),
    );
    return { ok: true as const, value: true as const };
  });
}
