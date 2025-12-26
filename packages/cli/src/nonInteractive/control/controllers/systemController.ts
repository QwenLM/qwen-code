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
  CLIMcpServerConfig,
} from '../../types.js';
import { getAvailableCommands } from '../../../nonInteractiveCliCommands.js';
import {
  MCPServerConfig,
  AuthProviderType,
  type MCPOAuthConfig,
} from '@qwen-code/qwen-code-core';

export class SystemController extends BaseController {
  /**
   * Handle system control requests
   */
  protected async handleRequestPayload(
    payload: ControlRequestPayload,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) {
      throw new Error('Request aborted');
    }

    switch (payload.subtype) {
      case 'initialize':
        return this.handleInitialize(
          payload as CLIControlInitializeRequest,
          signal,
        );

      case 'interrupt':
        return this.handleInterrupt();

      case 'set_model':
        return this.handleSetModel(
          payload as CLIControlSetModelRequest,
          signal,
        );

      case 'supported_commands':
        return this.handleSupportedCommands(signal);

      default:
        throw new Error(`Unsupported request subtype in SystemController`);
    }
  }

  /**
   * Handle initialize request
   *
   * Processes SDK MCP servers config.
   * SDK servers are registered in context.sdkMcpServers
   * and added to config.mcpServers with the sdk type flag.
   * External MCP servers are configured separately in settings.
   */
  private async handleInitialize(
    payload: CLIControlInitializeRequest,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) {
      throw new Error('Request aborted');
    }

    this.context.config.setSdkMode(true);

    // Process SDK MCP servers
    if (
      payload.sdkMcpServers &&
      typeof payload.sdkMcpServers === 'object' &&
      payload.sdkMcpServers !== null
    ) {
      const sdkServers: Record<string, MCPServerConfig> = {};
      for (const [key, wireConfig] of Object.entries(payload.sdkMcpServers)) {
        const name =
          typeof wireConfig?.name === 'string' && wireConfig.name.trim().length
            ? wireConfig.name
            : key;

        this.context.sdkMcpServers.add(name);
        sdkServers[name] = new MCPServerConfig(
          undefined, // command
          undefined, // args
          undefined, // env
          undefined, // cwd
          undefined, // url
          undefined, // httpUrl
          undefined, // headers
          undefined, // tcp
          undefined, // timeout
          true, // trust - SDK servers are trusted
          undefined, // description
          undefined, // includeTools
          undefined, // excludeTools
          undefined, // extensionName
          undefined, // oauth
          undefined, // authProviderType
          undefined, // targetAudience
          undefined, // targetServiceAccount
          'sdk', // type
        );
      }

      const sdkServerCount = Object.keys(sdkServers).length;
      if (sdkServerCount > 0) {
        try {
          this.context.config.addMcpServers(sdkServers);
          if (this.context.debugMode) {
            console.error(
              `[SystemController] Added ${sdkServerCount} SDK MCP servers to config`,
            );
          }
        } catch (error) {
          if (this.context.debugMode) {
            console.error(
              '[SystemController] Failed to add SDK MCP servers:',
              error,
            );
          }
        }
      }
    }

    if (
      payload.mcpServers &&
      typeof payload.mcpServers === 'object' &&
      payload.mcpServers !== null
    ) {
      const externalServers: Record<string, MCPServerConfig> = {};
      for (const [name, serverConfig] of Object.entries(payload.mcpServers)) {
        const normalized = this.normalizeMcpServerConfig(
          name,
          serverConfig as CLIMcpServerConfig | undefined,
        );
        if (normalized) {
          externalServers[name] = normalized;
        }
      }

      const externalCount = Object.keys(externalServers).length;
      if (externalCount > 0) {
        try {
          this.context.config.addMcpServers(externalServers);
          if (this.context.debugMode) {
            console.error(
              `[SystemController] Added ${externalCount} external MCP servers to config`,
            );
          }
        } catch (error) {
          if (this.context.debugMode) {
            console.error(
              '[SystemController] Failed to add external MCP servers:',
              error,
            );
          }
        }
      }
    }

    if (payload.agents && Array.isArray(payload.agents)) {
      try {
        this.context.config.setSessionSubagents(payload.agents);

        if (this.context.debugMode) {
          console.error(
            `[SystemController] Added ${payload.agents.length} session subagents to config`,
          );
        }
      } catch (error) {
        if (this.context.debugMode) {
          console.error(
            '[SystemController] Failed to add session subagents:',
            error,
          );
        }
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
      can_handle_hook_callback: false,
      can_set_permission_mode:
        typeof this.context.config.setApprovalMode === 'function',
      can_set_model: typeof this.context.config.setModel === 'function',
      // SDK MCP servers are supported - messages routed through control plane
      can_handle_mcp_message: true,
    };

    return capabilities;
  }

  private normalizeMcpServerConfig(
    serverName: string,
    config?: CLIMcpServerConfig,
  ): MCPServerConfig | null {
    if (!config || typeof config !== 'object') {
      if (this.context.debugMode) {
        console.error(
          `[SystemController] Ignoring invalid MCP server config for '${serverName}'`,
        );
      }
      return null;
    }

    const authProvider = this.normalizeAuthProviderType(
      config.authProviderType,
    );
    const oauthConfig = this.normalizeOAuthConfig(config.oauth);

    return new MCPServerConfig(
      config.command,
      config.args,
      config.env,
      config.cwd,
      config.url,
      config.httpUrl,
      config.headers,
      config.tcp,
      config.timeout,
      config.trust,
      config.description,
      config.includeTools,
      config.excludeTools,
      config.extensionName,
      oauthConfig,
      authProvider,
      config.targetAudience,
      config.targetServiceAccount,
    );
  }

  private normalizeAuthProviderType(
    value?: string,
  ): AuthProviderType | undefined {
    if (!value) {
      return undefined;
    }

    switch (value) {
      case AuthProviderType.DYNAMIC_DISCOVERY:
      case AuthProviderType.GOOGLE_CREDENTIALS:
      case AuthProviderType.SERVICE_ACCOUNT_IMPERSONATION:
        return value;
      default:
        if (this.context.debugMode) {
          console.error(
            `[SystemController] Unsupported authProviderType '${value}', skipping`,
          );
        }
        return undefined;
    }
  }

  private normalizeOAuthConfig(
    oauth?: CLIMcpServerConfig['oauth'],
  ): MCPOAuthConfig | undefined {
    if (!oauth) {
      return undefined;
    }

    return {
      enabled: oauth.enabled,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      authorizationUrl: oauth.authorizationUrl,
      tokenUrl: oauth.tokenUrl,
      scopes: oauth.scopes,
      audiences: oauth.audiences,
      redirectUri: oauth.redirectUri,
      tokenParamName: oauth.tokenParamName,
      registrationUrl: oauth.registrationUrl,
    };
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
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) {
      throw new Error('Request aborted');
    }

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
   * Returns list of supported slash commands loaded dynamically
   */
  private async handleSupportedCommands(
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) {
      throw new Error('Request aborted');
    }

    const slashCommands = await this.loadSlashCommandNames(signal);

    return {
      subtype: 'supported_commands',
      commands: slashCommands,
    };
  }

  /**
   * Load slash command names using getAvailableCommands
   *
   * @param signal - AbortSignal to respect for cancellation
   * @returns Promise resolving to array of slash command names
   */
  private async loadSlashCommandNames(signal: AbortSignal): Promise<string[]> {
    if (signal.aborted) {
      return [];
    }

    try {
      const commands = await getAvailableCommands(this.context.config, signal);

      if (signal.aborted) {
        return [];
      }

      // Extract command names and sort
      return commands.map((cmd) => cmd.name).sort();
    } catch (error) {
      // Check if the error is due to abort
      if (signal.aborted) {
        return [];
      }

      if (this.context.debugMode) {
        console.error(
          '[SystemController] Failed to load slash commands:',
          error,
        );
      }
      return [];
    }
  }
}
