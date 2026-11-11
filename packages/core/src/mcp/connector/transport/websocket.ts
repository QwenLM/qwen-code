/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Options for the WebSocket client transport.
 */
export interface WebSocketClientTransportOptions {
  /** Additional headers to send with the WebSocket upgrade request. */
  headers?: Record<string, string>;
}

/**
 * A WebSocket-based MCP transport implementing the SDK's Transport interface.
 *
 * Uses the Node.js built-in WebSocket API (available since Node.js 21,
 * behind --experimental-websocket in Node.js 20).
 */
export class WebSocketClientTransport implements Transport {
  private ws: WebSocket | undefined;
  private readonly url: URL;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(url: string | URL, _options?: WebSocketClientTransportOptions) {
    this.url = typeof url === 'string' ? new URL(url) : url;
  }

  async start(): Promise<void> {
    if (this.ws) {
      throw new Error('WebSocket transport already started');
    }

    return new Promise<void>((resolve, reject) => {
      // Node.js built-in WebSocket (from undici) does not support custom
      // headers in the constructor. If headers are needed, they should be
      // passed via query parameters or a token-based auth scheme.
      // For maximum compatibility, we pass headers as a subprotocol-based
      // workaround is not standard, so we simply create the WebSocket
      // without custom headers and rely on URL-based auth (query params)
      // or the server's own auth mechanism.
      //
      // Note: If you need header-based auth for WebSocket MCP servers,
      // consider using the `ws` npm package which supports custom headers.
      const ws = new WebSocket(this.url.toString());

      ws.addEventListener(
        'open',
        () => {
          this.ws = ws;
          resolve();
        },
        { once: true },
      );

      ws.addEventListener(
        'error',
        (event) => {
          const error = new Error(`WebSocket connection error: ${event.type}`);
          if (!this.ws) {
            // Connection phase error
            reject(error);
          } else {
            this.onerror?.(error);
          }
        },
        { once: true },
      );

      ws.addEventListener('message', (event) => {
        try {
          const data =
            typeof event.data === 'string' ? event.data : String(event.data);
          const message = JSON.parse(data) as JSONRPCMessage;
          this.onmessage?.(message);
        } catch (parseError) {
          this.onerror?.(
            new Error(
              `Failed to parse WebSocket message: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          );
        }
      });

      ws.addEventListener(
        'close',
        () => {
          this.ws = undefined;
          this.onclose?.();
        },
        { once: true },
      );
    });
  }

  async close(): Promise<void> {
    const ws = this.ws;
    if (!ws) {
      return;
    }
    this.ws = undefined;

    return new Promise<void>((resolve) => {
      ws.addEventListener(
        'close',
        () => {
          resolve();
        },
        { once: true },
      );

      // If already closed, resolve immediately
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      ws.close();

      // Timeout to avoid hanging forever
      setTimeout(() => {
        resolve();
      }, 3000);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(message));
  }
}
