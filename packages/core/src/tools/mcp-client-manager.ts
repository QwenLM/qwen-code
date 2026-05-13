/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, MCPServerConfig } from '../config/config.js';
import { isSdkMcpServerConfig } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  McpClient,
  MCPDiscoveryState,
  MCPServerStatus,
  getMCPServerStatus,
  populateMcpServerCommand,
  removeMCPServerStatus,
} from './mcp-client.js';
import type { SendSdkMcpMessage } from './mcp-client.js';
import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { recordStartupEvent } from '../utils/startupEventSink.js';
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
  private serverDiscoveryPromises: Map<string, Promise<void>> = new Map();

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
    const inProgressDiscovery = this.serverDiscoveryPromises.get(serverName);
    if (inProgressDiscovery) {
      await inProgressDiscovery;
      return;
    }

    const discoveryPromise = this.discoverMcpToolsForServerInternal(
      serverName,
      cliConfig,
    );
    this.serverDiscoveryPromises.set(serverName, discoveryPromise);

    try {
      await discoveryPromise;
    } finally {
      if (this.serverDiscoveryPromises.get(serverName) === discoveryPromise) {
        this.serverDiscoveryPromises.delete(serverName);
      }
    }
  }

  private async discoverMcpToolsForServerInternal(
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

    this.stopHealthCheck(serverName);

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
    } catch (error) {
      // Log the error but don't throw: callers expect best-effort discovery.
      debugLogger.error(
        `Error during discovery for server '${serverName}': ${getErrorMessage(
          error,
        )}`,
      );
    } finally {
      this.startHealthCheck(serverName);
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
    this.serverDiscoveryPromises.clear();
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
        this.serverDiscoveryPromises.delete(serverName);
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

    // Don't arm a health-check timer for a server that no longer has a
    // tracked client. The discovery-timeout handler deletes the client
    // before the discovery `finally` block runs `startHealthCheck`, and
    // without this guard we'd create a timer that fires every
    // checkIntervalMs and ultimately reconnects an intentionally
    // timed-out server (bypassing `runWithDiscoveryTimeout`).
    if (!this.clients.has(serverName)) {
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
    recordStartupEvent('mcp_discovery_start', {
      serverCount: Object.keys(servers).length,
      incremental: true,
    });
    // Mirrors `discoverAllMcpTools`: announce IN_PROGRESS so UI subscribers
    // (MCP status pill, AppContainer batch-flush effect) know discovery
    // started, even when no servers need updates this pass.
    this.eventEmitter?.emit('mcp-client-update', this.clients);

    // Tracks the first successful server discover so we can emit the
    // `mcp_first_tool_registered` event exactly once. "First successful
    // discover" rather than a tool-count delta — simpler and aligns with the
    // user-perceived metric ("first MCP server is ready").
    let firstToolEventFired = false;

    // Find servers that are new or have changed configuration
    const serversToUpdate: string[] = [];
    const currentServerNames = new Set(this.clients.keys());
    const newServerNames = new Set(Object.keys(servers));

    // Check for new servers or configuration changes
    for (const [name] of Object.entries(servers)) {
      // Mirror `discoverAllMcpTools` (line ~102): users who explicitly
      // disabled a server via `mcpServers.<name>.disabled: true` must not
      // see it reconnected by the incremental path. Without this, the
      // PR-A background path silently re-registers tools the user has
      // told us to ignore.
      if (cliConfig.isMcpServerDisabled(name)) {
        debugLogger.debug(`Skipping disabled MCP server: ${name}`);
        // If the server was previously enabled and got connected, we now
        // need to tear it down — otherwise its client, registered tools
        // and health checks linger after an enabled→disabled mid-session
        // transition (e.g. via `/mcp disable <name>`). `removeServer`
        // disconnects, drops the client entry, removes tools from the
        // registry, stops the health check, and removes the global
        // status so the Footer pill stops counting it.
        if (this.clients.has(name)) {
          await this.removeServer(name);
        }
        continue;
      }
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

    // Update only the servers that need it. Each per-server discover is
    // wrapped in a discovery-only timeout (stdio default 30s, remote 5s,
    // per-server override via `discoveryTimeoutMs`). Tool-call timeout is
    // intentionally left alone — a long-running tool invocation is not a
    // startup pathology.
    const discoveryPromises = serversToUpdate.map(async (name) => {
      const serverConfig = servers[name];
      try {
        await this.runWithDiscoveryTimeout(name, serverConfig, () =>
          this.discoverMcpToolsForServer(name, cliConfig),
        );
        // `discoverMcpToolsForServerInternal` swallows connect/discover
        // errors (best-effort discovery semantics — see its catch block),
        // so the try here resolves even for failed servers. Only the
        // timeout path reaches the catch below. Consult the actual
        // server status to decide which outcome to record, otherwise
        // every auth failure / crash / "no tools found" looks like
        // `ready` in the startup profile.
        const client = this.clients.get(name);
        const actuallyReady =
          !!client && getMCPServerStatus(name) === MCPServerStatus.CONNECTED;
        if (actuallyReady) {
          if (!firstToolEventFired) {
            firstToolEventFired = true;
            recordStartupEvent('mcp_first_tool_registered', {
              serverName: name,
            });
          }
          recordStartupEvent(`mcp_server_ready:${name}`, { outcome: 'ready' });
        } else {
          recordStartupEvent(`mcp_server_ready:${name}`, {
            outcome: 'failed',
            reason: 'connect or discover error',
          });
        }
      } catch (error) {
        // Defensive cleanup: the dedup Map entry is normally removed by
        // `discoverMcpToolsForServer`'s `finally`, but `runWithDiscoveryTimeout`
        // can reject before that finally runs (the timeout also disconnects
        // the client to abort the underlying handshake). Without this
        // explicit delete, a brief window exists where a subsequent
        // `discoverMcpToolsForServer(name)` call would short-circuit on
        // a now-doomed promise.
        this.serverDiscoveryPromises.delete(name);
        recordStartupEvent(`mcp_server_ready:${name}`, {
          outcome: 'failed',
          reason: getErrorMessage(error),
        });
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
    recordStartupEvent('mcp_all_servers_settled', {
      serverCount: Object.keys(servers).length,
      incremental: true,
    });
    // Trailing `mcp-client-update` AFTER flipping discoveryState to
    // COMPLETED. Without this the per-server updates above all fire while
    // the state is still IN_PROGRESS, so the AppContainer batch-flush
    // subscriber never observes the terminal state.
    this.eventEmitter?.emit('mcp-client-update', this.clients);
  }

  /**
   * Caps how long a single MCP server's discover handshake is allowed to
   * take during startup. Local stdio servers default to 30s; remote
   * HTTP/SSE servers default to 5s (mirrors Claude Code's
   * `CLAUDE_AI_MCP_TIMEOUT_MS`). Per-server override via
   * `mcpServers.<name>.discoveryTimeoutMs` in settings.
   */
  private runWithDiscoveryTimeout<T>(
    serverName: string,
    serverConfig: MCPServerConfig | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const timeoutMs = this.discoveryTimeoutFor(serverConfig);
    let timedOut = false;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(async () => {
        timedOut = true;
        // CRITICAL: rejecting `runWithDiscoveryTimeout` does NOT cancel
        // the underlying `discoverMcpToolsForServer` — it keeps trying
        // to `connect()` / `discover()`, and if the slow server
        // eventually responds, `discover()` registers its tools into
        // the live `toolRegistry` and re-emits `mcp-client-update`.
        // From the user's perspective the server "failed" but its tools
        // are silently active, including any that shadow built-ins.
        //
        // Disconnect the client to abort the handshake so the background
        // promise rejects, then drop any tools that DID slip through the
        // race window. A fire-and-forget `client.disconnect()` is NOT
        // enough: `disconnect()` awaits `transport.close()`, and the
        // in-flight `discover()` may have already pumped its `tools/list`
        // response through the transport AND iterated
        // `toolRegistry.registerTool(tool)` synchronously by the time
        // the close lands. The earlier fix's comment described the
        // pre-fix state as a "remote-exploitable silent-tool-registration
        // vector" — `await` plus `removeMcpToolsByServer` closes it.
        const client = this.clients.get(serverName);
        if (client) {
          try {
            await client.disconnect();
          } catch (err) {
            debugLogger.debug(
              `Forced disconnect of timed-out server '${serverName}' threw: ${getErrorMessage(err)}`,
            );
          }
        }
        // Drop any tools that registered during the disconnect window. No-op
        // if the server hadn't reached `discover()` yet, so it's safe to
        // always call.
        this.toolRegistry.removeMcpToolsByServer(serverName);
        // Prevent the discovery `finally` block's `startHealthCheck` from
        // resurrecting this server: without removing the client entry,
        // `performHealthCheck` would observe `status !== CONNECTED` for
        // ~maxConsecutiveFailures intervals and then call
        // `reconnectServer()` → `discoverMcpToolsForServer()` directly,
        // bypassing `runWithDiscoveryTimeout` entirely. The intentionally
        // timed-out server would silently come back. Removing the client
        // entry + stopping any pending health-check timer closes that
        // loop; `startHealthCheck` early-returns when the client is
        // absent, so the trailing `finally`-block call becomes a no-op.
        this.stopHealthCheck(serverName);
        this.clients.delete(serverName);
        reject(
          new Error(
            `MCP server '${serverName}' discovery timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      fn().then(
        (value) => {
          clearTimeout(timer);
          // Suppress success after timeout — the timeout already
          // rejected the outer promise; resolving it again is a no-op
          // but the success path would also re-emit
          // `mcp_server_ready:ready` and `mcp_first_tool_registered`
          // even though the rest of the system has moved on.
          if (!timedOut) resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          if (!timedOut) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
    });
  }

  /**
   * Minimum / maximum discovery timeouts. `0` or a negative value as a
   * per-server override would cause every discover to fire its timeout on
   * the next tick — combined with the lack of disconnect on timeout this
   * was a remote-exploitable silent-tool-registration vector (a
   * MITM/attacker-controlled MCP server could land its tools after the
   * timeout fired). `Infinity` / very large values would hang
   * `waitForMcpReady()` forever for non-interactive paths. The 100ms
   * floor is generous (real handshakes start in single-digit ms locally,
   * tens of ms remote); the 5-minute ceiling matches the longest tool
   * call timeouts we've documented.
   */
  private static readonly MIN_DISCOVERY_TIMEOUT_MS = 100;
  private static readonly MAX_DISCOVERY_TIMEOUT_MS = 300_000;

  private discoveryTimeoutFor(serverConfig?: MCPServerConfig): number {
    const override = serverConfig?.discoveryTimeoutMs;
    if (override !== undefined && Number.isFinite(override)) {
      return Math.max(
        McpClientManager.MIN_DISCOVERY_TIMEOUT_MS,
        Math.min(override, McpClientManager.MAX_DISCOVERY_TIMEOUT_MS),
      );
    }
    // Remote transports (HTTP/SSE/WebSocket) carry network risk and get
    // a shorter default; stdio servers we trust the user already runs
    // locally. `tcp` is the WebSocket transport field on
    // `MCPServerConfig` — without it, websocket servers fall through to
    // the stdio default and a hung WS handshake holds back the
    // non-interactive `waitForMcpReady()` for 30s instead of 5s.
    const isRemote = !!(
      serverConfig?.httpUrl ||
      serverConfig?.url ||
      serverConfig?.tcp
    );
    return isRemote ? 5_000 : 30_000;
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

    // The server has been removed from configuration, so drop it from the
    // global status registry too — the health pill should no longer count it.
    removeMCPServerStatus(serverName);

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
