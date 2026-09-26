/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileManagedActivationStore,
  type ManagedActivationDescriptor,
} from './managed-activation-store.js';
import {
  ManagedPromptAdmissionController,
  type ManagedActivationSubmitter,
} from './managed-prompt-admission.js';
import {
  FileManagedSessionInbox,
  managedSessionPayloadRef,
  type ManagedSessionUserMessageInput,
} from './managed-session-inbox.js';

const inboxLimits = { maxPending: 10, maxPendingPerTenant: 5 };
const activationLimits = { maxQueued: 10, maxQueuedPerTenant: 5 };

function userMessage(messageId: string): ManagedSessionUserMessageInput {
  return {
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    messageId,
    payload: { prompt: [{ type: 'text', text: 'hello' }] },
  };
}

describe('ManagedPromptAdmissionController', () => {
  let root: string;
  let inboxPath: string;
  let activationPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'managed-admission-'));
    inboxPath = path.join(root, 'messages.jsonl');
    activationPath = path.join(root, 'activations.jsonl');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('makes the complete message readable before activation submission', async () => {
    const inbox = await FileManagedSessionInbox.open(inboxPath);
    const input = userMessage('m1');
    const submit = vi.fn(async (activation: ManagedActivationDescriptor) => {
      expect(inbox.getByPayloadRef(input, activation.payloadRef)).toMatchObject(
        {
          state: 'admitted',
          activationReady: true,
          message: { payload: input.payload },
        },
      );
      return {
        created: true,
        activation: {
          descriptor: activation,
          queuedAt: 1,
          queueSequence: 1,
          status: 'queued' as const,
        },
      };
    });
    const controller = new ManagedPromptAdmissionController(
      inbox,
      { submit },
      inboxLimits,
    );

    await expect(controller.admit(input)).resolves.toMatchObject({
      created: true,
      message: { activationReady: true },
      activation: { created: true },
    });
    expect(submit).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      activationId: 'm1',
      payloadRef: managedSessionPayloadRef(input),
      reason: 'user_message',
      recovery: 'replay_safe',
    });
  });

  it('readies the captured identity when the caller mutates its object during submission', async () => {
    const inbox = await FileManagedSessionInbox.open(inboxPath);
    const input = {
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      messageId: 'm1',
      payload: { prompt: [{ type: 'text', text: 'hello' }] },
    };
    const controller = new ManagedPromptAdmissionController(
      inbox,
      {
        submit: async (activation) => {
          input.sessionId = 'mutated-session';
          return {
            created: true,
            activation: {
              descriptor: activation,
              queuedAt: 1,
              queueSequence: 1,
              status: 'queued',
            },
          };
        },
      },
      inboxLimits,
    );

    await expect(controller.admit(input)).resolves.toMatchObject({
      message: {
        activationReady: true,
        message: { sessionId: 'session-a' },
      },
    });
    expect(inbox.get(userMessage('m1'))).toMatchObject({
      activationReady: true,
    });
  });

  it('recovers a ready durable message after activation submission failed', async () => {
    const inbox = await FileManagedSessionInbox.open(inboxPath);
    const failing: ManagedActivationSubmitter = {
      submit: async () => {
        throw new Error('activation store unavailable');
      },
    };
    const first = new ManagedPromptAdmissionController(
      inbox,
      failing,
      inboxLimits,
    );
    await expect(first.admit(userMessage('m1'))).rejects.toThrow(
      'activation store unavailable',
    );
    expect(inbox.listPending()).toMatchObject([
      { activationReady: true, message: { messageId: 'm1' } },
    ]);

    const reopenedInbox = await FileManagedSessionInbox.open(inboxPath);
    const activationStore =
      await FileManagedActivationStore.open(activationPath);
    const recovered = new ManagedPromptAdmissionController(
      reopenedInbox,
      {
        submit: (activation) =>
          activationStore.enqueue(activation, activationLimits),
      },
      inboxLimits,
    );

    await expect(recovered.reconcile()).resolves.toEqual({
      inspected: 1,
      readied: 0,
    });
    expect(reopenedInbox.get(userMessage('m1'))).toMatchObject({
      activationReady: true,
      message: { payload: userMessage('m1').payload },
    });
    expect(activationStore.listPending()).toMatchObject([
      {
        descriptor: {
          activationId: 'm1',
          payloadRef: managedSessionPayloadRef(userMessage('m1')),
        },
      },
    ]);
  });

  it('readies and submits a message interrupted immediately after admission', async () => {
    const inbox = await FileManagedSessionInbox.open(inboxPath);
    const activationStore =
      await FileManagedActivationStore.open(activationPath);
    const input = userMessage('m1');
    await inbox.admit(input, inboxLimits);
    const controller = new ManagedPromptAdmissionController(
      inbox,
      {
        submit: (activation) =>
          activationStore.enqueue(activation, activationLimits),
      },
      inboxLimits,
    );

    await expect(controller.reconcile()).resolves.toEqual({
      inspected: 1,
      readied: 1,
    });
    expect(activationStore.listPending()).toHaveLength(1);
    await expect(controller.reconcile()).resolves.toEqual({
      inspected: 1,
      readied: 0,
    });
    expect(activationStore.listPending()).toHaveLength(1);
  });

  it('keeps client retries idempotent after the ready admission', async () => {
    const inbox = await FileManagedSessionInbox.open(inboxPath);
    const activationStore =
      await FileManagedActivationStore.open(activationPath);
    const controller = new ManagedPromptAdmissionController(
      inbox,
      {
        submit: (activation) =>
          activationStore.enqueue(activation, activationLimits),
      },
      inboxLimits,
    );

    await expect(controller.admit(userMessage('m1'))).resolves.toMatchObject({
      created: true,
      activation: { created: true },
    });
    await expect(controller.admit(userMessage('m1'))).resolves.toMatchObject({
      created: false,
      activation: { created: false },
      message: { activationReady: true },
    });
    expect(inbox.listPending()).toHaveLength(1);
    expect(activationStore.listPending()).toHaveLength(1);
  });
});
