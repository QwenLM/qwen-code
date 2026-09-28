/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ManagedSessionKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ToolResultCapture } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { LocalShellReceipt } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-session.js';
import type { ManagedToolResultPayload } from './managed-runtime-tool-executor.js';
import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import type {
  ManagedMcpControl,
  ManagedMcpOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';

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
  runtime?: {
    bindingId: string;
    generation: string;
    workspaceGeneration: string;
  };

  get runtimeSessionId(): string {
    return this.identity.runtimeSessionId;
  }

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
    const runtime = response['runtime'];
    if (runtime !== undefined) {
      const binding = object(runtime);
      const generation = String(binding['generation']);
      const workspaceGeneration = String(scope['workspaceGeneration']);
      if (
        typeof binding['bindingId'] !== 'string' ||
        !/^[1-9][0-9]{0,18}$/u.test(generation) ||
        !/^[1-9][0-9]{0,18}$/u.test(workspaceGeneration)
      )
        throw new Error('Runtime Broker binding is invalid.');
      this.runtime = {
        bindingId: binding['bindingId'],
        generation,
        workspaceGeneration,
      };
    }
  }

  async registerPublisher(publisher: {
    url: string;
    token: string;
  }): Promise<string> {
    const response = await this.request(
      `/tool-sessions/${encodeURIComponent(this.identity.runtimeSessionId)}:publisher`,
      { publisher },
    );
    const generation = response['bindingGeneration'];
    if (
      response['installed'] !== true ||
      typeof generation !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(generation) ||
      BigInt(generation) > 2n ** 63n - 1n
    ) {
      throw new Error('Runtime did not install the original Shell publisher.');
    }
    return generation;
  }

  async prepare(
    callId: string,
    digest: string,
    inputDigest?: string,
    turnId = this.identity.runtimeSessionId,
  ): Promise<string> {
    const reservation = {
      idempotencyKey: `${this.identity.runtimeSessionId}:${callId}`,
      turnId,
      toolCallId: callId,
      requestDigest: digest,
      reference: {
        sessionId: this.identity.runtimeSessionId,
        promptId: turnId,
        callId,
        argsDigest: digest,
        ...(inputDigest ? { runtimeProtocol: 3, inputDigest } : {}),
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

  async execute(
    id: string,
    payloadJson: string,
    signal: AbortSignal,
    observationMs = 120_000,
  ): Promise<
    ManagedToolResultPayload & { capture?: ToolResultCapture | null }
  > {
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
    const end = Date.now() + observationMs;
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

  async control(
    operation: ManagedMcpControl,
  ): Promise<ManagedMcpOperationView> {
    const envelope = await this.request(
      `/tool-sessions/${encodeURIComponent(this.identity.runtimeSessionId)}/control`,
      { operation },
    );
    const result = object(envelope['result']);
    if (
      result['operationId'] !==
        (operation.kind === 'mcp-status' || operation.kind === 'mcp-cancel'
          ? operation.targetOperationId
          : operation.operationId) ||
      !['running', 'settled', 'outcome_unknown'].includes(
        String(result['state']),
      )
    )
      throw new Error('Runtime MCP response identity is invalid.');
    return result as unknown as ManagedMcpOperationView;
  }

  async acknowledge(id: string, receipt: LocalShellReceipt): Promise<void> {
    const response = await this.request(
      `/executions/${encodeURIComponent(id)}:acknowledge`,
      {
        receipt: {
          executionCallId: receipt.executionCallId,
          manifest: receipt.manifest,
          deliveryStatus: receipt.deliveryStatus,
          historyRevision: receipt.historyRevision,
        },
      },
    );
    if (
      response['executionCallId'] !== id ||
      response['acknowledged'] !== true
    ) {
      throw new Error(
        'Runtime did not acknowledge the original Shell receipt.',
      );
    }
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
