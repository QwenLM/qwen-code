/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Lazy MCP loading — three meta tools (mcp_list / mcp_get /
 * mcp_call) that replace per-tool schema registration when lazy is enabled.
 *
 * 模式由配置决定，在主注册表接入时应用，与连接和工具数量无关。
 */

import type { Config } from '../../config/config.js';
import type { ToolRegistry } from '../tool-registry.js';
import { McpListTool, MCP_LIST_TOOL_NAME } from './mcp-list-tool.js';
import { McpGetTool, MCP_GET_TOOL_NAME } from './mcp-get-tool.js';
import { McpCallTool, MCP_CALL_TOOL_NAME } from './mcp-call-tool.js';

export { McpListTool, MCP_LIST_TOOL_NAME } from './mcp-list-tool.js';
export { McpGetTool, MCP_GET_TOOL_NAME } from './mcp-get-tool.js';
export { McpCallTool, MCP_CALL_TOOL_NAME } from './mcp-call-tool.js';
export {
  LAZY_MCP_TEXT_MAX_CHARS,
  LAZY_MCP_SERVER_DESC_MAX_CHARS,
} from './constants.js';

export const LAZY_MCP_META_TOOL_NAMES: readonly string[] = [
  MCP_LIST_TOOL_NAME,
  MCP_GET_TOOL_NAME,
  MCP_CALL_TOOL_NAME,
];

/**
 * Register the three lazy MCP meta tools into the registry. Idempotent —
 * safe to call multiple times.
 */
export function registerLazyMcpMetaTools(
  registry: ToolRegistry,
  config: Config,
): void {
  if (!registry.getTool(MCP_LIST_TOOL_NAME)) {
    registry.registerTool(new McpListTool(config));
  }
  if (!registry.getTool(MCP_GET_TOOL_NAME)) {
    registry.registerTool(new McpGetTool(config));
  }
  if (!registry.getTool(MCP_CALL_TOOL_NAME)) {
    registry.registerTool(new McpCallTool(config));
  }
}
