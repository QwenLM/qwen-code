/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type ManagedToolExecutionResult,
  type ManagedToolInvocationStatus,
  type ManagedToolV2Client,
} from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import {
  managedToolDigest,
  type ManagedToolInvocationReference,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { isLoopbackBind } from './loopback-binds.js';
import {
  ManagedRuntimeProviderError,
  type ManagedRuntimeExecutionIdentity,
  type ManagedRuntimeExecutionInspection,
  type ManagedRuntimeHandle,
  type ManagedRuntimeProvider,
  type ManagedRuntimeReleaseOptions,
  type ManagedRuntimeToolClientContext,
  type ManagedRuntimeUnknownResolution,
} from './managed-runtime-provider.js';
import {
  sameManagedRuntimeIdentity,
  type ManagedRuntimePrepareRequest,
} from './managed-runtime-protocol.js';

export const MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION = 1 as const;
export const MANAGED_RUNTIME_BROKER_ROUTE_PREFIX =
  '/internal/runtime-broker/v1' as const;

const MAX_BROKER_RESPONSE_BYTES = 8 * 1024 * 1024;
const BROKER_REQUEST_TIMEOUT_MS = 10 * 60_000;
const EXECUTION_POLL_DELAY_MS = 50;

interface BrokerEnvelope {
  readonly protocolVersion: typeof MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION;
  readonly harnessSessionId: string;
  readonly runtimeSessionId: string;
}

interface BrokerAcquireResponse extends BrokerEnvelope {
  readonly acquired: true;
}

interface BrokerControlResponse extends BrokerEnvelope {
  readonly result: unknown;
}

interface BrokerExecutionResponse extends BrokerEnvelope {
  readonly executionCallId: string;
  readonly status: ManagedToolInvocationStatus;
}

interface BrokerReleaseResponse extends BrokerEnvelope {
  readonly released: true;
}

interface BrokerEntry {
  readonly request: ManagedRuntimePrepareRequest;
  readonly harnessSessionId: string;
  readonly acquisition: Promise<void>;
  readonly executions: Map<string, BrokerExecution>;
  client?: ManagedToolV2Client;
  release?: Promise<boolean>;
  releasing?: boolean;
}

interface BrokerExecution {
  readonly referenceDigest: string;
  readonly reserved: Promise<{
    executionCallId: string;
    status: ManagedToolInvocationStatus;
  }>;
  started?: Promise<ManagedToolExecutionResult>;
}

class BrokerResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly retryable?: boolean,
  ) {
    super(`Managed Runtime Broker returned HTTP ${status}.`);
    this.name = 'BrokerResponseError';
  }
}

export interface ManagedRuntimeBrokerClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export function resolveManagedRuntimeBrokerBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Managed Runtime Broker URL is invalid.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('Managed Runtime Broker URL must be an HTTP(S) origin.');
  }
  if (url.protocol === 'http:' && !isLoopbackBind(url.hostname)) {
    throw new Error(
      'Managed Runtime Broker URL must use HTTPS outside the loopback interface.',
    );
  }
  url.pathname = '/';
  return url;
}

async function readBoundedResponseText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Managed Runtime Broker response exceeded its limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Managed Runtime Broker returned an invalid response.');
  }
  return value as Record<string, unknown>;
}

function boundedId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0')
  ) {
    throw new Error(`Managed Runtime Broker returned an invalid ${label}.`);
  }
  return value;
}

function parseExecutionResult(value: unknown): ManagedToolExecutionResult {
  const input = record(value);
  if (
    !['not_started', 'success', 'error', 'cancelled'].includes(
      String(input['executionStatus']),
    )
  ) {
    throw new Error(
      'Managed Runtime Broker returned an invalid execution result.',
    );
  }
  return structuredClone(value) as ManagedToolExecutionResult;
}

function parseInvocationStatus(value: unknown): ManagedToolInvocationStatus {
  const input = record(value);
  if (
    !['prepared', 'executing', 'cancel_requested', 'settled'].includes(
      String(input['state']),
    ) ||
    typeof input['cancelRequested'] !== 'boolean' ||
    !Number.isSafeInteger(input['lastSeq']) ||
    Number(input['lastSeq']) < 0 ||
    !Number.isSafeInteger(input['firstAvailableSeq']) ||
    Number(input['firstAvailableSeq']) < 0 ||
    typeof input['progressGap'] !== 'boolean' ||
    !Array.isArray(input['progress'])
  ) {
    throw new Error(
      'Managed Runtime Broker returned an invalid execution status.',
    );
  }
  for (const event of input['progress']) {
    const progress = record(event);
    if (
      !Number.isSafeInteger(progress['seq']) ||
      Number(progress['seq']) < 0 ||
      !('output' in progress)
    ) {
      throw new Error(
        'Managed Runtime Broker returned invalid execution progress.',
      );
    }
  }
  if (input['state'] === 'settled') {
    parseExecutionResult(input['result']);
  } else if (input['result'] !== undefined) {
    throw new Error(
      'Managed Runtime Broker returned a premature execution result.',
    );
  }
  return structuredClone(value) as ManagedToolInvocationStatus;
}

function executionIdempotencyKey(
  harnessSessionId: string,
  reference: ManagedToolInvocationReference,
): string {
  return createHash('sha256')
    .update(harnessSessionId)
    .update('\0')
    .update(reference.promptId)
    .update('\0')
    .update(reference.callId)
    .update('\0')
    .update(reference.argsDigest)
    .digest('hex');
}

export class ManagedRuntimeBrokerClient {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ManagedRuntimeBrokerClientOptions) {
    this.baseUrl = resolveManagedRuntimeBrokerBaseUrl(options.baseUrl);
    this.token = options.token.trim();
    if (!this.token)
      throw new Error('Managed Runtime Broker token is required.');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async acquire(
    request: ManagedRuntimePrepareRequest,
    harnessSessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.requestJson(
      'POST',
      'tool-sessions:acquire',
      {
        protocolVersion: MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: randomUUID(),
        harnessSessionId,
        runtimeSessionId: request.sessionId,
        turnKind: request.turnKind,
      },
      signal,
    );
    const envelope = this.parseEnvelope(
      response,
      harnessSessionId,
      request.sessionId,
    ) as BrokerAcquireResponse;
    if (envelope.acquired !== true) {
      throw new Error('Managed Runtime Broker did not acquire the Session.');
    }
  }

  async control(
    runtimeSessionId: string,
    harnessSessionId: string,
    operation: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.requestJson(
      'POST',
      `tool-sessions/${encodeURIComponent(runtimeSessionId)}/control`,
      {
        protocolVersion: MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: randomUUID(),
        harnessSessionId,
        operation,
      },
      signal,
    );
    return (
      this.parseEnvelope(
        response,
        harnessSessionId,
        runtimeSessionId,
      ) as BrokerControlResponse
    ).result;
  }

  async createExecution(
    runtimeSessionId: string,
    harnessSessionId: string,
    reference: ManagedToolInvocationReference,
    signal: AbortSignal,
  ): Promise<{ executionCallId: string; status: ManagedToolInvocationStatus }> {
    return this.submitExecution(
      'executions',
      runtimeSessionId,
      harnessSessionId,
      reference,
      signal,
    );
  }

  async prepareExecution(
    runtimeSessionId: string,
    harnessSessionId: string,
    reference: ManagedToolInvocationReference,
    signal: AbortSignal,
  ): Promise<{ executionCallId: string; status: ManagedToolInvocationStatus }> {
    return this.submitExecution(
      'executions:prepare',
      runtimeSessionId,
      harnessSessionId,
      reference,
      signal,
    );
  }

  async startExecution(
    runtimeSessionId: string,
    harnessSessionId: string,
    executionCallId: string,
    signal: AbortSignal,
  ): Promise<ManagedToolInvocationStatus> {
    const response = await this.requestJson(
      'POST',
      `executions/${encodeURIComponent(executionCallId)}:start`,
      {
        protocolVersion: MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: randomUUID(),
        harnessSessionId,
        runtimeSessionId,
      },
      signal,
    );
    const envelope = this.parseEnvelope(
      response,
      harnessSessionId,
      runtimeSessionId,
    ) as BrokerExecutionResponse;
    if (envelope.executionCallId !== executionCallId) {
      throw new Error('Managed Runtime Broker execution identity changed.');
    }
    return parseInvocationStatus(envelope.status);
  }

  async getExecution(
    runtimeSessionId: string,
    harnessSessionId: string,
    executionCallId: string,
    afterSeq: number | undefined,
    signal: AbortSignal,
  ): Promise<ManagedToolInvocationStatus> {
    const query = new URLSearchParams({
      requestId: randomUUID(),
      harnessSessionId,
      runtimeSessionId,
    });
    if (afterSeq !== undefined) query.set('afterSeq', String(afterSeq));
    const response = await this.requestJson(
      'GET',
      `executions/${encodeURIComponent(executionCallId)}?${query}`,
      undefined,
      signal,
    );
    const envelope = this.parseEnvelope(
      response,
      harnessSessionId,
      runtimeSessionId,
    ) as BrokerExecutionResponse;
    if (envelope.executionCallId !== executionCallId) {
      throw new Error('Managed Runtime Broker execution identity changed.');
    }
    return parseInvocationStatus(envelope.status);
  }

  async cancelExecution(
    runtimeSessionId: string,
    harnessSessionId: string,
    executionCallId: string,
    signal: AbortSignal,
  ): Promise<ManagedToolInvocationStatus> {
    const response = await this.requestJson(
      'POST',
      `executions/${encodeURIComponent(executionCallId)}:cancel`,
      {
        protocolVersion: MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: randomUUID(),
        harnessSessionId,
        runtimeSessionId,
      },
      signal,
    );
    const envelope = this.parseEnvelope(
      response,
      harnessSessionId,
      runtimeSessionId,
    ) as BrokerExecutionResponse;
    if (envelope.executionCallId !== executionCallId) {
      throw new Error('Managed Runtime Broker execution identity changed.');
    }
    return parseInvocationStatus(envelope.status);
  }

  async resolveUnknownExecution(
    runtimeSessionId: string,
    harnessSessionId: string,
    executionCallId: string,
    resolution: 'confirmed_not_executed' | 'accepted_unknown',
    signal: AbortSignal,
  ): Promise<ManagedToolInvocationStatus> {
    const response = await this.requestJson(
      'POST',
      `executions/${encodeURIComponent(executionCallId)}:resolve`,
      {
        protocolVersion: MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: randomUUID(),
        harnessSessionId,
        runtimeSessionId,
        resolution,
      },
      signal,
    );
    const envelope = this.parseEnvelope(
      response,
      harnessSessionId,
      runtimeSessionId,
    ) as BrokerExecutionResponse;
    if (envelope.executionCallId !== executionCallId) {
      throw new Error('Managed Runtime Broker execution identity changed.');
    }
    return parseInvocationStatus(envelope.status);
  }

  async release(
    runtimeSessionId: string,
    harnessSessionId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const response = await this.requestJson(
      'POST',
      `tool-sessions/${encodeURIComponent(runtimeSessionId)}:release`,
      {
        protocolVersion: MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: randomUUID(),
        harnessSessionId,
      },
      signal,
    );
    const envelope = this.parseEnvelope(
      response,
      harnessSessionId,
      runtimeSessionId,
    ) as BrokerReleaseResponse;
    return envelope.released === true;
  }

  private async submitExecution(
    path: 'executions' | 'executions:prepare',
    runtimeSessionId: string,
    harnessSessionId: string,
    reference: ManagedToolInvocationReference,
    signal: AbortSignal,
  ): Promise<{ executionCallId: string; status: ManagedToolInvocationStatus }> {
    const body = {
      protocolVersion: MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION,
      requestId: randomUUID(),
      idempotencyKey: executionIdempotencyKey(harnessSessionId, reference),
      harnessSessionId,
      runtimeSessionId,
      turnId: reference.promptId,
      toolCallId: reference.callId,
      requestDigest: reference.argsDigest,
      reference,
    };
    let response: unknown;
    try {
      response = await this.requestJson('POST', path, body, signal);
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof BrokerResponseError && error.status < 500)
      ) {
        throw error;
      }
      response = await this.requestJson('POST', path, body, signal);
    }
    const envelope = this.parseEnvelope(
      response,
      harnessSessionId,
      runtimeSessionId,
    ) as BrokerExecutionResponse;
    return {
      executionCallId: boundedId(envelope.executionCallId, 'executionCallId'),
      status: parseInvocationStatus(envelope.status),
    };
  }

  private parseEnvelope(
    value: unknown,
    harnessSessionId: string,
    runtimeSessionId: string,
  ): BrokerEnvelope {
    const input = record(value);
    if (
      input['protocolVersion'] !== MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION ||
      input['harnessSessionId'] !== harnessSessionId ||
      input['runtimeSessionId'] !== runtimeSessionId
    ) {
      throw new Error('Managed Runtime Broker response identity changed.');
    }
    return input as unknown as BrokerEnvelope;
  }

  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetchImpl(
      new URL(
        `${MANAGED_RUNTIME_BROKER_ROUTE_PREFIX.slice(1)}/${path}`,
        this.baseUrl,
      ),
      {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      },
    );
    if (!response.ok) {
      let code: string | undefined;
      let retryable: boolean | undefined;
      try {
        const text = await readBoundedResponseText(
          response,
          MAX_BROKER_RESPONSE_BYTES,
        );
        const body = record(JSON.parse(text) as unknown);
        if (
          typeof body['code'] === 'string' &&
          body['code'].length > 0 &&
          body['code'].length <= 512 &&
          !body['code'].includes('\0')
        ) {
          code = body['code'];
        }
        if (typeof body['retryable'] === 'boolean') {
          retryable = body['retryable'];
        }
      } catch {
        await response.body?.cancel().catch(() => undefined);
      }
      throw new BrokerResponseError(response.status, code, retryable);
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_BROKER_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Managed Runtime Broker response exceeded its limit.');
    }
    const text = await readBoundedResponseText(
      response,
      MAX_BROKER_RESPONSE_BYTES,
    );
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('Managed Runtime Broker returned invalid JSON.');
    }
  }
}

export type BrokerManagedRuntimeProviderOptions =
  ManagedRuntimeBrokerClientOptions;

export class BrokerManagedRuntimeProvider implements ManagedRuntimeProvider {
  private readonly client: ManagedRuntimeBrokerClient;
  private readonly entries = new Map<string, BrokerEntry>();
  private readonly closedSessions = new Map<
    string,
    ManagedRuntimePrepareRequest
  >();
  private readonly lifetime = new AbortController();

  constructor(options: BrokerManagedRuntimeProviderOptions) {
    this.client = new ManagedRuntimeBrokerClient(options);
  }

  prepare(_request: ManagedRuntimePrepareRequest): ManagedRuntimeHandle {
    throw new ManagedRuntimeProviderError(
      'managed_runtime_unavailable',
      'Hosted Harness supports only the Managed Tool v2 Broker path.',
      false,
    );
  }

  async getToolV2Client(
    request: ManagedRuntimePrepareRequest,
    context?: ManagedRuntimeToolClientContext,
  ): Promise<ManagedToolV2Client> {
    this.lifetime.signal.throwIfAborted();
    const harnessSessionId = context?.harnessSessionId.trim();
    if (!harnessSessionId) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Hosted Harness Session identity is required.',
        false,
      );
    }
    const closed = this.closedSessions.get(request.sessionId);
    if (closed) {
      throw new ManagedRuntimeProviderError(
        sameManagedRuntimeIdentity(closed, request)
          ? 'managed_runtime_unavailable'
          : 'managed_runtime_identity_conflict',
        'Managed Runtime Broker Session is permanently closed.',
        false,
      );
    }
    let entry = this.entries.get(request.sessionId);
    if (
      entry &&
      (!sameManagedRuntimeIdentity(entry.request, request) ||
        entry.harnessSessionId !== harnessSessionId)
    ) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Broker Session identity changed.',
        false,
      );
    }
    if (entry?.releasing) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_unavailable',
        'Managed Runtime Broker Session is being released.',
        false,
      );
    }
    if (!entry) {
      const immutableRequest = structuredClone(request);
      const acquisition = this.client.acquire(
        immutableRequest,
        harnessSessionId,
        AbortSignal.any([
          this.lifetime.signal,
          AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
        ]),
      );
      entry = {
        request: immutableRequest,
        harnessSessionId,
        acquisition,
        executions: new Map(),
      };
      this.entries.set(request.sessionId, entry);
    }
    await entry.acquisition;
    this.lifetime.signal.throwIfAborted();
    entry.client ??= this.createToolClient(entry);
    return entry.client;
  }

  async inspectExecution(
    identity: ManagedRuntimeExecutionIdentity,
  ): Promise<ManagedRuntimeExecutionInspection> {
    this.lifetime.signal.throwIfAborted();
    try {
      const status = await this.client.getExecution(
        identity.runtimeSessionId,
        identity.harnessSessionId,
        identity.executionCallId,
        identity.afterSeq,
        AbortSignal.any([
          this.lifetime.signal,
          AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
        ]),
      );
      return { outcome: 'known', status };
    } catch (error) {
      if (
        error instanceof BrokerResponseError &&
        error.code === 'runtime_broker_execution_unknown'
      ) {
        return { outcome: 'unknown' };
      }
      throw error;
    }
  }

  async reconcileExecution(
    identity: ManagedRuntimeExecutionIdentity,
  ): Promise<ManagedRuntimeExecutionInspection> {
    this.lifetime.signal.throwIfAborted();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
    ]);
    try {
      let status = await this.client.getExecution(
        identity.runtimeSessionId,
        identity.harnessSessionId,
        identity.executionCallId,
        identity.afterSeq,
        signal,
      );
      if (status.state === 'prepared') {
        status = await this.client.startExecution(
          identity.runtimeSessionId,
          identity.harnessSessionId,
          identity.executionCallId,
          signal,
        );
      }
      while (status.state !== 'settled') {
        await delay(EXECUTION_POLL_DELAY_MS, undefined, { signal });
        status = await this.client.getExecution(
          identity.runtimeSessionId,
          identity.harnessSessionId,
          identity.executionCallId,
          undefined,
          signal,
        );
      }
      return { outcome: 'known', status };
    } catch (error) {
      if (
        error instanceof BrokerResponseError &&
        error.code === 'runtime_broker_execution_unknown'
      ) {
        return { outcome: 'unknown' };
      }
      throw error;
    }
  }

  async cancelExecution(
    identity: ManagedRuntimeExecutionIdentity,
  ): Promise<ManagedRuntimeExecutionInspection> {
    this.lifetime.signal.throwIfAborted();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
    ]);
    try {
      let status = await this.client.getExecution(
        identity.runtimeSessionId,
        identity.harnessSessionId,
        identity.executionCallId,
        identity.afterSeq,
        signal,
      );
      if (status.state !== 'settled') {
        status = await this.client.cancelExecution(
          identity.runtimeSessionId,
          identity.harnessSessionId,
          identity.executionCallId,
          signal,
        );
      }
      while (status.state !== 'settled') {
        await delay(EXECUTION_POLL_DELAY_MS, undefined, { signal });
        status = await this.client.getExecution(
          identity.runtimeSessionId,
          identity.harnessSessionId,
          identity.executionCallId,
          undefined,
          signal,
        );
      }
      return { outcome: 'known', status };
    } catch (error) {
      if (
        error instanceof BrokerResponseError &&
        error.code === 'runtime_broker_execution_unknown'
      ) {
        return { outcome: 'unknown' };
      }
      throw error;
    }
  }

  async resolveExecution(
    identity: ManagedRuntimeExecutionIdentity,
    resolution: ManagedRuntimeUnknownResolution,
  ): Promise<ManagedRuntimeExecutionInspection> {
    this.lifetime.signal.throwIfAborted();
    const status = await this.client.resolveUnknownExecution(
      identity.runtimeSessionId,
      identity.harnessSessionId,
      identity.executionCallId,
      resolution,
      AbortSignal.any([
        this.lifetime.signal,
        AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
      ]),
    );
    return { outcome: 'known', status };
  }

  async cancel(
    _sessionId: string,
    _executionId: string,
    _expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean> {
    return false;
  }

  async release(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
    options?: ManagedRuntimeReleaseOptions,
  ): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    const closed = this.closedSessions.get(sessionId);
    if (closed) {
      if (expected && !sameManagedRuntimeIdentity(closed, expected)) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime Broker Session identity changed.',
          false,
        );
      }
      return true;
    }
    if (!entry) return false;
    if (expected && !sameManagedRuntimeIdentity(entry.request, expected)) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Broker Session identity changed.',
        false,
      );
    }
    entry.releasing = true;
    if (entry.release) return entry.release;
    const release = (async () => {
      await entry.acquisition.catch(() => {});
      this.lifetime.signal.throwIfAborted();
      const released = await this.client.release(
        sessionId,
        entry.harnessSessionId,
        AbortSignal.any([
          this.lifetime.signal,
          AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
        ]),
      );
      if (released) {
        this.entries.delete(sessionId);
        if (options?.terminal === true) {
          this.closedSessions.set(sessionId, entry.request);
        }
      }
      return released;
    })().finally(() => {
      if (entry.release === release) entry.release = undefined;
    });
    entry.release = release;
    return release;
  }

  dispose(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error('Managed Runtime Broker provider disposed.'));
    this.entries.clear();
    this.closedSessions.clear();
  }

  private createToolClient(entry: BrokerEntry): ManagedToolV2Client {
    const control = (operation: Record<string, unknown>) =>
      this.client.control(
        entry.request.sessionId,
        entry.harnessSessionId,
        operation,
        AbortSignal.any([
          this.lifetime.signal,
          AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
        ]),
      );
    const ensureExecution = (
      reference: ManagedToolInvocationReference,
    ): BrokerExecution => {
      this.assertReference(entry, reference);
      const referenceDigest = managedToolDigest(reference);
      let execution = entry.executions.get(reference.invocationId);
      if (execution && execution.referenceDigest !== referenceDigest) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime Broker invocation identity changed.',
          false,
        );
      }
      if (!execution) {
        execution = {
          referenceDigest,
          reserved: this.client.prepareExecution(
            entry.request.sessionId,
            entry.harnessSessionId,
            reference,
            AbortSignal.any([
              this.lifetime.signal,
              AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
            ]),
          ),
        };
        entry.executions.set(reference.invocationId, execution);
      }
      return execution;
    };
    const readExecution = async (
      reference: ManagedToolInvocationReference,
      afterSeq?: number,
    ) => {
      const execution = ensureExecution(reference);
      const reserved = await execution.reserved;
      if (reserved.status.state === 'settled' && afterSeq === undefined) {
        return reserved.status;
      }
      return this.client.getExecution(
        entry.request.sessionId,
        entry.harnessSessionId,
        reserved.executionCallId,
        afterSeq,
        AbortSignal.any([
          this.lifetime.signal,
          AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
        ]),
      );
    };
    const startExecution = async (
      reference: ManagedToolInvocationReference,
      executionCallId?: string,
    ): Promise<ManagedToolExecutionResult> => {
      const execution = ensureExecution(reference);
      const reserved = await execution.reserved;
      if (
        executionCallId !== undefined &&
        reserved.executionCallId !== executionCallId
      ) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime Broker execution identity changed.',
          false,
        );
      }
      execution.started ??= (async () => {
        let status = await this.client.startExecution(
          entry.request.sessionId,
          entry.harnessSessionId,
          reserved.executionCallId,
          AbortSignal.any([
            this.lifetime.signal,
            AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
          ]),
        );
        while (status.state !== 'settled') {
          await delay(EXECUTION_POLL_DELAY_MS, undefined, {
            signal: this.lifetime.signal,
          });
          status = await readExecution(reference);
        }
        return parseExecutionResult(status.result);
      })();
      return execution.started;
    };
    return {
      fileHistory: {
        bind: (binding) => control({ kind: 'bind-history', binding }),
        checkpoint: (promptId) => control({ kind: 'checkpoint', promptId }),
        snapshot: () => control({ kind: 'history' }),
      },
      manifest: () => control({ kind: 'manifest' }),
      beginTurn: async (identity) => {
        await control({ kind: 'begin-turn', identity });
      },
      prepare: (identity, toolName, input, modification, mediaContext) =>
        control({
          kind: 'prepare',
          identity,
          toolName,
          input,
          ...(modification === undefined ? {} : { modification }),
          ...(mediaContext === undefined ? {} : { mediaContext }),
        }),
      confirmation: (reference) => control({ kind: 'confirmation', reference }),
      confirm: async (reference, outcome, payload, phase) => {
        await control({
          kind: 'confirm',
          reference,
          outcome,
          ...(payload === undefined ? {} : { payload }),
          ...(phase === undefined ? {} : { phase }),
        });
      },
      preflight: (reference) => control({ kind: 'preflight', reference }),
      prepareExecution: async (reference) => {
        const reserved = await ensureExecution(reference).reserved;
        return {
          executionCallId: reserved.executionCallId,
          invocationBindingId: entry.request.sessionId,
        };
      },
      startExecution: (reference, executionCallId) =>
        startExecution(reference, executionCallId),
      execute: (reference) => startExecution(reference),
      status: (reference, afterSeq) => readExecution(reference, afterSeq),
      cancel: async (reference) => {
        const reserved = await ensureExecution(reference).reserved;
        return this.client.cancelExecution(
          entry.request.sessionId,
          entry.harnessSessionId,
          reserved.executionCallId,
          AbortSignal.any([
            this.lifetime.signal,
            AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
          ]),
        );
      },
    } as ManagedToolV2Client;
  }

  private assertReference(
    entry: BrokerEntry,
    reference: ManagedToolInvocationReference,
  ): void {
    if (reference.sessionId !== entry.request.sessionId) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Broker invocation belongs to another Session.',
        false,
      );
    }
  }
}
