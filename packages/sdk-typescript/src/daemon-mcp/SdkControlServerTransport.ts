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
import { SdkLogger } from '../utils/logger.js';

export type SendToQueryCallback = (message: JSONRPCMessage) => Promise<void>;

export interface SdkControlServerTransportOptions {
  sendToQuery: SendToQueryCallback;
  serverName: string;
}

export class SdkControlServerTransport {
  sendToQuery: SendToQueryCallback;
  private serverName: string;
  private started = false;
  private logger;

  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(options: SdkControlServerTransportOptions) {
    this.sendToQuery = options.sendToQuery;
    this.serverName = options.serverName;
    this.logger = SdkLogger.createLogger(
      `SdkControlServerTransport:${options.serverName}`,
    );
  }

  async start(): Promise<void> {
    this.started = true;
    this.logger.debug('Transport started');
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started) {
      throw new Error(
        `SdkControlServerTransport (${this.serverName}) not started. Call start() first.`,
      );
    }

    try {
      this.logger.debug('Sending message to Query', message);
      await this.sendToQuery(message);
    } catch (error) {
      this.logger.error('Error sending message:', error);
      if (this.onerror) {
        this.onerror(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.started) {
      return; // Already closed
    }

    this.started = false;
    this.logger.debug('Transport closed');

    // Notify MCP Server
    if (this.onclose) {
      this.onclose();
    }
  }

  handleMessage(message: JSONRPCMessage): void {
    if (!this.started) {
      this.logger.warn('Received message for closed transport');
      return;
    }

    this.logger.debug('Handling message from CLI', message);
    if (this.onmessage) {
      this.onmessage(message);
    } else {
      this.logger.warn('No onmessage handler set');
    }
  }

  handleError(error: Error): void {
    this.logger.error('Transport error:', error);
    if (this.onerror) {
      this.onerror(error);
    }
  }

  isStarted(): boolean {
    return this.started;
  }

  getServerName(): string {
    return this.serverName;
  }
}
