/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
// Type-only: under verbatimModuleSyntax an `import { type X }` still loads the
// module, and managed-tool-runtime pulls the whole Config graph into the
// serve fast path (scripts/check-serve-fast-path-bundle.js).
import type {
  ManagedToolExecutionResult,
  ManagedToolInvocationStatus,
  ManagedToolV2Client,
} from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import {
  managedToolDigest,
  parseManagedToolInvocationReference,
  type ManagedToolInvocationReference,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';

export { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';
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
import {
  parseManagedRuntimeProviderOperation,
  parseManagedRuntimeProviderResult,
  type ManagedRuntimeProviderControl,
} from './managed-runtime-provider-protocol.js';

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
  acquisitionFailed?: boolean;
  readonly executions: Map<string, BrokerExecution>;
  readonly failedDigests: Map<string, BrokerExecutionFailure>;
  client?: ManagedToolV2Client;
  release?: Promise<boolean>;
  releasing?: boolean;
  terminal?: boolean;
}

interface BrokerExecution {
  readonly referenceDigest: string;
  readonly reserved: Promise<{
    executionCallId: string;
    status: ManagedToolInvocationStatus;
  }>;
  started?: Promise<ManagedToolExecutionResult>;
}

interface BrokerExecutionFailure {
  readonly referenceDigest: string;
  readonly error: unknown;
  readonly executionCallId?: string;
}

// Eviction is for failures a retry can outrun: a 5xx the Broker did not
// declare permanent, a 4xx it explicitly marked retryable, a reconcilable
// (non-abandoned) execution_unknown, a transport failure (timeout, abort,
// network), or a response whose body could not be decoded — an LB drain page
// or a truncated reply is a transport-shaped fault the next request can
// answer correctly. Everything else — a declared refusal, an unclassified
// 4xx, a decoded-but-invalid envelope, or an over-limit body — cannot produce
// a different answer within the session, so it stays cached and later calls
// replay it instead of re-driving a doomed prepare/start cycle.
function isTransientBrokerFailure(error: unknown): boolean {
  if (error instanceof BrokerResponseError) {
    // execution_unknown is non-terminal unless the Broker marked it
    // abandoned: the record can still reconcile to settled, so the
    // invocation re-drives instead of replaying the 409 for the session's
    // life. The abandoned (terminal runtime_lost) variant stays cached.
    if (error.code === 'runtime_broker_execution_unknown' && !error.abandoned)
      return true;
    return error.status >= 500
      ? error.retryable !== false
      : error.retryable === true;
  }
  if (error instanceof BrokerWireError) return error.retryableByRedrive;
  return error instanceof TypeError || error instanceof DOMException;
}

// A response the client could not decode at all. An undecodable body (an LB
// drain page, a truncated reply) is transport-shaped: the next request can
// answer correctly, so it retries by re-drive. An over-limit body is a
// deterministic property of the response — re-driving it transfers the same
// bytes to the same refusal — so it stays cached like a declared refusal.
class BrokerWireError extends Error {
  constructor(
    message: string,
    readonly retryableByRedrive: boolean,
  ) {
    super(message);
    this.name = 'BrokerWireError';
  }
}

class BrokerResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly retryable?: boolean,
    reason?: string,
    readonly abandoned = false,
  ) {
    super(
      `Managed Runtime Broker returned HTTP ${status}.${reason ? ` ${reason}` : ''}`,
    );
    this.name = 'BrokerResponseError';
  }
}

export interface ManagedRuntimeBrokerClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
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
        throw new BrokerWireError(
          'Managed Runtime Broker response exceeded its limit.',
          false,
        );
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
    .update('\0')
    .update(reference.invocationId)
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
        (error instanceof BrokerResponseError &&
          (error.status < 500 || error.retryable === false)) ||
        (error instanceof BrokerWireError && !error.retryableByRedrive)
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
      let reason: string | undefined;
      let abandoned = false;
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
        // The Broker's envelope is error, code and retryable, plus details
        // when there are any (a terminal ABANDONED answer carries them).
        const details = body['details'];
        if (
          code !== undefined &&
          typeof body['retryable'] === 'boolean' &&
          Object.keys(body).filter((key) => key !== 'details').length === 3 &&
          (details === undefined ||
            (details !== null &&
              typeof details === 'object' &&
              !Array.isArray(details))) &&
          response.headers
            .get('content-type')
            ?.split(';')[0]
            .trim()
            .toLowerCase() === 'application/json' &&
          typeof body['error'] === 'string' &&
          body['error'].length > 0 &&
          body['error'].length <= 4096 &&
          !body['error'].includes('\0')
        ) {
          reason = body['error'];
        }
        if (typeof body['retryable'] === 'boolean') {
          retryable = body['retryable'];
        }
        if (body['details'] !== undefined) {
          const details = record(body['details']);
          abandoned =
            code === 'runtime_broker_execution_unknown' &&
            details['terminal'] === true &&
            details['reason'] === 'runtime_lost';
        }
      } catch (error) {
        // An over-limit error body keeps its size classification: the limit
        // is a deterministic property of the response, so it must stay
        // cached rather than be re-driven as an unclassified failure.
        if (error instanceof BrokerWireError) throw error;
        await response.body?.cancel().catch(() => undefined);
      }
      throw new BrokerResponseError(
        response.status,
        code,
        retryable,
        reason,
        abandoned,
      );
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_BROKER_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new BrokerWireError(
        'Managed Runtime Broker response exceeded its limit.',
        false,
      );
    }
    const text = await readBoundedResponseText(
      response,
      MAX_BROKER_RESPONSE_BYTES,
    );
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BrokerWireError(
        'Managed Runtime Broker returned invalid JSON.',
        true,
      );
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
    if (entry?.acquisitionFailed) {
      this.entries.delete(request.sessionId);
      entry = undefined;
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
        failedDigests: new Map(),
      };
      this.entries.set(request.sessionId, entry);
      const acquiredEntry = entry;
      void acquisition.catch(() => {
        acquiredEntry.acquisitionFailed = true;
      });
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
        return error.abandoned
          ? { outcome: 'unknown', terminal: true, reason: 'runtime_lost' }
          : { outcome: 'unknown' };
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
        return error.abandoned
          ? { outcome: 'unknown', terminal: true, reason: 'runtime_lost' }
          : { outcome: 'unknown' };
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
        return error.abandoned
          ? { outcome: 'unknown', terminal: true, reason: 'runtime_lost' }
          : { outcome: 'unknown' };
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
    this.lifetime.signal.throwIfAborted();
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
    entry.terminal ||= options?.terminal === true;
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
      if (released !== true) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_unavailable',
          `Managed Runtime Broker did not confirm Session release for ${sessionId}.`,
          true,
        );
      }
      this.entries.delete(sessionId);
      if (entry.terminal) {
        this.closedSessions.set(sessionId, entry.request);
      }
      return true;
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
    const assertEntry = (allowDraining = false) => {
      this.lifetime.signal.throwIfAborted();
      if (
        this.entries.get(entry.request.sessionId) !== entry ||
        (!allowDraining && entry.releasing)
      ) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_unavailable',
          'Managed Runtime Broker Session is being released or is closed.',
          false,
        );
      }
    };
    const control = async (operation: ManagedRuntimeProviderControl) => {
      assertEntry(operation.kind === 'history');
      const session = {
        harnessSessionId: entry.harnessSessionId,
        runtimeSessionId: entry.request.sessionId,
        turnKind: entry.request.turnKind,
      };
      const parsed = parseManagedRuntimeProviderOperation(operation, session);
      return parseManagedRuntimeProviderResult(
        parsed,
        await this.client.control(
          entry.request.sessionId,
          entry.harnessSessionId,
          parsed,
          AbortSignal.any([
            this.lifetime.signal,
            AbortSignal.timeout(BROKER_REQUEST_TIMEOUT_MS),
          ]),
        ),
        session,
      );
    };
    const ensureExecution = (
      reference: ManagedToolInvocationReference,
    ): BrokerExecution => {
      assertEntry();
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
      const failed = entry.failedDigests.get(reference.invocationId);
      if (failed !== undefined && failed.referenceDigest !== referenceDigest) {
        throw new ManagedRuntimeProviderError(
          'managed_runtime_identity_conflict',
          'Managed Runtime Broker invocation identity changed.',
          false,
        );
      }
      if (!execution) {
        assertEntry();
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
        const retained = execution;
        // A transiently rejected reservation must not be cached forever: the
        // next attempt re-prepares under the stable idempotency key. The
        // eviction drops the recorded digest with it, so keep it tombstoned
        // or a changed-args retry would pass the identity check on an empty
        // cache.
        void retained.reserved.catch((error: unknown) => {
          if (!isTransientBrokerFailure(error)) {
            // The Broker refused a retry, or the failure is deterministic:
            // keep it cached instead of re-sending it on every later call.
            return;
          }
          if (entry.executions.get(reference.invocationId) === retained) {
            entry.executions.delete(reference.invocationId);
            // A prior eviction may already have recorded the Broker-side
            // call id (a failed start): the read-only cancel/status path
            // still needs it to reach the receipt, so never overwrite it
            // away. The digests always match here — ensureExecution refused
            // a changed-digest re-drive before this execution existed.
            const prior = entry.failedDigests.get(reference.invocationId);
            entry.failedDigests.set(reference.invocationId, {
              referenceDigest: retained.referenceDigest,
              error,
              ...(prior?.executionCallId === undefined
                ? {}
                : { executionCallId: prior.executionCallId }),
            });
          }
        });
      }
      return execution;
    };
    // Read-only resolution for status/cancel: a read must never create a
    // reservation, so an invocation that is not cached surfaces its recorded
    // failure, or keeps answering by the call id its reservation produced
    // before a transient failure evicted it.
    const resolveReadOnlyExecution = (
      reference: ManagedToolInvocationReference,
    ):
      | { readonly execution: BrokerExecution }
      | { readonly executionCallId: string } => {
      assertEntry(true);
      this.assertReference(entry, reference);
      const referenceDigest = managedToolDigest(reference);
      const execution = entry.executions.get(reference.invocationId);
      if (execution !== undefined) {
        if (execution.referenceDigest !== referenceDigest) {
          throw new ManagedRuntimeProviderError(
            'managed_runtime_identity_conflict',
            'Managed Runtime Broker invocation identity changed.',
            false,
          );
        }
        return { execution };
      }
      const failed = entry.failedDigests.get(reference.invocationId);
      if (failed !== undefined) {
        if (failed.referenceDigest !== referenceDigest) {
          throw new ManagedRuntimeProviderError(
            'managed_runtime_identity_conflict',
            'Managed Runtime Broker invocation identity changed.',
            false,
          );
        }
        if (failed.executionCallId !== undefined) {
          return { executionCallId: failed.executionCallId };
        }
        throw failed.error;
      }
      throw new ManagedRuntimeProviderError(
        'managed_runtime_unavailable',
        'Managed Runtime Broker execution is unknown to this Session.',
        true,
      );
    };
    const readExecution = async (
      reference: ManagedToolInvocationReference,
      afterSeq?: number,
    ) => {
      const resolved = resolveReadOnlyExecution(reference);
      let executionCallId: string;
      if ('execution' in resolved) {
        const reserved = await resolved.execution.reserved;
        if (reserved.status.state === 'settled' && afterSeq === undefined) {
          return reserved.status;
        }
        executionCallId = reserved.executionCallId;
      } else {
        executionCallId = resolved.executionCallId;
      }
      return this.client.getExecution(
        entry.request.sessionId,
        entry.harnessSessionId,
        executionCallId,
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
        try {
          assertEntry();
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
        } catch (error) {
          // A transiently rejected start must not be cached forever either:
          // re-execution re-prepares under the stable idempotency key, with
          // the failed digest tombstoned for the same reason as the
          // reservation. Evicting here — inside the continuation that
          // settles `started` — guarantees a caller retrying off the
          // rejection already finds the cache empty; an async handler
          // attached beside it would resume only after that retry replayed
          // the stale rejection. The reservation resolved before this IIFE
          // ran, so the call id is in scope for the tombstone: without it a
          // draining cancel/status could no longer reach the receipt.
          if (
            isTransientBrokerFailure(error) &&
            entry.executions.get(reference.invocationId) === execution
          ) {
            entry.executions.delete(reference.invocationId);
            entry.failedDigests.set(reference.invocationId, {
              referenceDigest: execution.referenceDigest,
              error,
              executionCallId: reserved.executionCallId,
            });
          }
          throw error;
        }
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
        const resolved = resolveReadOnlyExecution(reference);
        const executionCallId =
          'execution' in resolved
            ? (await resolved.execution.reserved).executionCallId
            : resolved.executionCallId;
        return this.client.cancelExecution(
          entry.request.sessionId,
          entry.harnessSessionId,
          executionCallId,
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
    parseManagedToolInvocationReference(reference);
    if (reference.sessionId !== entry.request.sessionId) {
      throw new ManagedRuntimeProviderError(
        'managed_runtime_identity_conflict',
        'Managed Runtime Broker invocation belongs to another Session.',
        false,
      );
    }
  }
}
