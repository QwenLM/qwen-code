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
