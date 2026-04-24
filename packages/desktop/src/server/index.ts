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
import { getRuntimeInfo } from './services/runtimeService.js';
import type {
  DesktopErrorResponse,
  DesktopHealthResponse,
  DesktopRuntimeResponse,
  DesktopServer,
  DesktopServerOptions,
} from './types.js';

interface HandlerContext {
  token: string;
  startedAt: number;
  now: () => Date;
}

export async function startDesktopServer(
  options: DesktopServerOptions = {},
): Promise<DesktopServer> {
  const token = options.token ?? createServerToken();
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const server = createServer((request, response) => {
    void handleRequest(request, response, { token, startedAt, now }).catch(
      (error: unknown) => {
        sendJson(response, getSingleHeader(request.headers.origin), 500, {
          ok: false,
          code: 'internal_error',
          message:
            error instanceof Error
              ? error.message
              : 'Desktop server request failed.',
        });
      },
    );
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
    close: () => closeHttpServer(server),
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

  sendJson(response, origin, 404, {
    ok: false,
    code: 'not_found',
    message: 'Route not found.',
  });
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
  payload:
    | DesktopHealthResponse
    | DesktopRuntimeResponse
    | DesktopErrorResponse,
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
