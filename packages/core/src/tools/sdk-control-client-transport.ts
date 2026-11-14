/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SdkControlClientTransport - MCP Client transport for SDK MCP servers
 *
 * This transport enables CLI's MCP client to connect to SDK MCP servers
 * through the control plane. Messages are routed:
 *
 * CLI MCP Client → SdkControlClientTransport → sendMcpMessage() →
 * control_request (mcp_message) → SDK → control_response → onmessage → CLI
 *
 * Unlike StdioClientTransport which spawns a subprocess, this transport
 * communicates with SDK MCP servers running in the SDK process.
 */

import {
  isJSONRPCRequest,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MCP_SDK_TRANSPORT');

/**
 * Callback to send MCP messages to SDK via control plane
 * Returns the MCP response from the SDK
 */
export type SendMcpMessageCallback = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>;

export interface SdkControlClientTransportOptions {
  serverName: string;
  sendMcpMessage: SendMcpMessageCallback;
  debugMode?: boolean;
}

/**
 * MCP Client Transport for SDK MCP servers
 *
 * Implements the @modelcontextprotocol/sdk Transport interface to enable
 * CLI's MCP client to connect to SDK MCP servers via the control plane.
 */
export class SdkControlClientTransport {
  private serverName: string;
  private sendMcpMessage: SendMcpMessageCallback;
  private started = false;
  private readonly pending = new Map<string | number, { cancelled: boolean }>();

  // Transport interface callbacks
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(options: SdkControlClientTransportOptions) {
    this.serverName = options.serverName;
    this.sendMcpMessage = options.sendMcpMessage;
    // Note: debugMode option is preserved for API compatibility but no longer used
    // since debugLogger now always writes to the session logfile
  }

  /**
   * Start the transport
   * For SDK transport, this just marks it as ready - no subprocess to spawn
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    debugLogger.debug(`Started for server '${this.serverName}'`);
  }

  /**
   * Send a message to the SDK MCP server via control plane
   *
   * Routes the message through the control plane and delivers
   * the response via onmessage callback.
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started) {
      throw new Error(
        `SdkControlClientTransport (${this.serverName}) not started. Call start() first.`,
      );
    }

    debugLogger.debug(
      `Sending message to '${this.serverName}': ${JSON.stringify(message)}`,
    );

    const request = isJSONRPCRequest(message)
      ? { id: message.id, cancelled: false }
      : undefined;
    if (request) this.pending.set(request.id, request);
    if ('method' in message && message.method === 'notifications/cancelled') {
      const id = message.params?.['requestId'];
      if (typeof id === 'string' || typeof id === 'number') {
        const pending = this.pending.get(id);
        if (pending) pending.cancelled = true;
      }
    }

    try {
      // Send message to SDK and wait for response
      const response = await this.sendMcpMessage(this.serverName, message);

      debugLogger.debug(
        `Received response from '${this.serverName}': ${JSON.stringify(response)}`,
      );

      // Control-plane notification acks and late cancelled replies are not MCP
      // responses: the SDK has no response handler for either of them.
      if (request && !request.cancelled) {
        this.onmessage?.(response);
      }
    } catch (error) {
      if (request?.cancelled) return;
      debugLogger.error(`Error sending to '${this.serverName}': ${error}`);

      if (this.onerror) {
        this.onerror(error instanceof Error ? error : new Error(String(error)));
      }

      throw error;
    } finally {
      if (request && this.pending.get(request.id) === request) {
        this.pending.delete(request.id);
      }
    }
  }

  /**
   * Close the transport
   */
  async close(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;
    debugLogger.debug(`Closed for server '${this.serverName}'`);

    if (this.onclose) {
      this.onclose();
    }
  }

  /**
   * Check if transport is started
   */
  isStarted(): boolean {
    return this.started;
  }

  /**
   * Get server name
   */
  getServerName(): string {
    return this.serverName;
  }
}
