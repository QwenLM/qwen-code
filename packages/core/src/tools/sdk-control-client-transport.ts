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

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

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
  private debugMode: boolean;
  private started = false;

  // Transport interface callbacks
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(options: SdkControlClientTransportOptions) {
    this.serverName = options.serverName;
    this.sendMcpMessage = options.sendMcpMessage;
    this.debugMode = options.debugMode ?? false;
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

    if (this.debugMode) {
      console.error(
        `[SdkControlClientTransport] Started for server '${this.serverName}'`,
      );
    }
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

    if (this.debugMode) {
      console.error(
        `[SdkControlClientTransport] Sending message to '${this.serverName}':`,
        JSON.stringify(message),
      );
    }

    try {
      // Send message to SDK and wait for response
      const response = await this.sendMcpMessage(this.serverName, message);

      if (this.debugMode) {
        console.error(
          `[SdkControlClientTransport] Received response from '${this.serverName}':`,
          JSON.stringify(response),
        );
      }

      // Deliver response via onmessage callback
      if (this.onmessage) {
        this.onmessage(response);
      }
    } catch (error) {
      if (this.debugMode) {
        console.error(
          `[SdkControlClientTransport] Error sending to '${this.serverName}':`,
          error,
        );
      }

      if (this.onerror) {
        this.onerror(error instanceof Error ? error : new Error(String(error)));
      }

      throw error;
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

    if (this.debugMode) {
      console.error(
        `[SdkControlClientTransport] Closed for server '${this.serverName}'`,
      );
    }

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
