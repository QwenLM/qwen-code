/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SDK MCP Controller
 *
 * Handles MCP communication between CLI MCP clients and SDK MCP servers:
 * - Provides sendSdkMcpMessage callback for CLI → SDK MCP message routing
 * - mcp_server_status: Returns status of SDK MCP servers
 *
 * Message Flow (CLI MCP Client → SDK MCP Server):
 * CLI MCP Client → SdkControlClientTransport.send() →
 * sendSdkMcpMessage callback → control_request (mcp_message) → SDK →
 * SDK MCP Server processes → control_response → CLI MCP Client
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { BaseController } from './baseController.js';
import type {
  ControlRequestPayload,
  CLIControlMcpMessageRequest,
} from '../../types.js';

const MCP_REQUEST_TIMEOUT = 30_000; // 30 seconds

export class SdkMcpController extends BaseController {
  /**
   * Handle SDK MCP control requests from ControlDispatcher
   *
   * Note: mcp_message requests are NOT handled here. CLI MCP clients
   * send messages via the sendSdkMcpMessage callback directly, not
   * through the control dispatcher.
   */
  protected async handleRequestPayload(
    payload: ControlRequestPayload,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) {
      throw new Error('Request aborted');
    }

    switch (payload.subtype) {
      case 'mcp_server_status':
        return this.handleMcpStatus();

      default:
        throw new Error(`Unsupported request subtype in SdkMcpController`);
    }
  }

  /**
   * Handle mcp_server_status request
   *
   * Returns status of all registered SDK MCP servers.
   * SDK servers are considered "connected" if they are registered.
   */
  private async handleMcpStatus(): Promise<Record<string, unknown>> {
    const status: Record<string, string> = {};

    for (const serverName of this.context.sdkMcpServers) {
      // SDK MCP servers are "connected" once registered since they run in SDK process
      status[serverName] = 'connected';
    }

    return {
      subtype: 'mcp_server_status',
      status,
    };
  }

  /**
   * Send MCP message to SDK server via control plane
   *
   * @param serverName - Name of the SDK MCP server
   * @param message - MCP JSON-RPC message to send
   * @returns MCP JSON-RPC response from SDK server
   */
  private async sendMcpMessageToSdk(
    serverName: string,
    message: JSONRPCMessage,
  ): Promise<JSONRPCMessage> {
    if (this.context.debugMode) {
      console.error(
        `[SdkMcpController] Sending MCP message to SDK server '${serverName}':`,
        JSON.stringify(message),
      );
    }

    // Send control request to SDK with the MCP message
    const response = await this.sendControlRequest(
      {
        subtype: 'mcp_message',
        server_name: serverName,
        message: message as CLIControlMcpMessageRequest['message'],
      },
      MCP_REQUEST_TIMEOUT,
      this.context.abortSignal,
    );

    // Extract MCP response from control response
    const responsePayload = response.response as Record<string, unknown>;
    const mcpResponse = responsePayload?.['mcp_response'] as JSONRPCMessage;

    if (!mcpResponse) {
      throw new Error(
        `Invalid MCP response from SDK for server '${serverName}'`,
      );
    }

    if (this.context.debugMode) {
      console.error(
        `[SdkMcpController] Received MCP response from SDK server '${serverName}':`,
        JSON.stringify(mcpResponse),
      );
    }

    return mcpResponse;
  }

  /**
   * Create a callback function for sending MCP messages to SDK servers.
   *
   * This callback is used by McpClientManager/SdkControlClientTransport to send
   * MCP messages from CLI MCP clients to SDK MCP servers via the control plane.
   *
   * @returns A function that sends MCP messages to SDK and returns the response
   */
  createSendSdkMcpMessage(): (
    serverName: string,
    message: JSONRPCMessage,
  ) => Promise<JSONRPCMessage> {
    return (serverName: string, message: JSONRPCMessage) =>
      this.sendMcpMessageToSdk(serverName, message);
  }
}
