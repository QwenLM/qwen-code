/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { inspect } from 'node:util';
import {
  RequestError,
  type Client,
  type ClientSideConnection,
} from '@agentclientprotocol/sdk';
import {
  NdJsonQueueLimitError,
  type NdJsonMessageObservation,
  type NdJsonStreamLimits,
} from './ndJsonStream.js';
import { estimateJsonStringBytes } from './json-string-bytes.js';

export interface AcpChannelTransportGuard {
  maxActiveHandlers: number;
  maxActiveHandlerBytes: number;
  reserveOutboundOperation(value: unknown): () => void;
  reservePreparedResponse(value: unknown): void;
  fail(error: unknown): void;
}

export interface BoundedAcpTransportSafety {
  readonly guard: AcpChannelTransportGuard;
  readonly transportFailed: Promise<unknown>;
  observeMessage(observation: NdJsonMessageObservation): void;
}

interface RetainedBudget {
  close(): void;
}

class PreparedResponseBudget implements RetainedBudget {
  private objectCharges = new WeakMap<object, number[]>();
  private readonly primitiveCharges = new Map<unknown, number[]>();
  private retainedCount = 0;
  private retainedBytes = 0;
  private closed = false;

  constructor(private readonly limits: NdJsonStreamLimits) {}

  reserve(value: unknown): void {
    if (this.closed) return;
    const charge = this.charge(value);
    const charges = this.getCharges(value, true);
    charges.push(charge);
    this.retainedCount++;
    this.retainedBytes += charge;
  }

  releaseMessage(message: unknown): void {
    if (
      !isPlainRecord(message) ||
      Object.hasOwn(message, 'method') ||
      !Object.hasOwn(message, 'id')
    ) {
      return;
    }
    const value = Object.hasOwn(message, 'result')
      ? message['result']
      : message['error'];
    const charges = this.getCharges(value, false);
    if (!charges) return;
    const charge = charges.shift();
    if (charge === undefined) return;
    if (charges.length === 0 && !isObjectValue(value)) {
      this.primitiveCharges.delete(value);
    }
    this.retainedCount--;
    this.retainedBytes -= charge;
  }

  close(): void {
    this.closed = true;
    this.objectCharges = new WeakMap<object, number[]>();
    this.primitiveCharges.clear();
    this.retainedCount = 0;
    this.retainedBytes = 0;
  }

  private charge(value: unknown): number {
    const availableBytes = Math.max(
      0,
      this.limits.maxQueuedBytes - this.retainedBytes,
    );
    const charge = estimateRetainedValueCharge(
      value,
      availableBytes,
      this.limits.maxQueuedBytes,
    );
    if (
      this.retainedCount >= this.limits.maxQueuedMessages ||
      charge > availableBytes
    ) {
      throw new NdJsonQueueLimitError(
        this.limits.maxQueuedMessages,
        this.limits.maxQueuedBytes,
        charge,
        availableBytes,
      );
    }
    return charge;
  }

  private getCharges(value: unknown, create: true): number[];
  private getCharges(value: unknown, create: false): number[] | undefined;
  private getCharges(value: unknown, create: boolean): number[] | undefined {
    const charges = isObjectValue(value)
      ? this.objectCharges.get(value)
      : this.primitiveCharges.get(value);
    if (charges || !create) return charges;
    const created: number[] = [];
    if (isObjectValue(value)) {
      this.objectCharges.set(value, created);
    } else {
      this.primitiveCharges.set(value, created);
    }
    return created;
  }
}

class OutboundOperationBudget implements RetainedBudget {
  private retainedCount = 0;
  private retainedBytes = 0;
  private generation = 0;
  private closed = false;

  constructor(private readonly limits: NdJsonStreamLimits) {}

  reserve(value: unknown): () => void {
    if (this.closed) return () => {};
    const availableBytes = Math.max(
      0,
      this.limits.maxQueuedBytes - this.retainedBytes,
    );
    const charge = estimateRetainedValueCharge(
      value,
      availableBytes,
      this.limits.maxQueuedBytes,
    );
    if (
      this.retainedCount >= this.limits.maxQueuedMessages ||
      charge > availableBytes
    ) {
      throw new NdJsonQueueLimitError(
        this.limits.maxQueuedMessages,
        this.limits.maxQueuedBytes,
        charge,
        availableBytes,
      );
    }
    this.retainedCount++;
    this.retainedBytes += charge;
    const generation = this.generation;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.closed || this.generation !== generation) return;
      this.retainedCount--;
      this.retainedBytes -= charge;
    };
  }

  close(): void {
    this.closed = true;
    this.generation++;
    this.retainedCount = 0;
    this.retainedBytes = 0;
  }
}

export function createBoundedAcpTransportSafety(
  limits: NdJsonStreamLimits,
  onFailure: (error: unknown) => void,
): BoundedAcpTransportSafety {
  const preparedResponses = new PreparedResponseBudget(limits);
  const outboundOperations = new OutboundOperationBudget(limits);
  const budgets: RetainedBudget[] = [preparedResponses, outboundOperations];
  let reportFailure: ((error: unknown) => void) | undefined;
  let failed = false;
  const transportFailed = new Promise<unknown>((resolve) => {
    reportFailure = resolve;
  });
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    for (const budget of budgets) budget.close();
    reportFailure?.(error);
    reportFailure = undefined;
    onFailure(error);
  };
  const guard: AcpChannelTransportGuard = {
    maxActiveHandlers: limits.maxQueuedMessages,
    maxActiveHandlerBytes: limits.maxQueuedBytes,
    reserveOutboundOperation: (value) => {
      try {
        return outboundOperations.reserve(value);
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    reservePreparedResponse: (value) => {
      try {
        preparedResponses.reserve(value);
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    fail,
  };
  return {
    guard,
    transportFailed,
    observeMessage: (observation) => {
      if (observation.direction === 'sent') {
        preparedResponses.releaseMessage(observation.message);
      }
    },
  };
}

function estimateRetainedValueCharge(
  value: unknown,
  availableBytes: number,
  maxBytes: number,
): number {
  const envelopeBytes = Math.min(2_048, maxBytes);
  return (
    envelopeBytes +
    estimateTransportValueBytes(
      value,
      Math.max(0, availableBytes - envelopeBytes),
    )
  );
}

type EstimationFrame =
  | { kind: 'value'; value: unknown }
  | { kind: 'array'; value: unknown[]; index: number }
  | {
      kind: 'record';
      value: Record<string, unknown>;
      keys: Generator<string, void, unknown>;
      first: boolean;
    };

function* enumerableOwnKeys(
  value: Record<string, unknown>,
): Generator<string, void, unknown> {
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield key;
  }
}

export function estimateTransportValueBytes(
  value: unknown,
  limitBytes: number,
): number {
  let bytes = 0;
  const stack: EstimationFrame[] = [{ kind: 'value', value }];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'array') {
      if (frame.index >= frame.value.length) continue;
      if (frame.index > 0) bytes++;
      if (bytes > limitBytes) return limitBytes + 1;
      const descriptor = Object.getOwnPropertyDescriptor(
        frame.value,
        String(frame.index),
      );
      if (descriptor?.get || descriptor?.set) return limitBytes + 1;
      stack.push({ ...frame, index: frame.index + 1 });
      stack.push({ kind: 'value', value: descriptor?.value });
      continue;
    }
    if (frame.kind === 'record') {
      const next = frame.keys.next();
      if (next.done) continue;
      const descriptor = Object.getOwnPropertyDescriptor(
        frame.value,
        next.value,
      );
      if (!descriptor || descriptor.get || descriptor.set) {
        return limitBytes + 1;
      }
      bytes +=
        (frame.first ? 0 : 1) +
        estimateJsonStringBytes(next.value, Math.max(0, limitBytes - bytes)) +
        1;
      if (bytes > limitBytes) return limitBytes + 1;
      stack.push({ ...frame, first: false });
      stack.push({ kind: 'value', value: descriptor.value });
      continue;
    }
    const current = frame.value;
    if (current === null || current === undefined) {
      bytes += 4;
    } else if (typeof current === 'string') {
      bytes += estimateJsonStringBytes(
        current,
        Math.max(0, limitBytes - bytes),
      );
    } else if (typeof current === 'number') {
      bytes += 24;
    } else if (typeof current === 'boolean') {
      bytes += 5;
    } else if (Array.isArray(current)) {
      if (seen.has(current) || Object.hasOwn(current, 'toJSON')) {
        return limitBytes + 1;
      }
      seen.add(current);
      bytes += 2;
      stack.push({ kind: 'array', value: current, index: 0 });
    } else if (isPlainRecord(current)) {
      if (seen.has(current) || Object.hasOwn(current, 'toJSON')) {
        return limitBytes + 1;
      }
      seen.add(current);
      bytes += 2;
      stack.push({
        kind: 'record',
        value: current,
        keys: enumerableOwnKeys(current),
        first: true,
      });
    } else {
      return limitBytes + 1;
    }
    if (bytes > limitBytes) return limitBytes + 1;
  }
  return Math.max(1, bytes);
}

function isObjectValue(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObjectValue(value) && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObjectValue(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

class AcpInboundHandlerLimitError extends Error {
  readonly code = 'acp_handler_limit_exceeded';

  constructor(
    readonly maxActiveHandlers: number,
    readonly maxActiveHandlerBytes: number,
    readonly requiredBytes: number,
    readonly availableBytes: number,
  ) {
    super('ACP inbound handler capacity exceeded');
    this.name = 'AcpInboundHandlerLimitError';
  }
}

class AcpInboundHandlerAdmission {
  private activeHandlers = 0;
  private activeBytes = 0;

  constructor(private readonly guard: AcpChannelTransportGuard) {}

  async run<T>(params: unknown, operation: () => Promise<T>): Promise<T> {
    const envelopeBytes = Math.min(2_048, this.guard.maxActiveHandlerBytes);
    const requiredBytes =
      envelopeBytes +
      estimateTransportValueBytes(
        params,
        Math.max(0, this.guard.maxActiveHandlerBytes - envelopeBytes),
      );
    const availableBytes = Math.max(
      0,
      this.guard.maxActiveHandlerBytes - this.activeBytes,
    );
    if (
      this.activeHandlers >= this.guard.maxActiveHandlers ||
      requiredBytes > availableBytes
    ) {
      const error = new AcpInboundHandlerLimitError(
        this.guard.maxActiveHandlers,
        this.guard.maxActiveHandlerBytes,
        requiredBytes,
        availableBytes,
      );
      this.guard.fail(error);
      throw error;
    }
    this.activeHandlers++;
    this.activeBytes += requiredBytes;
    try {
      return await operation();
    } finally {
      this.activeHandlers--;
      this.activeBytes -= requiredBytes;
    }
  }
}

class LogSafeAcpRequestError extends RequestError {
  constructor(
    code: number,
    message: string,
    data: unknown,
    private readonly reservePreparedResponse?: (value: unknown) => void,
  ) {
    super(code, message, data);
  }

  override toResult<T>() {
    const result = super.toResult<T>();
    if ('error' in result) {
      Object.defineProperty(result.error, inspect.custom, {
        configurable: true,
        value: () => ({ code: result.error.code, payloadOmitted: true }),
      });
      try {
        this.reservePreparedResponse?.(result.error);
      } catch {
        // The failure path has already retired the transport. Throwing here
        // would escape the ACP SDK's unawaited message dispatcher.
      }
    }
    return result;
  }
}

const MAX_LOG_SAFE_ACP_ERROR_DETAILS_CHARS = 1_024;
const MAX_LOG_SAFE_ACP_ERROR_KIND_CHARS = 128;
const MAX_LOG_SAFE_ACP_ERROR_HINT_CHARS = 512;

function boundedAcpErrorString(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function logSafeRequestErrorMessage(code: number): string {
  switch (code) {
    case -32700:
      return 'Parse error';
    case -32600:
      return 'Invalid request';
    case -32601:
      return 'Method not found';
    case -32602:
      return 'Invalid params';
    case -32603:
      return 'Internal error';
    case -32000:
      return 'Authentication required';
    case -32002:
      return 'Resource not found';
    default:
      return 'ACP client request failed';
  }
}

function logSafeRequestErrorData(data: unknown): unknown {
  if (!isRecord(data) || typeof data['errorKind'] !== 'string') {
    return undefined;
  }
  const status = data['status'];
  const hint = data['hint'];
  return {
    errorKind: boundedAcpErrorString(
      data['errorKind'],
      MAX_LOG_SAFE_ACP_ERROR_KIND_CHARS,
    ),
    ...(typeof status === 'number' && Number.isFinite(status)
      ? { status }
      : {}),
    ...(typeof hint === 'string'
      ? {
          hint: boundedAcpErrorString(hint, MAX_LOG_SAFE_ACP_ERROR_HINT_CHARS),
        }
      : {}),
  };
}

function logSafeAcpErrorDetails(
  error: unknown,
): { details: string } | undefined {
  const details =
    error instanceof Error
      ? error.message
      : isRecord(error) && typeof error['message'] === 'string'
        ? error['message']
        : undefined;
  if (!details) return undefined;
  return {
    details: boundedAcpErrorString(
      details,
      MAX_LOG_SAFE_ACP_ERROR_DETAILS_CHARS,
    ),
  };
}

async function withLogSafeAcpError<T>(
  operation: () => Promise<T>,
  reservePreparedResponse?: (value: unknown) => void,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RequestError) {
      const code = Number.isFinite(error.code) ? error.code : -32603;
      throw new LogSafeAcpRequestError(
        code,
        logSafeRequestErrorMessage(code),
        logSafeRequestErrorData(error.data),
        reservePreparedResponse,
      );
    }
    throw new LogSafeAcpRequestError(
      -32603,
      'Internal error',
      logSafeAcpErrorDetails(error),
      reservePreparedResponse,
    );
  }
}

export function createLogSafeAcpClient(
  client: Client,
  transportGuard: AcpChannelTransportGuard,
): Client {
  const admission = new AcpInboundHandlerAdmission(transportGuard);
  const runNotification = <T>(params: unknown, operation: () => Promise<T>) =>
    withLogSafeAcpError(() => admission.run(params, operation));
  const runRequest = <T>(params: unknown, operation: () => Promise<T>) =>
    withLogSafeAcpError(
      () =>
        admission.run(params, async () => {
          const result = await operation();
          transportGuard.reservePreparedResponse(result ?? null);
          return result;
        }),
      transportGuard.reservePreparedResponse,
    );
  return {
    requestPermission: (params) =>
      runRequest(params, () => client.requestPermission(params)),
    sessionUpdate: (params) =>
      runNotification(params, () => client.sessionUpdate(params)),
    writeTextFile: client.writeTextFile
      ? (params) => runRequest(params, () => client.writeTextFile!(params))
      : undefined,
    readTextFile: client.readTextFile
      ? (params) => runRequest(params, () => client.readTextFile!(params))
      : undefined,
    createTerminal: client.createTerminal
      ? (params) => runRequest(params, () => client.createTerminal!(params))
      : undefined,
    terminalOutput: client.terminalOutput
      ? (params) => runRequest(params, () => client.terminalOutput!(params))
      : undefined,
    releaseTerminal: client.releaseTerminal
      ? (params) =>
          runRequest(
            params,
            async () => (await client.releaseTerminal!(params)) ?? {},
          )
      : undefined,
    waitForTerminalExit: client.waitForTerminalExit
      ? (params) =>
          runRequest(params, () => client.waitForTerminalExit!(params))
      : undefined,
    killTerminal: client.killTerminal
      ? (params) =>
          runRequest(
            params,
            async () => (await client.killTerminal!(params)) ?? {},
          )
      : undefined,
    extMethod: client.extMethod
      ? (method, params) =>
          runRequest(params, () => client.extMethod!(method, params))
      : undefined,
    extNotification: client.extNotification
      ? (method, params) =>
          runNotification(params, () => client.extNotification!(method, params))
      : undefined,
  };
}

const OUTBOUND_GUARDED_CONNECTION_METHODS = new Set<PropertyKey>([
  'initialize',
  'newSession',
  'loadSession',
  'unstable_forkSession',
  'unstable_listSessions',
  'unstable_resumeSession',
  'setSessionMode',
  'unstable_setSessionModel',
  'setSessionConfigOption',
  'authenticate',
  'prompt',
  'cancel',
  'extMethod',
  'extNotification',
]);

export function createOutboundGuardedConnection(
  connection: ClientSideConnection,
  transportGuard: AcpChannelTransportGuard,
): ClientSideConnection {
  const wrappers = new Map<
    PropertyKey,
    (...args: unknown[]) => Promise<unknown>
  >();
  return new Proxy(connection, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (
        typeof value !== 'function' ||
        !OUTBOUND_GUARDED_CONNECTION_METHODS.has(property)
      ) {
        return value;
      }
      let wrapper = wrappers.get(property);
      if (!wrapper) {
        wrapper = async (...args: unknown[]) => {
          const release = transportGuard.reserveOutboundOperation(args);
          try {
            return await Reflect.apply(value, target, args);
          } finally {
            release();
          }
        };
        wrappers.set(property, wrapper);
      }
      return wrapper;
    },
  });
}
