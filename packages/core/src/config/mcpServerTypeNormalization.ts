/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger } from '../utils/debugLogger.js';
import type { MCPServerConfig } from './config.js';

const VALID_TYPES = new Set(['stdio', 'sse', 'http', 'ws']);

const TYPE_ALIASES: Record<string, string> = {
  'streamable-http': 'http',
};

/** The canonical spelling of an MCP transport type (`streamable-http` → `http`). */
export function normalizeMcpServerType(type: string): string {
  return TYPE_ALIASES[type] ?? type;
}

/**
 * Normalizes MCP server type values across all configured servers.
 * - Maps known aliases (e.g., 'streamable-http' -> 'http')
 * - Strips 'stdio' type since it's auto-inferred from the presence of 'command'
 * - Logs a warning for unrecognized type values
 */
export function normalizeMcpServerConfigs(
  servers: Record<string, MCPServerConfig>,
): Record<string, MCPServerConfig> {
  const result: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    result[name] = normalizeSingleServerType(name, config);
  }
  return result;
}

function normalizeSingleServerType(
  serverName: string,
  config: MCPServerConfig,
): MCPServerConfig {
  // At runtime, type can be any string from JSON despite the TypeScript type constraint
  const raw = config as Record<string, unknown>;
  const rawType = raw['type'] as string | undefined;
  if (rawType === undefined) {
    return config;
  }

  // Check for alias mapping (e.g. streamable-http -> http)
  const alias = TYPE_ALIASES[rawType];
  if (alias) {
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    return { ...config, type: alias } as MCPServerConfig;
  }

  // 'stdio' is auto-inferred from 'command', strip it
  if (rawType === 'stdio') {
    const { type: _, ...rest } = config as Record<string, unknown>;
    return rest as MCPServerConfig;
  }

  // Warn for unrecognized types
  if (!VALID_TYPES.has(rawType)) {
    debugLogger.warn(
      `MCP server '${serverName}': unrecognized type '${rawType}'. ` +
        `Valid types are: stdio, sse, http, ws, streamable-http. ` +
        `The server may not work as expected.`,
    );
  }

  return config;
}
