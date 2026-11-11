/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { WebSocketClientTransport } from './transport/websocket.js';
import { prepareHttpConnection } from './httpPreparation.js';
import type {
  McpConnectOutcome,
  McpConnectRequest,
  McpConnector,
  McpConnectorContext,
} from './types.js';

/**
 * WebSocket connector. Not one of the two transports the MCP specification
 * defines, kept for configs that already use `type: 'ws'`. Shares the HTTP
 * preparation and only differs in how headers reach the transport, since a
 * WebSocket handshake takes a plain header map rather than a `RequestInit`.
 */
export class WebsocketMcpConnector implements McpConnector {
  async connect(
    request: McpConnectRequest,
    ctx: McpConnectorContext,
  ): Promise<McpConnectOutcome> {
    const prepared = await prepareHttpConnection(request, ctx);
    const headers = extractHeaders(prepared.transportOptions.requestInit);
    return {
      transport: new WebSocketClientTransport(
        new URL(prepared.config.url!),
        headers && Object.keys(headers).length > 0 ? { headers } : {},
      ),
    };
  }
}

function extractHeaders(
  requestInit: RequestInit | undefined,
): Record<string, string> | undefined {
  const raw = requestInit?.headers;
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(raw)) {
    for (const [key, value] of raw) {
      headers[key] = value;
    }
  } else {
    Object.assign(headers, raw);
  }
  return headers;
}
