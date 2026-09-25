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
