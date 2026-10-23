/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
// Type-only: under verbatimModuleSyntax an `import { type X }` still loads the
// module, and managed-tool-runtime pulls the whole Config graph into the
// serve fast path (scripts/check-serve-fast-path-bundle.js).
import type {
  ManagedToolExecutionResult,
  ManagedToolInvocationStatus,
} from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import type { ManagedToolInvocationReference } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';
import type { ManagedRuntimePrepareRequest } from './managed-runtime-protocol.js';

export const MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION = 1 as const;
export const MANAGED_RUNTIME_BROKER_ROUTE_PREFIX =
  '/internal/runtime-broker/v1' as const;

const MAX_BROKER_RESPONSE_BYTES = 8 * 1024 * 1024;

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

// Wire failures may retry; deterministic response-size failures must not.
class BrokerWireError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
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
  ) {
    super(
      `Managed Runtime Broker returned HTTP ${status}.${reason ? ` ${reason}` : ''}`,
    );
    this.name = 'BrokerResponseError';
  }
}

function canRetryBrokerRequest(error: unknown): boolean {
  if (error instanceof BrokerResponseError) {
    return error.status >= 500 && error.retryable !== false;
  }
  if (error instanceof BrokerWireError) return error.retryable;
  return true;
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

  async prepareExecution(
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
      response = await this.requestJson(
        'POST',
        'executions:prepare',
        body,
        signal,
      );
    } catch (error) {
      if (signal.aborted || !canRetryBrokerRequest(error)) {
        throw error;
      }
      response = await this.requestJson(
        'POST',
        'executions:prepare',
        body,
        signal,
      );
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
    // A declared over-limit response classifies identically on both status
    // arms: cancel it without reading a byte instead of buffering a doomed
    // error body up to the limit first.
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
    if (!response.ok) {
      let code: string | undefined;
      let retryable: boolean | undefined;
      let reason: string | undefined;
      // The read stays outside the classification try: an over-limit error
      // body keeps its size classification instead of being erased into an
      // unclassified refusal, while a merely undecodable one still falls
      // through to the status-graded BrokerResponseError below.
      const text = await readBoundedResponseText(
        response,
        MAX_BROKER_RESPONSE_BYTES,
      );
      try {
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
      } catch {
        // An undecodable or shapeless error body stays unclassified: the
        // refusal below is graded by status alone.
      }
      throw new BrokerResponseError(response.status, code, retryable, reason);
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
