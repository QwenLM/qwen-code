/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { isSdkMcpServerConfig } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  McpClient,
  MCPDiscoveryState,
  MCPServerStatus,
  populateMcpServerCommand,
} from './mcp-client.js';
import type { SendSdkMcpMessage } from './mcp-client.js';
import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { EventEmitter } from 'node:events';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

const debugLogger = createDebugLogger('MCP');

/**
 * Configuration for MCP health monitoring
 */
export interface MCPHealthMonitorConfig {
  /** Health check interval in milliseconds (default: 30000ms) */
  checkIntervalMs: number;
  /** Number of consecutive failures before marking as disconnected (default: 3) */
  maxConsecutiveFailures: number;
  /** Enable automatic reconnection (default: true) */
  autoReconnect: boolean;
  /** Delay before reconnection attempt in milliseconds (default: 5000ms) */
  reconnectDelayMs: number;
}

const DEFAULT_HEALTH_CONFIG: MCPHealthMonitorConfig = {
  checkIntervalMs: 30000, // 30 seconds
  maxConsecutiveFailures: 3,
  autoReconnect: true,
  reconnectDelayMs: 5000, // 5 seconds
};

/**
 * Manages the lifecycle of multiple MCP clients, including local child processes.
 * This class is responsible for starting, stopping, and discovering tools from
 * a collection of MCP servers defined in the configuration.
 */
export class McpClientManager {
  private clients: Map<string, McpClient> = new Map();
  private readonly toolRegistry: ToolRegistry;
  private readonly cliConfig: Config;
  private discoveryState: MCPDiscoveryState = MCPDiscoveryState.NOT_STARTED;
  private readonly eventEmitter?: EventEmitter;
  private readonly sendSdkMcpMessage?: SendSdkMcpMessage;
  private healthConfig: MCPHealthMonitorConfig;
  private healthCheckTimers: Map<string, NodeJS.Timeout> = new Map();
  private consecutiveFailures: Map<string, number> = new Map();
  private isReconnecting: Map<string, boolean> = new Map();

  constructor(
    config: Config,
    toolRegistry: ToolRegistry,
    eventEmitter?: EventEmitter,
    sendSdkMcpMessage?: SendSdkMcpMessage,
    healthConfig?: Partial<MCPHealthMonitorConfig>,
  ) {
    this.cliConfig = config;
    this.toolRegistry = toolRegistry;

    this.eventEmitter = eventEmitter;
    this.sendSdkMcpMessage = sendSdkMcpMessage;
    this.healthConfig = { ...DEFAULT_HEALTH_CONFIG, ...healthConfig };
  }

  /**
   * Initiates the tool discovery process for all configured MCP servers.
   * It connects to each server, discovers its available tools, and registers
   * them with the `ToolRegistry`.
   */
  async discoverAllMcpTools(cliConfig: Config): Promise<void> {
    if (!cliConfig.isTrustedFolder()) {
      return;
    }
    await this.stop();

    const servers = populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
    );

    this.discoveryState = MCPDiscoveryState.IN_PROGRESS;

    this.eventEmitter?.emit('mcp-client-update', this.clients);
    const discoveryPromises = Object.entries(servers).map(
      async ([name, config]) => {
        // Skip disabled servers
        if (cliConfig.isMcpServerDisabled(name)) {
          debugLogger.debug(`Skipping disabled MCP server: ${name}`);
          return;
        }

        // For SDK MCP servers, pass the sendSdkMcpMessage callback
        const sdkCallback = isSdkMcpServerConfig(config)
          ? this.sendSdkMcpMessage
          : undefined;

        const client = new McpClient(
          name,
          config,
          this.toolRegistry,
          this.cliConfig.getPromptRegistry(),
          this.cliConfig.getWorkspaceContext(),
          this.cliConfig.getDebugMode(),
          sdkCallback,
        );
        this.clients.set(name, client);

        this.eventEmitter?.emit('mcp-client-update', this.clients);
        try {
          await client.connect();
          await client.discover(cliConfig);
          this.eventEmitter?.emit('mcp-client-update', this.clients);
        } catch (error) {
          this.eventEmitter?.emit('mcp-client-update', this.clients);
          // Log the error but don't let a single failed server stop the others
          debugLogger.error(
            `Error during discovery for server '${name}': ${getErrorMessage(
              error,
            )}`,
          );
        }
      },
    );

    await Promise.all(discoveryPromises);
    this.discoveryState = MCPDiscoveryState.COMPLETED;
  }

  /**
   * Connects to a single MCP server and discovers its tools/prompts.
   * The connected client is tracked so it can be closed by {@link stop}.
   *
   * This is primarily used for on-demand re-discovery flows (e.g. after OAuth).
   */
  async discoverMcpToolsForServer(
    serverName: string,
    cliConfig: Config,
  ): Promise<void> {
    const servers = populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
    );
    const serverConfig = servers[serverName];
    if (!serverConfig) {
      return;
    }

    // Ensure we don't leak an existing connection for this server.
    const existingClient = this.clients.get(serverName);
    if (existingClient) {
      try {
        await existingClient.disconnect();
      } catch (error) {
        debugLogger.error(
          `Error stopping client '${serverName}': ${getErrorMessage(error)}`,
        );
      } finally {
        this.clients.delete(serverName);
        this.eventEmitter?.emit('mcp-client-update', this.clients);
      }
    }

    // For SDK MCP servers, pass the sendSdkMcpMessage callback.
    const sdkCallback = isSdkMcpServerConfig(serverConfig)
      ? this.sendSdkMcpMessage
      : undefined;

    const client = new McpClient(
      serverName,
      serverConfig,
      this.toolRegistry,
      this.cliConfig.getPromptRegistry(),
      this.cliConfig.getWorkspaceContext(),
      this.cliConfig.getDebugMode(),
      sdkCallback,
    );

    this.clients.set(serverName, client);
    this.eventEmitter?.emit('mcp-client-update', this.clients);

    try {
      await client.connect();
      await client.discover(cliConfig);
      // Start health check for this server after successful discovery
      this.startHealthCheck(serverName);
    } catch (error) {
      // Log the error but don't throw: callers expect best-effort discovery.
      debugLogger.error(
        `Error during discovery for server '${serverName}': ${getErrorMessage(
          error,
        )}`,
      );
    } finally {
      this.eventEmitter?.emit('mcp-client-update', this.clients);
    }
  }

  /**
   * Stops all running local MCP servers and closes all client connections.
   * This is the cleanup method to be called on application exit.
   */
  async stop(): Promise<void> {
    // Stop all health checks first
    this.stopAllHealthChecks();

    const disconnectionPromises = Array.from(this.clients.entries()).map(
      async ([name, client]) => {
        try {
          await client.disconnect();
        } catch (error) {
          debugLogger.error(
            `Error stopping client '${name}': ${getErrorMessage(error)}`,
          );
        }
      },
    );

    await Promise.all(disconnectionPromises);
    this.clients.clear();
    this.consecutiveFailures.clear();
    this.isReconnecting.clear();
  }

  /**
   * Disconnects a specific MCP server.
   * @param serverName The name of the server to disconnect.
   */
  async disconnectServer(serverName: string): Promise<void> {
    // Stop health check for this server
    this.stopHealthCheck(serverName);

    const client = this.clients.get(serverName);
    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        debugLogger.error(
          `Error disconnecting client '${serverName}': ${getErrorMessage(error)}`,
        );
      } finally {
        this.clients.delete(serverName);
        this.consecutiveFailures.delete(serverName);
        this.isReconnecting.delete(serverName);
        this.eventEmitter?.emit('mcp-client-update', this.clients);
      }
    }
  }

  getDiscoveryState(): MCPDiscoveryState {
    return this.discoveryState;
  }

  /**
   * Gets the health monitoring configuration
   */
  getHealthConfig(): MCPHealthMonitorConfig {
    return { ...this.healthConfig };
  }

  /**
   * Updates the health monitoring configuration
   */
  updateHealthConfig(config: Partial<MCPHealthMonitorConfig>): void {
    this.healthConfig = { ...this.healthConfig, ...config };
    // Restart health checks with new configuration
    this.stopAllHealthChecks();
    if (this.healthConfig.autoReconnect) {
      this.startAllHealthChecks();
    }
  }

  /**
   * Starts health monitoring for a specific server
   */
  private startHealthCheck(serverName: string): void {
    if (!this.healthConfig.autoReconnect) {
      return;
    }

    // Clear existing timer if any
    this.stopHealthCheck(serverName);

    const timer = setInterval(async () => {
      await this.performHealthCheck(serverName);
    }, this.healthConfig.checkIntervalMs);

    this.healthCheckTimers.set(serverName, timer);
  }

  /**
   * Stops health monitoring for a specific server
   */
  private stopHealthCheck(serverName: string): void {
    const timer = this.healthCheckTimers.get(serverName);
    if (timer) {
      clearInterval(timer);
      this.healthCheckTimers.delete(serverName);
    }
  }

  /**
   * Stops all health checks
   */
  private stopAllHealthChecks(): void {
    for (const [, timer] of this.healthCheckTimers.entries()) {
      clearInterval(timer);
    }
    this.healthCheckTimers.clear();
  }

  /**
   * Starts health checks for all connected servers
   */
  private startAllHealthChecks(): void {
    for (const serverName of this.clients.keys()) {
      this.startHealthCheck(serverName);
    }
  }

  /**
   * Performs a health check on a specific server
   */
  private async performHealthCheck(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (!client) {
      return;
    }

    // Skip if already reconnecting
    if (this.isReconnecting.get(serverName)) {
      return;
    }

    try {
      // Check if client is connected by getting its status
      const status = client.getStatus();

      if (status !== MCPServerStatus.CONNECTED) {
        // Connection is not healthy
        const failures = (this.consecutiveFailures.get(serverName) || 0) + 1;
        this.consecutiveFailures.set(serverName, failures);

        debugLogger.warn(
          `Health check failed for server '${serverName}' (${failures}/${this.healthConfig.maxConsecutiveFailures})`,
        );

        if (failures >= this.healthConfig.maxConsecutiveFailures) {
          // Trigger reconnection
          await this.reconnectServer(serverName);
        }
      } else {
        // Connection is healthy, reset failure count
        this.consecutiveFailures.set(serverName, 0);
      }
    } catch (error) {
      debugLogger.error(
        `Error during health check for server '${serverName}': ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Reconnects a specific server
   */
  private async reconnectServer(serverName: string): Promise<void> {
    if (this.isReconnecting.get(serverName)) {
      return;
    }

    this.isReconnecting.set(serverName, true);
    debugLogger.info(`Attempting to reconnect to server '${serverName}'...`);

    try {
      // Wait before reconnecting
      await new Promise((resolve) =>
        setTimeout(resolve, this.healthConfig.reconnectDelayMs),
      );

      await this.discoverMcpToolsForServer(serverName, this.cliConfig);

      // Reset failure count on successful reconnection
      this.consecutiveFailures.set(serverName, 0);
      debugLogger.info(`Successfully reconnected to server '${serverName}'`);
    } catch (error) {
      debugLogger.error(
        `Failed to reconnect to server '${serverName}': ${getErrorMessage(error)}`,
      );
    } finally {
      this.isReconnecting.set(serverName, false);
    }
  }

  /**
   * Discovers tools incrementally for all configured servers.
   * Only updates servers that have changed or are new.
   */
  async discoverAllMcpToolsIncremental(cliConfig: Config): Promise<void> {
    if (!cliConfig.isTrustedFolder()) {
      return;
    }

    const servers = populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
    );

    this.discoveryState = MCPDiscoveryState.IN_PROGRESS;

    // Find servers that are new or have changed configuration
    const serversToUpdate: string[] = [];
    const currentServerNames = new Set(this.clients.keys());
    const newServerNames = new Set(Object.keys(servers));

    // Check for new servers or configuration changes
    for (const [name] of Object.entries(servers)) {
      const existingClient = this.clients.get(name);
      if (!existingClient) {
        // New server
        serversToUpdate.push(name);
      } else if (existingClient.getStatus() === MCPServerStatus.DISCONNECTED) {
        // Disconnected server, try to reconnect
        serversToUpdate.push(name);
      }
      // Note: Configuration change detection would require comparing
      // the old and new config, which is not implemented here
    }

    // Find removed servers
    for (const name of currentServerNames) {
      if (!newServerNames.has(name)) {
        // Server was removed from configuration
        await this.removeServer(name);
      }
    }

    // Update only the servers that need it
    const discoveryPromises = serversToUpdate.map(async (name) => {
      try {
        await this.discoverMcpToolsForServer(name, cliConfig);
      } catch (error) {
        debugLogger.error(
          `Error during incremental discovery for server '${name}': ${getErrorMessage(error)}`,
        );
      }
    });

    await Promise.all(discoveryPromises);

    // Start health checks for all connected servers
    if (this.healthConfig.autoReconnect) {
      this.startAllHealthChecks();
    }

    this.discoveryState = MCPDiscoveryState.COMPLETED;
  }

  /**
   * Removes a server and its tools
   */
  private async removeServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        debugLogger.error(
          `Error disconnecting removed server '${serverName}': ${getErrorMessage(error)}`,
        );
      }
      this.clients.delete(serverName);
      this.stopHealthCheck(serverName);
      this.consecutiveFailures.delete(serverName);
    }

    // Remove tools for this server from registry
    this.toolRegistry.removeMcpToolsByServer(serverName);

    this.eventEmitter?.emit('mcp-client-update', this.clients);
  }

  async readResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadResourceResult> {
    let client = this.clients.get(serverName);
    if (!client) {
      const servers = populateMcpServerCommand(
        this.cliConfig.getMcpServers() || {},
        this.cliConfig.getMcpServerCommand(),
      );
      const serverConfig = servers[serverName];
      if (!serverConfig) {
        throw new Error(`MCP server '${serverName}' is not configured.`);
      }

      const sdkCallback = isSdkMcpServerConfig(serverConfig)
        ? this.sendSdkMcpMessage
        : undefined;

      client = new McpClient(
        serverName,
        serverConfig,
        this.toolRegistry,
        this.cliConfig.getPromptRegistry(),
        this.cliConfig.getWorkspaceContext(),
        this.cliConfig.getDebugMode(),
        sdkCallback,
      );
      this.clients.set(serverName, client);
      this.eventEmitter?.emit('mcp-client-update', this.clients);
    }

    if (client.getStatus() !== MCPServerStatus.CONNECTED) {
      await client.connect();
    }

    return client.readResource(uri, options);
  }
}
