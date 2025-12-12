/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Service API Types
 *
 * These interfaces define the public API contract for the ControlService facade.
 * They provide type-safe, domain-grouped access to control plane functionality
 * for internal CLI code (nonInteractiveCli, session managers, etc.).
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import type { PermissionSuggestion } from '../../types.js';

/**
 * Permission Service API
 *
 * Provides permission-related operations including tool execution approval,
 * permission suggestions, and tool call monitoring callbacks.
 */
export interface PermissionServiceAPI {
  /**
   * Build UI suggestions for tool confirmation dialogs
   *
   * Creates actionable permission suggestions based on tool confirmation details,
   * helping host applications present appropriate approval/denial options.
   *
   * @param confirmationDetails - Tool confirmation details (type, title, metadata)
   * @returns Array of permission suggestions or null if details are invalid
   */
  buildPermissionSuggestions(
    confirmationDetails: unknown,
  ): PermissionSuggestion[] | null;

  /**
   * Get callback for monitoring tool call status updates
   *
   * Returns a callback function that should be passed to executeToolCall
   * to enable integration with CoreToolScheduler updates. This callback
   * handles outgoing permission requests for tools awaiting approval.
   *
   * @returns Callback function that processes tool call updates
   */
  getToolCallUpdateCallback(): (toolCalls: unknown[]) => void;
}

/**
 * System Service API
 *
 * Provides system-level operations for the control system.
 *
 * Note: System messages and slash commands are NOT part of the control system API.
 * They are handled independently via buildSystemMessage() from nonInteractiveHelpers.ts,
 * regardless of whether the control system is available.
 */
export interface SystemServiceAPI {
  /**
   * Get control capabilities
   *
   * Returns the control capabilities object indicating what control
   * features are available. Used exclusively for the initialize control
   * response. System messages do not include capabilities as they are
   * independent of the control system.
   *
   * @returns Control capabilities object
   */
  getControlCapabilities(): Record<string, unknown>;
}

/**
 * MCP Service API
 *
 * Provides Model Context Protocol server interaction including
 * lazy client initialization and server discovery.
 */
export interface McpServiceAPI {
  /**
   * Get or create MCP client for a server (lazy initialization)
   *
   * Returns an existing client from cache or creates a new connection
   * if this is the first request for the server. Handles connection
   * lifecycle and error recovery.
   *
   * @param serverName - Name of the MCP server to connect to
   * @returns Promise resolving to client instance and server configuration
   * @throws Error if server is not configured or connection fails
   */
  getMcpClient(serverName: string): Promise<{
    client: Client;
    config: MCPServerConfig;
  }>;

  /**
   * List all available MCP servers
   *
   * Returns names of both SDK-managed and CLI-managed MCP servers
   * that are currently configured or connected.
   *
   * @returns Array of server names
   */
  listServers(): string[];
}

/**
 * Hook Service API
 *
 * Provides hook callback processing (placeholder for future expansion).
 */
export interface HookServiceAPI {
  // Future: Hook-related methods will be added here
  // For now, hook functionality is handled only via control requests
  registerHookCallback(callback: unknown): void;
}
