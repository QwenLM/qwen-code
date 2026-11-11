/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Picks the concrete URL transport for an already-prepared connection.

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPServerConfig } from '../../mcpServerConfig.js';
import { runLogger } from '../../../utils/runLogger.js';
import type { McpUrlTransportOptions } from '../types.js';

/**
 * Picks the concrete URL transport for an already-prepared connection:
 * `httpUrl` wins over `url` for backward compatibility, an explicit `type: 'sse'`
 * picks SSE, and anything else with a `url` defaults to Streamable HTTP.
 *
 * Exported because the OAuth retry path builds its own `transportOptions` (it
 * has a fresh access token to carry) and must still get the same selection
 * rules.
 */
export function createUrlTransport(
  serverName: string,
  config: MCPServerConfig,
  transportOptions: McpUrlTransportOptions,
): Transport {
  if (config.httpUrl) {
    if (config.url) {
      runLogger.warn(
        `MCP server '${serverName}': Both 'httpUrl' and 'url' are configured. ` +
          `Using deprecated 'httpUrl'. Please migrate to 'url' with 'type: "http"'.`,
      );
    }
    return new StreamableHTTPClientTransport(
      new URL(config.httpUrl),
      transportOptions,
    );
  }

  if (config.url && config.type === 'sse') {
    return new SSEClientTransport(new URL(config.url), transportOptions);
  }

  if (config.url) {
    return new StreamableHTTPClientTransport(
      new URL(config.url),
      transportOptions,
    );
  }

  throw new Error(`No URL configured for MCP server '${serverName}'`);
}
