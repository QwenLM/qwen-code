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
import type { ManagedActivationFence } from './managed-activation-store.js';
import {
  FileManagedSessionInbox,
  ManagedSessionMessageConflictError,
  ManagedSessionMessageStaleFenceError,
  managedSessionPayloadRef,
  type ManagedSessionUserMessageInput,
} from './managed-session-inbox.js';
import { MANAGED_SESSION_LIMITS } from './managed-session-records.js';
import { MANAGED_JOURNAL_COMPACT_BYTES } from './managed-journal-snapshot.js';

const limits = { maxPending: 10, maxPendingPerTenant: 5 };

function userMessage(
  messageId: string,
  overrides: Partial<ManagedSessionUserMessageInput> = {},
): ManagedSessionUserMessageInput {
  return {
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    messageId,
    payload: {
      prompt: [{ type: 'text', text: `hello ${messageId}` }],
      clientId: 'client-a',
    },
    ...overrides,
  };
}

function activationFence(
  messageId: string,
  epoch: number,
  workerId = 'worker-a',
): ManagedActivationFence {
  return {
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    activationId: messageId,
    workerId,
    epoch,
  };
}

describe('FileManagedSessionInbox', () => {
  let root: string;
  let filePath: string;
  let now: number;

  const nested = (levels: number): unknown => {
    let payload: unknown = null;
    for (let index = 0; index < levels; index++) {
      payload = { nested: payload };
    }
    return payload;
  };

  it('bounds payload depth at the shared managed-session JSON depth limit', async () => {
    const inbox = await openInbox();
    await expect(
      inbox.admit(
        userMessage('exact', {
          payload: nested(MANAGED_SESSION_LIMITS.maxJsonDepth),
        }),
        limits,
      ),
    ).resolves.toMatchObject({ created: true });
    await expect(
      inbox.admit(
        userMessage('over', {
          payload: nested(MANAGED_SESSION_LIMITS.maxJsonDepth + 1),
        }),
        limits,
      ),
    ).rejects.toThrow(/maximum JSON depth/);
  });

  const openInbox = (maxPayloadBytes?: number) =>
    FileManagedSessionInbox.open(filePath, {
      clock: () => now,
      ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
    });

  beforeEach(async () => {
    now = 100;
    root = await mkdtemp(path.join(os.tmpdir(), 'managed-session-inbox-'));
    filePath = path.join(root, 'state', 'messages.jsonl');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists the canonical complete payload across reopen', async () => {
    const inbox = await openInbox();
    const input = {
      ...userMessage('m1'),
      ignoredTopLevel: 'not durable',
    } as ManagedSessionUserMessageInput;

    const admitted = await inbox.admit(input, limits);
    expect(admitted).toMatchObject({
      created: true,
      message: {
        admittedAt: 100,
        activationReady: false,
        state: 'admitted',
        message: {
          tenantId: 'tenant-a',
          sessionId: 'session-a',
          messageId: 'm1',
          payload: input.payload,
        },
      },
    });

    const reopened = await openInbox();
    expect(reopened.get(input)).toEqual(admitted.message);
    expect(await readFile(filePath, 'utf8')).not.toContain('ignoredTopLevel');
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('truncates a torn tail before accepting the next message', async () => {
    const inbox = await openInbox();
    await inbox.admit(userMessage('m1'), limits);
    await appendFile(filePath, '{"v":1,"sequence":2');

    const recovered = await openInbox();
    now = 200;
    await recovered.admit(userMessage('m2'), limits);

    const reopened = await openInbox();
    expect(
      reopened.listPending().map((item) => item.message.messageId),
    ).toEqual(['m1', 'm2']);
  });

  it('lists every durable message in admission order without exposing state', async () => {
    const inbox = await openInbox();
    await inbox.admit(userMessage('m1'), limits);
    await inbox.admit(userMessage('m2'), limits);

    const listed = inbox.listAll();
    expect(listed.map((item) => item.message.messageId)).toEqual(['m1', 'm2']);
    const payload = listed[0]!.message.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('expected object payload');
    }
    payload['changed'] = true;
    expect(inbox.listAll()[0]!.message.payload).not.toHaveProperty('changed');
  });

  it('fails closed on malformed and inconsistent committed history', async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{"v":1,"sequence":1}\n');
    await expect(openInbox()).rejects.toThrow('inbox line 1 is invalid');

    await rm(filePath, { force: true });
    const inbox = await openInbox();
    await inbox.admit(userMessage('m1'), limits);
    const contents = await readFile(filePath, 'utf8');
    await writeFile(filePath, contents.replace('"sequence":1', '"sequence":2'));
    await expect(openInbox()).rejects.toThrow(
      'Expected inbox sequence 1, got 2',
    );
  });

  it('deduplicates exact input and rejects identity reuse or invalid JSON', async () => {
    const inbox = await openInbox(256);
    await inbox.admit(userMessage('m1'), {
      maxPending: 1,
      maxPendingPerTenant: 1,
    });
    await expect(
      inbox.admit(userMessage('m1'), {
        maxPending: 1,
        maxPendingPerTenant: 1,
      }),
    ).resolves.toMatchObject({ created: false });
    await expect(
      inbox.admit(
        userMessage('m1', { payload: { prompt: 'different' } }),
        limits,
      ),
    ).rejects.toBeInstanceOf(ManagedSessionMessageConflictError);
    await expect(
      inbox.admit(
        userMessage('m2', { payload: { invalid: Infinity } }),
        limits,
      ),
    ).rejects.toThrow('numbers must be finite');
    await expect(
      inbox.admit(
        userMessage('m2', { payload: { text: 'x'.repeat(300) } }),
        limits,
      ),
    ).rejects.toThrow('maximum size of 256');
    await expect(
      inbox.admit(userMessage('x'.repeat(513), { payload: null }), limits),
    ).rejects.toThrow('messageId must be no larger than 512');
  });

  it('compacts repeated processing fences and restores only the current fence', async () => {
    const inbox = await openInbox();
    const input = userMessage('long-lived');
    await inbox.admit(input, limits);
    await inbox.markActivationReady(input);
    for (let epoch = 1; epoch <= 1024; epoch++) {
      await inbox.beginProcessing(
        input,
        activationFence(input.messageId, epoch),
      );
    }
    const contents = await readFile(filePath, 'utf8');
    const lines = contents.trimEnd().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({
      v: 2,
      type: 'inbox.snapshot',
    });
    expect(Buffer.byteLength(contents)).toBeLessThan(
      MANAGED_JOURNAL_COMPACT_BYTES + Buffer.byteLength(lines[0]) + 512,
    );
    const reopened = await openInbox();
    expect(reopened.listAll()).toEqual(inbox.listAll());
    await expect(
      reopened.finish(
        input,
        activationFence(input.messageId, 1023),
        'completed',
      ),
    ).rejects.toBeInstanceOf(ManagedSessionMessageStaleFenceError);
    await reopened.finish(
      input,
      activationFence(input.messageId, 1024),
      'completed',
    );
    expect((await openInbox()).get(input)?.state).toBe('finished');
  }, 60_000);

  it('preserves completed, cancelled, processing, and pending message replay across snapshots', async () => {
    const inbox = await openInbox();
    const finished = userMessage('finished');
    const cancelled = userMessage('cancelled');
    const processing = userMessage('processing');
    const admitted = userMessage('admitted');
    for (const input of [finished, cancelled, processing, admitted]) {
      await inbox.admit(input, limits);
    }
    const finishedFence = activationFence(finished.messageId, 3);
    await inbox.markActivationReady(finished);
    await inbox.beginProcessing(finished, finishedFence);
    await inbox.finish(finished, finishedFence, 'completed');
    await inbox.requestCancel(cancelled);
    const currentFence = activationFence(processing.messageId, 9);
    await inbox.markActivationReady(processing);
    await inbox.beginProcessing(processing, currentFence);
    await inbox.requestCancel(processing);
    await inbox.admit(
      userMessage('padding', {
        payload: { text: 'x'.repeat(MANAGED_JOURNAL_COMPACT_BYTES) },
      }),
      limits,
    );
    await inbox.markActivationReady(admitted);
    const reopened = await openInbox();
    expect(reopened.listAll()).toEqual(inbox.listAll());
    expect(reopened.listPending()).toEqual(inbox.listPending());
    await expect(reopened.admit(finished, limits)).resolves.toMatchObject({
      created: false,
      message: { state: 'finished', outcome: 'completed' },
    });
    await expect(
      reopened.admit({ ...finished, payload: 'different' }, limits),
    ).rejects.toBeInstanceOf(ManagedSessionMessageConflictError);
    await expect(
      reopened.finish(finished, finishedFence, 'completed'),
    ).resolves.toEqual(inbox.get(finished));
    await expect(reopened.requestCancel(cancelled)).resolves.toEqual(
      inbox.get(cancelled),
    );
    await reopened.finish(processing, currentFence, 'cancelled');
    expect((await openInbox()).get(processing)?.outcome).toBe('cancelled');
  });

  it('repairs only a torn post-snapshot tail before continuing admission', async () => {
    const inbox = await openInbox();
    const input = userMessage('large', {
      payload: 'x'.repeat(MANAGED_JOURNAL_COMPACT_BYTES),
    });
    await inbox.admit(input, limits);
    await inbox.markActivationReady(input);
    const committed = await readFile(filePath, 'utf8');
    expect(JSON.parse(committed.split('\n')[0])['type']).toBe('inbox.snapshot');
    await appendFile(filePath, '{"v":1,"sequence":');
    const reopened = await openInbox();
    expect(await readFile(filePath, 'utf8')).toBe(committed);
    await reopened.admit(userMessage('next'), limits);
    expect((await openInbox()).listAll()).toEqual(reopened.listAll());
  });

  it('captures caller-owned payload and limits before entering the write queue', async () => {
    const inbox = await openInbox();
    const payload = { prompt: [{ type: 'text', text: 'original' }] };
    const input = {
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      messageId: 'm1',
      payload,
    };
    const mutableLimits = { maxPending: 1, maxPendingPerTenant: 1 };

    const admission = inbox.admit(input, mutableLimits);
    payload.prompt[0]!.text = 'mutated';
    mutableLimits.maxPending = 0;
    mutableLimits.maxPendingPerTenant = 0;

    await expect(admission).resolves.toMatchObject({
      message: {
        message: {
          payload: { prompt: [{ type: 'text', text: 'original' }] },
        },
      },
    });
  });

  it('bounds all unfinished work and releases capacity after a fenced terminal', async () => {
    const inbox = await openInbox();
    const one = userMessage('m1');
    await inbox.admit(one, { maxPending: 1, maxPendingPerTenant: 1 });
    await inbox.markActivationReady(one);
    await inbox.beginProcessing(one, activationFence('m1', 1));

    await expect(
      inbox.admit(userMessage('m2'), {
        maxPending: 1,
        maxPendingPerTenant: 1,
      }),
    ).rejects.toMatchObject({
      code: 'GLOBAL_INBOX_FULL',
      retryable: true,
    });

    now = 200;
    await inbox.finish(one, activationFence('m1', 1), 'completed');
    await expect(
      inbox.admit(userMessage('m2'), {
        maxPending: 1,
        maxPendingPerTenant: 1,
      }),
    ).resolves.toMatchObject({ created: true });
  });

  it('applies the per-tenant limit independently of global capacity', async () => {
    const inbox = await openInbox();
    await inbox.admit(userMessage('m1'), {
      maxPending: 3,
      maxPendingPerTenant: 1,
    });
    await expect(
      inbox.admit(userMessage('m2'), {
        maxPending: 3,
        maxPendingPerTenant: 1,
      }),
    ).rejects.toMatchObject({
      code: 'TENANT_INBOX_FULL',
    });
    await expect(
      inbox.admit(
        userMessage('m2', {
          tenantId: 'tenant-b',
          sessionId: 'session-b',
        }),
        { maxPending: 3, maxPendingPerTenant: 1 },
      ),
    ).resolves.toMatchObject({ created: true });
  });

  it('lets a newer epoch reclaim processing and fences the older Worker', async () => {
    const inbox = await openInbox();
    const input = userMessage('m1');
    await inbox.admit(input, limits);
    await inbox.markActivationReady(input);
    await inbox.beginProcessing(input, activationFence('m1', 1, 'old'));
    await inbox.beginProcessing(input, activationFence('m1', 2, 'new'));

    await expect(
      inbox.finish(input, activationFence('m1', 1, 'old'), 'completed'),
    ).rejects.toBeInstanceOf(ManagedSessionMessageStaleFenceError);
    await expect(
      inbox.finish(input, activationFence('m1', 2, 'new'), 'completed'),
    ).resolves.toMatchObject({
      state: 'finished',
      outcome: 'completed',
      fence: { epoch: 2, workerId: 'new' },
    });
  });

  it('rejects readiness after cancellation without corrupting the inbox', async () => {
    const inbox = await openInbox();
    const input = userMessage('m1');
    await inbox.admit(input, limits);
    await inbox.requestCancel(input);
    const contents = await readFile(filePath, 'utf8');

    await expect(inbox.markActivationReady(input)).rejects.toThrow(
      'already finished',
    );
    expect(await readFile(filePath, 'utf8')).toBe(contents);
    expect(inbox.haltedError).toBeUndefined();
    const reopened = await openInbox();
    expect(reopened.get(input)).toMatchObject({
      state: 'finished',
      outcome: 'cancelled',
    });
    await expect(
      reopened.admit(userMessage('m2'), limits),
    ).resolves.toMatchObject({
      created: true,
    });
  });

  it('latches a persist failure and halts every later operation until reopen', async () => {
    const inbox = await openInbox();
    await inbox.admit(userMessage('m1'), limits);

    const contents = await readFile(filePath, 'utf8');
    await rm(filePath);
    await mkdir(filePath);

    const m2 = userMessage('m2');
    await expect(inbox.admit(m2, limits)).rejects.toBeInstanceOf(Error);
    expect(inbox.haltedError).toBeInstanceOf(Error);
    // The latch, not the original errno, is what later operations see.
    await expect(inbox.admit(m2, limits)).rejects.toBe(inbox.haltedError);
    // A failed persist must not have applied the event to memory either.
    expect(inbox.get(m2)).toBeUndefined();
    expect(inbox.listPending()).toHaveLength(1);

    await rm(filePath, { recursive: true, force: true });
    await writeFile(filePath, contents);
    const reopened = await openInbox();
    expect(reopened.get(userMessage('m1'))?.state).toBe('admitted');
    expect(reopened.get(m2)).toBeUndefined();
    await expect(
      reopened.admit(userMessage('m3'), limits),
    ).resolves.toMatchObject({ created: true });
  });

  it('requires the deterministic payload reference and matching fence identity', async () => {
    const inbox = await openInbox();
    const input = userMessage('m1');
    await inbox.admit(input, limits);
    expect(
      inbox.getByPayloadRef(input, managedSessionPayloadRef(input)),
    ).toBeDefined();
    expect(() => inbox.getByPayloadRef(input, 'wrong')).toThrow(
      'payloadRef does not match',
    );

    await inbox.markActivationReady(input);
    await expect(
      inbox.beginProcessing(input, {
        ...activationFence('m1', 1),
        sessionId: 'other-session',
      }),
    ).rejects.toThrow('does not match the message identity');
  });
});
