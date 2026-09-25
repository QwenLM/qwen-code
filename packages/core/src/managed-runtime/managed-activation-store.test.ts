/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileManagedActivationStore,
  ManagedActivationStaleLeaseError,
  type ManagedActivationDescriptor,
} from './managed-activation-store.js';

const limits = { maxQueued: 10, maxQueuedPerTenant: 5 };

function activation(
  activationId: string,
  overrides: Partial<ManagedActivationDescriptor> = {},
): ManagedActivationDescriptor {
  return {
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    activationId,
    payloadRef: `event:${activationId}`,
    reason: 'user_message',
    recovery: 'replay_safe',
    ...overrides,
  };
}

describe('FileManagedActivationStore', () => {
  let root: string;
  let filePath: string;
  let now: number;

  const openStore = () =>
    FileManagedActivationStore.open(filePath, { clock: () => now });

  beforeEach(async () => {
    now = 100;
    root = await mkdtemp(path.join(os.tmpdir(), 'managed-activation-'));
    filePath = path.join(root, 'control', 'activations.jsonl');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists canonical activation metadata across reopen', async () => {
    const store = await openStore();
    const input = {
      ...activation('a1'),
      prompt: 'must not enter the control-plane journal',
    } as ManagedActivationDescriptor;

    await expect(store.enqueue(input, limits)).resolves.toMatchObject({
      created: true,
      activation: { status: 'queued', queuedAt: 100 },
    });

    const reopened = await openStore();
    expect(reopened.get(input)).toMatchObject({
      descriptor: activation('a1'),
      status: 'queued',
    });
    expect(await readFile(filePath, 'utf8')).not.toContain('must not enter');
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('truncates a torn tail before appending the next valid record', async () => {
    const store = await openStore();
    await store.enqueue(activation('a1'), limits);
    await appendFile(filePath, '{"v":1,"sequence":2');

    const recovered = await openStore();
    now = 200;
    await recovered.enqueue(activation('a2'), limits);

    const reopened = await openStore();
    expect(
      reopened.listPending().map((item) => item.descriptor.activationId),
    ).toEqual(['a1', 'a2']);
    expect(await readFile(filePath, 'utf8')).not.toContain('"sequence":2\n{');
  });

  it('fails closed on malformed committed history', async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{"v":1,"sequence":1}\n');
    await expect(openStore()).rejects.toThrow('journal line 1 is invalid');
  });

  it('fails closed on inconsistent committed history', async () => {
    const store = await openStore();
    await store.enqueue(activation('a1'), limits);
    const contents = await readFile(filePath, 'utf8');
    await writeFile(filePath, contents.replace('"sequence":1', '"sequence":2'));

    await expect(openStore()).rejects.toThrow(
      'Expected journal sequence 1, got 2',
    );
  });

  it('deduplicates exact identities and rejects conflicting reuse', async () => {
    const store = await openStore();
    const first = await store.enqueue(activation('a1'), {
      maxQueued: 1,
      maxQueuedPerTenant: 1,
    });
    const duplicate = await store.enqueue(activation('a1'), {
      maxQueued: 1,
      maxQueuedPerTenant: 1,
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    await expect(
      store.enqueue(activation('a1', { payloadRef: 'event:other' }), limits),
    ).rejects.toThrow('reused with different data');
  });

  it('enforces tenant and global queue limits for new work', async () => {
    const tenantStore = await openStore();
    await tenantStore.enqueue(activation('a1'), {
      maxQueued: 2,
      maxQueuedPerTenant: 1,
    });
    await expect(
      tenantStore.enqueue(activation('a2'), {
        maxQueued: 2,
        maxQueuedPerTenant: 1,
      }),
    ).rejects.toMatchObject({
      code: 'TENANT_QUEUE_FULL',
      retryable: true,
    });

    await tenantStore.enqueue(
      activation('b1', { tenantId: 'tenant-b', sessionId: 'session-b' }),
      { maxQueued: 2, maxQueuedPerTenant: 1 },
    );
    await expect(
      tenantStore.enqueue(
        activation('c1', { tenantId: 'tenant-c', sessionId: 'session-c' }),
        { maxQueued: 2, maxQueuedPerTenant: 1 },
      ),
    ).rejects.toMatchObject({
      code: 'GLOBAL_QUEUE_FULL',
      retryable: true,
    });
  });

  it('preserves Session FIFO and fences expired lease epochs', async () => {
    const store = await openStore();
    const first = activation('a1');
    const second = activation('a2');
    now = 0;
    await store.enqueue(first, limits);
    now = 1;
    await store.enqueue(second, limits);

    now = 2;
    await expect(store.claim(second, 'worker-a', 10)).resolves.toBeUndefined();
    const epochOne = await store.claim(first, 'worker-a', 10);
    expect(epochOne).toMatchObject({ epoch: 1, expiresAt: 12 });
    now = 11;
    await expect(store.claim(first, 'worker-b', 10)).resolves.toBeUndefined();

    now = 12;
    const epochTwo = await store.claim(first, 'worker-b', 10);
    expect(epochTwo).toMatchObject({ epoch: 2, expiresAt: 22 });
    now = 13;
    await expect(store.release(epochOne!, 'completed')).rejects.toBeInstanceOf(
      ManagedActivationStaleLeaseError,
    );

    now = 15;
    const renewed = await store.renew(epochTwo!, 10);
    expect(renewed.expiresAt).toBe(25);
    now = 20;
    await store.release(renewed, 'completed');
    const next = await store.claim(second, 'worker-b', 10);
    expect(next?.epoch).toBe(3);
  });
});
