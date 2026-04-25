/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopServerInfo } from '../../shared/desktopApi.js';
import type {
  DesktopApprovalMode,
  DesktopClientMessage,
  DesktopServerMessage,
} from '../../shared/desktopProtocol.js';

export interface SessionSocketHandlers {
  onOpen?: () => void;
  onMessage: (message: DesktopServerMessage) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
}

export interface SessionSocketClient {
  sendUserMessage(content: string): void;
  respondToPermission(requestId: string, optionId: string): void;
  respondToAskUserQuestion(
    requestId: string,
    optionId: string,
    answers?: Record<string, string>,
  ): void;
  setPermissionMode(mode: DesktopApprovalMode): void;
  setModel(modelId: string): void;
  stopGeneration(): void;
  ping(): void;
  close(): void;
}

export function connectSessionSocket(
  serverInfo: DesktopServerInfo,
  sessionId: string,
  handlers: SessionSocketHandlers,
): SessionSocketClient {
  const socket = new WebSocket(createSessionSocketUrl(serverInfo, sessionId));

  socket.addEventListener('open', () => handlers.onOpen?.());
  socket.addEventListener('message', (event) => {
    const message = parseServerMessage(event.data);
    if (message) {
      handlers.onMessage(message);
    }
  });
  socket.addEventListener('close', (event) => handlers.onClose?.(event));
  socket.addEventListener('error', (event) => handlers.onError?.(event));

  return {
    sendUserMessage(content: string): void {
      sendClientMessage(socket, { type: 'user_message', content });
    },
    respondToPermission(requestId: string, optionId: string): void {
      sendClientMessage(socket, {
        type: 'permission_response',
        requestId,
        optionId,
      });
    },
    respondToAskUserQuestion(
      requestId: string,
      optionId: string,
      answers?: Record<string, string>,
    ): void {
      sendClientMessage(socket, {
        type: 'ask_user_question_response',
        requestId,
        optionId,
        answers,
      });
    },
    setPermissionMode(mode: DesktopApprovalMode): void {
      sendClientMessage(socket, { type: 'set_permission_mode', mode });
    },
    setModel(modelId: string): void {
      sendClientMessage(socket, { type: 'set_model', modelId });
    },
    stopGeneration(): void {
      sendClientMessage(socket, { type: 'stop_generation' });
    },
    ping(): void {
      sendClientMessage(socket, { type: 'ping' });
    },
    close(): void {
      socket.close();
    },
  };
}

function createSessionSocketUrl(
  serverInfo: DesktopServerInfo,
  sessionId: string,
): string {
  const url = new URL(`/ws/${encodeURIComponent(sessionId)}`, serverInfo.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', serverInfo.token);
  return url.toString();
}

function sendClientMessage(
  socket: WebSocket,
  message: DesktopClientMessage,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(message));
}

function parseServerMessage(value: unknown): DesktopServerMessage | null {
  if (typeof value !== 'string') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
    return null;
  }

  return parsed as DesktopServerMessage;
}
