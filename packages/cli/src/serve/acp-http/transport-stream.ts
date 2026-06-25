/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transport-agnostic stream interface consumed by `AcpConnection`.
 * Both `SseStream` (HTTP SSE) and `WsStream` (WebSocket) implement this.
 */
export interface TransportStream {
  readonly kind: 'sse' | 'ws';
  send(message: unknown): Promise<void>;
  close(): void;
  readonly isClosed: boolean;
}
