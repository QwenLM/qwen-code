/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ManagedSessionKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedToolResultPayload } from './managed-runtime-tool-executor.js';
import type { ToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';

export interface HostedWorkspaceBrokerOptions {
  baseUrl: string;
  token: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Hosted Workspace Broker response.');
  return value as Record<string, unknown>;
}

export class HostedWorkspaceBrokerRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: unknown,
  ) {
    super(`Runtime Broker returned HTTP ${status} (${String(code)}).`);
  }
}

export class HostedWorkspaceBroker {
  private readonly baseUrl: URL;
  private readonly identity: {
    harnessSessionId: string;
    runtimeSessionId: string;
  };

  constructor(
    private readonly options: HostedWorkspaceBrokerOptions,
    private readonly key: ManagedSessionKey,
    runtimeSessionId: string,
  ) {
    this.baseUrl = resolveManagedRuntimeBrokerBaseUrl(options.baseUrl);
    this.identity = { harnessSessionId: key.sessionId, runtimeSessionId };
  }

  async warm(): Promise<void> {
    await this.request('/runtimes:warm', {});
  }

  async acquire(): Promise<void> {
    const response = await this.request('/tool-sessions:acquire', {
      turnKind: 'bootstrap',
    });
    const scope = object(response['scope']);
    if (
      response['acquired'] !== true ||
      scope['tenantId'] !== this.key.tenantId ||
      scope['workspaceId'] !== this.key.workspaceId ||
      scope['capabilityDigest'] !== WORKSPACE_CAPABILITY_DIGEST
    )
      throw new Error(
        'Hosted Workspace Broker scope does not match the saved Session.',
      );
  }

  async prepare(callId: string, digest: string): Promise<string> {
    const reservation = {
      idempotencyKey: `${this.identity.runtimeSessionId}:${callId}`,
      turnId: this.identity.runtimeSessionId,
      toolCallId: callId,
      requestDigest: digest,
      reference: {
        sessionId: this.identity.runtimeSessionId,
        promptId: this.identity.runtimeSessionId,
        callId,
        argsDigest: digest,
      },
    };
    let response: Record<string, unknown>;
    try {
      response = await this.request('/executions:prepare', reservation);
    } catch (cause) {
      if (
        !(cause instanceof TypeError) &&
        !(cause instanceof DOMException && cause.name === 'TimeoutError')
      )
        throw cause;
      response = await this.request('/executions:prepare', reservation);
    }
    const id = response['executionCallId'];
    if (
      typeof id !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(id) ||
      object(response['status'])['state'] !== 'prepared'
    )
      throw new Error(
        'Hosted Workspace Broker did not reserve a fresh execution.',
      );
    return id;
  }

  async prepareV3(
    callId: string,
    argsDigest: string,
    requestDigest: string,
    publicationId: string,
  ): Promise<{
    executionCallId: string;
    runtimeBindingId: string;
    bindingGeneration: string;
  }> {
    const response = await this.request('/executions:prepare', {
      idempotencyKey: `${this.identity.runtimeSessionId}:${callId}`,
      turnId: this.identity.runtimeSessionId,
      toolCallId: callId,
      requestDigest,
      toolProtocol: 'v3',
      publicationId,
      reference: {
        sessionId: this.identity.runtimeSessionId,
        promptId: this.identity.runtimeSessionId,
        callId,
        argsDigest,
      },
    });
    const executionCallId = response['executionCallId'];
    const runtimeBindingId = response['runtimeBindingId'];
    const bindingGeneration = response['bindingGeneration'];
    if (
      typeof executionCallId !== 'string' ||
      typeof runtimeBindingId !== 'string' ||
      typeof bindingGeneration !== 'string' ||
      !/^[1-9][0-9]{0,18}$/u.test(bindingGeneration) ||
      object(response['status'])['state'] !== 'prepared'
    )
      throw new Error(
        'Hosted Broker did not reserve the original Tool v3 execution.',
      );
    return { executionCallId, runtimeBindingId, bindingGeneration };
  }

  async executeV3(
    id: string,
    payloadJson: string,
    publicationId: string,
    publicationToken: string,
    signal: AbortSignal,
  ): Promise<ToolResultEnvelope> {
    const path = `/executions/${encodeURIComponent(id)}`;
    let response: Record<string, unknown> | undefined;
    let cancellationSent = false;
    if (!signal.aborted) {
      try {
        response = await this.request(`${path}:start`, {
          payloadJson,
          publicationId,
          publicationToken,
        });
      } catch (failure) {
        if (
          failure instanceof HostedWorkspaceBrokerRejection &&
          [400, 401, 403, 404, 409].includes(failure.status)
        )
          throw failure;
      }
    }
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      if (signal.aborted && !cancellationSent) {
        cancellationSent = true;
        response = await this.request(`${path}:cancel`, {});
      }
      response ??= await this.request(path);
      if (response['executionCallId'] !== id)
        throw new Error('Tool v3 execution identity changed.');
      const status = object(response['status']);
      if (status['state'] === 'settled') {
        const result = object(status['result']);
        if (
          !['success', 'error', 'cancelled', 'not_started'].includes(
            String(result['executionStatus']),
          ) ||
          !Array.isArray(result['responseParts'])
        )
          throw new Error('Tool v3 result is invalid.');
        return result as unknown as ToolResultEnvelope;
      }
      if (
        !['prepared', 'executing', 'cancel_requested'].includes(
          String(status['state']),
        )
      )
        throw new Error('Tool v3 execution outcome is unknown.');
      response = undefined;
      await delay(100);
    }
    throw new Error('Tool v3 execution exceeded its observation deadline.');
  }

  async execute(
    id: string,
    payloadJson: string,
    signal: AbortSignal,
  ): Promise<ManagedToolResultPayload> {
    const path = `/executions/${encodeURIComponent(id)}`;
    let response: Record<string, unknown> | undefined;
    let cancellationSent = false;
    if (!signal.aborted) {
      try {
        response = await this.request(`${path}:start`, { payloadJson });
      } catch (error) {
        if (
          error instanceof HostedWorkspaceBrokerRejection &&
          error.status === 409 &&
          (error.code === 'runtime_idempotency_conflict' ||
            error.code === 'runtime_execution_conflict')
        )
          throw error;
        // A lost start reply is not permission to start another invocation.
      }
    }
    const end = Date.now() + 120_000;
    while (Date.now() < end) {
      if (signal.aborted && !cancellationSent) {
        cancellationSent = true;
        response = await this.request(`${path}:cancel`, {});
      }
      response ??= await this.request(path);
      if (response['executionCallId'] !== id)
        throw new Error('Runtime execution identity changed.');
      const status = object(response['status']);
      if (status['state'] === 'settled') {
        const result = object(status['result']);
        if (
          !['success', 'error', 'cancelled', 'not_started'].includes(
            String(result['executionStatus']),
          ) ||
          (result['executionStatus'] === 'success' &&
            !Array.isArray(result['responseParts'])) ||
          (result['responseParts'] !== undefined &&
            !Array.isArray(result['responseParts']))
        )
          throw new Error('Runtime execution result is invalid.');
        return {
          ...result,
          responseParts: result['responseParts'] ?? [],
        } as unknown as ManagedToolResultPayload;
      }
      if (
        !['prepared', 'executing', 'cancel_requested'].includes(
          String(status['state']),
        )
      )
        throw new Error('Runtime execution outcome is unknown.');
      response = undefined;
      await delay(50);
    }
    throw new Error(
      'Runtime execution did not settle within its observation window.',
    );
  }

  async cancel(id: string): Promise<void> {
    await this.request(`/executions/${encodeURIComponent(id)}:cancel`, {});
  }

  async acknowledgeV3(
    id: string,
    receipt: {
      executionCallId: string;
      manifest: unknown;
      deliveryStatus: 'committed' | 'blocked';
      historyRevision: number | null;
    },
  ): Promise<void> {
    const response = await this.request(
      `/executions/${encodeURIComponent(id)}:acknowledge`,
      { receipt },
    );
    if (object(response['acknowledged'])['state'] !== 'settled')
      throw new Error('Original Tool v3 ACK was not confirmed.');
  }

  async release(): Promise<void> {
    const response = await this.request(
      `/tool-sessions/${encodeURIComponent(this.identity.runtimeSessionId)}:release`,
      {},
    );
    if (response['released'] !== true)
      throw new Error('Runtime Session release is unconfirmed.');
  }

  private async request(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`/internal/runtime-broker/v1${path}`, this.baseUrl);
    const fields = {
      protocolVersion: 1,
      requestId: randomUUID(),
      ...this.identity,
      ...body,
    };
    if (!body)
      for (const [key, value] of Object.entries(fields))
        url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(fields) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.body) throw new Error('Runtime Broker returned no body.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('Runtime Broker response exceeds its limit.');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const parsed = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!response.ok)
      throw new HostedWorkspaceBrokerRejection(response.status, parsed['code']);
    if (
      parsed['protocolVersion'] !== 1 ||
      parsed['harnessSessionId'] !== this.key.sessionId ||
      (path !== '/runtimes:warm' &&
        parsed['runtimeSessionId'] !== this.identity.runtimeSessionId)
    )
      throw new Error('Runtime Broker response identity changed.');
    return parsed;
  }
}
