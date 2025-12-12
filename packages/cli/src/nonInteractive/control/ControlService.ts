/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Control Service - Public Programmatic API
 *
 * Provides type-safe access to control plane functionality for internal
 * CLI code. This is the ONLY programmatic interface that should be used by:
 * - nonInteractiveCli
 * - Session managers
 * - Tool execution handlers
 * - Internal CLI logic
 *
 * DO NOT use ControlDispatcher or controllers directly from application code.
 *
 * Architecture:
 * - ControlContext stores shared session state (Layer 1)
 * - ControlDispatcher handles protocol-level routing (Layer 2)
 * - ControlService provides programmatic API for internal CLI usage (Layer 3)
 *
 * ControlService and ControlDispatcher share controller instances to ensure
 * a single source of truth. All higher level code MUST access the control
 * plane exclusively through ControlService.
 */

import type { IControlContext } from './ControlContext.js';
import type { ControlDispatcher } from './ControlDispatcher.js';
import type {
  PermissionServiceAPI,
  SystemServiceAPI,
  // McpServiceAPI,
  // HookServiceAPI,
} from './types/serviceAPIs.js';

/**
 * Control Service
 *
 * Facade layer providing domain-grouped APIs for control plane operations.
 * Shares controller instances with ControlDispatcher to ensure single source
 * of truth and state consistency.
 */
export class ControlService {
  private dispatcher: ControlDispatcher;

  /**
   * Construct ControlService
   *
   * @param context - Control context (unused directly, passed to dispatcher)
   * @param dispatcher - Control dispatcher that owns the controller instances
   */
  constructor(context: IControlContext, dispatcher: ControlDispatcher) {
    this.dispatcher = dispatcher;
  }

  /**
   * Permission Domain API
   *
   * Handles tool execution permissions, approval checks, and callbacks.
   * Delegates to the shared PermissionController instance.
   */
  get permission(): PermissionServiceAPI {
    const controller = this.dispatcher.permissionController;
    return {
      /**
       * Build UI suggestions for tool confirmation dialogs
       *
       * Creates actionable permission suggestions based on tool confirmation details.
       *
       * @param confirmationDetails - Tool confirmation details
       * @returns Array of permission suggestions or null
       */
      buildPermissionSuggestions:
        controller.buildPermissionSuggestions.bind(controller),

      /**
       * Get callback for monitoring tool call status updates
       *
       * Returns callback function for integration with CoreToolScheduler.
       *
       * @returns Callback function for tool call updates
       */
      getToolCallUpdateCallback:
        controller.getToolCallUpdateCallback.bind(controller),
    };
  }

  /**
   * System Domain API
   *
   * Handles system-level operations and session management.
   * Delegates to the shared SystemController instance.
   */
  get system(): SystemServiceAPI {
    const controller = this.dispatcher.systemController;
    return {
      /**
       * Get control capabilities
       *
       * Returns the control capabilities object indicating what control
       * features are available. Used exclusively for the initialize
       * control response. System messages do not include capabilities.
       *
       * @returns Control capabilities object
       */
      getControlCapabilities: () => controller.buildControlCapabilities(),
    };
  }

  /**
   * MCP Domain API
   *
   * Handles Model Context Protocol server interactions.
   * Delegates to the shared MCPController instance.
   */
  // get mcp(): McpServiceAPI {
  //   return {
  //     /**
  //      * Get or create MCP client for a server (lazy initialization)
  //      *
  //      * Returns existing client or creates new connection.
  //      *
  //      * @param serverName - Name of the MCP server
  //      * @returns Promise with client and config
  //      */
  //     getMcpClient: async (serverName: string) => {
  //       // MCPController has a private method getOrCreateMcpClient
  //       // We need to expose it via the API
  //       // For now, throw error as placeholder
  //       // The actual implementation will be added when we update MCPController
  //       throw new Error(
  //         `getMcpClient not yet implemented in ControlService. Server: ${serverName}`,
  //       );
  //     },
  //
  //     /**
  //      * List all available MCP servers
  //      *
  //      * Returns names of configured/connected MCP servers.
  //      *
  //      * @returns Array of server names
  //      */
  //     listServers: () => {
  //       // Get servers from context
  //       const sdkServers = Array.from(
  //         this.dispatcher.mcpController['context'].sdkMcpServers,
  //       );
  //       const cliServers = Array.from(
  //         this.dispatcher.mcpController['context'].mcpClients.keys(),
  //       );
  //       return [...new Set([...sdkServers, ...cliServers])];
  //     },
  //   };
  // }

  /**
   * Hook Domain API
   *
   * Handles hook callback processing (placeholder for future expansion).
   * Delegates to the shared HookController instance.
   */
  // get hook(): HookServiceAPI {
  //   // HookController has no public methods yet - controller access reserved for future use
  //   return {};
  // }

  /**
   * Cleanup all controllers
   *
   * Should be called on session shutdown. Delegates to dispatcher's shutdown
   * method to ensure all controllers are properly cleaned up.
   */
  cleanup(): void {
    // Delegate to dispatcher which manages controller cleanup
    this.dispatcher.shutdown();
  }
}
