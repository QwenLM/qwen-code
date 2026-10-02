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
  // production wiring: a transient renewal failure must abandon only the
  // affected activation, not halt the whole worker.
  it('abandons only the affected activation on a transient renewal failure', async () => {
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

    // The first renewal tick hits one transient journal write failure; the
    // store repairs the intact tail and reports the failure as transient.
    fsFault.failAppends = 1;
    now = 130;
    await vi.advanceTimersByTimeAsync(30);
    // The tail repair behind the failure is real file IO, which fake timers
    // do not drain.
    await waitUntil(() => signals.get('a1')?.aborted === true);

    expect(signals.get('a2')?.aborted).toBe(false);
    expect(scheduler.haltedError).toBeUndefined();
    expect(store.haltedError).toBeUndefined();
    await expect(scheduler.submit(activation('a3'))).resolves.toMatchObject({
      created: true,
    });
    expect(store.get(activation('a1'))?.status).toBe('assigned');
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

  // A transient failure while releasing a finished activation must not halt
  // the worker either; the activation's lease expires and it is re-run.
  it('re-queues the activation after a transient release failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 100;
    const store = await FileManagedActivationStore.open(filePath, {
      clock: () => now,
    });
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
      },
    });
    schedulers.push(scheduler);
    await scheduler.submit(item);
    await scheduler.start();
    await waitUntil(() => runs === 1);

    // The release's journal write fails transiently: the outcome is lost,
    // the activation is abandoned, and its lease (claimed at 100 for 90)
    // expires at 190.
    fsFault.failAppends = 1;
    gate.resolve();
    await waitUntil(
      () =>
        scheduler.activeSlotCount === 0 &&
        store.get(item)?.status === 'assigned',
    );
    expect(scheduler.haltedError).toBeUndefined();

    // The recovery wake at the lease's expiry re-queues and re-runs it.
    now = 250;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(160);
    await waitUntil(() => runs === 2);
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
});
