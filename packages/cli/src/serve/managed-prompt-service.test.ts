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
  FileManagedSessionInbox,
  managedSessionPayloadRef,
} from '@qwen-code/qwen-code-core';
import { createManagedPromptService } from './managed-prompt-service.js';
import type {
  ManagedGatewayPromptRequest,
  ManagedPromptRequest,
  ManagedPromptService,
} from './managed-prompt-types.js';

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
  throw new Error('Timed out waiting for Managed Prompt state.');
}

function request(messageId: string): ManagedPromptRequest {
  return gatewayRequest(messageId);
}

function gatewayRequest(messageId: string): ManagedGatewayPromptRequest {
  return {
    mode: 'gateway',
    turnKind: 'bootstrap',
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    workspaceCwd: '/workspace-a',
    sessionId: `session-${messageId}`,
    messageId,
    managedClientId: 'managed-client-a',
    prompt: [{ type: 'text', text: `prompt-${messageId}` }],
  };
}

function gatewayContinuation(
  messageId: string,
  overrides: Partial<ManagedGatewayPromptRequest> = {},
): ManagedGatewayPromptRequest {
  return {
    ...gatewayRequest('message-a'),
    turnKind: 'continuation',
    messageId,
    prompt: [{ type: 'text', text: `follow-up-${messageId}` }],
    ...overrides,
  };
}

describe('createManagedPromptService', () => {
  let root: string;
  const services: ManagedPromptService[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'managed-prompt-service-'));
  });

  afterEach(async () => {
    for (const service of services) service.dispose();
    services.length = 0;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('cancels a queued turn without capacity and never dispatches it after restart', async () => {
    const dispatch = vi.fn(async () => undefined);
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'cancel-a',
      hasMemoryHeadroom: () => false,
      dispatch,
    });
    services.push(service);
    const input = request('queued');
    await service.admit(input);
    expect(await service.cancel!(input.sessionId, input.messageId)).toBe(true);
    expect(
      service.getStatus(input.tenantId, input.sessionId, input.messageId),
    ).toMatchObject({ state: 'finished', outcome: 'cancelled' });
    const queued = await FileManagedActivationStore.open(
      path.join(root, 'activations.jsonl'),
    );
    expect(queued.listPending()).toHaveLength(0);
    service.dispose();
    const reopened = await createManagedPromptService({
      stateDir: root,
      workerId: 'cancel-b',
      hasMemoryHeadroom: () => true,
      dispatch,
    });
    services.push(reopened);
    expect(await reopened.admit(input)).toMatchObject({
      created: false,
      state: 'finished',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(reopened.canContinue!(input.sessionId)).toBe(false);
  });

  it('cancels the exact running turn while completed older turns remain unchanged', async () => {
    let entered = false;
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'cancel-a',
      hasMemoryHeadroom: () => true,
      dispatch: async (input, signal) => {
        if (input.turnKind === 'bootstrap') return;
        entered = true;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    });
    services.push(service);
    const initial = request('message-a');
    await service.admit(initial);
    await waitUntil(() => service.canContinue!(initial.sessionId));
    const followup = gatewayContinuation('next');
    await service.admit(followup);
    await waitUntil(() => entered);
    expect(await service.cancel!(initial.sessionId, initial.messageId)).toBe(
      false,
    );
    expect(
      service.getStatus(
        followup.tenantId,
        followup.sessionId,
        followup.messageId,
      )?.state,
    ).toBe('processing');
    expect(await service.cancel!(followup.sessionId, followup.messageId)).toBe(
      true,
    );
    await waitUntil(
      () =>
        service.getStatus(
          followup.tenantId,
          followup.sessionId,
          followup.messageId,
        )?.state === 'finished',
    );
    expect(
      service.getStatus(
        followup.tenantId,
        followup.sessionId,
        followup.messageId,
      )?.outcome,
    ).toBe('cancelled');
    expect(service.canContinue!(initial.sessionId)).toBe(true);
  });

  it('preserves completion when dispatch has already committed despite a concurrent cancellation request', async () => {
    const gate = deferred();
    let entered = false;
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'cancel-a',
      hasMemoryHeadroom: () => true,
      dispatch: async () => {
        entered = true;
        await gate.promise;
      },
    });
    services.push(service);
    const input = request('race');
    await service.admit(input);
    await waitUntil(() => entered);
    await service.cancel!(input.sessionId, input.messageId);
    gate.resolve();
    await waitUntil(
      () =>
        service.getStatus(input.tenantId, input.sessionId, input.messageId)
          ?.state === 'finished',
    );
    expect(
      service.getStatus(input.tenantId, input.sessionId, input.messageId)
        ?.outcome,
    ).toBe('completed');
  });

  it('acknowledges durable admission without waiting for dispatch completion', async () => {
    const gate = deferred();
    const started: string[] = [];
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch: async (item) => {
        started.push(item.messageId);
        await gate.promise;
      },
    });
    services.push(service);

    const admitted = await service.admit(request('message-a'));
    expect(admitted).toMatchObject({ created: true, activationReady: true });
    await waitUntil(() => started.length === 1);
    expect(
      service.getStatus('tenant-a', 'session-message-a', 'message-a'),
    ).toMatchObject({ state: 'processing' });

    gate.resolve();
    await waitUntil(
      () =>
        service.getStatus('tenant-a', 'session-message-a', 'message-a')
          ?.state === 'finished',
    );
    expect(
      service.getStatus('tenant-a', 'session-message-a', 'message-a'),
    ).toMatchObject({ state: 'finished', outcome: 'completed' });
  });

  it('deduplicates concurrent retries while preserving the first deadline', async () => {
    const gate = deferred();
    const dispatch = vi.fn(async () => gate.promise);
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch,
    });
    services.push(service);

    const [first, second] = await Promise.all([
      service.admit({
        ...request('message-a'),
        deadlineAt: Date.now() + 60_000,
      }),
      service.admit({
        ...request('message-a'),
        deadlineAt: Date.now() + 120_000,
      }),
    ]);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    await waitUntil(() => dispatch.mock.calls.length === 1);
    gate.resolve();
    await waitUntil(
      () =>
        service.getStatus('tenant-a', 'session-message-a', 'message-a')
          ?.state === 'finished',
    );
  });

  it('persists and recovers a Gateway admission without a live Session', async () => {
    const first = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch: async () => undefined,
      startPaused: true,
    });
    services.push(first);
    await first.admit(gatewayRequest('message-a'));
    first.dispose();

    const dispatch = vi.fn(async () => undefined);
    const recovered = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-b',
      hasMemoryHeadroom: () => true,
      dispatch,
      startPaused: true,
    });
    services.push(recovered);
    await recovered.start?.();
    await waitUntil(() => dispatch.mock.calls.length === 1);
    expect(dispatch).toHaveBeenCalledWith(
      gatewayRequest('message-a'),
      expect.any(AbortSignal),
    );
    expect(recovered.getGatewayBinding?.('session-message-a')).toEqual({
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      workspaceCwd: '/workspace-a',
      sessionId: 'session-message-a',
      managedClientId: 'managed-client-a',
    });
  });

  it('serializes Gateway continuations and admits the next turn after terminal', async () => {
    const followUpGate = deferred();
    const dispatch = vi.fn(async (item: ManagedPromptRequest) => {
      if (item.messageId === 'message-b') await followUpGate.promise;
    });
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch,
    });
    services.push(service);

    await service.admit(gatewayRequest('message-a'));
    await waitUntil(
      () =>
        service.getStatus('tenant-a', 'session-message-a', 'message-a')
          ?.state === 'finished',
    );
    const second = gatewayContinuation('message-b');
    await expect(service.admit(second)).resolves.toMatchObject({
      created: true,
    });
    await waitUntil(() =>
      dispatch.mock.calls.some(([item]) => item.messageId === 'message-b'),
    );
    await expect(service.admit(second)).resolves.toMatchObject({
      created: false,
    });
    await expect(
      service.admit(gatewayContinuation('message-c')),
    ).rejects.toMatchObject({
      code: 'managed_gateway_turn_active',
      retryable: true,
    });
    followUpGate.resolve();
    await waitUntil(
      () =>
        service.getStatus('tenant-a', 'session-message-a', 'message-b')
          ?.state === 'finished',
    );
    await expect(
      service.admit(gatewayContinuation('message-c')),
    ).resolves.toMatchObject({ created: true });
  });

  it('publishes completion only after the durable outcome accepts a continuation', async () => {
    let outcomeAtCompletion: string | undefined;
    let continuationAdmission:
      | ReturnType<ManagedPromptService['admit']>
      | undefined;
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch: async () => undefined,
      onCompleted: (item) => {
        if (item.messageId !== 'message-a') return;
        outcomeAtCompletion = service.getStatus(
          item.tenantId,
          item.sessionId,
          item.messageId,
        )?.outcome;
        continuationAdmission = service.admit(gatewayContinuation('message-b'));
      },
    });
    services.push(service);

    await service.admit(gatewayRequest('message-a'));
    await waitUntil(() => continuationAdmission !== undefined);

    expect(outcomeAtCompletion).toBe('completed');
    await expect(continuationAdmission).resolves.toMatchObject({
      created: true,
    });
  });

  it('rejects a continuation that changes the durable Gateway binding', async () => {
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch: async () => undefined,
    });
    services.push(service);
    await service.admit(gatewayRequest('message-a'));
    await waitUntil(
      () =>
        service.getStatus('tenant-a', 'session-message-a', 'message-a')
          ?.state === 'finished',
    );

    await expect(
      service.admit(
        gatewayContinuation('message-b', {
          managedClientId: 'managed-client-b',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'managed_prompt_idempotency_conflict',
      retryable: false,
    });
  });

  it('rejects a continuation after the initial Gateway turn failed', async () => {
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch: async () => {
        throw new Error('model failed');
      },
    });
    services.push(service);
    await service.admit(gatewayRequest('message-a'));
    await waitUntil(
      () =>
        service.getStatus('tenant-a', 'session-message-a', 'message-a')
          ?.state === 'finished',
    );

    await expect(
      service.admit(gatewayContinuation('message-b')),
    ).rejects.toMatchObject({
      code: 'managed_prompt_idempotency_conflict',
      retryable: false,
    });
  });

  it('rejects a durable continuation that has no initial Gateway turn', async () => {
    const inbox = await FileManagedSessionInbox.open(
      path.join(root, 'messages.jsonl'),
    );
    const continuation = gatewayContinuation('message-b');
    await inbox.admit(
      {
        tenantId: continuation.tenantId,
        sessionId: continuation.sessionId,
        messageId: continuation.messageId,
        payload: {
          v: 1,
          ...continuation,
          prompt: continuation.prompt as never,
        },
      },
      { maxPending: 64, maxPendingPerTenant: 16 },
    );

    await expect(
      createManagedPromptService({
        stateDir: root,
        workerId: 'worker-a',
        hasMemoryHeadroom: () => true,
        dispatch: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'managed_prompt_payload_invalid' });
  });

  it('rejects an idempotency key reused with different request data', async () => {
    const gate = deferred();
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch: async () => gate.promise,
    });
    services.push(service);

    await service.admit(request('message-a'));
    await expect(
      service.admit({
        ...request('message-a'),
        prompt: [{ type: 'text', text: 'different' }],
      }),
    ).rejects.toMatchObject({
      code: 'managed_prompt_idempotency_conflict',
      retryable: false,
    });
    gate.resolve();
    await waitUntil(
      () =>
        service.getStatus('tenant-a', 'session-message-a', 'message-a')
          ?.state === 'finished',
    );
  });

  it('rejects an oversized payload before durable admission', async () => {
    const dispatch = vi.fn(async () => undefined);
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch,
    });
    services.push(service);

    await expect(
      service.admit({
        ...request('message-a'),
        prompt: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }],
      }),
    ).rejects.toMatchObject({
      code: 'managed_prompt_payload_invalid',
      retryable: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      service.getStatus('tenant-a', 'session-message-a', 'message-a'),
    ).toBeUndefined();
  });

  it('records dispatch failures as fenced failed terminals', async () => {
    const expected = new Error('dispatch failed');
    const onError = vi.fn();
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch: async () => {
        throw expected;
      },
      onError,
    });
    services.push(service);

    await service.admit(request('message-a'));
    await waitUntil(
      () =>
        service.getStatus('tenant-a', 'session-message-a', 'message-a')
          ?.state === 'finished',
    );
    expect(
      service.getStatus('tenant-a', 'session-message-a', 'message-a'),
    ).toMatchObject({ state: 'finished', outcome: 'failed' });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message-a' }),
      expected,
    );
  });

  it('publishes failure only after the durable outcome accepts a later continuation', async () => {
    let outcomeAtFailure: string | undefined;
    let continuationAdmission:
      | ReturnType<ManagedPromptService['admit']>
      | undefined;
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch: async (item) => {
        if (item.messageId === 'message-b') {
          throw new Error('continuation failed');
        }
      },
      onError: (item) => {
        if (item.messageId !== 'message-b') return;
        outcomeAtFailure = service.getStatus(
          item.tenantId,
          item.sessionId,
          item.messageId,
        )?.outcome;
        continuationAdmission = service.admit(gatewayContinuation('message-c'));
      },
    });
    services.push(service);

    await service.admit(gatewayRequest('message-a'));
    await waitUntil(
      () =>
        service.getStatus('tenant-a', 'session-message-a', 'message-a')
          ?.state === 'finished',
    );
    await service.admit(gatewayContinuation('message-b'));
    await waitUntil(() => continuationAdmission !== undefined);

    expect(outcomeAtFailure).toBe('failed');
    await expect(continuationAdmission).resolves.toMatchObject({
      created: true,
    });
  });

  it('does not dispatch a Prompt whose absolute deadline already expired', async () => {
    const dispatch = vi.fn(async () => undefined);
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch,
    });
    services.push(service);

    await service.admit({
      ...request('message-a'),
      deadlineAt: Date.now() - 1,
    });
    await waitUntil(
      () =>
        service.getStatus('tenant-a', 'session-message-a', 'message-a')
          ?.state === 'finished',
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      service.getStatus('tenant-a', 'session-message-a', 'message-a'),
    ).toMatchObject({ outcome: 'failed' });
  });

  it('fails closed when a recovered payload identity differs from its activation', async () => {
    const inbox = await FileManagedSessionInbox.open(
      path.join(root, 'messages.jsonl'),
    );
    await inbox.admit(
      {
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        messageId: 'message-a',
        payload: {
          v: 1,
          mode: 'gateway',
          turnKind: 'bootstrap',
          tenantId: 'tenant-b',
          workspaceId: 'workspace-a',
          workspaceCwd: '/workspace-a',
          sessionId: 'session-a',
          messageId: 'message-a',
          managedClientId: 'managed-client-a',
          prompt: [{ type: 'text', text: 'hi' }],
        },
      },
      { maxPending: 64, maxPendingPerTenant: 16 },
    );
    const dispatch = vi.fn(async () => undefined);
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch,
    });
    services.push(service);

    await waitUntil(
      () =>
        service.getStatus('tenant-a', 'session-a', 'message-a')?.state ===
        'finished',
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      service.getStatus('tenant-a', 'session-a', 'message-a'),
    ).toMatchObject({ state: 'finished', outcome: 'failed' });
  });

  it('runs at most four asynchronous Harness slots', async () => {
    const gates = new Map(
      Array.from({ length: 5 }, (_, index) => {
        const id = `message-${index}`;
        return [id, deferred()] as const;
      }),
    );
    let running = 0;
    let maximumRunning = 0;
    const started: string[] = [];
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch: async (item) => {
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        started.push(item.messageId);
        await gates.get(item.messageId)!.promise;
        running -= 1;
      },
    });
    services.push(service);

    await Promise.all(
      [...gates.keys()].map((id) => service.admit(request(id))),
    );
    await waitUntil(() => started.length === 4);
    expect(maximumRunning).toBe(4);
    gates.get(started[0]!)!.resolve();
    await waitUntil(() => started.length === 5);
    expect(maximumRunning).toBe(4);
    for (const gate of gates.values()) gate.resolve();
    await waitUntil(() =>
      [...gates.keys()].every(
        (id) =>
          service.getStatus('tenant-a', `session-${id}`, id)?.state ===
          'finished',
      ),
    );
  });

  it('leaves an active message recoverable when the service stops', async () => {
    let observedSignal: AbortSignal | undefined;
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => true,
      dispatch: async (_item, signal) => {
        observedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    services.push(service);

    await service.admit(request('message-a'));
    await waitUntil(() => observedSignal !== undefined);
    service.dispose();
    await waitUntil(() => observedSignal?.aborted === true);
    expect(
      service.getStatus('tenant-a', 'session-message-a', 'message-a'),
    ).toMatchObject({ state: 'processing' });
  });

  it('does not dispatch recovered work until a paused service starts', async () => {
    const first = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-a',
      hasMemoryHeadroom: () => false,
      dispatch: async () => undefined,
    });
    services.push(first);
    await first.admit(request('message-a'));
    first.dispose();

    const dispatch = vi.fn(async () => undefined);
    const recovered = await createManagedPromptService({
      stateDir: root,
      workerId: 'worker-b',
      hasMemoryHeadroom: () => true,
      dispatch,
      startPaused: true,
    });
    services.push(recovered);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dispatch).not.toHaveBeenCalled();
    await recovered.start?.();
    await waitUntil(() => dispatch.mock.calls.length === 1);
  });

  it('fails closed instead of replaying a previously processing Prompt', async () => {
    const inbox = await FileManagedSessionInbox.open(
      path.join(root, 'messages.jsonl'),
    );
    const item = request('message-a');
    await inbox.admit(
      {
        tenantId: item.tenantId,
        sessionId: item.sessionId,
        messageId: item.messageId,
        payload: {
          v: 1,
          ...item,
          prompt: [...item.prompt],
        },
      },
      { maxPending: 64, maxPendingPerTenant: 16 },
    );
    await inbox.markActivationReady(item);
    const activations = await FileManagedActivationStore.open(
      path.join(root, 'activations.jsonl'),
      { clock: () => Date.now() - 1_000 },
    );
    const descriptor = {
      tenantId: item.tenantId,
      sessionId: item.sessionId,
      activationId: item.messageId,
      payloadRef: managedSessionPayloadRef(item),
      reason: 'user_message' as const,
      recovery: 'replay_safe' as const,
    };
    await activations.enqueue(descriptor, {
      maxQueued: 64,
      maxQueuedPerTenant: 16,
    });
    const oldLease = await activations.claim(descriptor, 'old-worker', 10);
    await inbox.beginProcessing(item, oldLease!);

    const dispatch = vi.fn(async () => undefined);
    const onError = vi.fn();
    const service = await createManagedPromptService({
      stateDir: root,
      workerId: 'new-worker',
      hasMemoryHeadroom: () => true,
      dispatch,
      onError,
    });
    services.push(service);

    await waitUntil(
      () =>
        service.getStatus(item.tenantId, item.sessionId, item.messageId)
          ?.state === 'finished',
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: item.messageId }),
      expect.objectContaining({ code: 'managed_prompt_recovery_ambiguous' }),
    );
    expect(
      service.getStatus(item.tenantId, item.sessionId, item.messageId),
    ).toMatchObject({ outcome: 'failed' });
  });
});
