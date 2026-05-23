/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Factory: wraps `qwen serve` HTTP API as an MCP server.
 */

import { DaemonClient } from '../../daemon/DaemonClient.js';
import { createSdkMcpServer } from '../createSdkMcpServer.js';
import type { McpSdkServerConfigWithInstance } from '../createSdkMcpServer.js';
import type { ServeBridgeMcpServerOptions, BridgeState } from './types.js';
import { allTools } from './tools/index.js';

/**
 * Create an MCP server that proxies `qwen serve` HTTP endpoints as MCP tools.
 *
 * @example
 * ```typescript
 * import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
 * import { createServeBridgeMcpServer } from '@qwen-code/sdk';
 *
 * const server = createServeBridgeMcpServer({
 *   daemonUrl: 'http://127.0.0.1:4170',
 *   token: process.env.QWEN_DAEMON_TOKEN,
 * });
 *
 * const transport = new StdioServerTransport();
 * await server.instance.connect(transport);
 * ```
 */
export function createServeBridgeMcpServer(
  opts: ServeBridgeMcpServerOptions,
): McpSdkServerConfigWithInstance {
  const state: BridgeState = {
    client: new DaemonClient({
      baseUrl: opts.daemonUrl,
      token: opts.token,
    }),
    defaultSessionId: undefined,
    workspaceCwd: opts.workspaceCwd,
  };

  const tools = allTools(state);

  return createSdkMcpServer({
    name: 'qwen-serve-bridge',
    version: '1.0.0',
    tools,
  });
}
