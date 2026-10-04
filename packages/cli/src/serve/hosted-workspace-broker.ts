/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseManagedRuntimeProviderResult } from './managed-runtime-provider-protocol.js';
import type {
  RawFileHistoryOperation,
  HostedFileHistoryState,
} from './hosted-file-history-protocol.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ManagedSessionKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type {
  ToolResultCapture,
  ToolResultEnvelope,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { LocalShellReceipt } from '@qwen-code/qwen-code-core/managed-runtime/local-shell-result-session.js';
import type { ManagedToolResultPayload } from './managed-runtime-tool-executor.js';
import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';
import { WORKSPACE_CAPABILITY_DIGEST } from './managed-workspace-activation.js';
import type {
  ManagedMcpControl,
  ManagedMcpOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';

import type {
  ManagedHookControl,
  ManagedHookOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import type { ManagedSessionLifecycleAuthority } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';

export interface HostedWorkspaceBrokerOptions {
  baseUrl: string;
  token: string;
  lifecycleAuthority?: () => ManagedSessionLifecycleAuthority | undefined;
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
    readonly details?: Record<string, unknown>,
    readonly reason?: string,
  ) {
    super(`Runtime Broker returned HTTP ${status} (${String(code)}).`);
  }
}

export function isHostedFileHistoryRefusal(
  cause: unknown,
): cause is HostedWorkspaceBrokerRejection {
  return (
    cause instanceof HostedWorkspaceBrokerRejection &&
    ((cause.status === 409 &&
      cause.code === 'managed_runtime_provider_operation_failed') ||
      (cause.status === 400 &&
        cause.code === 'runtime_control_operation_invalid'))
  );
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

  async fileHistory(
    operation: Exclude<RawFileHistoryOperation, { action: 'rewind' }>,
  ): Promise<HostedFileHistoryState>;
  async fileHistory(
    operation: Extract<RawFileHistoryOperation, { action: 'rewind' }>,
  ): Promise<{
    state: HostedFileHistoryState;
    filesChanged: string[];
    filesFailed: string[];
    conflict: boolean;
  }>;
  async fileHistory(operation: RawFileHistoryOperation): Promise<
    | HostedFileHistoryState
    | {
        state: HostedFileHistoryState;
        filesChanged: string[];
        filesFailed: string[];
        conflict: boolean;
      }
  >;
  async fileHistory(operation: RawFileHistoryOperation): Promise<unknown> {
    const response = await this.request(
      `/tool-sessions/${encodeURIComponent(this.identity.runtimeSessionId)}/control`,
      { operation },
    );
    return parseManagedRuntimeProviderResult(operation, response['result'], {
      ...this.identity,
      turnKind: 'bootstrap',
    });
  }

  async warm(): Promise<void> {
    await this.request('/runtimes:warm', {});
  }

  async authorizeLifecycle(): Promise<void> {
    if (this.options.lifecycleAuthority?.())
      await this.request('/runtimes:authorize-lifecycle', {});
  }

  async acquire(expected?: {
    runtimeBindingId: string;
    generation: string;
  }): Promise<void> {
    const response = await this.request('/tool-sessions:acquire', {
      turnKind: 'bootstrap',
      ...(expected
        ? {
            recoveryBindingId: expected.runtimeBindingId,
            recoveryGeneration: expected.generation,
          }
        : {}),
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
    let startUncertain = false;
    let startAttempts = 0;
    let preparedObservations = 0;
    const definiteStartFailure = (failure: unknown): boolean =>
      failure instanceof HostedWorkspaceBrokerRejection &&
      ([400, 401, 403, 404, 409].includes(failure.status) ||
        (failure.status === 501 &&
          failure.code === 'runtime_tool_v3_unsupported'));
    if (!signal.aborted) {
      startAttempts++;
      try {
        response = await this.request(`${path}:start`, {
          payloadJson,
          publicationId,
          publicationToken,
        });
      } catch (failure) {
        if (definiteStartFailure(failure)) throw failure;
        startUncertain = true;
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
      if (status['state'] === 'prepared' && startUncertain && !signal.aborted) {
        preparedObservations++;
        if (preparedObservations >= 10) {
          if (startAttempts >= 3)
            throw new Error('Tool v3 start was not confirmed.');
          startAttempts++;
          preparedObservations = 0;
          try {
            response = await this.request(`${path}:start`, {
              payloadJson,
              publicationId,
              publicationToken,
            });
            startUncertain = false;
          } catch (failure) {
            if (definiteStartFailure(failure)) throw failure;
            response = undefined;
          }
          continue;
        }
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
    observationMs = 120_000,
    waitForUnknown = false,
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
      const cancelling = signal.aborted && !cancellationSent;
      try {
        if (cancelling) {
          cancellationSent = true;
          response = await this.request(`${path}:cancel`, {});
        }
        response ??= await this.request(
          waitForUnknown ? `${path}?reconcile=true` : path,
        );
      } catch (cause) {
        const transportFailed =
          cause instanceof TypeError ||
          (cause instanceof DOMException && cause.name === 'TimeoutError');
        if (cancelling && transportFailed) cancellationSent = false;
        if (
          !waitForUnknown ||
          !(
            (cause instanceof HostedWorkspaceBrokerRejection &&
              cause.status === 409 &&
              cause.code === 'runtime_broker_execution_unknown' &&
              cause.details?.['terminal'] !== true) ||
            transportFailed
          )
        )
          throw cause;
        response = undefined;
        await delay(250);
        continue;
      }
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
        !(waitForUnknown && status['state'] === 'unknown') &&
        !['prepared', 'executing', 'cancel_requested'].includes(
          String(status['state']),
        )
      )
        throw new Error('Runtime execution outcome is unknown.');
      response = undefined;
      await delay(waitForUnknown ? 250 : 50);
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

  async hookControl(
    operation: ManagedHookControl,
  ): Promise<ManagedHookOperationView> {
    const envelope = await this.request(
      `/tool-sessions/${encodeURIComponent(this.identity.runtimeSessionId)}/control`,
      { operation },
    );
    const result = object(envelope['result']);
    if (
      result['operationId'] !==
        (operation.kind === 'hook-status' || operation.kind === 'hook-cancel'
          ? operation.targetOperationId
          : operation.operationId) ||
      !['running', 'settled', 'outcome_unknown'].includes(
        String(result['state']),
      )
    )
      throw new Error('Runtime Hook response identity is invalid.');
    return result as unknown as ManagedHookOperationView;
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
    if (
      response['acknowledged'] !== true ||
      response['executionCallId'] !== id ||
      object(response['status'])['state'] !== 'settled'
    )
      throw new Error('Original Tool v3 ACK was not confirmed.');
  }

  /**
   * Read-only execution state. Only a definitive not-found resolves to
   * undefined; an unknown outcome is not proof that execution stopped.
   */
  async status(id: string): Promise<{ state: string } | undefined> {
    let response: Record<string, unknown>;
    try {
      response = await this.request(`/executions/${encodeURIComponent(id)}`);
    } catch (cause) {
      if (cause instanceof HostedWorkspaceBrokerRejection) {
        if (
          cause.status === 404 &&
          cause.code === 'runtime_execution_not_found'
        )
          return undefined;
        if (
          cause.status === 409 &&
          cause.code === 'runtime_broker_execution_unknown'
        )
          return { state: 'unknown' };
      }
      throw cause;
    }
    if (response['executionCallId'] !== id)
      throw new Error('Runtime execution identity changed.');
    const status = object(response['status']);
    const state = status['state'];
    if (
      typeof state !== 'string' ||
      !['prepared', 'executing', 'cancel_requested', 'settled'].includes(state)
    )
      throw new Error('Runtime execution outcome is unknown.');
    return { state };
  }

  async acknowledge(id: string, receipt: LocalShellReceipt): Promise<void> {
    const path = `/executions/${encodeURIComponent(id)}:acknowledge`;
    const body = {
      receipt: {
        executionCallId: receipt.executionCallId,
        manifest: receipt.manifest,
        deliveryStatus: receipt.deliveryStatus,
        historyRevision: receipt.historyRevision,
      },
    };
    let response: Record<string, unknown>;
    try {
      response = await this.request(path, body);
    } catch (cause) {
      // The acknowledgement runs after every durable record is committed, so
      // a lost reply is replayed the way prepare() replays its reservation:
      // the runtime deduplicates an identical receipt.
      if (
        !(cause instanceof TypeError) &&
        !(cause instanceof DOMException && cause.name === 'TimeoutError')
      )
        throw cause;
      response = await this.request(path, body);
    }
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
    const authority = this.options.lifecycleAuthority?.();
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        'Content-Type': 'application/json',
        ...(authority
          ? {
              'X-Qwen-Lifecycle-Operation-Id': authority.operationId,
              'X-Qwen-Lifecycle-Claim-Generation': String(
                authority.claimGeneration,
              ),
            }
          : {}),
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
    if (!response.ok) {
      const details = parsed['details'];
      throw new HostedWorkspaceBrokerRejection(
        response.status,
        parsed['code'],
        details && typeof details === 'object' && !Array.isArray(details)
          ? (details as Record<string, unknown>)
          : undefined,
        typeof parsed['error'] === 'string' ? parsed['error'] : undefined,
      );
    }
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
