/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileManagedActivationStore } from './managed-activation-store.js';
import { MANAGED_JOURNAL_COMPACT_BYTES } from './managed-journal-snapshot.js';
import { FileManagedSessionInbox } from './managed-session-inbox.js';
import {
  FileManagedSessionHistory,
  MANAGED_HISTORY_LIMITS,
  ManagedHistoryUnavailableError,
} from './managed-session-history.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function file(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-terminal-window-'));
  roots.push(root);
  return path.join(root, name);
}
const limits = { maxQueued: 100, maxQueuedPerTenant: 100 };
const inboxLimits = { maxPending: 100, maxPendingPerTenant: 100 };
const activation = (index: number) => ({
  tenantId: 'tenant',
  sessionId: `session-${index}`,
  activationId: `activation-${index}`,
  payloadRef: `${index}:${'x'.repeat(128 * 1024)}`,
  reason: 'user_message' as const,
  recovery: 'replay_safe' as const,
});
const message = (index: number) => ({
  tenantId: 'tenant',
  sessionId: `session-${index}`,
  messageId: `message-${index}`,
  payload: { text: `${index}:${'x'.repeat(128 * 1024)}` },
});

describe('Managed terminal residency', () => {
  async function damageDerivedRoot(
    store: FileManagedActivationStore | FileManagedSessionInbox,
    damage: 'missing' | 'corrupt',
  ) {
    const history = Reflect.get(store, 'history') as FileManagedSessionHistory;
    const digest = history.rootDigest!;
    const target = path.join(history.directory, digest);
    if (damage === 'missing') await unlink(target);
    else await writeFile(target, 'corrupt derived page');
    await history.loadBody(`evict-before-${damage}`, async () =>
      Buffer.alloc(MANAGED_HISTORY_LIMITS.cacheBytes),
    );
    return { history, digest };
  }

  it.each(['missing', 'corrupt'] as const)(
    'rebuilds a %s activation page from canonical history without changing FIFO or epochs',
    async (damage) => {
      const target = await file(`activation-repair-${damage}.jsonl`);
      const store = await FileManagedActivationStore.open(target);
      const old = { ...activation(0), payloadRef: 'old' };
      const first = {
        ...old,
        activationId: 'first',
        payloadRef: 'x'.repeat(MANAGED_JOURNAL_COMPACT_BYTES),
      };
      const second = { ...old, activationId: 'second', payloadRef: 'second' };
      await store.enqueue(old, limits);
      const oldLease = (await store.claim(old, 'worker', 300_000))!;
      const terminal = await store.release(oldLease, 'completed');
      await store.enqueue(first, limits);
      await store.enqueue(second, limits);
      const canonical = await readFile(target);
      expect(
        JSON.parse(canonical.toString('utf8').split('\n')[0])['type'],
      ).toBe('activation.snapshot');
      const { history, digest } = await damageDerivedRoot(store, damage);
      expect(await store.get(old)).toEqual(terminal);
      expect(
        await history.get(
          'activation',
          JSON.stringify([old.tenantId, old.sessionId, old.activationId]),
          digest,
        ),
      ).toEqual(terminal);
      expect(await readFile(target)).toEqual(canonical);
      expect(await store.enqueue(old, limits)).toEqual({
        created: false,
        activation: terminal,
      });
      expect(
        await store.get({ ...old, activationId: 'never-admitted' }),
      ).toBeUndefined();
      expect(
        store.listPending().map((entry) => entry.descriptor.activationId),
      ).toEqual(['first', 'second']);
      expect(await store.claim(second, 'worker', 300_000)).toBeUndefined();
      const next = (await store.claim(first, 'worker', 300_000))!;
      expect(next.epoch).toBe(2);
      await expect(store.release(oldLease, 'completed')).rejects.toThrow(
        'stale',
      );
      await store.release(next, 'completed');
      await store.close();
      const reopened = await FileManagedActivationStore.open(target);
      expect((await reopened.claim(second, 'worker', 300_000))?.epoch).toBe(3);
      expect(await reopened.get(old)).toEqual(terminal);
      await reopened.close();
    },
  );

  it.each(['missing', 'corrupt'] as const)(
    'rebuilds a %s inbox page while retaining terminal retry identity and pending order',
    async (damage) => {
      const target = await file(`inbox-repair-${damage}.jsonl`);
      const store = await FileManagedSessionInbox.open(target);
      const old = { ...message(0), payload: 'old' };
      const first = {
        ...old,
        messageId: 'first',
        payload: 'x'.repeat(MANAGED_JOURNAL_COMPACT_BYTES),
      };
      const second = { ...old, messageId: 'second', payload: 'second' };
      const fence = {
        tenantId: old.tenantId,
        sessionId: old.sessionId,
        activationId: old.messageId,
        workerId: 'worker',
        epoch: 1,
      };
      await store.admit(old, inboxLimits);
      await store.markActivationReady(old);
      await store.beginProcessing(old, fence);
      await store.requestCancel(old);
      const terminal = await store.finish(old, fence, 'cancelled');
      await store.admit(first, inboxLimits);
      await store.admit(second, inboxLimits);
      const canonical = await readFile(target);
      expect(
        JSON.parse(canonical.toString('utf8').split('\n')[0])['type'],
      ).toBe('inbox.snapshot');
      const { history, digest } = await damageDerivedRoot(store, damage);
      expect(await store.get(old)).toEqual(terminal);
      expect(
        await history.get(
          'inbox',
          JSON.stringify([old.tenantId, old.sessionId, old.messageId]),
          digest,
        ),
      ).toEqual(terminal);
      expect(await readFile(target)).toEqual(canonical);
      expect(await store.admit(old, inboxLimits)).toEqual({
        created: false,
        message: terminal,
      });
      await expect(
        store.admit({ ...old, payload: 'changed' }, inboxLimits),
      ).rejects.toThrow('different data');
      expect(await store.finish(old, fence, 'cancelled')).toEqual(terminal);
      await expect(
        store.finish(old, { ...fence, epoch: 2 }, 'cancelled'),
      ).rejects.toThrow('stale');
      expect(
        await store.get({ ...old, messageId: 'never-admitted' }),
      ).toBeUndefined();
      expect(
        store.listPending().map((entry) => entry.message.messageId),
      ).toEqual(['first', 'second']);
      await store.close();
      const reopened = await FileManagedSessionInbox.open(target);
      expect(await reopened.get(old)).toEqual(terminal);
      const ids: string[] = [];
      for await (const entry of reopened.listAll())
        ids.push(entry.message.messageId);
      expect(ids).toEqual([old.messageId, 'first', 'second']);
      await reopened.close();
    },
  );

  it('refuses a stale activation repair prefix after a later canonical append', async () => {
    const target = await file('activation-repair-stale.jsonl');
    const store = await FileManagedActivationStore.open(target);
    const old = { ...activation(0), payloadRef: 'old' };
    await store.enqueue(old, limits);
    const history = Reflect.get(store, 'history') as FileManagedSessionHistory;
    const frozen = history.snapshot();
    const oldRoot = frozen.rootDigest!;
    await store.enqueue({ ...old, activationId: 'later' }, limits);
    await unlink(path.join(history.directory, oldRoot));
    await history.loadBody('evict-stale-prefix', async () =>
      Buffer.alloc(MANAGED_HISTORY_LIMITS.cacheBytes),
    );
    const canonical = await readFile(target);
    await expect(
      frozen.get(
        'activation',
        JSON.stringify([old.tenantId, old.sessionId, old.activationId]),
      ),
    ).rejects.toBeInstanceOf(ManagedHistoryUnavailableError);
    expect(await readFile(target)).toEqual(canonical);
    expect(
      store.listPending().map((entry) => entry.descriptor.activationId),
    ).toEqual([old.activationId, 'later']);
    await frozen.close();
    await store.close();
  });

  it('refuses a stale inbox repair prefix after a later canonical append', async () => {
    const target = await file('inbox-repair-stale.jsonl');
    const store = await FileManagedSessionInbox.open(target);
    const old = { ...message(0), payload: 'old' };
    await store.admit(old, inboxLimits);
    const history = Reflect.get(store, 'history') as FileManagedSessionHistory;
    const frozen = history.snapshot();
    const oldRoot = frozen.rootDigest!;
    await store.admit({ ...old, messageId: 'later' }, inboxLimits);
    await unlink(path.join(history.directory, oldRoot));
    await history.loadBody('evict-stale-prefix', async () =>
      Buffer.alloc(MANAGED_HISTORY_LIMITS.cacheBytes),
    );
    const canonical = await readFile(target);
    await expect(
      frozen.get(
        'inbox',
        JSON.stringify([old.tenantId, old.sessionId, old.messageId]),
      ),
    ).rejects.toBeInstanceOf(ManagedHistoryUnavailableError);
    expect(await readFile(target)).toEqual(canonical);
    expect(store.listPending().map((entry) => entry.message.messageId)).toEqual(
      [old.messageId, 'later'],
    );
    await frozen.close();
    await store.close();
  });

  it('captures historical lookup identities before asynchronous work', async () => {
    const activationStore = await FileManagedActivationStore.open(
      await file('lookup-activation.jsonl'),
    );
    const first = { ...activation(0), payloadRef: 'small' };
    await activationStore.enqueue(first, limits);
    const identity = { ...first };
    const reading = activationStore.get(identity);
    identity.activationId = 'another';
    expect((await reading)?.descriptor.activationId).toBe(first.activationId);
    const inbox = await FileManagedSessionInbox.open(
      await file('lookup-inbox.jsonl'),
    );
    const input = { ...message(0), payload: 'small' };
    await inbox.admit(input, inboxLimits);
    const messageIdentity = { ...input };
    const pending = inbox.get(messageIdentity);
    messageIdentity.messageId = 'another';
    expect((await pending)?.message.messageId).toBe(input.messageId);
    await activationStore.close();
    await inbox.close();
  });

  it('preserves identities larger than one index page across snapshot, reopen and exact retry', async () => {
    const target = await file('activation-large-key.jsonl');
    const input = {
      ...activation(0),
      activationId: `activation:${'a'.repeat(70 * 1024)}`,
      sessionId: `session:${'s'.repeat(70 * 1024)}`,
    };
    const store = await FileManagedActivationStore.open(target);
    await store.enqueue(input, limits);
    const lease = (await store.claim(input, 'worker', 300_000))!;
    const terminal = await store.release(lease, 'completed');
    await store.close();
    const reopened = await FileManagedActivationStore.open(target);
    expect(await reopened.get(input)).toEqual(terminal);
    expect(await reopened.enqueue(input, limits)).toEqual({
      created: false,
      activation: terminal,
    });
    const successor = {
      ...input,
      activationId: 'next-large-session-activation',
    };
    await reopened.enqueue(successor, limits);
    expect((await reopened.claim(successor, 'worker', 300_000))?.epoch).toBe(2);
    await reopened.close();
  });

  it('evicts released bodies, preserves cold identities and restores cold Session epochs', async () => {
    const target = await file('activation.jsonl');
    const store = await FileManagedActivationStore.open(target);
    for (let index = 0; index < 40; index++) {
      const input = activation(index);
      await store.enqueue(input, limits);
      const lease = (await store.claim(input, 'worker', 300_000))!;
      await store.release(lease, 'completed');
    }
    expect(store.listPending()).toEqual([]);
    expect(
      (Reflect.get(store, 'activations') as Map<string, unknown>).size,
    ).toBe(0);
    const original = await store.get(activation(0));
    expect(await store.enqueue(activation(0), limits)).toEqual({
      created: false,
      activation: original,
    });
    await expect(
      store.enqueue({ ...activation(0), payloadRef: 'conflict' }, limits),
    ).rejects.toThrow(/different data/);
    await store.close();
    const reopened = await FileManagedActivationStore.open(target);
    expect(await reopened.get(activation(0))).toEqual(original);
    expect(
      (Reflect.get(reopened, 'activations') as Map<string, unknown>).size,
    ).toBe(0);
    const next = { ...activation(0), activationId: 'successor' };
    await reopened.enqueue(next, limits);
    const lease = (await reopened.claim(next, 'worker', 300_000))!;
    expect(lease.epoch).toBe(2);
    await reopened.release(lease, 'completed');
    await reopened.close();
  });

  it('evicts finished inbox bodies while replay and ordered historical enumeration survive reopen', async () => {
    const target = await file('inbox.jsonl');
    const store = await FileManagedSessionInbox.open(target);
    for (let index = 0; index < 40; index++) {
      const input = message(index);
      const fence = {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        activationId: input.messageId,
        workerId: 'worker',
        epoch: 1,
      };
      await store.admit(input, inboxLimits);
      await store.markActivationReady(input);
      await store.beginProcessing(input, fence);
      await store.finish(input, fence, 'completed');
    }
    expect(store.listPending()).toEqual([]);
    expect((Reflect.get(store, 'messages') as Map<string, unknown>).size).toBe(
      0,
    );
    const original = await store.get(message(0));
    expect(await store.admit(message(0), inboxLimits)).toEqual({
      created: false,
      message: original,
    });
    await store.close();
    const reopened = await FileManagedSessionInbox.open(target);
    expect(await reopened.get(message(0))).toEqual(original);
    expect(
      (Reflect.get(reopened, 'messages') as Map<string, unknown>).size,
    ).toBe(0);
    let index = 0;
    for await (const entry of reopened.listAll())
      expect(entry.message.messageId).toBe(`message-${index++}`);
    expect(index).toBe(40);
    await reopened.close();
  });

  it('does not reject a committed activation release when the derived view flush fails', async () => {
    const target = await file('activation-fault.jsonl');
    const store = await FileManagedActivationStore.open(target);
    const input = activation(0);
    await store.enqueue(input, limits);
    const lease = (await store.claim(input, 'worker', 300_000))!;
    vi.spyOn(
      FileManagedSessionHistory.prototype,
      'flush',
    ).mockRejectedValueOnce(new Error('view unavailable'));
    const terminal = await store.release(lease, 'completed');
    expect(terminal.status).toBe('released');
    expect(await store.get(input)).toEqual(terminal);
    expect(await store.enqueue(input, limits)).toEqual({
      created: false,
      activation: terminal,
    });
    await expect(store.enqueue(activation(1), limits)).rejects.toThrow(
      'view unavailable',
    );
    await store.close();
    const reopened = await FileManagedActivationStore.open(target);
    expect(await reopened.get(input)).toEqual(terminal);
    await reopened.close();
  });

  it('does not reject a committed inbox outcome when the derived view flush fails', async () => {
    const target = await file('inbox-fault.jsonl');
    const store = await FileManagedSessionInbox.open(target);
    const input = message(0);
    const fence = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      activationId: input.messageId,
      workerId: 'worker',
      epoch: 1,
    };
    await store.admit(input, inboxLimits);
    await store.markActivationReady(input);
    await store.beginProcessing(input, fence);
    vi.spyOn(
      FileManagedSessionHistory.prototype,
      'flush',
    ).mockRejectedValueOnce(new Error('view unavailable'));
    const terminal = await store.finish(input, fence, 'completed');
    expect(terminal.state).toBe('finished');
    expect(await store.get(input)).toEqual(terminal);
    expect(await store.admit(input, inboxLimits)).toEqual({
      created: false,
      message: terminal,
    });
    await expect(store.admit(message(1), inboxLimits)).rejects.toThrow(
      'view unavailable',
    );
    await store.close();
    const reopened = await FileManagedSessionInbox.open(target);
    expect(await reopened.get(input)).toEqual(terminal);
    await reopened.close();
  });
});
