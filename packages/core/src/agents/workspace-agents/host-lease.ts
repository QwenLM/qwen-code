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
 * The long-poll pickup and the result transport are not here: they are the
 * parts that need a network, and they are worth nothing until this is right.
 */

import { randomBytes } from 'node:crypto';

import { withAgentStoreTransaction } from './store.js';
import type { RunLease, Thread } from './types.js';

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

function liveLease(run: { lease?: RunLease }, now: number): RunLease | undefined {
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
  input: { threadId: string; runId: string; leaseId: string },
  now = Date.now(),
): Promise<LeaseResult<RunLease>> {
  const thread = await withAgentStoreTransaction(projectRoot, (transaction) =>
    transaction.readThread(input.threadId),
  );
  const run = thread?.runs.find((candidate) => candidate.id === input.runId);
  if (!run) return { ok: false, reason: 'no_such_run' };
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
