/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import { defineDeclarativeTool } from '../define-tool.js';
import { Kind } from '../tools.js';

import { MCP_GET_TOOL_NAME } from './constants.js';
import { normalizeMcpMarketplaceMetadata } from '@qwen-code/resource';

export { MCP_GET_TOOL_NAME };

interface McpGetParams {
  toolName: string;
}

/**
 * Lazy-mode introspection tool — fetches a single MCP tool's full metadata
 * (description, JSON Schema for inputs, server name).
 *
 * Always pair with `mcp_list` (to discover names) and `mcp_call` (to invoke).
 */
export const McpGetTool = defineDeclarativeTool<
  McpGetParams,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  Config
>({
  name: MCP_GET_TOOL_NAME,
  displayName: 'MCP Get',
  exposureHints: { metaTool: 'mcp' },
  description:
    'Get full metadata for a single MCP tool by its fully-qualified name.\n' +
    '\n' +
    'Returns `{ name, description, inputSchema, serverName, originalName }`.\n' +
    'Call this before `mcp_call` unless an earlier result for the same tool is still ' +
    'in your context; do not guess arguments.',
  kind: Kind.Search,
  parameterSchema: {
    type: 'object',
    properties: {
      toolName: {
        type: 'string',
        description:
          'The fully-qualified MCP tool name, e.g. `mcp__weather__forecast`.',
      },
    },
    required: ['toolName'],
    additionalProperties: false,
  },
  isConcurrencySafe: () => true,
  validateParams: (params) => {
    if (typeof params.toolName !== 'string' || params.toolName.length === 0) {
      return 'toolName must be a non-empty string';
    }
    return null;
  },
  execute: async (params, ctx, config) => {
    const manager = config.getMcpClientManager();
    if (!manager) {
      return {
        llmContent: `Error: MCP client manager unavailable.`,
        returnDisplay: 'MCP client manager unavailable.',
      };
    }
    const entry = manager.getLazyDiscoveredMcpToolByQualifiedName(
      params.toolName,
    );
    if (!entry) {
      const suggestions = manager
        .getLazyDiscoveredMcpTools()
        .map((e) => e.qualifiedName)
        .filter((n) => n.includes(params.toolName.split('__').pop() ?? ''))
        .slice(0, 5);
      const suggestText = suggestions.length
        ? `\nDid you mean: ${suggestions.join(', ')}?`
        : '';
      return {
        llmContent: `Error: MCP tool "${params.toolName}" not found.${suggestText}`,
        returnDisplay: `MCP tool "${params.toolName}" not found.`,
      };
    }
    // 查询单个目标时沿用它的初始化身份；读取 schema 不等于激活所属插件。
    if (ctx.extensionExecutionRawRecord) {
      Object.assign(
        ctx.extensionExecutionRawRecord,
        normalizeMcpMarketplaceMetadata(entry.tool.mcpMarketplace),
      );
    }

    const payload = {
      name: entry.qualifiedName,
      description: entry.description ?? '',
      inputSchema: entry.inputSchema ?? { type: 'object', properties: {} },
      serverName: entry.serverName,
      originalName: entry.toolName,
    };
    return {
      llmContent: JSON.stringify(payload),
      returnDisplay: `Loaded schema for ${entry.qualifiedName}.`,
    };
  },
});
