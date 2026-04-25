/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { getSingleHeader, isAllowedOrigin } from '../http/auth.js';
import { isDesktopApprovalMode } from '../services/sessionService.js';
import type { AcpSessionClient } from '../services/sessionService.js';
import type {
  DesktopClientMessage,
  DesktopServerMessage,
} from '../../shared/desktopProtocol.js';
import type { PermissionBridge } from '../acp/permissionBridge.js';

interface SessionSocketHubOptions {
  token: string;
  acpClient?: AcpSessionClient;
  permissionBridge?: PermissionBridge;
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

  broadcast(sessionId: string, message: DesktopServerMessage): void {
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
          const normalizedError = normalizeSocketError(error);
          sendMessage(socket, {
            type: 'error',
            ...normalizedError,
          });
        },
      );
    });

    socket.on('close', () => {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.socketsBySession.delete(sessionId);
        this.options.permissionBridge?.cancelSession(sessionId);
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
      case 'permission_response':
      case 'ask_user_question_response':
        if (!this.options.permissionBridge?.handleClientMessage(message)) {
          sendMessage(socket, {
            type: 'error',
            code: 'permission_request_not_found',
            message: 'Permission request is no longer pending.',
          });
        }
        return;
      case 'ping':
        sendMessage(socket, { type: 'pong' });
        return;
      case 'stop_generation':
        await this.cancelPrompt(sessionId, socket);
        return;
      case 'set_permission_mode':
        await this.setPermissionMode(sessionId, socket, message.mode);
        return;
      case 'set_model':
        await this.setModel(sessionId, socket, message.modelId);
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

  private async setPermissionMode(
    sessionId: string,
    socket: WebSocket,
    mode: string,
  ): Promise<void> {
    if (!this.options.acpClient?.setMode) {
      sendMessage(socket, {
        type: 'error',
        code: 'acp_set_mode_unavailable',
        message: 'ACP client does not support setting a session mode.',
        retryable: true,
      });
      return;
    }

    await this.options.acpClient.setMode(sessionId, mode);
    this.broadcast(sessionId, { type: 'mode_changed', mode });
  }

  private async setModel(
    sessionId: string,
    socket: WebSocket,
    modelId: string,
  ): Promise<void> {
    if (!this.options.acpClient?.setModel) {
      sendMessage(socket, {
        type: 'error',
        code: 'acp_set_model_unavailable',
        message: 'ACP client does not support setting a session model.',
        retryable: true,
      });
      return;
    }

    await this.options.acpClient.setModel(sessionId, modelId);
    this.broadcast(sessionId, { type: 'model_changed', modelId });
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
): DesktopClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage.toString()) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
    return null;
  }

  const candidate = parsed as Partial<DesktopClientMessage>;
  if (candidate.type === 'ping' || candidate.type === 'stop_generation') {
    return { type: candidate.type };
  }

  if (
    candidate.type === 'set_permission_mode' &&
    isDesktopApprovalMode(candidate.mode)
  ) {
    return {
      type: 'set_permission_mode',
      mode: candidate.mode,
    };
  }

  if (
    candidate.type === 'set_model' &&
    typeof candidate.modelId === 'string' &&
    candidate.modelId.length > 0
  ) {
    return {
      type: 'set_model',
      modelId: candidate.modelId,
    };
  }

  if (
    candidate.type === 'permission_response' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.optionId === 'string'
  ) {
    return {
      type: 'permission_response',
      requestId: candidate.requestId,
      optionId: candidate.optionId,
    };
  }

  if (
    candidate.type === 'ask_user_question_response' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.optionId === 'string' &&
    (candidate.answers === undefined || isStringRecord(candidate.answers))
  ) {
    return {
      type: 'ask_user_question_response',
      requestId: candidate.requestId,
      optionId: candidate.optionId,
      answers: candidate.answers,
    };
  }

  if (
    candidate.type === 'user_message' &&
    typeof candidate.content === 'string'
  ) {
    return { type: 'user_message', content: candidate.content };
  }

  return null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => typeof item === 'string');
}

function sendMessage(socket: WebSocket, message: DesktopServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function normalizeSocketError(error: unknown): {
  code: string;
  message: string;
} {
  const record = asRecord(error);
  const nestedError = asRecord(record?.['error']);
  const code =
    getErrorCode(nestedError?.['code']) ??
    getErrorCode(record?.['code']) ??
    'internal_error';
  const message =
    getErrorMessage(error) ??
    getErrorMessage(record?.['message']) ??
    getErrorMessage(nestedError?.['message']) ??
    'WebSocket message handling failed.';

  return { code, message };
}

function getErrorCode(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `acp_${value}`;
  }

  return null;
}

function getErrorMessage(value: unknown): string | null {
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return (
    getErrorMessage(record['message']) ??
    getErrorMessage(asRecord(record['error'])?.['message'])
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
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
