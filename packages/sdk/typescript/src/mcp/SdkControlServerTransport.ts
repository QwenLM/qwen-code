/**
 * SdkControlServerTransport - bridges MCP Server with Query's control plane
 *
 * Implements @modelcontextprotocol/sdk Transport interface to enable
 * SDK-embedded MCP servers. Messages flow bidirectionally:
 *
 * MCP Server → send() → Query → control_request (mcp_message) → CLI
 * CLI → control_request (mcp_message) → Query → handleMessage() → MCP Server
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Callback type for sending messages to Query
 */
export type SendToQueryCallback = (message: JSONRPCMessage) => Promise<void>;

/**
 * SdkControlServerTransport options
 */
export interface SdkControlServerTransportOptions {
  sendToQuery: SendToQueryCallback;
  serverName: string;
}

/**
 * Transport adapter that bridges MCP Server with Query's control plane
 */
export class SdkControlServerTransport {
  public sendToQuery: SendToQueryCallback;
  private serverName: string;
  private started = false;

  /**
   * Callbacks set by MCP Server
   */
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(options: SdkControlServerTransportOptions) {
    this.sendToQuery = options.sendToQuery;
    this.serverName = options.serverName;
  }

  /**
   * Start the transport
   */
  async start(): Promise<void> {
    this.started = true;
  }

  /**
   * Send message from MCP Server to CLI via Query's control plane
   *
   * @param message - JSON-RPC message from MCP Server
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started) {
      throw new Error(
        `SdkControlServerTransport (${this.serverName}) not started. Call start() first.`,
      );
    }

    try {
      // Send via Query's control plane
      await this.sendToQuery(message);
    } catch (error) {
      // Invoke error callback if set
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
      return; // Already closed
    }

    this.started = false;

    // Notify MCP Server
    if (this.onclose) {
      this.onclose();
    }
  }

  /**
   * Handle incoming message from CLI
   *
   * @param message - JSON-RPC message from CLI
   */
  handleMessage(message: JSONRPCMessage): void {
    if (!this.started) {
      console.warn(
        `[SdkControlServerTransport] Received message for closed transport (${this.serverName})`,
      );
      return;
    }

    if (this.onmessage) {
      this.onmessage(message);
    } else {
      console.warn(
        `[SdkControlServerTransport] No onmessage handler set for ${this.serverName}`,
      );
    }
  }

  /**
   * Handle incoming error from CLI
   *
   * @param error - Error from CLI
   */
  handleError(error: Error): void {
    if (this.onerror) {
      this.onerror(error);
    } else {
      console.error(
        `[SdkControlServerTransport] Error for ${this.serverName}:`,
        error,
      );
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

/**
 * Create SdkControlServerTransport instance
 */
export function createSdkControlServerTransport(
  options: SdkControlServerTransportOptions,
): SdkControlServerTransport {
  return new SdkControlServerTransport(options);
}
