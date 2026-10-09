/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddedHarnessScheduler } from './embedded-harness-scheduler.js';
import {
  FileManagedActivationStore,
  ManagedActivationStaleLeaseError,
  type ManagedActivationDescriptor,
} from './managed-activation-store.js';

// Journal fault injection: a failed append whose tail repair succeeds is a
// transient store failure; one whose repair fails is consistency damage.
const fsFault = vi.hoisted(() => ({ failAppends: 0, failTruncates: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    appendFile: async (...args: Parameters<typeof original.appendFile>) => {
      if (fsFault.failAppends > 0) {
        fsFault.failAppends--;
        throw new Error('disk busy');
      }
      return original.appendFile(...args);
    },
    truncate: async (...args: Parameters<typeof original.truncate>) => {
      if (fsFault.failTruncates > 0) {
        fsFault.failTruncates--;
        throw new Error('repair failed');
      }
      return original.truncate(...args);
    },
  };
});

function activation(
  activationId: string,
  overrides: Partial<ManagedActivationDescriptor> = {},
): ManagedActivationDescriptor {
  return {
    tenantId: 'tenant-a',
    sessionId: `session-${activationId}`,
    activationId,
    payloadRef: `event:${activationId}`,
    reason: 'user_message',
    recovery: 'replay_safe',
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for scheduler state.');
}

/**
 * Advances the fake clock in steps until the predicate holds. Timer callbacks
 * that await real file IO finish their chain (and arm any follow-up timer) on
 * the real event loop, which a single advanceTimersByTimeAsync does not
 * drain — so steps are interleaved with real turns, bounded by real time
 * rather than a fixed iteration count (40 fast turns can elapse before one
 * fsync-backed write resolves under coverage).
 */
async function advanceTimersUntil(
  predicate: () => boolean,
  stepMs: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(stepMs);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out advancing timers.');
}

describe('EmbeddedHarnessScheduler', () => {
  let root: string;
  let filePath: string;
  const schedulers: EmbeddedHarnessScheduler[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'embedded-harness-'));
    filePath = path.join(root, 'activations.jsonl');
  });

  afterEach(async () => {
    for (const scheduler of schedulers) scheduler.dispose();
    schedulers.length = 0;
    fsFault.failAppends = 0;
    fsFault.failTruncates = 0;
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it('bounds concurrent asynchronous activation slots', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    const gates = new Map(
      ['a1', 'a2', 'a3'].map((id) => [id, deferred()] as const),
    );
    const started: string[] = [];
    let running = 0;
    let maximumRunning = 0;
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 2,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => true,
      handler: async (item) => {
        started.push(item.activationId);
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        await gates.get(item.activationId)!.promise;
        running -= 1;
      },
    });
    schedulers.push(scheduler);
    for (const id of gates.keys()) await scheduler.submit(activation(id));

    await scheduler.start();
    expect(started).toEqual(['a1', 'a2']);
    expect(scheduler.activeSlotCount).toBe(2);

    gates.get('a1')!.resolve();
    await waitUntil(() => started.length === 3);
    expect(started).toEqual(['a1', 'a2', 'a3']);
    expect(maximumRunning).toBe(2);

    gates.get('a2')!.resolve();
    gates.get('a3')!.resolve();
    await waitUntil(() => scheduler.activeSlotCount === 0);
    expect(
      ['a1', 'a2', 'a3'].map((id) => store.get(activation(id))?.outcome),
    ).toEqual(['completed', 'completed', 'completed']);
  });

  it('alternates tenants while preserving each Session FIFO', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    const order: string[] = [];
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => true,
      handler: async (item) => {
        order.push(item.activationId);
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(activation('a1', { sessionId: 'session-a' }));
    await scheduler.submit(activation('a2', { sessionId: 'session-a' }));
    await scheduler.submit(activation('a3', { sessionId: 'session-a3' }));
    await scheduler.submit(
      activation('b1', { tenantId: 'tenant-b', sessionId: 'session-b' }),
    );
    await scheduler.submit(
      activation('b2', { tenantId: 'tenant-b', sessionId: 'session-b' }),
    );

    await scheduler.start();
    await waitUntil(
      () => order.length === 5 && scheduler.activeSlotCount === 0,
    );
    expect(order).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('leaves work queued until memory headroom is available', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    let hasMemory = false;
    const handled = vi.fn();
    const item = activation('a1');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 2,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => hasMemory,
      handler: async () => {
        handled();
      },
    });
    schedulers.push(scheduler);
    await scheduler.start();
    await expect(scheduler.submit(item)).resolves.toMatchObject({
      created: true,
      activation: { status: 'queued' },
    });

    await waitUntil(() => scheduler.isMemoryBlocked);
    expect(scheduler.isMemoryBlocked).toBe(true);
    expect(scheduler.activeSlotCount).toBe(0);
    expect(store.get(item)).toMatchObject({ status: 'queued' });

    hasMemory = true;
    scheduler.notifyCapacityChanged();
    await waitUntil(() => store.get(item)?.status === 'released');
    expect(handled).toHaveBeenCalledOnce();
  });

  it('recovers an expired assignment with a higher fenced epoch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0;
    const original = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const item = activation('a1');
    await original.enqueue(item, { maxQueued: 10, maxQueuedPerTenant: 10 });
    const oldLease = await original.claim(item, 'dead-worker', 10);

    now = 9;
    const recovered = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const gate = deferred();
    let observedEpoch: number | undefined;
    const scheduler = new EmbeddedHarnessScheduler({
      store: recovered,
      workerId: 'replacement-worker',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 30_000,
      hasMemoryHeadroom: () => true,
      handler: async (_activation, context) => {
        observedEpoch = context.fence.epoch;
        await gate.promise;
      },
    });
    schedulers.push(scheduler);

    await scheduler.start();
    expect(observedEpoch).toBeUndefined();
    now = 10;
    await vi.advanceTimersByTimeAsync(1);
    await waitUntil(() => observedEpoch !== undefined);
    expect(observedEpoch).toBe(2);
    now = 11;
    await expect(
      recovered.release(oldLease!, 'completed'),
    ).rejects.toBeInstanceOf(ManagedActivationStaleLeaseError);
    now = 12;
    gate.resolve();
    await waitUntil(() => recovered.get(item)?.status === 'released');
    expect(recovered.get(item)?.outcome).toBe('completed');
  });

  it('renews the lease while a handler remains active', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const item = activation('a1');
    const gate = deferred();
    const renewed = deferred();
    const originalRenew = store.renew.bind(store);
    vi.spyOn(store, 'renew').mockImplementation(async (...args) => {
      const result = await originalRenew(...args);
      renewed.resolve();
      return result;
    });
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async () => {
        await gate.promise;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();

    now = 130;
    await vi.advanceTimersByTimeAsync(30);
    await renewed.promise;
    expect(store.get(item)?.lease?.expiresAt).toBe(220);

    now = 131;
    gate.resolve();
    await waitUntil(() => store.get(item)?.status === 'released');
  });

  it('durably records handler failure without halting the Worker', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    const onActivationError = vi.fn();
    const item = activation('a1');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => true,
      handler: async () => {
        throw new Error('handler failed');
      },
      onActivationError,
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => store.get(item)?.status === 'released');

    expect(store.get(item)?.outcome).toBe('failed');
    expect(onActivationError).toHaveBeenCalledWith(
      expect.objectContaining({ activationId: 'a1' }),
      expect.objectContaining({ message: 'handler failed' }),
    );
    expect(scheduler.haltedError).toBeUndefined();
  });

  // Issue #13182 finding 4, hardened ahead of the scheduler's first
  // production wiring: a memory-blocked pump must arm its own recovery
  // source — a missed notifyCapacityChanged() must not starve queued
  // activations forever.
  it('recovers queued work when memory pressure relieves without a notification', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    let hasMemory = false;
    const handled = vi.fn();
    const item = activation('a1');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => hasMemory,
      handler: async () => {
        handled();
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => scheduler.isMemoryBlocked);
    expect(store.get(item)?.status).toBe('queued');

    // Memory pressure relieves, but the capacity notification is missed:
    // the embedder's monitor fired on pressure and not on relief, or it was
    // never wired. The queued activation holds no lease whose expiry would
    // arm the recovery timer, so the scheduler must re-check on its own.
    hasMemory = true;

    // Nothing may run while the block still holds.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(handled).not.toHaveBeenCalled();
    expect(store.get(item)?.status).toBe('queued');

    await waitUntil(() => handled.mock.calls.length > 0);
    await waitUntil(() => store.get(item)?.status === 'released');
  });

  // Issue #13182 finding 5, hardened ahead of the scheduler's first
  // production wiring: a transient renewal failure is retried within the
  // lease's remaining headroom, not abandoned on — and still must not halt
  // the whole worker.
  it('retries a transient renewal failure within the lease headroom', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const gate = deferred();
    const signals = new Map<string, AbortSignal>();
    const renewalCalls = new Map<string, number>();
    const originalRenew = store.renew.bind(store);
    let failA1Renewals = 1;
    vi.spyOn(store, 'renew').mockImplementation(async (...args) => {
      renewalCalls.set(
        args[0].activationId,
        (renewalCalls.get(args[0].activationId) ?? 0) + 1,
      );
      if (args[0].activationId === 'a1' && failA1Renewals > 0) {
        failA1Renewals--;
        throw new Error('disk busy');
      }
      return originalRenew(...args);
    });
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 2,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async (item, context) => {
        signals.set(item.activationId, context.signal);
        await gate.promise;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(activation('a1'));
    await scheduler.submit(activation('a2'));
    await scheduler.start();
    expect(scheduler.activeSlotCount).toBe(2);

    // a1's first renewal tick hits one transient store failure. The lease
    // (claimed at 100, expiring at 190) still has headroom for another tick,
    // so the renewal is retried instead of abandoning the run.
    now = 130;
    await vi.advanceTimersByTimeAsync(30);
    // The retried renewal landing is the observable proof that the failure
    // was absorbed (no abort, no abandon); its write is real file IO, which
    // fake timers do not drain.
    await vi.advanceTimersByTimeAsync(30);
    await waitUntil(
      () => store.get(activation('a1'))?.lease?.expiresAt === 220,
    );
    expect(renewalCalls.get('a1')).toBe(2);
    expect(signals.get('a1')?.aborted).toBe(false);
    expect(signals.get('a2')?.aborted).toBe(false);
    expect(scheduler.haltedError).toBeUndefined();
    expect(store.haltedError).toBeUndefined();

    gate.resolve();
    await waitUntil(() => scheduler.activeSlotCount === 0);
    expect(store.get(activation('a1'))?.outcome).toBe('completed');
    expect(store.get(activation('a2'))?.outcome).toBe('completed');
    await expect(scheduler.submit(activation('a3'))).resolves.toMatchObject({
      created: true,
    });
  });

  // A renewal that fails transiently while the handler is finishing belongs
  // to execute()'s release path, which owns the outcome's retry: abandoning
  // the run there would drop a completed outcome and re-run the handler.
  it('releases a finished handler whose in-flight renewal failed transiently', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const gate = deferred();
    const renewGate = deferred();
    const signals = new Map<string, AbortSignal>();
    const item = activation('a1');
    let runs = 0;
    const originalRenew = store.renew.bind(store);
    vi.spyOn(store, 'renew').mockImplementation(async (...args) => {
      await renewGate.promise;
      fsFault.failAppends = 1;
      return originalRenew(...args);
    });
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async (activation, context) => {
        runs++;
        signals.set(activation.activationId, context.signal);
        await gate.promise;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => runs === 1);

    // The renewal tick starts and stays in flight; the handler finishes
    // underneath it, so execute() is waiting on the renewal when its
    // transient failure lands. The lease expires at 190: landing the failure
    // at 170 leaves no headroom for another tick, so without the finishing
    // early-return the renewal path would abandon the finished run.
    now = 170;
    await vi.advanceTimersByTimeAsync(30);
    gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    renewGate.resolve();

    await waitUntil(() => store.get(item)?.status === 'released');
    expect(store.get(item)?.outcome).toBe('completed');
    expect(signals.get('a1')?.aborted).toBe(false);
    expect(scheduler.haltedError).toBeUndefined();
  });

  // The other half of finding 5: when the store cannot repair a failed
  // write, the journal's state is unknown — that is consistency damage, and
  // the worker still halts.
  it('halts the worker when the store cannot repair a failed write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const gate = deferred();
    const signals = new Map<string, AbortSignal>();
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 2,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async (item, context) => {
        signals.set(item.activationId, context.signal);
        await gate.promise;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(activation('a1'));
    await scheduler.submit(activation('a2'));
    await scheduler.start();
    expect(scheduler.activeSlotCount).toBe(2);

    fsFault.failAppends = 1;
    fsFault.failTruncates = 1;
    now = 130;
    await vi.advanceTimersByTimeAsync(30);
    // The injected append/truncate failures themselves are synchronous, but
    // persist() awaits a real mkdir first, so the failure chain crosses real
    // event-loop turns that fake timers do not drain.
    await waitUntil(() => scheduler.haltedError !== undefined);

    expect(scheduler.haltedError?.message).toBe('disk busy');
    expect(signals.get('a1')?.aborted).toBe(true);
    expect(signals.get('a2')?.aborted).toBe(true);
    await expect(scheduler.submit(activation('a3'))).rejects.toThrow(
      'disk busy',
    );
  });

  // A transient failure while releasing a finished activation provably never
  // recorded the outcome, so the scheduler retries within the lease window:
  // an already-finished handler must not be re-executed over one repaired
  // write failure, and the worker must not halt.
  it('retries a transient release failure within the lease window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const gate = deferred();
    let runs = 0;
    const item = activation('a1');
    const releaseSpy = vi.spyOn(store, 'release');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async () => {
        runs++;
        await gate.promise;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => runs === 1);

    // The release's first journal write fails transiently; the lease
    // (claimed at 100, expiring at 190) is still ours, so the release is
    // retried once the spaced retry timer fires.
    fsFault.failAppends = 1;
    gate.resolve();
    await waitUntil(() => releaseSpy.mock.calls.length === 1);
    await advanceTimersUntil(() => releaseSpy.mock.calls.length === 2, 250);
    await waitUntil(() => store.get(item)?.status === 'released');
    expect(runs).toBe(1);
    expect(store.get(item)?.outcome).toBe('completed');
    expect(scheduler.haltedError).toBeUndefined();
  });

  // A dispose landing inside the release retry's sleep must stop the retry
  // write: dispose leaves the lease to lapse so a successor re-queues the
  // activation, and releasing here would make that retryable failure
  // permanent.
  it('does not release after disposal races the release retry sleep', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const gate = deferred();
    const item = activation('a1');
    const releaseSpy = vi.spyOn(store, 'release');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async () => {
        await gate.promise;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();

    fsFault.failAppends = 1;
    gate.resolve();
    await waitUntil(() => releaseSpy.mock.calls.length === 1);
    // The retry sleep must provably be armed before the disposal lands
    // inside it: while execute() awaits the sleep it is the only pending
    // timer, and consuming 100 of its 250 ms proves it started and has not
    // finished.
    await waitUntil(() => vi.getTimerCount() === 1);
    await vi.advanceTimersByTimeAsync(100);
    scheduler.dispose();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(250);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(releaseSpy.mock.calls.length).toBe(1);
    expect(store.get(item)?.status).toBe('assigned');
    expect(scheduler.haltedError).toBeUndefined();
  });

  // Once the release's retry bound is spent the activation is abandoned as
  // before — but its transient-failure budget is spent too, so the scheduler
  // records the terminal outcome itself rather than re-queuing the handler
  // for another execution.
  it('records the terminal outcome when release retries exhaust the transient budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const gate = deferred();
    let runs = 0;
    const item = activation('a1');
    const releaseSpy = vi.spyOn(store, 'release');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async () => {
        runs++;
        await gate.promise;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => runs === 1);

    // The initial release and all three retries fail transiently; the fault
    // clears just before the scheduler's own terminal write.
    fsFault.failAppends = 4;
    gate.resolve();
    await waitUntil(() => releaseSpy.mock.calls.length === 1);
    await advanceTimersUntil(() => releaseSpy.mock.calls.length === 4, 250);

    // Four absorbed failures exceed the activation's budget (3): the run is
    // abandoned and the scheduler records the completed outcome itself. The
    // terminal write commits after a yielded turn, so the wait advances the
    // clock.
    await advanceTimersUntil(() => store.get(item)?.status === 'released', 250);
    expect(releaseSpy.mock.calls.length).toBe(5);
    expect(runs).toBe(1);
    expect(store.get(item)?.outcome).toBe('completed');
    expect(scheduler.haltedError).toBeUndefined();
  });

  // If even the terminal outcome write fails transiently, the lease expiry
  // re-queues the activation as before and the re-run records the outcome.
  it('re-queues the activation when even the terminal outcome write fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const gate = deferred();
    let runs = 0;
    const item = activation('a1');
    const releaseSpy = vi.spyOn(store, 'release');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async () => {
        runs++;
        await gate.promise;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => runs === 1);

    // The initial release, all three retries, and the terminal outcome
    // write fail transiently: the activation is abandoned and its lease
    // (claimed at 100 for 90) expires at 190.
    fsFault.failAppends = 5;
    gate.resolve();
    await waitUntil(() => releaseSpy.mock.calls.length === 1);
    await advanceTimersUntil(() => releaseSpy.mock.calls.length === 4, 250);
    // The terminal outcome write (the fifth call) fires once the budget is
    // found to be spent, after a yielded commit turn.
    await advanceTimersUntil(
      () =>
        releaseSpy.mock.calls.length === 5 &&
        scheduler.activeSlotCount === 0 &&
        store.get(item)?.status === 'assigned',
      250,
    );
    expect(scheduler.haltedError).toBeUndefined();

    // The recovery wake at the lease's expiry re-queues and re-runs it.
    now = 250;
    await advanceTimersUntil(() => runs === 2, 160);
    await waitUntil(() => store.get(item)?.status === 'released');
    expect(store.get(item)?.outcome).toBe('completed');
  });

  // The other half of the claim policy: when the store cannot repair the
  // failed write, the claim error still halts the worker.
  it('halts the worker when a claim write cannot be repaired', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => true,
      handler: async () => {},
    });
    schedulers.push(scheduler);
    await scheduler.submit(activation('a1'));

    fsFault.failAppends = 1;
    fsFault.failTruncates = 1;
    await expect(scheduler.start()).rejects.toThrow('disk busy');

    expect(scheduler.haltedError?.message).toBe('disk busy');
    await expect(scheduler.submit(activation('a2'))).rejects.toThrow(
      'disk busy',
    );
  });

  // The release path keeps the other half of the policy too: an
  // unrepairable write while releasing halts the worker.
  it('halts the worker when a release write cannot be repaired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const gate = deferred();
    const signals = new Map<string, AbortSignal>();
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 2,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async (item, context) => {
        signals.set(item.activationId, context.signal);
        if (item.activationId === 'a1') return;
        await gate.promise;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(activation('a1'));
    await scheduler.submit(activation('a2'));
    await scheduler.start();
    await waitUntil(() => signals.size === 2);

    // a1's handler completes; the release's journal write fails and the
    // repair fails too — consistency damage halts the whole worker.
    fsFault.failAppends = 1;
    fsFault.failTruncates = 1;
    await waitUntil(() => scheduler.haltedError !== undefined);

    expect(scheduler.haltedError?.message).toBe('disk busy');
    expect(signals.get('a2')?.aborted).toBe(true);
    await expect(scheduler.submit(activation('a3'))).rejects.toThrow(
      'disk busy',
    );
    gate.resolve();
  });

  // The claim path follows the same policy: a transient journal write
  // failure while claiming is retried by the recheck wake, not halted on.
  it('retries a claim after a transient store write failure', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    const handled = vi.fn();
    const item = activation('a1');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => true,
      handler: async () => {
        handled();
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    // The first claim's journal write fails transiently.
    fsFault.failAppends = 1;
    await scheduler.start();
    expect(scheduler.haltedError).toBeUndefined();
    expect(store.get(item)?.status).toBe('queued');

    await waitUntil(() => handled.mock.calls.length > 0);
    await waitUntil(() => store.get(item)?.status === 'released');
  });

  // The transient claim retry has its own bound: a store that keeps failing
  // across every recheck is a persistent outage in disguise, and the worker
  // halts loudly instead of polling silently forever.
  it('halts the worker after a streak of transient claim failures', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = await FileManagedActivationStore.open(filePath);
    const item = activation('a1');
    const claimSpy = vi.spyOn(store, 'claim');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => true,
      handler: async () => {},
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    // Every claim's journal write fails transiently; the repair keeps
    // succeeding, so the store itself never halts.
    fsFault.failAppends = 10;
    await scheduler.start();
    await waitUntil(() => claimSpy.mock.calls.length === 1);
    expect(scheduler.haltedError).toBeUndefined();

    await advanceTimersUntil(() => claimSpy.mock.calls.length === 10, 1_000);
    await waitUntil(() => scheduler.haltedError !== undefined);
    expect(scheduler.haltedError?.message).toContain(
      'consecutive transient store failures',
    );
    expect(store.get(item)?.status).toBe('queued');
    await expect(scheduler.submit(activation('a2'))).rejects.toThrow(
      'consecutive transient store failures',
    );
  });

  // A duplicate enqueue performs no store I/O (the descriptor is already
  // known), so re-submitting an activation between failing claim attempts
  // must not reset the consecutive-failure streak.
  it('halts the worker even when duplicates are re-submitted between failing claims', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = await FileManagedActivationStore.open(filePath);
    const item = activation('a1');
    const claimSpy = vi.spyOn(store, 'claim');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => true,
      handler: async () => {},
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    // Every claim's journal write fails transiently; the repair keeps
    // succeeding, so the store itself never halts.
    fsFault.failAppends = 10;
    await scheduler.start();
    await waitUntil(() => claimSpy.mock.calls.length === 1);
    expect(scheduler.haltedError).toBeUndefined();

    // Re-submit the already-known activation between rechecks.
    for (let i = 0; i < 20 && scheduler.haltedError === undefined; i++) {
      await vi.advanceTimersByTimeAsync(500);
      if (scheduler.haltedError !== undefined) break;
      const duplicate = await scheduler.submit(item);
      expect(duplicate.created).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(scheduler.haltedError?.message).toContain(
      'consecutive transient store failures',
    );
    expect(store.get(item)?.status).toBe('queued');
  });

  // The per-activation bound: renewals that keep failing across re-runs
  // spend the activation's transient-failure budget; once spent, the
  // scheduler records the terminal outcome itself instead of re-queuing the
  // activation forever. This handler returns only because the scheduler's
  // abort landed mid-handler, so the record is 'failed' — a
  // scheduler-induced abort must not certify the work succeeded.
  it('converges to a terminal release when renewals keep failing across re-runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    let runs = 0;
    const item = activation('a1');
    vi.spyOn(store, 'renew').mockRejectedValue(new Error('disk busy'));
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async (_activation, context) => {
        runs++;
        if (context.signal.aborted) return;
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => runs === 1);

    // Claimed at 100 with a 90ms lease (expires 190): the first renewal
    // failure is retried within the headroom, the second leaves no headroom
    // for another tick and the run is abandoned.
    now = 130;
    await vi.advanceTimersByTimeAsync(30);
    now = 160;
    await vi.advanceTimersByTimeAsync(30);
    await waitUntil(() => scheduler.activeSlotCount === 0);
    expect(store.get(item)?.status).toBe('assigned');

    // The lease expiry re-queues the activation; its renewals keep failing,
    // the budget (3) is spent, and the scheduler records the terminal
    // outcome instead of re-queuing it once more.
    now = 200;
    await vi.advanceTimersByTimeAsync(60);
    await waitUntil(() => runs === 2);
    now = 230;
    await vi.advanceTimersByTimeAsync(30);
    now = 260;
    await vi.advanceTimersByTimeAsync(30);
    await advanceTimersUntil(() => store.get(item)?.status === 'released', 30);
    expect(runs).toBe(2);
    expect(store.get(item)?.outcome).toBe('failed');
    expect(scheduler.haltedError).toBeUndefined();
  });

  // Failures absorbed by runs that end on a stale lease (an expired lease
  // reads as stale in this store) still count against the activation's
  // budget: dropping them would let an activation whose renewals keep failing
  // at the lease edge re-run forever.
  it('counts failures from stale-ended runs toward the activation budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    let runs = 0;
    const item = activation('a1');
    // Every run's first renewal tick fails transiently; the retry reaches
    // the real store after the lease expired and answers stale.
    const originalRenew = store.renew.bind(store);
    let renewCalls = 0;
    vi.spyOn(store, 'renew').mockImplementation(async (...args) => {
      renewCalls++;
      if (renewCalls % 2 === 1) {
        throw new Error('disk busy');
      }
      return originalRenew(...args);
    });
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async (_activation, context) => {
        runs++;
        if (context.signal.aborted) return;
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => runs === 1);

    // Runs 1-2: the renewal tick fails, and its retry lands after the lease
    // expired — the store's stale answer must still merge the absorbed
    // failures into the activation's budget. One timer per step
    // (nextTimer), so the renewal cadence and the recovery wake never share
    // an advance.
    let renewals = 0;
    let claimedAt = 100;
    for (let run = 1; run <= 2; run++) {
      now = claimedAt + 30;
      await vi.advanceTimersToNextTimerAsync();
      await waitUntil(() => renewCalls === ++renewals);
      now = claimedAt + 95;
      await vi.advanceTimersToNextTimerAsync();
      await waitUntil(() => renewCalls === ++renewals);
      // The stale abandon re-queues the activation; its lease expired, so
      // the trailing pump re-claims it inline (real file IO).
      claimedAt = now;
      await waitUntil(() => runs === run + 1);
    }

    // Run 3: the budget (2) plus this run's absorbed failure is spent, so
    // once the handler settles after the abort the scheduler records the
    // terminal outcome instead of re-queuing again — 'failed', because the
    // handler returned only by honoring the scheduler's mid-handler abort —
    // written with a fresh claim because the remembered lease has expired.
    now = claimedAt + 30;
    await vi.advanceTimersToNextTimerAsync();
    await waitUntil(() => renewCalls === ++renewals);
    now = claimedAt + 95;
    await vi.advanceTimersToNextTimerAsync();
    await waitUntil(() => renewCalls === ++renewals);
    await advanceTimersUntil(() => store.get(item)?.status === 'released', 30);
    expect(store.get(item)?.outcome).toBe('failed');
    expect(runs).toBe(3);
    expect(scheduler.haltedError).toBeUndefined();
  });

  // getCurrentTime() is a validating accessor: a clock that starts returning
  // garbage must not escape the renewal/release error paths as an unhandled
  // rejection or a leaked active slot — the run cleans up and the worker
  // escalates to a loud halt. The abort reason pins the path: the renewal's
  // transient failure abandons the run first (storeNow() treats the
  // unreadable clock as no headroom), so the handler is aborted with the
  // renewal's error; a clock throw escaping renew() would halt the worker
  // directly and abort the run with the clock error instead.
  it('halts loudly when the injected store clock starts failing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 100;
    let clockBroken = false;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => (clockBroken ? -1 : now),
    });
    let runs = 0;
    let abortReason: unknown;
    const item = activation('a1');
    // The renewal's journal write fails transiently while the injected
    // clock still reads fine (advancing, so the renewal extends and
    // persists); the clock breaks before the scheduler reads it for the
    // headroom decision.
    const originalRenew = store.renew.bind(store);
    vi.spyOn(store, 'renew').mockImplementation(async (...args) => {
      now += 30;
      fsFault.failAppends = 1;
      const pending = originalRenew(...args);
      pending.catch(() => {
        clockBroken = true;
      });
      return pending;
    });
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async (_activation, context) => {
        runs++;
        if (context.signal.aborted) return;
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            'abort',
            () => {
              abortReason = context.signal.reason;
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => runs === 1);

    await advanceTimersUntil(() => scheduler.haltedError !== undefined, 1_000);

    expect(scheduler.activeSlotCount).toBe(0);
    expect(scheduler.haltedError?.message).toContain('clock');
    expect(abortReason).toBeInstanceOf(Error);
    expect((abortReason as Error).message).toBe('disk busy');
  });

  // A disposal racing an in-flight transient claim failure must not arm the
  // recheck wake on the dead scheduler or record a bogus 'is disposed' halt.
  it('does not arm a wake when disposal races a transient claim failure', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    const item = activation('a1');
    const claimEntered = deferred();
    const allowClaim = deferred();
    const originalClaim = store.claim.bind(store);
    vi.spyOn(store, 'claim').mockImplementation(async (...args) => {
      claimEntered.resolve();
      await allowClaim.promise;
      // The in-flight claim now fails transiently.
      fsFault.failAppends = 1;
      return originalClaim(...args);
    });
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => true,
      handler: async () => {},
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);

    const starting = scheduler.start();
    await claimEntered.promise;
    scheduler.dispose();
    allowClaim.resolve();
    await expect(starting).resolves.toBeUndefined();

    // Past the recheck interval, nothing fired: no wake was armed.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    expect(scheduler.haltedError).toBeUndefined();
  });

  // A disposal racing in-flight releases whose writes then all fail
  // transiently must not leave a bogus store-failure halt on the dead
  // worker: the streak still counts, the escalation does not fire.
  it('does not halt when disposal races a streak of transient release failures', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    const releasesEntered: string[] = [];
    const allowRelease = deferred();
    const originalRelease = store.release.bind(store);
    vi.spyOn(store, 'release').mockImplementation(async (lease, outcome) => {
      releasesEntered.push(lease.activationId);
      await allowRelease.promise;
      return originalRelease(lease, outcome);
    });
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 10,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => true,
      handler: async () => {},
    });
    schedulers.push(scheduler);
    const items = Array.from({ length: 10 }, (_, i) => activation(`a${i}`));
    for (const item of items) await scheduler.submit(item);
    await scheduler.start();
    // All ten runs are inside their release call when the worker is
    // disposed; every journal append then fails transiently.
    await waitUntil(() => releasesEntered.length === 10);
    fsFault.failAppends = 10;
    scheduler.dispose();
    allowRelease.resolve();
    await waitUntil(() => scheduler.activeSlotCount === 0);

    expect(scheduler.haltedError).toBeUndefined();
    await expect(scheduler.submit(activation('a10'))).rejects.toThrow(
      'is disposed',
    );
  });

  // One shared journal blip lands on every in-flight run at once: the
  // streak is charged per concurrent attempt, so the halt bound must scale
  // with the worker's own concurrency — a burst the size of the slot count
  // is a blip, not an outage (review round 7, R7-1).
  it('does not halt when one store blip fails every concurrent release at once', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    const releasesEntered: string[] = [];
    const allowRelease = deferred();
    const originalRelease = store.release.bind(store);
    vi.spyOn(store, 'release').mockImplementation(async (lease, outcome) => {
      releasesEntered.push(lease.activationId);
      await allowRelease.promise;
      return originalRelease(lease, outcome);
    });
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 10,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => true,
      handler: async () => {},
    });
    schedulers.push(scheduler);
    const items = Array.from({ length: 10 }, (_, i) => activation(`a${i}`));
    for (const item of items) await scheduler.submit(item);
    await scheduler.start();
    // All ten runs are inside their release call; the blip fails every
    // first attempt, charging the streak ten times at once.
    await waitUntil(() => releasesEntered.length === 10);
    fsFault.failAppends = 10;
    allowRelease.resolve();

    await waitUntil(() =>
      items.every((i) => store.get(i)?.status === 'released'),
    );
    expect(scheduler.haltedError).toBeUndefined();
  });

  it('does not launch a handler after disposal races with a durable claim', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    const item = activation('a1');
    const claimEntered = deferred();
    const allowClaim = deferred();
    const originalClaim = store.claim.bind(store);
    vi.spyOn(store, 'claim').mockImplementation(async (...args) => {
      claimEntered.resolve();
      await allowClaim.promise;
      return originalClaim(...args);
    });
    const handler = vi.fn();
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => true,
      handler: async () => {
        handler();
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);

    const starting = scheduler.start();
    await claimEntered.promise;
    scheduler.dispose();
    allowClaim.resolve();
    await expect(starting).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(scheduler.activeSlotCount).toBe(0);
    expect(store.get(item)?.status).toBe('assigned');
  });

  // The wake helpers carry the same disposal guard everywhere: a disposal
  // racing the pump's memory-block arm must not arm the recheck either.
  it('does not arm the memory recheck when disposal races the pump', async () => {
    const store = await FileManagedActivationStore.open(filePath);
    let hasMemory = true;
    const claimEntered = deferred();
    const allowClaim = deferred();
    vi.spyOn(store, 'claim').mockImplementation(async () => {
      claimEntered.resolve();
      await allowClaim.promise;
      // The lease was contested away while the claim was in flight.
      return undefined;
    });
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => hasMemory,
      handler: async () => {},
    });
    schedulers.push(scheduler);
    await scheduler.submit(activation('a1'));
    await scheduler.submit(activation('a2'));

    const starting = scheduler.start();
    await claimEntered.promise;
    scheduler.dispose();
    // The next pump pass finds no headroom and would arm the recheck wake.
    hasMemory = false;
    allowClaim.resolve();
    await expect(starting).resolves.toBeUndefined();

    // Past the recheck interval, nothing fired: no wake was armed.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    expect(scheduler.haltedError).toBeUndefined();
  });

  // While the memory block holds, the recheck wake must not re-scan the
  // store on every tick: queued activations cannot have left the queue since
  // the previous pass (claims are the only way out, and this worker — the
  // queue's sole owner — is not claiming).
  it('does not re-scan the store while memory remains blocked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = await FileManagedActivationStore.open(filePath);
    let hasMemory = false;
    const handled = vi.fn();
    const item = activation('a1');
    const listSpy = vi.spyOn(store, 'listRunnable');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 60_000,
      hasMemoryHeadroom: () => hasMemory,
      handler: async () => {
        handled();
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    expect(scheduler.isMemoryBlocked).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Recheck ticks while the block holds re-arm without touching the store.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Once headroom returns, the next recheck re-scans and runs the work.
    hasMemory = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await waitUntil(() => handled.mock.calls.length > 0);
    expect(listSpy.mock.calls.length).toBeGreaterThan(1);
    await waitUntil(() => store.get(item)?.status === 'released');
  });

  // The onActivationError hook is the only channel that carries the
  // handler's error object: an activation whose release retries exhaust the
  // transient budget is terminally recorded by the scheduler itself, and
  // that scheduler-side record must not suppress the report.
  it('reports the handler error when the terminal outcome is recorded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const onActivationError = vi.fn();
    const gate = deferred();
    let runs = 0;
    const item = activation('a1');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async () => {
        runs++;
        await gate.promise;
        throw new Error('handler failed');
      },
      onActivationError,
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => runs === 1);

    // The initial release and all three retries fail transiently; the fault
    // clears just before the scheduler's own terminal write.
    fsFault.failAppends = 4;
    gate.resolve();
    await advanceTimersUntil(() => store.get(item)?.status === 'released', 250);
    expect(runs).toBe(1);
    expect(store.get(item)?.outcome).toBe('failed');
    expect(onActivationError).toHaveBeenCalledWith(
      expect.objectContaining({ activationId: 'a1' }),
      expect.objectContaining({ message: 'handler failed' }),
    );
    expect(scheduler.haltedError).toBeUndefined();
  });

  // The terminal write follows the same cancellation policy as the retry
  // loop: a dispose() landing before the write commits must stop it — a
  // stopped worker recording a terminal outcome would make a retryable
  // failure permanent.
  it('cancels the terminal outcome write when disposal races its commit turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const gate = deferred();
    const item = activation('a1');
    const releaseSpy = vi.spyOn(store, 'release');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async () => {
        await gate.promise;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();

    // The initial release and all three retries fail transiently, spending
    // the budget; the scheduler's own terminal write then waits on its
    // yielded commit turn — the only armed timer while execute() awaits it.
    fsFault.failAppends = 4;
    gate.resolve();
    await waitUntil(() => releaseSpy.mock.calls.length === 1);
    await advanceTimersUntil(() => releaseSpy.mock.calls.length === 4, 250);
    await waitUntil(() => vi.getTimerCount() === 1);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(releaseSpy.mock.calls.length).toBe(4);
    expect(store.get(item)?.status).toBe('assigned');
    expect(scheduler.haltedError).toBeUndefined();
  });

  // The terminal write's failure handling follows the same liveness policy
  // as every other store continuation: on a disposed worker, a store-halting
  // rejection must not plant a bogus fatal error on the clean shutdown.
  it('does not halt a disposed worker when the terminal write fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    const gate = deferred();
    const terminalWriteInFlight = deferred();
    let releaseCalls = 0;
    const originalRelease = store.release.bind(store);
    vi.spyOn(store, 'release').mockImplementation(async (...args) => {
      releaseCalls++;
      if (releaseCalls === 5) await terminalWriteInFlight.promise;
      return originalRelease(...args);
    });
    const item = activation('a1');
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async () => {
        await gate.promise;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();

    // The initial release and the three retries fail transiently; the
    // terminal write is held in flight, the worker is disposed, and only
    // then does the write fail with consistency damage (its journal repair
    // fails too).
    fsFault.failAppends = 5;
    gate.resolve();
    await waitUntil(() => releaseCalls === 1);
    await advanceTimersUntil(() => releaseCalls === 4, 250);
    await waitUntil(() => vi.getTimerCount() === 1);
    await vi.advanceTimersByTimeAsync(1);
    await waitUntil(() => releaseCalls === 5);
    scheduler.dispose();
    fsFault.failTruncates = 1;
    terminalWriteInFlight.resolve();
    await waitUntil(() => scheduler.activeSlotCount === 0);

    expect(scheduler.haltedError).toBeUndefined();
    expect(store.haltedError?.message).toBe('disk busy');
    await expect(scheduler.submit(activation('a2'))).rejects.toThrow(
      "Harness Worker 'worker-a' is disposed.",
    );
  });

  // A run can end stale with zero absorbed transient failures — a slow store
  // call that resolves past the lease boundary — so the dropped run itself
  // must count against the budget, or the activation re-runs without bound.
  it('bounds re-runs of an activation whose runs all end on a stale lease', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    let runs = 0;
    const item = activation('a1');
    // Every renewal tick resolves after the lease boundary, so the store
    // answers stale and the run ends having absorbed no transient failure.
    const originalRenew = store.renew.bind(store);
    vi.spyOn(store, 'renew').mockImplementation(async (...args) => {
      now = Math.max(now, args[0].expiresAt + 1);
      return originalRenew(...args);
    });
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 1,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async (_activation, context) => {
        runs++;
        if (context.signal.aborted) return;
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => runs === 1);

    await advanceTimersUntil(() => store.get(item)?.status === 'released', 100);

    // Each stale-ended run costs one budget unit; the third spends it and
    // the scheduler records the terminal outcome with a fresh claim —
    // 'failed': every run's handler returned only because the scheduler
    // aborted it, so the record must not claim the work succeeded.
    expect(runs).toBe(3);
    expect(store.get(item)?.outcome).toBe('failed');
    expect(scheduler.haltedError).toBeUndefined();
  });

  // The other terminal shape: the budget is spent by release failures after
  // the handler genuinely settled. Nothing aborted the work, so the
  // terminal write records the handler's own outcome — and the Session FIFO
  // fence holds until the record commits.
  it("records the handler's own outcome when the budget runs out after the handler settled", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
    let runs = 0;
    let inFlightDone = false;
    let a2Started = false;
    let a2StartedEarly = false;
    const a1 = activation('a1', { sessionId: 'session-a' });
    const a2 = activation('a2', { sessionId: 'session-a' });
    // Run 1's two renewal ticks fail transiently, so it abandons at the
    // tick that leaves no headroom for another (budget 2); later renewals
    // reach the real store.
    const originalRenew = store.renew.bind(store);
    let renewCalls = 0;
    vi.spyOn(store, 'renew').mockImplementation(async (...args) => {
      renewCalls++;
      if (renewCalls <= 2) throw new Error('disk busy');
      return originalRenew(...args);
    });
    const scheduler = new EmbeddedHarnessScheduler({
      store,
      workerId: 'worker-a',
      maxActiveSlots: 2,
      maxQueued: 10,
      maxQueuedPerTenant: 10,
      leaseDurationMs: 90,
      hasMemoryHeadroom: () => true,
      handler: async (item, context) => {
        if (item.activationId === 'a2') {
          a2Started = true;
          a2StartedEarly = store.get(a1)?.status !== 'released';
          return;
        }
        runs++;
        if (runs === 1) {
          if (context.signal.aborted) return;
          await new Promise<void>((resolve) => {
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          return;
        }
        // Run 2 finishes its real work before any store failure lands.
        inFlightDone = true;
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(a1);
    await scheduler.submit(a2);
    await scheduler.start();
    await waitUntil(() => runs === 1);

    now = 130;
    await vi.advanceTimersByTimeAsync(30);
    now = 160;
    await vi.advanceTimersByTimeAsync(30);
    await waitUntil(() => scheduler.activeSlotCount === 0);
    expect(store.get(a1)?.status).toBe('assigned');

    // Run 2's handler settles, then the release itself keeps failing
    // transiently: the initial attempt plus all three retries spend the
    // budget (2 + 4 >= 3) after the handler settled, and the scheduler's
    // own terminal write commits the handler's outcome.
    const originalRelease = store.release.bind(store);
    let releaseCalls = 0;
    vi.spyOn(store, 'release').mockImplementation(async (...args) => {
      releaseCalls++;
      if (releaseCalls <= 4) throw new Error('disk busy');
      return originalRelease(...args);
    });
    now = 200;
    await advanceTimersUntil(() => runs === 2, 60);
    expect(inFlightDone).toBe(true);

    await advanceTimersUntil(() => store.get(a1)?.status === 'released', 250);
    expect(releaseCalls).toBe(5);
    expect(store.get(a1)?.outcome).toBe('completed');
    expect(runs).toBe(2);

    // The FIFO fence held: the same-Session a2 starts only after a1's
    // terminal outcome was recorded.
    await waitUntil(() => store.get(a2)?.status === 'released');
    expect(a2Started).toBe(true);
    expect(a2StartedEarly).toBe(false);
    expect(scheduler.haltedError).toBeUndefined();
  });
});
