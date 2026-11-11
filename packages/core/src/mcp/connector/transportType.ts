/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The connector dimension of an MCP server: which `McpConnector` the runtime
// hands a config to. Deliberately coarser than the wire transports the MCP SDK
// exposes — `http` covers every URL-based transport (Streamable HTTP, legacy
// SSE, and the non-standard `ws`), because they share the one property that
// matters when picking a connector: no child process to own. The concrete
// transport is chosen inside the connector from `config.type`.

import type { MCPServerConfig } from '../mcpServerConfig.js';

export type McpTransportType = 'stdio' | 'xcode' | 'http' | 'sdk-hosted';

/**
 * Resolve which connector a config belongs to: an explicitly SDK-hosted server
 * first, then any configured endpoint, then a command to spawn.
 *
 * Returns `undefined` for a config with nothing to connect to. Callers turn that
 * into a diagnostic rather than throwing, so one malformed server in a settings
 * file cannot abort the whole startup pass.
 */
export function resolveMcpTransportType(
  config: MCPServerConfig,
): McpTransportType | undefined {
  if (config.type === 'sdk') return 'sdk-hosted';
  if (
    config.type === 'http' ||
    config.type === 'sse' ||
    config.type === 'ws' ||
    config.httpUrl ||
    config.url
  ) {
    return 'http';
  }
  if (config.command) {
    return config.command === 'xcrun' &&
      (config.args ?? []).includes('mcpbridge')
      ? 'xcode'
      : 'stdio';
  }
  return undefined;
}
