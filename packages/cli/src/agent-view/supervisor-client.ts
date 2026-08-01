/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Readable, Writable } from 'node:stream';
import * as net from 'node:net';
import { AGENT_VIEW_PROTOCOL_VERSION } from './protocol.js';
import type {
  AgentViewSessionSnapshot,
  AgentViewWorkerControlEvent,
  AgentViewWorkerEvent,
} from './protocol.js';
import { bridgeAgentViewTerminal } from './terminal-bridge.js';
import type { AgentViewTerminalBytes } from './terminal-bridge.js';

export type AgentViewSupervisorOperation =
  | 'status'
  | 'list'
  | 'subscribe'
  | 'shutdown'
  | 'dispatch'
  | 'adopt'
  | 'workerEvent'
  | 'workerControl'
  | 'attachStream'
  | 'resize'
  | 'peek'
  | 'send'
  | 'answer'
  | 'logs'
  | 'stop'
  | 'kill'
  | 'respawn'
  | 'remove'
  | 'pin'
  | 'rename';

export interface AgentViewSupervisorRequest {
  id: string;
  protocolVersion?: number;
  authToken?: string;
  op: AgentViewSupervisorOperation;
  params?: Record<string, unknown>;
}

export type AgentViewSupervisorResponse =
  | {
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      id: string;
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export interface AgentViewSupervisorClientOptions {
  timeoutMs?: number;
  authToken?: string;
}

export interface AgentViewSupervisorSubscriptionOptions
  extends AgentViewSupervisorClientOptions {
  onError?: (error: Error) => void;
}

export interface AgentViewSupervisorAdoptParams
  extends Record<string, unknown> {
  sessionId: string;
  projectCwd: string;
  activeCwd: string;
  approvalMode?: string;
  sandbox?: string;
  terminal: {
    columns: number;
    rows: number;
  };
}

export interface AgentViewSupervisorRequestMap {
  status: undefined;
  list: { cwd?: string } | undefined;
  subscribe: undefined;
  shutdown: { keepWorkers?: boolean } | undefined;
  dispatch: { prompt: string; cwd: string };
  adopt: AgentViewSupervisorAdoptParams;
  workerEvent: AgentViewWorkerEvent & { token?: string };
  workerControl: { sessionId: string; token?: string };
  attachStream: { sessionId: string };
  resize: { sessionId: string; columns: number; rows: number };
  peek: { sessionId: string };
  send: { sessionId: string; text: string };
  answer: { sessionId: string; text: string };
  logs: { sessionId: string };
  stop: { sessionId: string };
  kill: { sessionId: string };
  respawn: { sessionId: string } | { all: true };
  remove: { sessionId: string };
  pin: { sessionId: string; pinned?: boolean };
  rename: { sessionId: string; displayName: string };
}

export interface AgentViewSupervisorResponseMap {
  status: unknown;
  list: AgentViewSessionSnapshot[];
  subscribe: { subscribed: true };
  shutdown: unknown;
  dispatch: unknown;
  adopt: unknown;
  workerEvent: unknown;
  workerControl: {
    sessionId: string;
    events: AgentViewWorkerControlEvent[];
  };
  attachStream: unknown;
  resize: unknown;
  peek: unknown;
  send: unknown;
  answer: unknown;
  logs: unknown;
  stop: unknown;
  kill: unknown;
  respawn: unknown;
  remove: unknown;
  pin: unknown;
  rename: unknown;
}

type AgentViewSupervisorCallArgs<Op extends AgentViewSupervisorOperation> =
  undefined extends AgentViewSupervisorRequestMap[Op]
    ? [
        params?: AgentViewSupervisorRequestMap[Op],
        options?: AgentViewSupervisorClientOptions,
      ]
    : [
        params: AgentViewSupervisorRequestMap[Op],
        options?: AgentViewSupervisorClientOptions,
      ];

export interface AgentViewSupervisorAttachOptions {
  stdin?: Readable | AsyncIterable<AgentViewTerminalBytes>;
  stdout?: Writable;
  rawMode?: boolean;
  timeoutMs?: number;
  authToken?: string;
}

export interface AgentViewSupervisorSubscription {
  dispose(): void;
}

export interface AgentViewSupervisorEvent {
  type: 'changed';
  at: string;
}

export class AgentViewSupervisorClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AgentViewSupervisorClientError';
  }
}

export async function requestAgentViewSupervisor(
  socketPath: string,
  request: AgentViewSupervisorRequest,
  options: AgentViewSupervisorClientOptions = {},
): Promise<AgentViewSupervisorResponse> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const requestWithProtocol = {
    ...request,
    protocolVersion: request.protocolVersion ?? AGENT_VIEW_PROTOCOL_VERSION,
  };
  if (options.authToken && requestWithProtocol.authToken === undefined) {
    requestWithProtocol.authToken = options.authToken;
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const timeout = setTimeout(() => {
      finish(
        undefined,
        new AgentViewSupervisorClientError(
          'Timed out waiting for Agent View supervisor response.',
          'timeout',
        ),
      );
      socket.destroy();
    }, timeoutMs);

    const finish = (
      response: AgentViewSupervisorResponse | undefined,
      error?: Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      if (error) {
        reject(error);
      } else {
        resolve(response as AgentViewSupervisorResponse);
      }
    };

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(requestWithProtocol)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;

      const line = buffer.slice(0, newline);
      try {
        finish(parseSupervisorResponse(line));
      } catch (error) {
        finish(undefined, error as Error);
      } finally {
        socket.end();
      }
    });
    socket.on('error', (error) => finish(undefined, error));
    socket.on('end', () => {
      finish(
        undefined,
        new AgentViewSupervisorClientError(
          'Agent View supervisor closed before sending a response.',
          'closed',
        ),
      );
    });
  });
}

export async function callAgentViewSupervisor<
  Op extends AgentViewSupervisorOperation,
>(
  socketPath: string,
  op: Op,
  ...args: AgentViewSupervisorCallArgs<Op>
): Promise<AgentViewSupervisorResponseMap[Op]> {
  const params = args[0] as Record<string, unknown> | undefined;
  const options = args[1];
  const response = await requestAgentViewSupervisor(
    socketPath,
    {
      id: createRequestId(),
      op,
      ...(params ? { params } : {}),
    },
    options,
  );
  if (response.ok) return response.result as AgentViewSupervisorResponseMap[Op];
  throw new AgentViewSupervisorClientError(
    response.error.message,
    response.error.code,
  );
}

export async function attachAgentViewSupervisorTerminal(
  socketPath: string,
  sessionId: string,
  options: AgentViewSupervisorAttachOptions = {},
): Promise<unknown> {
  const socket = net.createConnection(socketPath);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const request: AgentViewSupervisorRequest = {
    id: createRequestId(),
    protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
    ...(options.authToken ? { authToken: options.authToken } : {}),
    op: 'attachStream',
    params: { sessionId },
  };
  try {
    const { response, leftover } = await openAttachStream(socket, request, {
      timeoutMs: options.timeoutMs ?? 30_000,
    });
    if (!response.ok) {
      throw new AgentViewSupervisorClientError(
        response.error.message,
        response.error.code,
      );
    }

    const controller = new AbortController();
    socket.once('close', () => controller.abort());
    socket.on('error', () => {});

    if (leftover.length > 0) {
      socket.pause();
      await writeToWritable(stdout, leftover);
    }

    const restoreRawMode = setRawMode(stdin, options.rawMode ?? true);
    try {
      return await bridgeAgentViewTerminal({
        stdin,
        stdout,
        pty: {
          write(data) {
            socket.write(data);
          },
          onData(callback) {
            socket.on('data', callback);
            socket.resume();
            return {
              dispose: () => {
                socket.off('data', callback);
              },
            };
          },
          pause() {
            socket.pause();
          },
          resume() {
            socket.resume();
          },
          resize: (size) => {
            void callAgentViewSupervisor(
              socketPath,
              'resize',
              {
                sessionId,
                columns: size.columns,
                rows: size.rows,
              },
              options.authToken ? { authToken: options.authToken } : undefined,
            ).catch(() => {});
          },
        },
        detachSignal: controller.signal,
        onResize: createResizeSource(stdout),
      });
    } finally {
      restoreRawMode();
    }
  } finally {
    socket.destroy();
  }
}

export function subscribeAgentViewSupervisor(
  socketPath: string,
  onEvent: (event: AgentViewSupervisorEvent) => void,
  options: AgentViewSupervisorSubscriptionOptions = {},
): AgentViewSupervisorSubscription {
  const socket = net.createConnection(socketPath);
  let buffer = '';
  let subscribed = false;
  let disposed = false;
  let errorNotified = false;
  const request: AgentViewSupervisorRequest = {
    id: createRequestId(),
    protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
    ...(options.authToken ? { authToken: options.authToken } : {}),
    op: 'subscribe',
  };

  const handshakeTimeout = setTimeout(() => {
    notifySubscriptionError(
      new AgentViewSupervisorClientError(
        'Timed out waiting for Agent View subscription handshake.',
        'timeout',
      ),
    );
    socket.destroy();
  }, options.timeoutMs ?? 5000);

  socket.setEncoding('utf8');
  socket.on('connect', () => {
    socket.write(`${JSON.stringify(request)}\n`);
  });
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      if (!subscribed) {
        let response: AgentViewSupervisorResponse;
        try {
          response = parseSupervisorResponse(line);
        } catch (parseError) {
          notifySubscriptionError(
            new AgentViewSupervisorClientError(
              `Invalid subscription response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
              'invalid_response',
            ),
          );
          socket.destroy();
          return;
        }
        if (!response.ok) {
          notifySubscriptionError(
            new AgentViewSupervisorClientError(
              response.error.message,
              response.error.code,
            ),
          );
          socket.destroy();
          return;
        }
        subscribed = true;
        clearTimeout(handshakeTimeout);
        continue;
      }

      let event: AgentViewSupervisorEvent | undefined;
      try {
        event = parseSupervisorEvent(line);
      } catch {
        continue;
      }
      if (event) {
        try {
          onEvent(event);
        } catch {
          // Keep malformed subscribers from crashing the socket reader.
        }
      }
    }
  });
  socket.on('error', (error) => notifySubscriptionError(error));
  socket.on('close', () => {
    clearTimeout(handshakeTimeout);
    notifySubscriptionError(
      new AgentViewSupervisorClientError(
        'Agent View supervisor subscription closed.',
        'closed',
      ),
    );
  });

  return {
    dispose() {
      disposed = true;
      clearTimeout(handshakeTimeout);
      socket.destroy();
    },
  };

  function notifySubscriptionError(error: Error): void {
    if (disposed || errorNotified) return;
    errorNotified = true;
    options.onError?.(error);
  }
}

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function openAttachStream(
  socket: net.Socket,
  request: AgentViewSupervisorRequest,
  options: AgentViewSupervisorClientOptions = {},
): Promise<{ response: AgentViewSupervisorResponse; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      finishWithError(
        new AgentViewSupervisorClientError(
          'Timed out waiting for Agent View attach response.',
          'timeout',
        ),
      );
      socket.destroy();
    }, options.timeoutMs ?? 30_000);
    timeout.unref?.();
    const finish = (
      result: { response: AgentViewSupervisorResponse; leftover: Buffer },
      error?: Error,
    ) => {
      if (settled) return;
      settled = true;
      socket.off('connect', onConnect);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const onConnect = () => {
      socket.write(`${JSON.stringify(request)}\n`);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const newline = buffer.indexOf(10);
      if (newline === -1) return;
      try {
        finish({
          response: parseSupervisorResponse(
            buffer.subarray(0, newline).toString('utf8'),
          ),
          leftover: buffer.subarray(newline + 1),
        });
      } catch (error) {
        finishWithError(error as Error);
      }
    };
    const onError = (error: Error) => {
      finishWithError(error);
    };
    const onEnd = () => {
      finishWithError(
        new AgentViewSupervisorClientError(
          'Agent View supervisor closed before attach handshake.',
          'closed',
        ),
      );
    };
    const finishWithError = (error: Error) => {
      finish(
        {
          response: {
            id: request.id,
            ok: false,
            error: { code: 'error', message: error.message },
          },
          leftover: Buffer.alloc(0),
        },
        error,
      );
    };
    socket.on('connect', onConnect);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

function setRawMode(
  stdin: Readable | AsyncIterable<AgentViewTerminalBytes>,
  enabled: boolean,
): () => void {
  const maybeTty = stdin as {
    isTTY?: boolean;
    setRawMode?: (raw: boolean) => void;
  };
  if (
    !enabled ||
    !maybeTty.isTTY ||
    typeof maybeTty.setRawMode !== 'function'
  ) {
    return () => {};
  }
  maybeTty.setRawMode(true);
  return () => maybeTty.setRawMode?.(false);
}

function createResizeSource(stdout: Writable):
  | ((callback: (size: { columns: number; rows: number }) => void) => {
      dispose(): void;
    })
  | undefined {
  const maybeTty = stdout as {
    columns?: number;
    rows?: number;
    on?: (event: 'resize', listener: () => void) => void;
    off?: (event: 'resize', listener: () => void) => void;
  };
  if (typeof maybeTty.on !== 'function' || typeof maybeTty.off !== 'function') {
    return undefined;
  }
  return (callback) => {
    const emitSize = () => {
      const columns = maybeTty.columns;
      const rows = maybeTty.rows;
      if (Number.isInteger(columns) && Number.isInteger(rows)) {
        callback({ columns: columns as number, rows: rows as number });
      }
    };
    maybeTty.on?.('resize', emitSize);
    emitSize();
    return {
      dispose: () => {
        maybeTty.off?.('resize', emitSize);
      },
    };
  };
}

function writeToWritable(stdout: Writable, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stdout.write(data, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function parseSupervisorResponse(line: string): AgentViewSupervisorResponse {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || typeof parsed['id'] !== 'string') {
    throw new AgentViewSupervisorClientError(
      'Invalid Agent View supervisor response.',
      'invalid_response',
    );
  }

  if (parsed['ok'] === true) {
    return {
      id: parsed['id'],
      ok: true,
      result: parsed['result'],
    };
  }

  if (
    parsed['ok'] === false &&
    isRecord(parsed['error']) &&
    typeof parsed['error']['code'] === 'string' &&
    typeof parsed['error']['message'] === 'string'
  ) {
    return {
      id: parsed['id'],
      ok: false,
      error: {
        code: parsed['error']['code'],
        message: parsed['error']['message'],
      },
    };
  }

  throw new AgentViewSupervisorClientError(
    'Invalid Agent View supervisor response.',
    'invalid_response',
  );
}

function parseSupervisorEvent(
  line: string,
): AgentViewSupervisorEvent | undefined {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || parsed['type'] !== 'changed') return undefined;
  const at = typeof parsed['at'] === 'string' ? parsed['at'] : undefined;
  if (!at) return undefined;
  return { type: 'changed', at };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
