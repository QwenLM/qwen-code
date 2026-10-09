/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ManagedActivationStaleLeaseError,
  type FileManagedActivationStore,
  type ManagedActivationDescriptor,
  type ManagedActivationEnqueueResult,
  type ManagedActivationFence,
  type ManagedActivationLease,
  type ManagedActivationSnapshot,
} from './managed-activation-store.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('EMBEDDED_HARNESS_SCHEDULER');

export interface ManagedActivationHandlerContext {
  readonly fence: ManagedActivationFence;
  readonly signal: AbortSignal;
}

export type ManagedActivationHandler = (
  activation: ManagedActivationDescriptor,
  context: ManagedActivationHandlerContext,
) => Promise<void>;

export interface EmbeddedHarnessSchedulerOptions {
  readonly store: FileManagedActivationStore;
  readonly workerId: string;
  readonly maxActiveSlots: number;
  readonly maxQueued: number;
  readonly maxQueuedPerTenant: number;
  readonly leaseDurationMs: number;
  readonly hasMemoryHeadroom: () => boolean;
  readonly handler: ManagedActivationHandler;
  readonly onActivationError?: (
    activation: ManagedActivationDescriptor,
    error: unknown,
  ) => void;
}

interface ActiveRun {
  readonly activation: ManagedActivationDescriptor;
  readonly controller: AbortController;
  lease: ManagedActivationLease;
  renewalTimer?: NodeJS.Timeout;
  renewal?: Promise<void>;
  finishing: boolean;
  abandoned: boolean;
  abortedInFlight: boolean;
  transientFailures: number;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function activationKey(activation: {
  tenantId: string;
  sessionId: string;
  activationId: string;
}): string {
  return JSON.stringify([
    activation.tenantId,
    activation.sessionId,
    activation.activationId,
  ]);
}

function sessionKey(activation: {
  tenantId: string;
  sessionId: string;
}): string {
  return JSON.stringify([activation.tenantId, activation.sessionId]);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * How often a blocked pump re-checks on its own: memory headroom (queued
 * activations hold no lease whose expiry could wake the scheduler, so without
 * this poll a missed notifyCapacityChanged() would starve them forever) and
 * transient claim failures (the same candidates carry no lease either).
 */
const RECHECK_INTERVAL_MS = 1_000;

/**
 * Consecutive transient store failures per active slot that halt the
 * worker. A store that keeps failing across every path is a persistent
 * outage, not a transient one — the worker fails loudly instead of spinning
 * silently. The bound scales with the worker's own concurrency: one shared
 * journal blip lands on every in-flight run at once, charging the streak
 * once per concurrent run, and that blip must not exhaust the budget.
 */
const MAX_TRANSIENT_STORE_FAILURES_PER_SLOT = 10;

/**
 * Transient failures one activation absorbs across re-runs before the
 * scheduler records the handler's own outcome as terminal instead of
 * re-queuing the activation once more.
 */
const MAX_ACTIVATION_TRANSIENT_FAILURES = 3;

/**
 * Delay between bounded release retries. A transient store failure provably
 * never wrote (the journal tail repair succeeded), so a short spaced retry
 * within the lease window is safe and avoids re-executing the handler.
 */
const RELEASE_RETRY_DELAY_MS = 250;
const MAX_RELEASE_ATTEMPTS = 3;

/**
 * Bounded asynchronous Harness scheduler for one long-lived service process.
 * It intentionally creates neither child processes nor Worker threads.
 */
export class EmbeddedHarnessScheduler {
  private readonly store: FileManagedActivationStore;
  private readonly options: EmbeddedHarnessSchedulerOptions;
  private readonly active = new Map<string, ActiveRun>();
  private pumpTail: Promise<void> = Promise.resolve();
  private recoveryTimer: NodeJS.Timeout | undefined;
  private lastTenantId: string | undefined;
  private started = false;
  private disposed = false;
  private memoryBlocked = false;
  private fatalError: Error | undefined;
  private transientStoreFailures = 0;
  private readonly activationTransientFailures = new Map<string, number>();

  constructor(options: EmbeddedHarnessSchedulerOptions) {
    if (options.workerId.trim().length === 0) {
      throw new Error('workerId must be a non-empty string.');
    }
    requirePositiveInteger('maxActiveSlots', options.maxActiveSlots);
    requirePositiveInteger('maxQueued', options.maxQueued);
    requirePositiveInteger('maxQueuedPerTenant', options.maxQueuedPerTenant);
    if (options.maxQueuedPerTenant > options.maxQueued) {
      throw new Error('maxQueuedPerTenant cannot exceed maxQueued.');
    }
    requirePositiveInteger('leaseDurationMs', options.leaseDurationMs);
    this.options = Object.freeze({ ...options });
    this.store = options.store;
  }

  get activeSlotCount(): number {
    return this.active.size;
  }

  get isMemoryBlocked(): boolean {
    return this.memoryBlocked;
  }

  get haltedError(): Error | undefined {
    return this.fatalError;
  }

  async start(): Promise<void> {
    this.assertUsable();
    if (this.started) return;
    this.started = true;
    await this.requestPump();
  }

  async submit(
    activation: ManagedActivationDescriptor,
  ): Promise<ManagedActivationEnqueueResult> {
    this.assertUsable();
    let result: ManagedActivationEnqueueResult;
    try {
      result = await this.store.enqueue(activation, {
        maxQueued: this.options.maxQueued,
        maxQueuedPerTenant: this.options.maxQueuedPerTenant,
      });
    } catch (error) {
      if (this.store.haltedError) this.halt(this.store.haltedError);
      throw error;
    }
    // A duplicate enqueue performs no store I/O, so it must not reset the
    // consecutive transient-failure streak.
    if (result.created) this.noteStoreOutcome();
    if (this.started) {
      void this.requestPump().catch(() => undefined);
    }
    return result;
  }

  notifyCapacityChanged(): void {
    if (!this.started || this.disposed || this.fatalError) return;
    void this.requestPump().catch(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    const error = new Error(
      `Harness Worker '${this.options.workerId}' stopped.`,
    );
    for (const run of this.active.values()) {
      run.abandoned = true;
      if (run.renewalTimer) clearTimeout(run.renewalTimer);
      run.controller.abort(error);
    }
  }

  private requestPump(): Promise<void> {
    const result = this.pumpTail.then(async () => {
      this.assertUsable();
      await this.pump();
    });
    this.pumpTail = result.catch((error: unknown) => {
      this.halt(toError(error));
    });
    return result;
  }

  private async pump(): Promise<void> {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;

    while (this.active.size < this.options.maxActiveSlots) {
      if (this.memoryBlocked && !this.options.hasMemoryHeadroom()) {
        // Still memory-blocked from the previous pass. Queued activations
        // cannot have left the queue since (claims are the only way out, and
        // this worker — the queue's sole owner — is not claiming), so the
        // recheck re-arms without re-scanning the store.
        this.scheduleMemoryWake();
        return;
      }
      const candidates = this.store
        .listRunnable()
        .filter(
          (candidate) => !this.active.has(activationKey(candidate.descriptor)),
        );
      if (candidates.length === 0) {
        this.memoryBlocked = false;
        this.scheduleRecoveryWake();
        return;
      }
      if (!this.options.hasMemoryHeadroom()) {
        this.memoryBlocked = true;
        this.scheduleMemoryWake();
        return;
      }
      this.memoryBlocked = false;
      const candidate = this.selectTenantFair(candidates)!;
      let lease: ManagedActivationLease | undefined;
      try {
        lease = await this.store.claim(
          candidate.descriptor,
          this.options.workerId,
          this.options.leaseDurationMs,
        );
      } catch (error) {
        // The same policy as renewal and release: a transient store failure
        // leaves the candidate queued (with no lease, so no expiry wake), and
        // the worker halts only when the store itself has halted or when the
        // transient failures keep stacking (a persistent outage in disguise).
        if (this.store.haltedError) throw error;
        // A dispose or halt raced the in-flight claim: arming a wake on a
        // dead scheduler would surface a bogus 'is disposed' halt.
        if (this.disposed || this.fatalError) return;
        this.noteStoreOutcome(error);
        if (this.fatalError) return;
        debugLogger.warn(
          `Managed activation '${candidate.descriptor.activationId}'` +
            ` claim failed transiently: ${toError(error).message}`,
        );
        this.scheduleMemoryWake();
        return;
      }
      this.noteStoreOutcome();
      if (!lease) continue;
      if (this.disposed || this.fatalError) return;
      this.launch(candidate.descriptor, lease);
    }
  }

  private selectTenantFair(
    candidates: ManagedActivationSnapshot[],
  ): ManagedActivationSnapshot | undefined {
    if (candidates.length === 0) return undefined;
    const tenantIds = [
      ...new Set(candidates.map((candidate) => candidate.descriptor.tenantId)),
    ];
    const previousIndex = this.lastTenantId
      ? tenantIds.indexOf(this.lastTenantId)
      : -1;
    const tenantId = tenantIds[(previousIndex + 1) % tenantIds.length];
    this.lastTenantId = tenantId;
    return candidates.find(
      (candidate) => candidate.descriptor.tenantId === tenantId,
    );
  }

  private launch(
    activation: ManagedActivationDescriptor,
    lease: ManagedActivationLease,
  ): void {
    const run: ActiveRun = {
      activation: structuredClone(activation),
      lease,
      controller: new AbortController(),
      finishing: false,
      abandoned: false,
      abortedInFlight: false,
      transientFailures: 0,
    };
    this.active.set(activationKey(activation), run);
    this.scheduleRenewal(run);
    // No scheduler promise may reject unhandled: an escape becomes a loud
    // halt instead of a silent process-level unhandled rejection.
    void this.execute(run).catch((error: unknown) => {
      this.halt(toError(error));
    });
  }

  private async execute(run: ActiveRun): Promise<void> {
    let outcome: 'completed' | 'failed' = 'completed';
    let handlerError: unknown;
    try {
      await this.options.handler(structuredClone(run.activation), {
        fence: Object.freeze({
          tenantId: run.lease.tenantId,
          sessionId: run.lease.sessionId,
          activationId: run.lease.activationId,
          workerId: run.lease.workerId,
          epoch: run.lease.epoch,
        }),
        signal: run.controller.signal,
      });
    } catch (error) {
      outcome = 'failed';
      handlerError = error;
    }

    try {
      run.finishing = true;
      if (run.renewalTimer) clearTimeout(run.renewalTimer);
      await run.renewal;

      if (!run.abandoned && !this.disposed && !this.fatalError) {
        try {
          await this.store.release(run.lease, outcome);
          this.noteStoreOutcome();
          this.activationTransientFailures.delete(
            activationKey(run.activation),
          );
        } catch (error) {
          if (error instanceof ManagedActivationStaleLeaseError) {
            this.noteAbandonedFailures(run, 1);
            run.abandoned = true;
            run.controller.abort(error);
          } else {
            const storeHalted = this.store.haltedError;
            if (storeHalted) {
              this.halt(storeHalted);
            } else {
              // A transient store failure provably never wrote the outcome
              // (the journal tail repair succeeded), so retrying within the
              // lease's remaining window is safe and avoids re-executing an
              // already-finished handler over one repaired write failure.
              run.transientFailures++;
              this.noteStoreOutcome(error);
              if (!this.fatalError) {
                const settled = await this.retryReleaseWithinLease(
                  run,
                  outcome,
                );
                if (settled === 'stale') {
                  this.noteAbandonedFailures(run, 1);
                  run.abandoned = true;
                  run.controller.abort(error);
                } else if (
                  settled === 'exhausted' &&
                  !this.disposed &&
                  !this.fatalError
                ) {
                  debugLogger.warn(
                    `Managed activation '${run.lease.activationId}'` +
                      ` abandoned after a release failure:` +
                      ` ${toError(error).message}`,
                  );
                  this.abandonAfterTransientFailures(run, error);
                }
              }
            }
          }
        }
      }

      // Every abandon path converges here, after the handler settled: with
      // the activation's transient-failure budget spent, the scheduler
      // records the terminal outcome instead of re-queuing the activation
      // forever. A run the scheduler itself aborted mid-handler cannot
      // certify the handler's success — the handler may have returned only
      // because the abort landed — so its record is a failure; a run that
      // settled before the abandon keeps the handler's own outcome. The
      // write happens only here so it never certifies a still-running
      // handler, and settleTerminalOutcome re-checks liveness so a stopped
      // worker never records one either.
      let terminalRecorded = false;
      if (run.abandoned && !this.disposed && !this.fatalError) {
        const key = activationKey(run.activation);
        if (
          (this.activationTransientFailures.get(key) ?? 0) >=
          MAX_ACTIVATION_TRANSIENT_FAILURES
        ) {
          terminalRecorded = await this.settleTerminalOutcome(
            run,
            run.abortedInFlight ? 'failed' : outcome,
          );
        }
      }

      // The hook is the only channel that carries the handler's error
      // object, so a terminally recorded activation must still report it;
      // an abandoned run that only re-queues must not.
      if (
        handlerError !== undefined &&
        (!run.abandoned || terminalRecorded) &&
        !this.disposed
      ) {
        try {
          this.options.onActivationError?.(run.activation, handlerError);
        } catch (error) {
          this.halt(toError(error));
        }
      }
    } finally {
      // Whatever escaped above, the slot must be released and the pump
      // re-run: a leaked active entry would exclude this activation from
      // every future claim (pump skips keys in active) and inflate
      // activeSlotCount until the worker stops claiming at all.
      this.active.delete(activationKey(run.activation));
      if (!this.disposed && !this.fatalError) {
        void this.requestPump().catch(() => undefined);
      }
    }
  }

  private scheduleRenewal(run: ActiveRun): void {
    const delay = Math.max(1, Math.floor(this.options.leaseDurationMs / 3));
    run.renewalTimer = setTimeout(() => {
      // The catch keeps a renew failure from sitting unhandled between the
      // tick and execute()'s `await run.renewal`; halt() makes it loud and
      // marks the run abandoned, so execute() then skips its release.
      run.renewal = this.renew(run)
        .catch((error: unknown) => {
          this.halt(toError(error));
        })
        .finally(() => {
          run.renewal = undefined;
        });
    }, delay);
    run.renewalTimer.unref();
  }

  private async renew(run: ActiveRun): Promise<void> {
    if (run.finishing || run.abandoned || this.disposed) return;
    try {
      run.lease = await this.store.renew(
        run.lease,
        this.options.leaseDurationMs,
      );
      this.noteStoreOutcome();
      run.transientFailures = 0;
      if (!run.finishing && !run.abandoned && !this.disposed) {
        this.scheduleRenewal(run);
      }
    } catch (error) {
      if (error instanceof ManagedActivationStaleLeaseError) {
        // The lease is provably no longer ours; another worker owns the
        // activation's outcome now. The dropped run itself is an absorbed
        // failure even when it recorded no transient one — without counting
        // it, a store call that resolves past the lease edge on every run
        // would re-queue and re-execute the activation without bound.
        this.noteAbandonedFailures(run, 1);
        run.abandoned = true;
        // The handler may have settled while this renewal was in flight:
        // only a genuinely preempted handler forfeits its own outcome.
        run.abortedInFlight = !run.finishing;
        run.controller.abort(error);
        return;
      }
      const storeHalted = this.store.haltedError;
      if (storeHalted) {
        this.halt(storeHalted);
        return;
      }
      // Transient: the write provably never happened, so the lease is still
      // current. While it has headroom for another renewal tick, retry on
      // the cadence instead of aborting the run over one IO failure.
      run.transientFailures++;
      this.noteStoreOutcome(error);
      if (this.fatalError || this.disposed) return;
      // A run whose handler already finished belongs to execute()'s release
      // path, which owns the outcome's retry and terminal record; abandoning
      // here would drop a completed outcome and re-run the handler.
      if (run.finishing || run.abandoned) return;
      const interval = Math.max(
        1,
        Math.floor(this.options.leaseDurationMs / 3),
      );
      const now = this.storeNow();
      const headroom = now === undefined ? 0 : run.lease.expiresAt - now;
      if (headroom > interval) {
        debugLogger.warn(
          `Managed activation '${run.lease.activationId}' renewal failed` +
            ` transiently; retrying within its lease:` +
            ` ${toError(error).message}`,
        );
        this.scheduleRenewal(run);
        return;
      }
      // No headroom left for another tick: the lease lapses and the
      // recovery wake re-queues the activation. The handler may still be in
      // flight, so the terminal decision belongs to execute() — it awaits
      // the handler and records the handler's own outcome once the
      // activation's transient-failure budget is spent.
      debugLogger.warn(
        `Managed activation '${run.lease.activationId}' abandoned` +
          ` after a renewal failure: ${toError(error).message}`,
      );
      this.abandonAfterTransientFailures(run, error);
    }
  }

  /**
   * Reads the store clock without letting a validating-clock throw escape an
   * error path: undefined means "the clock cannot be trusted", which callers
   * treat as no headroom / lease expired — the fail-safe that abandons and
   * lets the consecutive-failure streak escalate to a loud halt.
   */
  private storeNow(): number | undefined {
    try {
      return this.store.getCurrentTime();
    } catch {
      return undefined;
    }
  }

  /**
   * Tracks consecutive transient store failures. Any successful store call
   * resets the streak; reaching the bound means the "transient" failure is a
   * persistent outage in disguise, and the worker halts loudly instead of
   * spinning forever.
   */
  private noteStoreOutcome(error?: unknown): void {
    if (error === undefined) {
      this.transientStoreFailures = 0;
      return;
    }
    this.transientStoreFailures++;
    // A dispose or halt raced the failure: the streak still counts, but the
    // escalation must not record a bogus store halt on a dead worker.
    if (this.disposed || this.fatalError) return;
    if (
      this.transientStoreFailures >=
      MAX_TRANSIENT_STORE_FAILURES_PER_SLOT *
        Math.max(1, this.options.maxActiveSlots)
    ) {
      this.halt(
        new Error(
          `Harness Worker '${this.options.workerId}' halted after` +
            ` ${this.transientStoreFailures} consecutive transient store` +
            ` failures; last: ${toError(error).message}`,
        ),
      );
    }
  }

  /**
   * Bounded release retries, spaced by RELEASE_RETRY_DELAY_MS and only while
   * the lease is still ours. Returns 'released' once the outcome is recorded,
   * 'stale' if the lease is provably lost, and 'exhausted' once the attempt
   * bound, the lease window, or the worker's liveness runs out.
   */
  private async retryReleaseWithinLease(
    run: ActiveRun,
    outcome: 'completed' | 'failed',
  ): Promise<'released' | 'stale' | 'exhausted'> {
    for (let attempt = 0; attempt < MAX_RELEASE_ATTEMPTS; attempt++) {
      if (this.disposed || this.fatalError || this.store.haltedError) {
        return 'exhausted';
      }
      const now = this.storeNow();
      if (now === undefined || now >= run.lease.expiresAt) {
        return 'exhausted';
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, RELEASE_RETRY_DELAY_MS);
        timer.unref();
      });
      // A dispose or halt that landed during the sleep must stop the write:
      // dispose leaves the lease to lapse so a successor re-queues the
      // activation, and a terminal release here would make that retryable
      // failure permanent.
      if (this.disposed || this.fatalError || this.store.haltedError) {
        return 'exhausted';
      }
      try {
        await this.store.release(run.lease, outcome);
        this.noteStoreOutcome();
        this.activationTransientFailures.delete(activationKey(run.activation));
        return 'released';
      } catch (error) {
        if (error instanceof ManagedActivationStaleLeaseError) {
          return 'stale';
        }
        const storeHalted = this.store.haltedError;
        if (storeHalted) {
          this.halt(storeHalted);
          return 'exhausted';
        }
        run.transientFailures++;
        this.noteStoreOutcome(error);
      }
    }
    return 'exhausted';
  }

  /**
   * Merges the transient failures an abandoned run absorbed into the
   * activation's cross-run budget. Every abandon path must call it: in the
   * single-owner store a stale lease is an expired one, so the activation
   * re-queues here — dropping the count would let a persistently failing
   * activation re-run forever. A stale-ended run passes a minimum of one:
   * the dropped run is itself an absorbed failure even when it recorded no
   * transient one.
   */
  private noteAbandonedFailures(run: ActiveRun, minimum = 0): void {
    const absorbed = Math.max(run.transientFailures, minimum);
    if (absorbed === 0) return;
    const key = activationKey(run.activation);
    this.activationTransientFailures.set(
      key,
      (this.activationTransientFailures.get(key) ?? 0) + absorbed,
    );
  }

  /**
   * Abandons a run after transient store failures: the handler is aborted,
   * the lease is left to expire and the recovery wake re-queues the
   * activation. The terminal decision is not made here: the handler may
   * still be in flight, so execute() records the handler's own outcome once
   * the run settles and the activation's transient-failure budget is spent.
   */
  private abandonAfterTransientFailures(run: ActiveRun, error: unknown): void {
    run.abandoned = true;
    run.abortedInFlight = !run.finishing;
    run.controller.abort(error);
    this.noteAbandonedFailures(run);
  }

  /**
   * Records the terminal outcome for an activation whose transient-failure
   * budget is spent. Called only from execute() after the handler settled,
   * so the write never certifies a still-running handler; the outcome is
   * the handler's own unless the scheduler itself aborted the run
   * mid-handler, which is recorded as a failure. A lease that lapsed while
   * the run was abandoning is re-claimed first: release() fences on the
   * remembered lease and would reject it as stale, so the terminal write
   * needs the fresh claim's lease. Returns true once the outcome is
   * durably recorded.
   */
  private async settleTerminalOutcome(
    run: ActiveRun,
    outcome: 'completed' | 'failed',
  ): Promise<boolean> {
    // Yield one scheduler turn before committing: a dispose() or halt()
    // racing the abandon decision must land before the write is issued,
    // because a terminal record from a stopped worker would make a
    // retryable failure permanent.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 0);
      timer.unref();
    });
    if (this.disposed || this.fatalError || this.store.haltedError) {
      return false;
    }
    try {
      await this.store.release(run.lease, outcome);
    } catch (error) {
      if (!(error instanceof ManagedActivationStaleLeaseError)) {
        return this.noteTerminalWriteFailure(error);
      }
      // The remembered lease is stale — in the single-owner store that is
      // an expired one. Re-claim so the terminal write fences on a live
      // lease; a live foreign claim means another worker owns the outcome.
      if (this.disposed || this.fatalError) return false;
      let fresh: ManagedActivationLease | undefined;
      try {
        fresh = await this.store.claim(
          run.activation,
          this.options.workerId,
          this.options.leaseDurationMs,
        );
      } catch (claimError) {
        return this.noteTerminalWriteFailure(claimError);
      }
      if (!fresh) return false;
      // A dispose or halt that landed during the claim must stop the write:
      // the fresh lease is left to lapse so a successor re-queues the
      // activation.
      if (this.disposed || this.fatalError || this.store.haltedError) {
        return false;
      }
      try {
        await this.store.release(fresh, outcome);
      } catch (secondError) {
        if (secondError instanceof ManagedActivationStaleLeaseError) {
          // Lost the fresh lease too; keep the spent budget and leave the
          // activation to its new owner.
          return false;
        }
        return this.noteTerminalWriteFailure(secondError);
      }
    }
    this.noteStoreOutcome();
    this.activationTransientFailures.delete(activationKey(run.activation));
    return true;
  }

  /**
   * Classifies a terminal-write failure the way every other store
   * continuation does: a halted store (consistency damage) halts the worker
   * loudly, a transient one keeps the spent budget so the re-run re-attempts
   * the write. On a disposed or halted scheduler neither happens — a bogus
   * 'is disposed' halt must not overwrite a clean shutdown.
   */
  private noteTerminalWriteFailure(error: unknown): false {
    if (this.disposed || this.fatalError) return false;
    const storeHalted = this.store.haltedError;
    if (storeHalted) {
      this.halt(storeHalted);
      return false;
    }
    // The terminal write failed transiently; the lease expiry re-queues the
    // activation and its next abandon re-attempts the terminal release.
    this.noteStoreOutcome(error);
    return false;
  }

  private scheduleMemoryWake(): void {
    // A dispose or halt may have raced the decision to arm; a wake firing on
    // a dead scheduler surfaces a bogus 'is disposed' halt.
    if (this.disposed || this.fatalError) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.requestPump().catch(() => undefined);
    }, RECHECK_INTERVAL_MS);
    this.recoveryTimer.unref();
  }

  private scheduleRecoveryWake(): void {
    if (this.disposed || this.fatalError) return;
    const activeKeys = new Set(this.active.keys());
    const seenSessions = new Set<string>();
    const pendingKeys = new Set<string>();
    let expiry: number | undefined;
    for (const activation of this.store.listPending()) {
      pendingKeys.add(activationKey(activation.descriptor));
      const key = sessionKey(activation.descriptor);
      if (seenSessions.has(key)) continue;
      seenSessions.add(key);
      if (
        activation.status !== 'assigned' ||
        activeKeys.has(activationKey(activation.descriptor))
      ) {
        continue;
      }
      expiry =
        expiry === undefined
          ? activation.lease!.expiresAt
          : Math.min(expiry, activation.lease!.expiresAt);
    }
    // An activation that is neither pending nor running can never be
    // re-queued; drop its budget entry so the map tracks only live work.
    for (const key of this.activationTransientFailures.keys()) {
      if (!pendingKeys.has(key) && !activeKeys.has(key)) {
        this.activationTransientFailures.delete(key);
      }
    }
    if (expiry === undefined) return;
    const delay = Math.min(
      Math.max(0, expiry - this.store.getCurrentTime()),
      2_147_483_647,
    );
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.requestPump().catch(() => undefined);
    }, delay);
    this.recoveryTimer.unref();
  }

  private halt(error: Error): void {
    if (this.fatalError) return;
    this.fatalError = error;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    for (const run of this.active.values()) {
      run.abandoned = true;
      if (run.renewalTimer) clearTimeout(run.renewalTimer);
      run.controller.abort(error);
    }
  }

  private assertUsable(): void {
    if (this.fatalError) throw this.fatalError;
    if (this.disposed) {
      throw new Error(`Harness Worker '${this.options.workerId}' is disposed.`);
    }
  }
}
