/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { getSingleHeader, isAllowedOrigin } from '../http/auth.js';
import type { AcpSessionClient } from '../services/sessionService.js';

type ClientMessage =
  | { type: 'ping' }
  | { type: 'stop_generation' }
  | { type: 'user_message'; content: string };

type ServerMessage =
  | { type: 'connected'; sessionId: string }
  | { type: 'pong' }
  | { type: 'message_complete'; stopReason?: string }
  | { type: 'error'; code: string; message: string; retryable?: boolean };

interface SessionSocketHubOptions {
  token: string;
  acpClient?: AcpSessionClient;
}

export class SessionSocketHub {
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly socketsBySession = new Map<string, Set<WebSocket>>();
  private readonly activePrompts = new Set<string>();

  constructor(private readonly options: SessionSocketHubOptions) {}

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = getSingleHeader(request.headers.origin);
    if (!isAllowedOrigin(origin)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const requestUrl = parseSocketUrl(request);
    if (!requestUrl) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }

    const sessionId = matchSessionId(requestUrl.pathname);
    if (!sessionId) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    if (requestUrl.searchParams.get('token') !== this.options.token) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    this.server.handleUpgrade(request, socket, head, (webSocket) => {
      this.handleConnection(sessionId, webSocket);
    });
  }

  close(): void {
    for (const sockets of this.socketsBySession.values()) {
      for (const socket of sockets) {
        socket.close();
      }
    }
    this.socketsBySession.clear();
    this.activePrompts.clear();
    this.server.close();
  }

  broadcast(sessionId: string, message: ServerMessage): void {
    const sockets = this.socketsBySession.get(sessionId);
    if (!sockets) {
      return;
    }

    for (const socket of sockets) {
      sendMessage(socket, message);
    }
  }

  private handleConnection(sessionId: string, socket: WebSocket): void {
    const sockets =
      this.socketsBySession.get(sessionId) ?? new Set<WebSocket>();
    sockets.add(socket);
    this.socketsBySession.set(sessionId, sockets);

    sendMessage(socket, { type: 'connected', sessionId });

    socket.on('message', (rawMessage) => {
      void this.handleClientMessage(sessionId, socket, rawMessage).catch(
        (error: unknown) => {
          sendMessage(socket, {
            type: 'error',
            code: 'internal_error',
            message:
              error instanceof Error
                ? error.message
                : 'WebSocket message handling failed.',
          });
        },
      );
    });

    socket.on('close', () => {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.socketsBySession.delete(sessionId);
      }
    });
  }

  private async handleClientMessage(
    sessionId: string,
    socket: WebSocket,
    rawMessage: WebSocket.RawData,
  ): Promise<void> {
    const message = parseClientMessage(rawMessage);
    if (!message) {
      sendMessage(socket, {
        type: 'error',
        code: 'bad_message',
        message: 'WebSocket message is invalid.',
      });
      return;
    }

    switch (message.type) {
      case 'ping':
        sendMessage(socket, { type: 'pong' });
        return;
      case 'stop_generation':
        await this.cancelPrompt(sessionId, socket);
        return;
      case 'user_message':
        await this.sendPrompt(sessionId, socket, message.content);
        return;
      default:
        sendMessage(socket, {
          type: 'error',
          code: 'bad_message',
          message: 'WebSocket message is invalid.',
        });
    }
  }

  private async sendPrompt(
    sessionId: string,
    socket: WebSocket,
    content: string,
  ): Promise<void> {
    if (!this.options.acpClient) {
      sendMessage(socket, {
        type: 'error',
        code: 'acp_unavailable',
        message: 'ACP client is not configured.',
        retryable: true,
      });
      return;
    }

    if (this.activePrompts.has(sessionId)) {
      sendMessage(socket, {
        type: 'error',
        code: 'prompt_active',
        message: 'A prompt is already running for this session.',
        retryable: true,
      });
      return;
    }

    this.activePrompts.add(sessionId);
    try {
      const response = await this.options.acpClient.prompt(sessionId, content);
      sendMessage(socket, {
        type: 'message_complete',
        stopReason: response.stopReason,
      });
    } finally {
      this.activePrompts.delete(sessionId);
    }
  }

  private async cancelPrompt(
    sessionId: string,
    socket: WebSocket,
  ): Promise<void> {
    if (!this.options.acpClient) {
      sendMessage(socket, {
        type: 'error',
        code: 'acp_unavailable',
        message: 'ACP client is not configured.',
        retryable: true,
      });
      return;
    }

    await this.options.acpClient.cancel(sessionId);
    this.activePrompts.delete(sessionId);
    sendMessage(socket, { type: 'message_complete', stopReason: 'cancelled' });
  }
}

function parseSocketUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? '/', 'ws://127.0.0.1');
  } catch {
    return null;
  }
}

function matchSessionId(pathname: string): string | null {
  const match = /^\/ws\/([^/]+)$/u.exec(pathname);
  if (!match?.[1]) {
    return null;
  }

  return decodeURIComponent(match[1]);
}

function parseClientMessage(
  rawMessage: WebSocket.RawData,
): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage.toString()) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
    return null;
  }

  const candidate = parsed as Partial<ClientMessage>;
  if (candidate.type === 'ping' || candidate.type === 'stop_generation') {
    return { type: candidate.type };
  }

  if (
    candidate.type === 'user_message' &&
    typeof candidate.content === 'string'
  ) {
    return { type: 'user_message', content: candidate.content };
  }

  return null;
}

function sendMessage(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  message: string,
): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`,
  );
  socket.destroy();
}
