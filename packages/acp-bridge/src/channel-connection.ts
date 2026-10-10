/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { inspect } from 'node:util';
import {
  ClientSideConnection,
  RequestError,
  type Client,
} from '@agentclientprotocol/sdk';
import type { AcpChannel, AcpChannelTransportGuard } from './channel.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
        // The guard already retired the transport. The ACP SDK does not await
        // its message dispatcher, so throwing from toResult would be unhandled.
      }
    }
    return result;
  }
}

const MAX_LOG_SAFE_ACP_ERROR_DETAILS_CHARS = 1_024;
const MAX_LOG_SAFE_ACP_ERROR_KIND_CHARS = 128;
const MAX_LOG_SAFE_ACP_ERROR_HINT_CHARS = 512;

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
    details:
      details.length <= MAX_LOG_SAFE_ACP_ERROR_DETAILS_CHARS
        ? details
        : `${details.slice(0, MAX_LOG_SAFE_ACP_ERROR_DETAILS_CHARS)}…`,
  };
}

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

function estimateAcpHandlerBytes(value: unknown, limitBytes: number): number {
  let bytes = 0;
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null) {
      bytes += 4;
    } else if (typeof current === 'string') {
      bytes += Buffer.byteLength(current) + 2;
    } else if (typeof current === 'number') {
      bytes += 24;
    } else if (typeof current === 'boolean') {
      bytes += 5;
    } else if (Array.isArray(current)) {
      if (seen.has(current)) return limitBytes + 1;
      seen.add(current);
      bytes += 2 + Math.max(0, current.length - 1);
      if (bytes + current.length > limitBytes) return limitBytes + 1;
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push(current[index]);
      }
    } else if (isRecord(current)) {
      if (seen.has(current)) return limitBytes + 1;
      seen.add(current);
      const entries = Object.entries(current);
      bytes += 2 + Math.max(0, entries.length - 1);
      for (const [key, entryValue] of entries) {
        bytes += Buffer.byteLength(key) + 3;
        stack.push(entryValue);
      }
    } else {
      bytes += 4;
    }
    if (bytes > limitBytes) return limitBytes + 1;
  }
  return Math.max(1, bytes);
}

class AcpInboundHandlerAdmission {
  private activeHandlers = 0;
  private activeBytes = 0;

  constructor(private readonly guard: AcpChannelTransportGuard) {}

  async run<T>(params: unknown, operation: () => Promise<T>): Promise<T> {
    const envelopeBytes = Math.min(2_048, this.guard.maxActiveHandlerBytes);
    const requiredBytes =
      envelopeBytes +
      estimateAcpHandlerBytes(
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

function createLogSafeAcpClient(
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

function createOutboundGuardedConnection(
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

export function createHarnessConnection(
  client: Client,
  channel: AcpChannel,
): ClientSideConnection {
  const rawConnection = new ClientSideConnection(
    () =>
      channel.transportGuard
        ? createLogSafeAcpClient(client, channel.transportGuard)
        : client,
    channel.stream,
  );
  return channel.transportGuard
    ? createOutboundGuardedConnection(rawConnection, channel.transportGuard)
    : rawConnection;
}
