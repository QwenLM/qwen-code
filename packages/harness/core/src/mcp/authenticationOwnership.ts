/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from './mcpServerConfig.js';

// Private symbol metadata survives object spread, but cannot come from JSON.
const HOST_AUTHENTICATION = Symbol('mcp.hostAuthentication');

/** Create a runtime config whose authentication is owned by its host. */
export function withMcpHostAuthentication<T extends MCPServerConfig>(config: T): T {
  return { ...config, [HOST_AUTHENTICATION]: true };
}

export function isMcpHostAuthenticated(config: MCPServerConfig): boolean {
  return (config as MCPServerConfig & { [HOST_AUTHENTICATION]?: boolean })[HOST_AUTHENTICATION] === true;
}
