/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { AGENT_VIEW_PROTOCOL_VERSION } from './protocol.js';
import type {
  AgentViewSupervisorOperation,
  AgentViewSupervisorRequestMap,
  AgentViewSupervisorResponse,
} from './supervisor-client.js';

type AgentViewSupervisorHandlerMethod<Op extends AgentViewSupervisorOperation> =
  undefined extends AgentViewSupervisorRequestMap[Op]
    ? (params?: AgentViewSupervisorRequestMap[Op]) => Promise<unknown> | unknown
    : (params: AgentViewSupervisorRequestMap[Op]) => Promise<unknown> | unknown;

export interface AgentViewSupervisorHandler {
  status: AgentViewSupervisorHandlerMethod<'status'>;
  list: AgentViewSupervisorHandlerMethod<'list'>;
  shutdown: AgentViewSupervisorHandlerMethod<'shutdown'>;
  subscribe?(
    params: AgentViewSupervisorRequestMap['subscribe'],
    socket: net.Socket,
    requestId: string,
  ): Promise<void> | void;
  dispatch?: AgentViewSupervisorHandlerMethod<'dispatch'>;
  adopt?: AgentViewSupervisorHandlerMethod<'adopt'>;
  workerEvent?: AgentViewSupervisorHandlerMethod<'workerEvent'>;
  workerControl?: AgentViewSupervisorHandlerMethod<'workerControl'>;
  attachStream?(
    params: AgentViewSupervisorRequestMap['attachStream'],
    socket: net.Socket,
    requestId: string,
  ): Promise<void> | void;
  resize?: AgentViewSupervisorHandlerMethod<'resize'>;
  peek?: AgentViewSupervisorHandlerMethod<'peek'>;
  send?: AgentViewSupervisorHandlerMethod<'send'>;
  answer?: AgentViewSupervisorHandlerMethod<'answer'>;
  logs?: AgentViewSupervisorHandlerMethod<'logs'>;
  stop?: AgentViewSupervisorHandlerMethod<'stop'>;
  kill?: AgentViewSupervisorHandlerMethod<'kill'>;
  respawn?: AgentViewSupervisorHandlerMethod<'respawn'>;
  remove?: AgentViewSupervisorHandlerMethod<'remove'>;
  pin?: AgentViewSupervisorHandlerMethod<'pin'>;
  rename?: AgentViewSupervisorHandlerMethod<'rename'>;
}

export interface AgentViewSupervisorServerOptions {
  socketPath: string;
  authToken?: string;
}

export interface AgentViewSupervisorServerHandle {
  socketPath: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

const MAX_SUPERVISOR_REQUEST_LINE_BYTES = 1024 * 1024;

export function createAgentViewSupervisorServer(
  handler: AgentViewSupervisorHandler,
  options: AgentViewSupervisorServerOptions,
): AgentViewSupervisorServerHandle {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk;
      if (
        Buffer.byteLength(buffer, 'utf8') > MAX_SUPERVISOR_REQUEST_LINE_BYTES
      ) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;

      const line = buffer.slice(0, newline);
      const remaining = buffer.slice(newline + 1);
      socket.pause();
      void respondToLine(line, handler, socket, options.authToken, remaining);
    });
  });

  return {
    socketPath: options.socketPath,
    async listen() {
      await prepareSocketPath(options.socketPath);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.socketPath, () => {
          server.off('error', reject);
          if (isWindowsPipePath(options.socketPath)) {
            resolve();
            return;
          }
          fs.chmod(options.socketPath, 0o600).then(resolve, (error) => {
            server.close(() => reject(error));
          });
        });
      });
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await removeSocketPath(options.socketPath);
    },
  };
}

export async function handleAgentViewSupervisorRequest(
  request: unknown,
  handler: AgentViewSupervisorHandler,
  authToken?: string,
): Promise<AgentViewSupervisorResponse> {
  if (!isRecord(request) || typeof request['id'] !== 'string') {
    return errorResponse('', 'invalid_request', 'Invalid supervisor request.');
  }
  if (!isCompatibleProtocolRequest(request)) {
    return errorResponse(
      request['id'],
      'incompatible_protocol',
      `Unsupported Agent View protocol version ${String(request['protocolVersion'])}. Expected ${AGENT_VIEW_PROTOCOL_VERSION}.`,
    );
  }

  const op = request['op'];
  if (!isSupervisorOperation(op)) {
    return errorResponse(
      request['id'],
      'invalid_request',
      'Unknown supervisor operation.',
    );
  }
  if (!isAuthorizedSupervisorRequest(request, authToken)) {
    return errorResponse(
      request['id'],
      'unauthorized',
      'Agent View supervisor authentication failed.',
    );
  }
  if (op === 'attachStream') {
    return errorResponse(
      request['id'],
      'not_implemented',
      'Agent View attachStream requires a streaming socket.',
    );
  }
  if (op === 'subscribe') {
    return errorResponse(
      request['id'],
      'not_implemented',
      'Agent View subscribe requires a streaming socket.',
    );
  }

  try {
    const params = parseSupervisorParams(op, request['params']);
    if (!handler[op]) {
      return errorResponse(
        request['id'],
        'not_implemented',
        `Agent View ${op} is not implemented yet.`,
      );
    }
    const method = handler[op] as
      | ((
          params: Record<string, unknown> | undefined,
        ) => Promise<unknown> | unknown)
      | undefined;
    const result = await method?.call(handler, params);
    return {
      id: request['id'],
      ok: true,
      result,
    };
  } catch (error) {
    return errorResponse(
      request['id'],
      'internal_error',
      error instanceof Error ? error.message : 'Supervisor request failed.',
    );
  }
}

interface ParsedRequest {
  id: string;
  protocolVersion?: number;
  authToken?: string;
  op: string;
  params?: Record<string, unknown>;
}

async function respondToLine(
  line: string,
  handler: AgentViewSupervisorHandler,
  socket: net.Socket,
  authToken: string | undefined,
  remaining = '',
): Promise<void> {
  const request = parseRequestLine(line);
  if (
    request &&
    request.op === 'attachStream' &&
    typeof handler.attachStream === 'function'
  ) {
    await handleStreamingOp(
      request,
      socket,
      authToken,
      remaining,
      'attachStream',
      handler.attachStream,
      'Attach stream failed.',
    );
    return;
  }

  if (
    request &&
    request.op === 'subscribe' &&
    typeof handler.subscribe === 'function'
  ) {
    await handleStreamingOp(
      request,
      socket,
      authToken,
      remaining,
      'subscribe',
      handler.subscribe,
      'Subscribe failed.',
    );
    return;
  }

  let response: AgentViewSupervisorResponse;
  try {
    response = await handleAgentViewSupervisorRequest(
      request ?? JSON.parse(line),
      handler,
      authToken,
    );
  } catch {
    response = errorResponse('', 'invalid_json', 'Invalid JSON request.');
  }
  socket.end(`${JSON.stringify(response)}\n`);
}

async function handleStreamingOp<Op extends 'attachStream' | 'subscribe'>(
  request: ParsedRequest,
  socket: net.Socket,
  authToken: string | undefined,
  remaining: string,
  op: Op,
  method: (
    params: AgentViewSupervisorRequestMap[Op],
    socket: net.Socket,
    requestId: string,
  ) => Promise<void> | void,
  fallbackErrorMessage: string,
): Promise<void> {
  if (!isCompatibleParsedRequest(request)) {
    socket.end(
      `${JSON.stringify(
        errorResponse(
          request.id,
          'incompatible_protocol',
          `Unsupported Agent View protocol version ${String(request.protocolVersion)}. Expected ${AGENT_VIEW_PROTOCOL_VERSION}.`,
        ),
      )}\n`,
    );
    return;
  }
  if (!isAuthorizedParsedRequest(request, authToken)) {
    socket.end(
      `${JSON.stringify(
        errorResponse(
          request.id,
          'unauthorized',
          'Agent View supervisor authentication failed.',
        ),
      )}\n`,
    );
    return;
  }
  socket.removeAllListeners('data');
  if (remaining.length > 0) {
    // Preserve terminal bytes that arrived in the same packet as the request.
    socket.unshift(remaining);
  }
  socket.resume();
  try {
    await method(parseSupervisorParams(op, request.params), socket, request.id);
  } catch (error) {
    socket.end(
      `${JSON.stringify(
        errorResponse(
          request.id,
          'internal_error',
          error instanceof Error ? error.message : fallbackErrorMessage,
        ),
      )}\n`,
    );
  }
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  if (isWindowsPipePath(socketPath)) return;
  const socketDir = path.dirname(socketPath);
  await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
  if (!(await socketPathExists(socketPath))) return;
  if (await canConnect(socketPath)) {
    const error = new Error(
      `Agent View supervisor socket is already in use: ${socketPath}`,
    ) as NodeJS.ErrnoException;
    error.code = 'EADDRINUSE';
    throw error;
  }
  await removeSocketPath(socketPath);
}

async function removeSocketPath(socketPath: string): Promise<void> {
  if (isWindowsPipePath(socketPath)) return;
  try {
    await fs.unlink(socketPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function errorResponse(
  id: string,
  code: string,
  message: string,
): AgentViewSupervisorResponse {
  return {
    id,
    ok: false,
    error: { code, message },
  };
}

function parseSupervisorParams<Op extends AgentViewSupervisorOperation>(
  _op: Op,
  params: unknown,
): AgentViewSupervisorRequestMap[Op] {
  return (
    isRecord(params) ? params : undefined
  ) as AgentViewSupervisorRequestMap[Op];
}

function isSupervisorOperation(
  value: unknown,
): value is AgentViewSupervisorOperation {
  return (
    value === 'status' ||
    value === 'list' ||
    value === 'subscribe' ||
    value === 'shutdown' ||
    value === 'dispatch' ||
    value === 'adopt' ||
    value === 'workerEvent' ||
    value === 'workerControl' ||
    value === 'attachStream' ||
    value === 'resize' ||
    value === 'peek' ||
    value === 'send' ||
    value === 'answer' ||
    value === 'logs' ||
    value === 'stop' ||
    value === 'kill' ||
    value === 'respawn' ||
    value === 'remove' ||
    value === 'pin' ||
    value === 'rename'
  );
}

function parseRequestLine(line: string): ParsedRequest | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed['id'] !== 'string') {
      return undefined;
    }
    return {
      id: parsed['id'],
      ...(typeof parsed['protocolVersion'] === 'number'
        ? { protocolVersion: parsed['protocolVersion'] }
        : {}),
      op: typeof parsed['op'] === 'string' ? parsed['op'] : '',
      ...(typeof parsed['authToken'] === 'string'
        ? { authToken: parsed['authToken'] }
        : {}),
      ...(isRecord(parsed['params']) ? { params: parsed['params'] } : {}),
    };
  } catch {
    return undefined;
  }
}

function isWindowsPipePath(socketPath: string): boolean {
  return socketPath.startsWith('\\\\.\\pipe\\');
}

async function socketPathExists(socketPath: string): Promise<boolean> {
  try {
    await fs.stat(socketPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    function finish(result: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    }

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    const timeout = setTimeout(() => finish(false), 250);
  });
}

function isCompatibleProtocolRequest(
  request: Record<string, unknown>,
): boolean {
  return (
    request['protocolVersion'] === undefined ||
    request['protocolVersion'] === AGENT_VIEW_PROTOCOL_VERSION
  );
}

function isCompatibleParsedRequest(request: {
  protocolVersion?: number;
}): boolean {
  return (
    request.protocolVersion === undefined ||
    request.protocolVersion === AGENT_VIEW_PROTOCOL_VERSION
  );
}

function isAuthorizedSupervisorRequest(
  request: Record<string, unknown>,
  authToken: string | undefined,
): boolean {
  if (!authToken || isWorkerSidebandOperation(request['op'])) return true;
  return request['authToken'] === authToken;
}

function isAuthorizedParsedRequest(
  request: { op: string; authToken?: string },
  authToken: string | undefined,
): boolean {
  if (!authToken || isWorkerSidebandOperation(request.op)) return true;
  return request.authToken === authToken;
}

function isWorkerSidebandOperation(op: unknown): boolean {
  return op === 'workerEvent' || op === 'workerControl';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
