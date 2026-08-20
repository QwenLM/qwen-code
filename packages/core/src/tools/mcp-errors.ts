/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * T2.8: thrown by `McpClientManager.addRuntimeMcpServer` when adding the
 * server would exceed the workspace MCP budget in `enforce` mode.
 */
export class McpBudgetWouldExceedError extends Error {
  readonly code = 'mcp_budget_would_exceed' as const;
  readonly serverName: string;
  constructor(serverName: string) {
    super(`Adding '${serverName}' would exceed workspace MCP budget`);
    this.name = 'McpBudgetWouldExceedError';
    this.serverName = serverName;
  }
}

/**
 * T2.8: thrown by `McpClientManager.addRuntimeMcpServer` when the
 * transport spawn (pool acquire / McpClient connect) fails.
 */
export class McpServerSpawnFailedError extends Error {
  readonly code = 'mcp_server_spawn_failed' as const;
  readonly serverName: string;
  readonly details: {
    exitCode?: number;
    stderr?: string;
    timeout?: boolean;
  };
  constructor(
    serverName: string,
    details: {
      exitCode?: number;
      stderr?: string;
      timeout?: boolean;
    },
  ) {
    super(
      `Failed to spawn MCP server '${serverName}': ${JSON.stringify(details)}`,
    );
    this.name = 'McpServerSpawnFailedError';
    this.serverName = serverName;
    this.details = details;
  }
}

/**
 * T2.8: thrown by `McpClientManager.addRuntimeMcpServer` when the
 * provided server config is structurally invalid (e.g. missing both
 * `command` and `url`/`httpUrl`).
 */
export class InvalidMcpConfigError extends Error {
  readonly code = 'invalid_config' as const;
  readonly serverName: string;
  readonly reason: string;
  constructor(serverName: string, reason: string) {
    super(`Invalid MCP server config for '${serverName}': ${reason}`);
    this.name = 'InvalidMcpConfigError';
    this.serverName = serverName;
    this.reason = reason;
  }
}
