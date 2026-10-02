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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileManagedActivationStore,
  ManagedActivationStaleLeaseError,
  type ManagedActivationDescriptor,
} from './managed-activation-store.js';

// Journal fault injection for the persist tail-repair: a failed append whose
// repair succeeds is transient; one whose repair fails is fatal.
const fsFault = vi.hoisted(() => ({
  failAppends: 0,
  failTruncates: 0,
  tornWrite: false,
  truncateEnoent: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    appendFile: async (...args: Parameters<typeof original.appendFile>) => {
      if (fsFault.failAppends > 0) {
        fsFault.failAppends--;
        if (fsFault.tornWrite) {
          const [file, data] = args;
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
          await original.appendFile(
            file,
            bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 2))),
            { flush: true },
          );
        }
        throw new Error('disk busy');
      }
      return original.appendFile(...args);
    },
    truncate: async (...args: Parameters<typeof original.truncate>) => {
      if (fsFault.failTruncates > 0) {
        fsFault.failTruncates--;
        if (fsFault.truncateEnoent) {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        throw new Error('repair failed');
      }
      return original.truncate(...args);
    },
  };
});

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
    fsFault.failAppends = 0;
    fsFault.failTruncates = 0;
    fsFault.tornWrite = false;
    fsFault.truncateEnoent = false;
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

  // Regression for issue #13182 finding 5's store half: a failed append that
  // leaves the journal intact — or with a torn tail the repair truncates —
  // is transient, and the store stays usable instead of halting forever.
  it('repairs a torn journal tail and keeps serving after a transient write failure', async () => {
    const store = await openStore();
    await store.enqueue(activation('a1'), limits);

    fsFault.failAppends = 1;
    fsFault.tornWrite = true;
    await expect(
      store.claim(activation('a1'), 'worker-a', 60_000),
    ).rejects.toThrow('disk busy');
    expect(store.haltedError).toBeUndefined();

    // The torn tail was truncated back to the last complete event, so the
    // retry writes the same sequence cleanly.
    const lease = await store.claim(activation('a1'), 'worker-a', 60_000);
    expect(lease?.epoch).toBe(1);

    const reopened = await openStore();
    expect(reopened.get(activation('a1'))).toMatchObject({
      status: 'assigned',
      lease: { workerId: 'worker-a' },
    });
  });

  // Only a failed repair leaves the journal's state unknown — the store
  // still fails closed then, with the repair failure on the causal chain.
  it('halts when a failed write cannot be repaired', async () => {
    const store = await openStore();
    await store.enqueue(activation('a1'), limits);

    fsFault.failAppends = 1;
    fsFault.failTruncates = 1;
    await expect(
      store.claim(activation('a1'), 'worker-a', 60_000),
    ).rejects.toThrow('disk busy');
    expect(store.haltedError?.message).toBe('disk busy');
    expect(store.haltedError?.cause).toBeInstanceOf(Error);
    expect((store.haltedError?.cause as Error).message).toBe('repair failed');
    await expect(
      store.claim(activation('a1'), 'worker-a', 60_000),
    ).rejects.toThrow('disk busy');
  });

  // A first-ever write that fails before the journal file exists (the repair
  // sees ENOENT and there is nothing to repair to) is transient.
  it('treats a first-write failure without a journal file as transient', async () => {
    const store = await openStore();
    fsFault.failAppends = 1;

    await expect(store.enqueue(activation('a1'), limits)).rejects.toThrow(
      'disk busy',
    );
    expect(store.haltedError).toBeUndefined();

    await expect(
      store.enqueue(activation('a1'), limits),
    ).resolves.toMatchObject({ created: true });
  });

  // The fourth cell of the fault matrix: the journal file vanished after
  // bytes were synced (ENOENT with syncedBytes > 0) — the store's durable
  // history is gone, so the failure is fatal, never transient.
  it('halts when the journal vanishes after synced writes', async () => {
    const store = await openStore();
    await store.enqueue(activation('a1'), limits);

    fsFault.failAppends = 1;
    fsFault.failTruncates = 1;
    fsFault.truncateEnoent = true;
    await expect(
      store.claim(activation('a1'), 'worker-a', 60_000),
    ).rejects.toThrow('disk busy');
    expect(store.haltedError?.message).toBe('disk busy');
    expect((store.haltedError?.cause as Error).message).toBe('gone');
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

  it('keeps non-extending renewals replayable without halting the store', async () => {
    const store = await openStore();
    const input = activation('a1');
    await store.enqueue(input, limits);
    const lease = (await store.claim(input, 'worker-a', 1000))!;
    const contents = await readFile(filePath, 'utf8');

    await expect(store.renew(lease, 1000)).resolves.toEqual(lease);
    now -= 1;
    await expect(store.renew(lease, 500)).resolves.toEqual(lease);
    expect(await readFile(filePath, 'utf8')).toBe(contents);
    expect(store.haltedError).toBeUndefined();
    const reopened = await openStore();
    expect(reopened.get(input)?.lease).toEqual(lease);
    now = 200;
    await expect(reopened.renew(lease, 1000)).resolves.toMatchObject({
      expiresAt: 1200,
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
