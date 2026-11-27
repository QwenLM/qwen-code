/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LazyMcpToolEntry } from '../../mcp/sessionMcpManager/index.js';

export type McpListResultCountBucket =
  | '0'
  | '1'
  | '2_5'
  | '6_10'
  | '11_25'
  | '26_50'
  | '51_plus';

export function bucketMcpListResultCount(
  count: number,
): McpListResultCountBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 10) return '6_10';
  if (count <= 25) return '11_25';
  if (count <= 50) return '26_50';
  return '51_plus';
}

export function lazyMcpTargetFields(entry: LazyMcpToolEntry): Record<string, unknown> {
  const transport = (entry.tool as { transportType?: unknown }).transportType;
  return {
    mcp_target_tool_name: entry.qualifiedName,
    mcp_server_name: entry.serverName,
    ...(typeof transport === 'string' ? { mcp_transport: transport } : {}),
  };
}
