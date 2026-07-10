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
  /**
   * Serialize one frame. `id` is the bus event id (`BridgeEvent.id`) used as
   * the SSE `id:` resume cursor — present only for ring-backed session events,
   * omitted for JSON-RPC responses and synthetic terminal frames. The
   * WebSocket transport ignores it (stateful connection, no SSE replay).
   */
  send(message: unknown, id?: number): Promise<void>;
  close(): void;
  readonly isClosed: boolean;
}
