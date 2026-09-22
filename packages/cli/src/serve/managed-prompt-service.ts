/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { FileManagedActivationStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-activation-store.js';
import { EmbeddedHarnessScheduler } from '@qwen-code/qwen-code-core/managed-runtime/embedded-harness-scheduler.js';
import { ManagedPromptAdmissionController } from '@qwen-code/qwen-code-core/managed-runtime/managed-prompt-admission.js';
import {
  FileManagedSessionInbox,
  ManagedSessionInboxAdmissionError,
  ManagedSessionMessageConflictError,
  type ManagedSessionJsonValue,
  type ManagedSessionMessageIdentity,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-inbox.js';
import {
  ManagedPromptServiceError,
  type ManagedPromptAdmissionResponse,
  type ManagedGatewayPromptRequest,
  type ManagedGatewaySessionBinding,
  type ManagedPromptRequest,
  type ManagedPromptService,
  type ManagedPromptStatus,
} from './managed-prompt-types.js';

const MAX_ACTIVE_SLOTS = 4;
const MAX_PENDING = 64;
const MAX_PENDING_PER_TENANT = 16;
const LEASE_DURATION_MS = 60_000;
const CAPACITY_RECHECK_MS = 1_000;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

export interface CreateManagedPromptServiceOptions {
  readonly stateDir: string;
  readonly workerId: string;
  readonly hasMemoryHeadroom: () => boolean;
  readonly dispatch: (
    request: ManagedPromptRequest,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly onCompleted?: (
    request: ManagedPromptRequest,
  ) => void | Promise<void>;
  readonly onRecovered?: (
    request: ManagedPromptRequest,
    status: ManagedPromptStatus,
  ) => void | Promise<void>;
  readonly onCancelling?: (
    request: ManagedPromptRequest,
  ) => void | Promise<void>;
  readonly onCancelled?: (
    request: ManagedPromptRequest,
  ) => void | Promise<void>;
  readonly onError?: (
    request: ManagedPromptRequest,
    error: unknown,
  ) => void | Promise<void>;
  readonly startPaused?: boolean;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedPromptServiceError(
      'managed_prompt_payload_invalid',
      `${name} must be an object.`,
      false,
    );
  }
  return value as Record<string, unknown>;
}

function string(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string' || result.length === 0) {
    throw new ManagedPromptServiceError(
      'managed_prompt_payload_invalid',
      `${field} must be a non-empty string.`,
      false,
    );
  }
  return result;
}

function parseRequest(payload: ManagedSessionJsonValue): ManagedPromptRequest {
  const record = object(payload, 'Managed Prompt payload');
  if (record['v'] !== 1 || !Array.isArray(record['prompt'])) {
    throw new ManagedPromptServiceError(
      'managed_prompt_payload_invalid',
      'Managed Prompt payload has an unsupported shape.',
      false,
    );
  }
  const prompt = record['prompt'];
  if (
    prompt.length === 0 ||
    !prompt.every(
      (block) =>
        typeof block === 'object' && block !== null && !Array.isArray(block),
    )
  ) {
    throw new ManagedPromptServiceError(
      'managed_prompt_payload_invalid',
      'Managed Prompt payload has invalid content blocks.',
      false,
    );
  }
  const rawDeadlineAt = record['deadlineAt'];
  if (
    rawDeadlineAt !== undefined &&
    (!Number.isSafeInteger(rawDeadlineAt) || (rawDeadlineAt as number) < 0)
  ) {
    throw new ManagedPromptServiceError(
      'managed_prompt_payload_invalid',
      'Managed Prompt deadline is invalid.',
      false,
    );
  }
  const base = {
    tenantId: string(record, 'tenantId'),
    workspaceId: string(record, 'workspaceId'),
    sessionId: string(record, 'sessionId'),
    messageId: string(record, 'messageId'),
    prompt: prompt as unknown as ManagedPromptRequest['prompt'],
    ...(rawDeadlineAt === undefined
      ? {}
      : { deadlineAt: rawDeadlineAt as number }),
  };
  if (record['mode'] !== 'gateway') {
    throw new ManagedPromptServiceError(
      'managed_prompt_payload_invalid',
      'Managed Prompt mode must be gateway.',
      false,
    );
  }
  const rawTurnKind = record['turnKind'];
  if (rawTurnKind !== 'bootstrap' && rawTurnKind !== 'continuation') {
    throw new ManagedPromptServiceError(
      'managed_prompt_payload_invalid',
      'Managed Gateway turnKind is invalid.',
      false,
    );
  }
  return {
    ...base,
    mode: 'gateway',
    turnKind: rawTurnKind,
    workspaceCwd: string(record, 'workspaceCwd'),
    managedClientId: string(record, 'managedClientId'),
  };
}

function toPayload(request: ManagedPromptRequest): ManagedSessionJsonValue {
  const base = {
    v: 1,
    mode: 'gateway',
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    messageId: request.messageId,
    prompt: request.prompt as unknown as ManagedSessionJsonValue[],
    ...(request.deadlineAt === undefined
      ? {}
      : { deadlineAt: request.deadlineAt }),
  };
  return {
    ...base,
    turnKind: request.turnKind,
    workspaceCwd: request.workspaceCwd,
    managedClientId: request.managedClientId,
  };
}

function identity(
  request: ManagedPromptRequest,
): ManagedSessionMessageIdentity {
  return {
    tenantId: request.tenantId,
    sessionId: request.sessionId,
    messageId: request.messageId,
  };
}

function sameIdempotentRequest(
  left: ManagedPromptRequest,
  right: ManagedPromptRequest,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.messageId === right.messageId &&
    left.mode === right.mode &&
    isDeepStrictEqual(left.prompt, right.prompt) &&
    left.turnKind === right.turnKind &&
    left.workspaceCwd === right.workspaceCwd &&
    left.managedClientId === right.managedClientId
  );
}

function gatewayBinding(
  request: ManagedGatewayPromptRequest,
): ManagedGatewaySessionBinding {
  return {
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    workspaceCwd: request.workspaceCwd,
    sessionId: request.sessionId,
    managedClientId: request.managedClientId,
  };
}

function sameGatewayBinding(
  left: ManagedGatewaySessionBinding,
  right: ManagedGatewaySessionBinding,
): boolean {
  return isDeepStrictEqual(left, right);
}

function admissionResponse(result: {
  readonly created: boolean;
  readonly message: {
    readonly state: ManagedPromptAdmissionResponse['state'];
    readonly activationReady: boolean;
  };
}): ManagedPromptAdmissionResponse {
  return {
    created: result.created,
    state: result.message.state,
    activationReady: result.message.activationReady,
  };
}

export async function createManagedPromptService(
  options: CreateManagedPromptServiceOptions,
): Promise<ManagedPromptService> {
  const inbox = await FileManagedSessionInbox.open(
    path.join(options.stateDir, 'messages.jsonl'),
  );
  const activations = await FileManagedActivationStore.open(
    path.join(options.stateDir, 'activations.jsonl'),
  );
  const running = new Map<string, AbortController>();
  const gatewayBindings = new Map<string, ManagedGatewaySessionBinding>();
  const recordGatewayBinding = (request: ManagedGatewayPromptRequest): void => {
    const candidate = gatewayBinding(request);
    const existing = gatewayBindings.get(request.sessionId);
    if (existing && !sameGatewayBinding(existing, candidate)) {
      throw new ManagedPromptServiceError(
        'managed_prompt_payload_invalid',
        `Managed Gateway Session ${JSON.stringify(request.sessionId)} has conflicting durable bindings.`,
        false,
      );
    }
    gatewayBindings.set(request.sessionId, candidate);
  };
  const initializedGatewaySessions = new Set<string>();
  const completedGatewaySessions = new Set<string>();
  for (const snapshot of inbox.listAll()) {
    const request = parseRequest(snapshot.message.payload);
    const initialized = initializedGatewaySessions.has(request.sessionId);
    const bootstrap = request.turnKind === 'bootstrap';
    if (initialized === bootstrap) {
      throw new ManagedPromptServiceError(
        'managed_prompt_payload_invalid',
        `Managed Gateway Session ${JSON.stringify(request.sessionId)} has an invalid durable turn sequence.`,
        false,
      );
    }
    if (!bootstrap && !completedGatewaySessions.has(request.sessionId)) {
      throw new ManagedPromptServiceError(
        'managed_prompt_payload_invalid',
        `Managed Gateway Session ${JSON.stringify(request.sessionId)} has a continuation before any completed turn.`,
        false,
      );
    }
    recordGatewayBinding(request);
    initializedGatewaySessions.add(request.sessionId);
    if (snapshot.outcome === 'completed') {
      completedGatewaySessions.add(request.sessionId);
    }
  }
  for (const entry of inbox.listAll()) {
    await options.onRecovered?.(parseRequest(entry.message.payload), {
      messageId: entry.message.messageId,
      state: entry.state,
      activationReady: entry.activationReady,
      admittedAt: entry.admittedAt,
      outcome: entry.outcome,
      finishedAt: entry.finishedAt,
      cancelRequested: entry.cancelRequested,
    });
  }
  // Finish the queue half of a cancellation interrupted between journal writes.
  for (const entry of inbox.listAll()) {
    if (entry.outcome === 'cancelled')
      await activations.cancelQueued({
        tenantId: entry.message.tenantId,
        sessionId: entry.message.sessionId,
        activationId: entry.message.messageId,
      });
  }
  const scheduler = new EmbeddedHarnessScheduler({
    store: activations,
    workerId: options.workerId,
    maxActiveSlots: MAX_ACTIVE_SLOTS,
    maxQueued: MAX_PENDING,
    maxQueuedPerTenant: MAX_PENDING_PER_TENANT,
    leaseDurationMs: LEASE_DURATION_MS,
    hasMemoryHeadroom: options.hasMemoryHeadroom,
    handler: async (activation, context) => {
      const messageIdentity = {
        tenantId: activation.tenantId,
        sessionId: activation.sessionId,
        messageId: activation.activationId,
      };
      const existing = inbox.getByPayloadRef(
        messageIdentity,
        activation.payloadRef,
      );
      if (!existing) {
        throw new ManagedPromptServiceError(
          'managed_prompt_payload_invalid',
          'Managed Prompt payload is missing.',
          false,
        );
      }
      if (existing.state === 'finished') return;
      const recoveredProcessing = existing.state === 'processing';
      const processing = await inbox.beginProcessing(
        messageIdentity,
        context.fence,
      );
      const cancellation = new AbortController();
      const runKey = JSON.stringify(messageIdentity);
      running.set(runKey, cancellation);
      const executionSignal = AbortSignal.any([
        context.signal,
        cancellation.signal,
      ]);
      let request: ManagedPromptRequest | undefined;
      try {
        request = parseRequest(processing.message.payload);
        if (
          request.tenantId !== activation.tenantId ||
          request.sessionId !== activation.sessionId ||
          request.messageId !== activation.activationId
        ) {
          throw new ManagedPromptServiceError(
            'managed_prompt_payload_invalid',
            'Managed Prompt payload identity does not match its activation.',
            false,
          );
        }
        if (inbox.get(messageIdentity)?.cancelRequested) {
          cancellation.abort(new Error('Managed Prompt cancelled.'));
          throw cancellation.signal.reason;
        }
        if (recoveredProcessing) {
          throw new ManagedPromptServiceError(
            'managed_prompt_recovery_ambiguous',
            'Managed Prompt may have been dispatched before the previous worker stopped; refusing to replay it.',
            false,
          );
        }
        if (context.signal.aborted) {
          throw context.signal.reason;
        }
        if (
          request.deadlineAt !== undefined &&
          request.deadlineAt <= Date.now()
        ) {
          throw new ManagedPromptServiceError(
            'managed_prompt_deadline_exceeded',
            'Managed Prompt deadline expired before dispatch.',
            false,
          );
        }
        await options.dispatch(request, executionSignal);
        if (context.signal.aborted) {
          throw context.signal.reason;
        }
        await inbox.finish(messageIdentity, context.fence, 'completed');
        completedGatewaySessions.add(request.sessionId);
        try {
          await options.onCompleted?.(request);
        } catch {
          // An observer must not turn a committed Prompt into a failed one.
        }
      } catch (error) {
        if (!context.signal.aborted) {
          const wasCancelled =
            inbox.get(messageIdentity)?.cancelRequested === true;
          await inbox.finish(
            messageIdentity,
            context.fence,
            wasCancelled ? 'cancelled' : 'failed',
          );
          if (request) {
            try {
              if (wasCancelled) await options.onCancelled?.(request);
              else await options.onError?.(request, error);
            } catch {
              // An observer must not strand a durable activation.
            }
          }
        }
        throw error;
      } finally {
        if (running.get(runKey) === cancellation) running.delete(runKey);
      }
    },
  });
  const admissions = new ManagedPromptAdmissionController(inbox, scheduler, {
    maxPending: MAX_PENDING,
    maxPendingPerTenant: MAX_PENDING_PER_TENANT,
  });
  await admissions.reconcile();
  let startPromise: Promise<void> | undefined;
  let capacityTimer: NodeJS.Timeout | undefined;
  let disposed = false;
  let admissionTail: Promise<void> = Promise.resolve();
  const serializeAdmission = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = admissionTail.then(operation);
    admissionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const start = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error('Managed Prompt service is disposed.'));
    }
    startPromise ??= (async () => {
      await scheduler.start();
      if (disposed) return;
      capacityTimer = setInterval(
        () => scheduler.notifyCapacityChanged(),
        CAPACITY_RECHECK_MS,
      );
      capacityTimer.unref();
    })();
    return startPromise;
  };
  const service: ManagedPromptService = {
    start,
    admit(request): Promise<ManagedPromptAdmissionResponse> {
      if (disposed) throw new Error('Managed Prompt service is disposed.');
      return serializeAdmission(async () => {
        try {
          let payload = toPayload(request);
          if (
            Buffer.byteLength(JSON.stringify(payload), 'utf8') >
            MAX_PAYLOAD_BYTES
          ) {
            throw new ManagedPromptServiceError(
              'managed_prompt_payload_invalid',
              `Managed Prompt payload exceeds ${MAX_PAYLOAD_BYTES} UTF-8 bytes.`,
              false,
            );
          }
          const parsedRequest = parseRequest(payload);
          const existing = inbox.get(identity(request));
          if (existing) {
            const existingRequest = parseRequest(existing.message.payload);
            if (!sameIdempotentRequest(parsedRequest, existingRequest)) {
              throw new ManagedPromptServiceError(
                'managed_prompt_idempotency_conflict',
                `Managed Session message ${JSON.stringify(request.messageId)} was reused with different data.`,
                false,
              );
            }
            payload = existing.message.payload;
          } else {
            const candidate = gatewayBinding(parsedRequest);
            const binding = gatewayBindings.get(parsedRequest.sessionId);
            if (parsedRequest.turnKind === 'bootstrap') {
              if (binding) {
                throw new ManagedPromptServiceError(
                  'managed_prompt_idempotency_conflict',
                  `Managed Gateway Session ${JSON.stringify(parsedRequest.sessionId)} already has an initial turn.`,
                  false,
                );
              }
            } else {
              if (!binding || !sameGatewayBinding(binding, candidate)) {
                throw new ManagedPromptServiceError(
                  'managed_prompt_idempotency_conflict',
                  'Managed Gateway continuation does not match its durable Session binding.',
                  false,
                );
              }
              if (!completedGatewaySessions.has(parsedRequest.sessionId)) {
                throw new ManagedPromptServiceError(
                  'managed_prompt_idempotency_conflict',
                  'Managed Gateway continuation requires a successfully completed prior turn.',
                  false,
                );
              }
            }
            const activeTurn = inbox.listPending().find((snapshot) => {
              const pending = parseRequest(snapshot.message.payload);
              return (
                pending.sessionId === parsedRequest.sessionId &&
                pending.messageId !== parsedRequest.messageId
              );
            });
            if (activeTurn) {
              throw new ManagedPromptServiceError(
                'managed_gateway_turn_active',
                'Managed Gateway Session already has an unfinished turn.',
                true,
              );
            }
          }
          const result = await admissions.admit({
            ...identity(request),
            payload,
          });
          recordGatewayBinding(parsedRequest);
          return admissionResponse(result);
        } catch (error) {
          const durable = inbox.get(identity(request));
          if (durable) {
            const durableRequest = parseRequest(durable.message.payload);
            recordGatewayBinding(durableRequest);
          }
          if (error instanceof ManagedSessionInboxAdmissionError) {
            throw new ManagedPromptServiceError(
              error.code === 'GLOBAL_INBOX_FULL'
                ? 'managed_prompt_inbox_full'
                : 'managed_prompt_tenant_inbox_full',
              error.message,
              true,
            );
          }
          if (error instanceof ManagedSessionMessageConflictError) {
            const existing = inbox.get(identity(request));
            if (
              existing &&
              sameIdempotentRequest(
                request,
                parseRequest(existing.message.payload),
              )
            ) {
              return admissionResponse(
                await admissions.admit({
                  ...identity(request),
                  payload: existing.message.payload,
                }),
              );
            }
            throw new ManagedPromptServiceError(
              'managed_prompt_idempotency_conflict',
              error.message,
              false,
            );
          }
          throw error;
        }
      });
    },
    getStatus(tenantId, sessionId, messageId): ManagedPromptStatus | undefined {
      const result = inbox.get({ tenantId, sessionId, messageId });
      if (!result) return undefined;
      return {
        messageId,
        state: result.state,
        activationReady: result.activationReady,
        admittedAt: result.admittedAt,
        ...(result.cancelRequested ? { cancelRequested: true } : {}),
        ...(result.outcome ? { outcome: result.outcome } : {}),
        ...(result.finishedAt === undefined
          ? {}
          : { finishedAt: result.finishedAt }),
      };
    },
    getGatewayBinding(sessionId): ManagedGatewaySessionBinding | undefined {
      const binding = gatewayBindings.get(sessionId);
      return binding ? structuredClone(binding) : undefined;
    },
    canContinue(sessionId) {
      return completedGatewaySessions.has(sessionId);
    },
    cancel(sessionId, messageId) {
      if (disposed) throw new Error('Managed Prompt service is disposed.');
      return serializeAdmission(async () => {
        const binding = gatewayBindings.get(sessionId);
        if (!binding) return false;
        const messageIdentity = {
          tenantId: binding.tenantId,
          sessionId,
          messageId,
        };
        const existing = inbox.get(messageIdentity);
        if (!existing || existing.state === 'finished') return false;
        const cancelled = await inbox.requestCancel(messageIdentity);
        const request = parseRequest(cancelled.message.payload);
        if (cancelled.outcome === 'cancelled') {
          await activations.cancelQueued({
            tenantId: binding.tenantId,
            sessionId,
            activationId: messageId,
          });
          await options.onCancelled?.(request);
        } else {
          running
            .get(JSON.stringify(messageIdentity))
            ?.abort(new Error('Managed Prompt cancelled.'));
          await options.onCancelling?.(request);
        }
        scheduler.notifyCapacityChanged();
        return true;
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (capacityTimer) clearInterval(capacityTimer);
      scheduler.dispose();
    },
  };
  if (!options.startPaused) await start();
  return service;
}
