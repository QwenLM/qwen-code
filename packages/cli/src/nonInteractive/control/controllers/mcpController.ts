/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Controller
 *
 * Handles MCP-related control requests:
 * - mcp_message: Route MCP messages
 * - mcp_server_status: Return MCP server status
 */

import { BaseController } from './baseController.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
  ControlRequestPayload,
  CLIControlMcpMessageRequest,
} from '../../types.js';
import type {
  MCPServerConfig,
  WorkspaceContext,
} from '@qwen-code/qwen-code-core';
import {
  connectToMcpServer,
  MCP_DEFAULT_TIMEOUT_MSEC,
} from '@qwen-code/qwen-code-core';

export class MCPController extends BaseController {
  /**
   * Handle MCP control requests
   */
  protected async handleRequestPayload(
    payload: ControlRequestPayload,
    _signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (payload.subtype) {
      case 'mcp_message':
        return this.handleMcpMessage(payload as CLIControlMcpMessageRequest);

      case 'mcp_server_status':
        return this.handleMcpStatus();

      default:
        throw new Error(`Unsupported request subtype in MCPController`);
    }
  }

  /**
   * Handle mcp_message request
   *
   * Routes JSON-RPC messages to MCP servers
   */
  private async handleMcpMessage(
    payload: CLIControlMcpMessageRequest,
  ): Promise<Record<string, unknown>> {
    const serverNameRaw = payload.server_name;
    if (
      typeof serverNameRaw !== 'string' ||
      serverNameRaw.trim().length === 0
    ) {
      throw new Error('Missing server_name in mcp_message request');
    }

    const message = payload.message;
    if (!message || typeof message !== 'object') {
      throw new Error(
        'Missing or invalid message payload for mcp_message request',
      );
    }

    // Get or create MCP client
    let clientEntry: { client: Client; config: MCPServerConfig };
    try {
      clientEntry = await this.getOrCreateMcpClient(serverNameRaw.trim());
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : 'Failed to connect to MCP server',
      );
    }

    const method = message.method;
    if (typeof method !== 'string' || method.trim().length === 0) {
      throw new Error('Invalid MCP message: missing method');
    }

    const jsonrpcVersion =
      typeof message.jsonrpc === 'string' ? message.jsonrpc : '2.0';
    const messageId = message.id;
    const params = message.params;
    const timeout =
      typeof clientEntry.config.timeout === 'number'
        ? clientEntry.config.timeout
        : MCP_DEFAULT_TIMEOUT_MSEC;

    try {
      // Handle notification (no id)
      if (messageId === undefined) {
        await clientEntry.client.notification({
          method,
          params,
        });
        return {
          subtype: 'mcp_message',
          mcp_response: {
            jsonrpc: jsonrpcVersion,
            id: null,
            result: { success: true, acknowledged: true },
          },
        };
      }

      // Handle request (with id)
      const result = await clientEntry.client.request(
        {
          method,
          params,
        },
        ResultSchema,
        { timeout },
      );

      return {
        subtype: 'mcp_message',
        mcp_response: {
          jsonrpc: jsonrpcVersion,
          id: messageId,
          result,
        },
      };
    } catch (error) {
      // If connection closed, remove from cache
      if (error instanceof Error && /closed/i.test(error.message)) {
        this.context.mcpClients.delete(serverNameRaw.trim());
      }

      const errorCode =
        typeof (error as { code?: unknown })?.code === 'number'
          ? ((error as { code: number }).code as number)
          : -32603;
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Failed to execute MCP request';
      const errorData = (error as { data?: unknown })?.data;

      const errorBody: Record<string, unknown> = {
        code: errorCode,
        message: errorMessage,
      };
      if (errorData !== undefined) {
        errorBody['data'] = errorData;
      }

      return {
        subtype: 'mcp_message',
        mcp_response: {
          jsonrpc: jsonrpcVersion,
          id: messageId ?? null,
          error: errorBody,
        },
      };
    }
  }

  /**
   * Handle mcp_server_status request
   *
   * Returns status of registered MCP servers
   */
  private async handleMcpStatus(): Promise<Record<string, unknown>> {
    const status: Record<string, string> = {};

    // Include SDK MCP servers
    for (const serverName of this.context.sdkMcpServers) {
      status[serverName] = 'connected';
    }

    // Include CLI-managed MCP clients
    for (const serverName of this.context.mcpClients.keys()) {
      status[serverName] = 'connected';
    }

    if (this.context.debugMode) {
      console.error(
        `[MCPController] MCP status: ${Object.keys(status).length} servers`,
      );
    }

    return status;
  }

  /**
   * Get or create MCP client for a server
   *
   * Implements lazy connection and caching
   */
  private async getOrCreateMcpClient(
    serverName: string,
  ): Promise<{ client: Client; config: MCPServerConfig }> {
    // Check cache first
    const cached = this.context.mcpClients.get(serverName);
    if (cached) {
      return cached;
    }

    // Get server configuration
    const provider = this.context.config as unknown as {
      getMcpServers?: () => Record<string, MCPServerConfig> | undefined;
      getDebugMode?: () => boolean;
      getWorkspaceContext?: () => unknown;
    };

    if (typeof provider.getMcpServers !== 'function') {
      throw new Error(`MCP server "${serverName}" is not configured`);
    }

    const servers = provider.getMcpServers() ?? {};
    const serverConfig = servers[serverName];
    if (!serverConfig) {
      throw new Error(`MCP server "${serverName}" is not configured`);
    }

    const debugMode =
      typeof provider.getDebugMode === 'function'
        ? provider.getDebugMode()
        : false;

    const workspaceContext =
      typeof provider.getWorkspaceContext === 'function'
        ? provider.getWorkspaceContext()
        : undefined;

    if (!workspaceContext) {
      throw new Error('Workspace context is not available for MCP connection');
    }

    // Connect to MCP server
    const client = await connectToMcpServer(
      serverName,
      serverConfig,
      debugMode,
      workspaceContext as WorkspaceContext,
    );

    // Cache the client
    const entry = { client, config: serverConfig };
    this.context.mcpClients.set(serverName, entry);

    if (this.context.debugMode) {
      console.error(`[MCPController] Connected to MCP server: ${serverName}`);
    }

    return entry;
  }

  /**
   * Cleanup MCP clients
   */
  override cleanup(): void {
    if (this.context.debugMode) {
      console.error(
        `[MCPController] Cleaning up ${this.context.mcpClients.size} MCP clients`,
      );
    }

    // Close all MCP clients
    for (const [serverName, { client }] of this.context.mcpClients.entries()) {
      try {
        client.close();
      } catch (error) {
        if (this.context.debugMode) {
          console.error(
            `[MCPController] Failed to close MCP client ${serverName}:`,
            error,
          );
        }
      }
    }

    this.context.mcpClients.clear();
  }
}
