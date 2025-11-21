/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * System Controller
 *
 * Handles system-level control requests:
 * - initialize: Setup session and return system info
 * - interrupt: Cancel current operations
 * - set_model: Switch model (placeholder)
 */

import { BaseController } from './baseController.js';
import type {
  ControlRequestPayload,
  CLIControlInitializeRequest,
  CLIControlSetModelRequest,
} from '../../types.js';

export class SystemController extends BaseController {
  /**
   * Handle system control requests
   */
  protected async handleRequestPayload(
    payload: ControlRequestPayload,
    _signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (payload.subtype) {
      case 'initialize':
        return this.handleInitialize(payload as CLIControlInitializeRequest);

      case 'interrupt':
        return this.handleInterrupt();

      case 'set_model':
        return this.handleSetModel(payload as CLIControlSetModelRequest);

      case 'supported_commands':
        return this.handleSupportedCommands();

      default:
        throw new Error(`Unsupported request subtype in SystemController`);
    }
  }

  /**
   * Handle initialize request
   *
   * Registers SDK MCP servers and returns capabilities
   */
  private async handleInitialize(
    payload: CLIControlInitializeRequest,
  ): Promise<Record<string, unknown>> {
    // Register SDK MCP servers if provided
    if (payload.sdkMcpServers && Array.isArray(payload.sdkMcpServers)) {
      for (const serverName of payload.sdkMcpServers) {
        this.context.sdkMcpServers.add(serverName);
      }
    }

    // Build capabilities for response
    const capabilities = this.buildControlCapabilities();

    if (this.context.debugMode) {
      console.error(
        `[SystemController] Initialized with ${this.context.sdkMcpServers.size} SDK MCP servers`,
      );
    }

    return {
      subtype: 'initialize',
      capabilities,
    };
  }

  /**
   * Build control capabilities for initialize control response
   *
   * This method constructs the control capabilities object that indicates
   * what control features are available. It is used exclusively in the
   * initialize control response.
   */
  buildControlCapabilities(): Record<string, unknown> {
    const capabilities: Record<string, unknown> = {
      can_handle_can_use_tool: true,
      can_handle_hook_callback: true,
      can_set_permission_mode:
        typeof this.context.config.setApprovalMode === 'function',
      can_set_model: typeof this.context.config.setModel === 'function',
    };

    // Check if MCP message handling is available
    try {
      const mcpProvider = this.context.config as unknown as {
        getMcpServers?: () => Record<string, unknown> | undefined;
      };
      if (typeof mcpProvider.getMcpServers === 'function') {
        const servers = mcpProvider.getMcpServers();
        capabilities['can_handle_mcp_message'] = Boolean(
          servers && Object.keys(servers).length > 0,
        );
      } else {
        capabilities['can_handle_mcp_message'] = false;
      }
    } catch (error) {
      if (this.context.debugMode) {
        console.error(
          '[SystemController] Failed to determine MCP capability:',
          error,
        );
      }
      capabilities['can_handle_mcp_message'] = false;
    }

    return capabilities;
  }

  /**
   * Handle interrupt request
   *
   * Triggers the interrupt callback to cancel current operations
   */
  private async handleInterrupt(): Promise<Record<string, unknown>> {
    // Trigger interrupt callback if available
    if (this.context.onInterrupt) {
      this.context.onInterrupt();
    }

    // Abort the main signal to cancel ongoing operations
    if (this.context.abortSignal && !this.context.abortSignal.aborted) {
      // Note: We can't directly abort the signal, but the onInterrupt callback should handle this
      if (this.context.debugMode) {
        console.error('[SystemController] Interrupt signal triggered');
      }
    }

    if (this.context.debugMode) {
      console.error('[SystemController] Interrupt handled');
    }

    return { subtype: 'interrupt' };
  }

  /**
   * Handle set_model request
   *
   * Implements actual model switching with validation and error handling
   */
  private async handleSetModel(
    payload: CLIControlSetModelRequest,
  ): Promise<Record<string, unknown>> {
    const model = payload.model;

    // Validate model parameter
    if (typeof model !== 'string' || model.trim() === '') {
      throw new Error('Invalid model specified for set_model request');
    }

    try {
      // Attempt to set the model using config
      await this.context.config.setModel(model);

      if (this.context.debugMode) {
        console.error(`[SystemController] Model switched to: ${model}`);
      }

      return {
        subtype: 'set_model',
        model,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to set model';

      if (this.context.debugMode) {
        console.error(
          `[SystemController] Failed to set model ${model}:`,
          error,
        );
      }

      throw new Error(errorMessage);
    }
  }

  /**
   * Handle supported_commands request
   *
   * Returns list of supported control commands
   *
   * Note: This list should match the ControlRequestType enum in
   * packages/sdk/typescript/src/types/controlRequests.ts
   */
  private async handleSupportedCommands(): Promise<Record<string, unknown>> {
    const commands = [
      'initialize',
      'interrupt',
      'set_model',
      'supported_commands',
      'can_use_tool',
      'set_permission_mode',
      'mcp_message',
      'mcp_server_status',
      'hook_callback',
    ];

    return {
      subtype: 'supported_commands',
      commands,
    };
  }
}
