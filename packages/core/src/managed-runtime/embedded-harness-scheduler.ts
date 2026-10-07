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
 * First headroom poll of a memory-blocked episode; it doubles per blocked
 * tick up to {@link MEMORY_BLOCKED_POLL_MAX_MS} and resets when a pump clears
 * the blocked flag, so a minutes-long memory-pressure episode does not poll
 * the store at a fixed 1 Hz.
 */
const MEMORY_BLOCKED_POLL_MS = 1_000;
const MEMORY_BLOCKED_POLL_MAX_MS = 30_000;

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
  private memoryBlockedPollMs = MEMORY_BLOCKED_POLL_MS;
  private fatalError: Error | undefined;

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
    if (this.started) {
      // A genuinely new queued activation restarts the blocked poll cadence;
      // an idempotent re-submit must not spend the backoff it did not cause.
      void this.requestPump({ restartBlockedCadence: result.created }).catch(
        () => undefined,
      );
    }
    return result;
  }

  notifyCapacityChanged(): void {
    if (!this.started || this.disposed || this.fatalError) return;
    // External triggers restart the blocked poll cadence: the backoff belongs
    // to timer-driven polls, and a burst of submissions must not spend it.
    void this.requestPump({ restartBlockedCadence: true }).catch(
      () => undefined,
    );
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

  private requestPump(options?: {
    restartBlockedCadence?: boolean;
  }): Promise<void> {
    const result = this.pumpTail.then(async () => {
      this.assertUsable();
      await this.pump(options);
    });
    this.pumpTail = result.catch((error: unknown) => {
      this.halt(toError(error));
    });
    return result;
  }

  private async pump(options?: {
    restartBlockedCadence?: boolean;
  }): Promise<void> {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;

    while (this.active.size < this.options.maxActiveSlots) {
      const candidates = this.store
        .listRunnable()
        .filter(
          (candidate) => !this.active.has(activationKey(candidate.descriptor)),
        );
      if (candidates.length === 0) {
        this.clearMemoryBlocked();
        this.scheduleRecoveryWake();
        return;
      }
      if (!this.options.hasMemoryHeadroom()) {
        this.memoryBlocked = true;
        // The restart is consumed here, inside the pump it was carried into:
        // written ahead of the queue it would be spent by a pump that was
        // already waiting.
        if (options?.restartBlockedCadence === true) {
          this.memoryBlockedPollMs = MEMORY_BLOCKED_POLL_MS;
        }
        // Entries of the pump cleared the armed recovery wake above, and no
        // execute() completion is coming to re-arm it (zero or idle active
        // runs) — queued work and reclaimable leases would otherwise wait
        // forever.
        this.armBlockedWake();
        return;
      }
      this.clearMemoryBlocked();
      const candidate = this.selectTenantFair(candidates)!;
      const lease = await this.store.claim(
        candidate.descriptor,
        this.options.workerId,
        this.options.leaseDurationMs,
      );
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
      } catch (error) {
        if (error instanceof ManagedActivationStaleLeaseError) {
          run.abandoned = true;
          run.controller.abort(error);
        } else {
          this.halt(toError(error));
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
      if (!run.finishing && !run.abandoned && !this.disposed) {
        this.scheduleRenewal(run);
      }
    } catch (error) {
      run.abandoned = true;
      run.controller.abort(error);
      if (!(error instanceof ManagedActivationStaleLeaseError)) {
        this.halt(toError(error));
      }
    }
  }

  private clearMemoryBlocked(): void {
    this.memoryBlocked = false;
    this.memoryBlockedPollMs = MEMORY_BLOCKED_POLL_MS;
  }

  /** Arms the wake a memory-blocked pump still needs and steps the backoff. */
  private armBlockedWake(): void {
    const wake = this.scheduleRecoveryWake(this.memoryBlockedPollMs);
    this.memoryBlockedPollMs =
      wake === 'lease'
        ? MEMORY_BLOCKED_POLL_MS
        : Math.min(this.memoryBlockedPollMs * 2, MEMORY_BLOCKED_POLL_MAX_MS);
  }

  private armRecoveryTimer(delay: number): void {
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.requestPump().catch(() => undefined);
    }, delay);
    this.recoveryTimer.unref();
  }

  /**
   * Arms the recovery wake for the next reclaimable lease expiry. A blocked
   * pump passes its headroom poll cadence and takes the sooner lease wake
   * only when the lease expires inside the base poll interval: reclaiming
   * waits on headroom either way, so a later expiry is covered by the
   * cadence. Returns what was armed — 'lease' restarts the blocked backoff,
   * since a lease transition is a fresh chance to claim.
   */
  private scheduleRecoveryWake(
    blockedPollMs?: number,
  ): 'lease' | 'poll' | 'none' {
    const activeKeys = new Set(this.active.keys());
    const seenSessions = new Set<string>();
    let expiry: number | undefined;
    for (const activation of this.store.listPending()) {
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
    if (expiry === undefined) {
      // No reclaimable lease; a blocked pump with queued work still polls
      // for headroom, since nothing else re-runs it.
      if (blockedPollMs === undefined) return 'none';
      this.armRecoveryTimer(blockedPollMs);
      return 'poll';
    }
    const remaining = expiry - this.store.getCurrentTime();
    if (
      blockedPollMs !== undefined &&
      (remaining <= 0 || remaining > MEMORY_BLOCKED_POLL_MS)
    ) {
      this.armRecoveryTimer(blockedPollMs);
      return 'poll';
    }
    // An already-expired lease is reclaimable now, but a zero delay would
    // spin the pump while the worker stays memory-blocked — poll instead.
    this.armRecoveryTimer(
      Math.min(remaining <= 0 ? 1_000 : remaining, 2_147_483_647),
    );
    return 'lease';
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
