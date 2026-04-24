/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createCorsHeaders,
  createServerToken,
  getSingleHeader,
  isAllowedOrigin,
  isAuthorized,
} from './http/auth.js';
import { AcpEventRouter } from './acp/AcpEventRouter.js';
import { PermissionBridge } from './acp/permissionBridge.js';
import { isDesktopHttpError, DesktopHttpError } from './http/errors.js';
import { getRuntimeInfo } from './services/runtimeService.js';
import { DesktopSessionService } from './services/sessionService.js';
import { SessionSocketHub } from './ws/SessionSocketHub.js';
import type {
  DesktopJsonResponse,
  DesktopServer,
  DesktopServerOptions,
} from './types.js';

interface HandlerContext {
  token: string;
  startedAt: number;
  now: () => Date;
  sessionService: DesktopSessionService;
}

export async function startDesktopServer(
  options: DesktopServerOptions = {},
): Promise<DesktopServer> {
  const token = options.token ?? createServerToken();
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const sessionService = new DesktopSessionService(options.acpClient);
  const socketHubRef: { current: SessionSocketHub | null } = { current: null };
  const permissionBridge = new PermissionBridge({
    timeoutMs: options.permissionRequestTimeoutMs,
    broadcast: (sessionId, message) => {
      socketHubRef.current?.broadcast(sessionId, message);
    },
  });
  const socketHub = new SessionSocketHub({
    token,
    acpClient: options.acpClient,
    permissionBridge,
  });
  socketHubRef.current = socketHub;
  const acpEventRouter = new AcpEventRouter({
    broadcast: (sessionId, message) => socketHub.broadcast(sessionId, message),
  });
  const previousSessionUpdateHandler = options.acpClient?.onSessionUpdate;
  if (options.acpClient) {
    options.acpClient.onSessionUpdate = (notification) => {
      previousSessionUpdateHandler?.(notification);
      acpEventRouter.handleSessionUpdate(notification);
    };
    options.acpClient.onPermissionRequest = (request) =>
      permissionBridge.requestPermission(request);
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      token,
      startedAt,
      now,
      sessionService,
    }).catch((error: unknown) => {
      const origin = getSingleHeader(request.headers.origin);
      if (isDesktopHttpError(error)) {
        sendJson(response, origin, error.statusCode, {
          ok: false,
          code: error.code,
          message: error.message,
        });
        return;
      }

      sendJson(response, origin, 500, {
        ok: false,
        code: 'internal_error',
        message:
          error instanceof Error
            ? error.message
            : 'Desktop server request failed.',
      });
    });
  });
  server.on('upgrade', (request, socket, head) => {
    socketHub.handleUpgrade(request, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!isAddressInfo(address)) {
    await closeHttpServer(server);
    throw new Error('Desktop server did not bind to a TCP address.');
  }

  return {
    info: {
      url: `http://127.0.0.1:${address.port}`,
      token,
    },
    close: async () => {
      permissionBridge.close();
      socketHub.close();
      await closeHttpServer(server);
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: HandlerContext,
): Promise<void> {
  const origin = getSingleHeader(request.headers.origin);
  if (!isAllowedOrigin(origin)) {
    sendJson(response, origin, 403, {
      ok: false,
      code: 'origin_forbidden',
      message: 'Request origin is not allowed.',
    });
    return;
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, createCorsHeaders(origin));
    response.end();
    return;
  }

  if (!isAuthorized(request.headers, context.token)) {
    sendJson(response, origin, 401, {
      ok: false,
      code: 'unauthorized',
      message: 'Missing or invalid desktop server token.',
    });
    return;
  }

  const requestUrl = parseRequestUrl(request);
  if (!requestUrl) {
    sendJson(response, origin, 400, {
      ok: false,
      code: 'bad_request',
      message: 'Request URL is invalid.',
    });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(response, origin, 200, {
      ok: true,
      service: 'qwen-desktop',
      uptimeMs: Math.max(0, context.now().getTime() - context.startedAt),
      timestamp: context.now().toISOString(),
    });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/runtime') {
    sendJson(response, origin, 200, await getRuntimeInfo());
    return;
  }

  if (requestUrl.pathname === '/api/sessions') {
    await handleSessionsRoute(request, response, origin, requestUrl, context);
    return;
  }

  const loadSessionMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/sessions\/([^/]+)\/load$/u,
  );
  if (loadSessionMatch) {
    await handleLoadSessionRoute(
      request,
      response,
      origin,
      context,
      loadSessionMatch,
    );
    return;
  }

  const sessionMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/sessions\/([^/]+)$/u,
  );
  if (sessionMatch) {
    await handleSessionRoute(
      request,
      response,
      origin,
      requestUrl,
      context,
      sessionMatch,
    );
    return;
  }

  sendJson(response, origin, 404, {
    ok: false,
    code: 'not_found',
    message: 'Route not found.',
  });
}

async function handleSessionsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  requestUrl: URL,
  context: HandlerContext,
): Promise<void> {
  if (request.method === 'GET') {
    const result = await context.sessionService.listSessions({
      cwd: getOptionalSearchParam(requestUrl, 'cwd'),
      cursor: getOptionalNumberSearchParam(requestUrl, 'cursor'),
      size: getOptionalNumberSearchParam(requestUrl, 'size'),
    });
    sendJson(response, origin, 200, { ok: true, ...result });
    return;
  }

  if (request.method === 'POST') {
    const body = await readObjectBody(request);
    const cwd = getRequiredString(body, 'cwd');
    const session = await context.sessionService.createSession(cwd);
    sendJson(response, origin, 200, { ok: true, session });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleLoadSessionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  sessionId: string,
): Promise<void> {
  if (request.method !== 'POST') {
    sendMethodNotAllowed(response, origin);
    return;
  }

  const body = await readObjectBody(request);
  const cwd = getRequiredString(body, 'cwd');
  const session = await context.sessionService.loadSession(sessionId, cwd);
  sendJson(response, origin, 200, { ok: true, session });
}

async function handleSessionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  requestUrl: URL,
  context: HandlerContext,
  sessionId: string,
): Promise<void> {
  if (request.method === 'PATCH') {
    const body = await readObjectBody(request);
    const title = getRequiredString(body, 'title');
    const result = await context.sessionService.renameSession(
      sessionId,
      title,
      getOptionalString(body, 'cwd'),
    );
    sendJson(response, origin, 200, { ok: true, result });
    return;
  }

  if (request.method === 'DELETE') {
    const result = await context.sessionService.deleteSession(
      sessionId,
      getOptionalSearchParam(requestUrl, 'cwd'),
    );
    sendJson(response, origin, 200, { ok: true, result });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

function parseRequestUrl(request: IncomingMessage): URL | undefined {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1');
  } catch {
    return undefined;
  }
}

function sendJson(
  response: ServerResponse,
  origin: string | undefined,
  statusCode: number,
  payload: DesktopJsonResponse,
) {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(statusCode, {
    ...createCorsHeaders(origin),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendMethodNotAllowed(
  response: ServerResponse,
  origin: string | undefined,
): void {
  sendJson(response, origin, 405, {
    ok: false,
    code: 'method_not_allowed',
    message: 'Method not allowed.',
  });
}

function matchSessionRoute(pathname: string, pattern: RegExp): string | null {
  const match = pattern.exec(pathname);
  if (!match?.[1]) {
    return null;
  }

  return decodeURIComponent(match[1]);
}

async function readObjectBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new DesktopHttpError(400, 'bad_request', 'Request body is required.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DesktopHttpError(400, 'bad_json', 'Request body must be JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      'Request body must be an object.',
    );
  }

  return parsed as Record<string, unknown>;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 1024 * 1024) {
      throw new DesktopHttpError(
        413,
        'payload_too_large',
        'Request body is too large.',
      );
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function getRequiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      `${key} must be a non-empty string.`,
    );
  }

  return value;
}

function getOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new DesktopHttpError(400, 'bad_request', `${key} must be a string.`);
  }

  return value;
}

function getOptionalSearchParam(url: URL, key: string): string | undefined {
  return url.searchParams.get(key) ?? undefined;
}

function getOptionalNumberSearchParam(
  url: URL,
  key: string,
): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new DesktopHttpError(400, 'bad_request', `${key} must be a number.`);
  }

  return numberValue;
}

function isAddressInfo(
  address: string | AddressInfo | null,
): address is AddressInfo {
  return typeof address === 'object' && address !== null;
}

async function closeHttpServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
