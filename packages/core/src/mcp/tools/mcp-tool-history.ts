/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { McpInfo } from './mcp-tool.js';
import type { ModelToolUseBlock } from '../../provider/event/modelCompleteEvent.js';
import { MCP_CALL_TOOL_NAME } from '../../tools/mcp-lazy/constants.js';
import { getOriginalToolName } from '../../utils/tool-name-utils.js';

/** 执行前保存 MCP 原始身份；模型工具块只携带标准调用数据。 */
export function captureMcpToolIdentity(
  block: ModelToolUseBlock,
  config: Config | undefined,
  capturedIdentities?: Map<string, McpInfo>,
): McpInfo | undefined {
  const captured = capturedIdentities?.get(block.id);
  if (captured) return { ...captured };
  if (!config) return undefined;
  const name = getOriginalToolName(block.name);
  const lazyToolName = block.input['toolName'];
  let identity: McpInfo | undefined;
  if (name === MCP_CALL_TOOL_NAME && typeof lazyToolName === 'string') {
    const entry = config
      .getMcpClientManager?.()
      ?.getLazyDiscoveredMcpToolByQualifiedName(lazyToolName);
    if (entry)
      identity = { serverName: entry.serverName, toolName: entry.toolName };
  } else {
    const tool = config.getToolRegistry?.()?.getTool(name);
    if (tool && 'mcpInfo' in tool) {
      const info = tool.mcpInfo;
      if (
        info !== null &&
        typeof info === 'object' &&
        'serverName' in info &&
        typeof info.serverName === 'string' &&
        'toolName' in info &&
        typeof info.toolName === 'string'
      ) {
        identity = { serverName: info.serverName, toolName: info.toolName };
      }
    }
  }
  // ASCII 名称可直接回放；非 ASCII 名称在断连后无法由哈希还原。
  if (!identity || !/[^\p{ASCII}]/u.test(identity.serverName + identity.toolName))
    return undefined;
  capturedIdentities?.set(block.id, { ...identity });
  return { ...identity };
}
