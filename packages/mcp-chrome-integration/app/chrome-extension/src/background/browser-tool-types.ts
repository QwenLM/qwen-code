/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the browser-tool executors (daemon-direct architecture).
 * Relocated from the deleted native-messaging-types.ts — only the executor /
 * network-capture types survive; the Native Messaging transport types are gone.
 */

/** Browser tool arguments type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BrowserToolArgs = Record<string, any>;

/** Raw network request type (from network-capture-utils). */
export type RawNetworkRequest = {
  requestId: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  status?: number;
  statusText?: string;
  mimeType?: string;
  type?: string;
  timestamp?: number;
  requestBody?: {
    raw: string;
    rawEncoding: string;
  };
  responseBody?: string;
  bodyTruncated?: boolean;
  responseBodyEncoding?: string;
  responseBodySource?: string;
  source?: {
    request?: string;
    response?: string;
  };
  error?: string;
};

/** WebSocket session type (from network-capture-utils). */
export type WebSocketSession = {
  requestId: string;
  url: string;
  frames: Array<{
    direction: 'sent' | 'received';
    opcode?: number;
    payload: string;
    payloadEncoding: 'base64' | 'text';
    truncated: boolean;
    timestamp?: number;
  }>;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  status?: number;
  statusText?: string;
  createdAt?: number;
  closedAt?: number;
  error?: string;
};

/** Network capture state. */
export type NetworkCaptureState = {
  capturing: boolean;
  tabId: number | null;
  debuggerRequests: Map<string, RawNetworkRequest>;
  webSocketSessions: Map<string, WebSocketSession>;
  startTime: number | null;
  needResponseBody?: boolean;
  needDocumentBody?: boolean;
  captureWebSocket?: boolean;
  includeStatic?: boolean;
  maxBodyChars?: number;
  maxWebSocketFrames?: number;
  maxWebSocketFrameChars?: number;
};
