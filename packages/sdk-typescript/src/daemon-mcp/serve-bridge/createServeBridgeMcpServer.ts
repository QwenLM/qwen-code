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
import { disposeBindings, startSessionCleanup } from './bindings.js';
import { allTools } from './tools/index.js';

export type ServeBridgeMcpServer = McpSdkServerConfigWithInstance & {
  dispose(): Promise<void>;
};

/** Strip trailing slashes without regex (avoids CodeQL ReDoS flag). */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end--;
  return end === url.length ? url : url.slice(0, end);
}

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
 *
 * // During shutdown:
 * await server.instance.close();
 * await server.dispose();
 * ```
 */
export function createServeBridgeMcpServer(
  opts: ServeBridgeMcpServerOptions,
): ServeBridgeMcpServer {
  const state: BridgeState = {
    client: new DaemonClient({
      baseUrl: opts.daemonUrl,
      token: opts.token,
      invocationIngress: 'external_mcp',
    }),
    daemonUrl: stripTrailingSlashes(opts.daemonUrl),
    token: opts.token,
    defaultSessionId: undefined,
    workspaceCwd: opts.workspaceCwd,
    bindings: new Map(),
    sessionLocks: new Map(),
    pendingLifecycles: new Set(),
    pendingReleases: new Set(),
    disposed: false,
    allowGlobalScope: opts.allowGlobalScope ?? false,
  };

  const tools = allTools(state);

  // Start periodic cleanup of idle SSE connections
  const stopCleanup = startSessionCleanup(state);

  const server = createSdkMcpServer({
    name: 'qwen-serve-bridge',
    version: '1.0.0',
    tools,
  });

  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposePromise ??= (async () => {
      stopCleanup();
      await disposeBindings(state);
    })();
    return disposePromise;
  };

  // Programmatic callers should await dispose(); onclose is a backstop for
  // callers that only close the underlying MCP server.
  server.instance.server.onclose = () => {
    void dispose();
  };

  return { ...server, dispose };
}
