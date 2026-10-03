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
 * Consecutive transient store failures that halt the worker. A store that
 * keeps failing across every path is a persistent outage, not a transient
 * one — the worker fails loudly instead of spinning silently.
 */
const MAX_TRANSIENT_STORE_FAILURES = 10;

/**
 * Transient failures one activation absorbs across re-runs before it is
 * released as failed instead of being re-queued once more.
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
    this.noteStoreOutcome();
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
      transientFailures: 0,
    };
    this.active.set(activationKey(activation), run);
    this.scheduleRenewal(run);
    void this.execute(run);
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

    run.finishing = true;
    if (run.renewalTimer) clearTimeout(run.renewalTimer);
    await run.renewal;

    if (!run.abandoned && !this.disposed && !this.fatalError) {
      try {
        await this.store.release(run.lease, outcome);
        this.noteStoreOutcome();
        this.activationTransientFailures.delete(activationKey(run.activation));
      } catch (error) {
        if (error instanceof ManagedActivationStaleLeaseError) {
          this.noteAbandonedFailures(run);
          run.abandoned = true;
          run.controller.abort(error);
        } else {
          const storeHalted = this.store.haltedError;
          if (storeHalted) {
            this.halt(storeHalted);
          } else {
            // A transient store failure provably never wrote the outcome (the
            // journal tail repair succeeded), so retrying within the lease's
            // remaining window is safe and avoids re-executing an
            // already-finished handler over one repaired write failure.
            run.transientFailures++;
            this.noteStoreOutcome(error);
            if (!this.fatalError) {
              const settled = await this.retryReleaseWithinLease(run, outcome);
              if (settled === 'stale') {
                this.noteAbandonedFailures(run);
                run.abandoned = true;
                run.controller.abort(error);
              } else if (
                settled === 'exhausted' &&
                !this.disposed &&
                !this.fatalError
              ) {
                debugLogger.warn(
                  `Managed activation '${run.lease.activationId}' abandoned` +
                    ` after a release failure: ${toError(error).message}`,
                );
                this.abandonAfterTransientFailures(run, outcome, error);
              }
            }
          }
        }
      }
    }

    this.active.delete(activationKey(run.activation));
    if (handlerError !== undefined && !run.abandoned && !this.disposed) {
      try {
        this.options.onActivationError?.(run.activation, handlerError);
      } catch (error) {
        this.halt(toError(error));
      }
    }
    if (!this.disposed && !this.fatalError) {
      void this.requestPump().catch(() => undefined);
    }
  }

  private scheduleRenewal(run: ActiveRun): void {
    const delay = Math.max(1, Math.floor(this.options.leaseDurationMs / 3));
    run.renewalTimer = setTimeout(() => {
      run.renewal = this.renew(run).finally(() => {
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
        // activation's outcome now. The transient failures this run absorbed
        // still count against its budget.
        this.noteAbandonedFailures(run);
        run.abandoned = true;
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
      const headroom = run.lease.expiresAt - this.store.getCurrentTime();
      if (headroom > interval) {
        debugLogger.warn(
          `Managed activation '${run.lease.activationId}' renewal failed` +
            ` transiently; retrying within its lease:` +
            ` ${toError(error).message}`,
        );
        this.scheduleRenewal(run);
        return;
      }
      // No headroom left for another tick: the lease lapses and the recovery
      // wake re-queues the activation, unless its transient-failure budget is
      // spent.
      debugLogger.warn(
        `Managed activation '${run.lease.activationId}' abandoned` +
          ` after a renewal failure: ${toError(error).message}`,
      );
      this.abandonAfterTransientFailures(run, 'failed', error);
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
    if (this.transientStoreFailures >= MAX_TRANSIENT_STORE_FAILURES) {
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
      if (this.store.getCurrentTime() >= run.lease.expiresAt) {
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
   * activation re-run forever.
   */
  private noteAbandonedFailures(run: ActiveRun): void {
    if (run.transientFailures === 0) return;
    const key = activationKey(run.activation);
    this.activationTransientFailures.set(
      key,
      (this.activationTransientFailures.get(key) ?? 0) + run.transientFailures,
    );
  }

  /**
   * Abandons a run after transient store failures: the lease is left to
   * expire and the recovery wake re-queues the activation. The activation's
   * transient-failure budget accumulates across re-runs; once spent, the
   * scheduler records the terminal outcome itself (best-effort) so a
   * persistently failing activation converges instead of re-running forever.
   */
  private abandonAfterTransientFailures(
    run: ActiveRun,
    outcome: 'completed' | 'failed',
    error: unknown,
  ): void {
    run.abandoned = true;
    run.controller.abort(error);
    const key = activationKey(run.activation);
    this.noteAbandonedFailures(run);
    const failures = this.activationTransientFailures.get(key) ?? 0;
    if (failures < MAX_ACTIVATION_TRANSIENT_FAILURES) return;
    void this.store.release(run.lease, outcome).then(
      () => {
        this.noteStoreOutcome();
        this.activationTransientFailures.delete(key);
      },
      (releaseError: unknown) => {
        if (releaseError instanceof ManagedActivationStaleLeaseError) {
          // The lease expired or another worker claimed the activation. Keep
          // the spent budget either way: on a bare expiry the activation
          // re-queues here, and a fresh budget would let it re-run forever.
          return;
        }
        const storeHalted = this.store.haltedError;
        if (storeHalted) {
          this.halt(storeHalted);
          return;
        }
        // The terminal write failed too; the lease expiry re-queues the
        // activation and its next abandon re-attempts the terminal release.
        this.noteStoreOutcome(releaseError);
      },
    );
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
