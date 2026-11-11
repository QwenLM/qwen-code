/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig, McpServerScope } from './config.js';

/**
 * Remove the runtime-only `scope` field from a single MCP server config.
 * Used by disk-write paths to ensure source provenance metadata never
 * leaks into settings.json / .mcp.json — see docs/design/mcp-source-model.md.
 */
export function stripScopeFromServer(cfg: MCPServerConfig): MCPServerConfig {
  if (cfg.scope === undefined) return cfg;
  const { scope: _scope, ...rest } = cfg;
  return rest as MCPServerConfig;
}

/** Strip `scope` from every entry in an MCP server map. */
export function stripScope(
  servers: Record<string, MCPServerConfig>,
): Record<string, MCPServerConfig> {
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    out[name] = stripScopeFromServer(cfg);
  }
  return out;
}

/** Stamp `scope` onto every entry in an MCP server map (undefined → {}). */
export function tagScope(
  servers: Record<string, MCPServerConfig> | undefined,
  scope: McpServerScope,
): Record<string, MCPServerConfig> {
  if (!servers) return {};
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- MCPServerConfig is constructed both via `new` and as a plain object from JSON; spread is intentional.
    out[name] = { ...cfg, scope };
  }
  return out;
}
