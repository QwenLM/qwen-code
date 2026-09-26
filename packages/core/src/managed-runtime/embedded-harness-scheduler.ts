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
        return;
      }
      this.memoryBlocked = false;
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

  private scheduleRecoveryWake(): void {
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
