/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { SessionMcpManager } from '../../mcp/sessionMcpManager/index.js';
import { defineDeclarativeTool } from '../define-tool.js';
import {
  Kind,
  type AnyDeclarativeTool,
  type AnyToolInvocation,
  type ToolResult,
} from '../tools.js';
import { ToolErrorType } from '../tool-error.js';
import { MCP_CALL_DESCRIPTION, MCP_CALL_TOOL_NAME } from './constants.js';

import { createMcpToolErrorResult } from '../../mcp/errors.js';
import { isCancelledError } from '../abort-utils.js';

export { MCP_CALL_TOOL_NAME };

interface McpCallParams {
  toolName: string;
  arguments?: Record<string, unknown>;
}

/**
 * Resolve the underlying {@link DiscoveredMCPTool} for a `mcp_call` request,
 * if any. Returns `undefined` when the manager is missing or the qualified
 * name is unknown — callers handle both cases.
 *
 * Centralized here so {@link McpCallTool}'s safety predicates
 * (isDestructive/toClassifierInput) and the `execute` dispatch all see the
 * same view.
 */
function resolveUnderlyingTool(
  config: Config | undefined,
  toolName: string,
): {
  manager?: SessionMcpManager;
  entry?: ReturnType<
    SessionMcpManager['getLazyDiscoveredMcpToolByQualifiedName']
  >;
  tool?: AnyDeclarativeTool;
} {
  const manager = config?.getMcpClientManager?.();
  if (!manager) return {};
  const entry = manager.getLazyDiscoveredMcpToolByQualifiedName(toolName);
  return { manager, entry, tool: entry?.tool };
}

/**
 * Lazy-mode dispatch tool: invokes an MCP tool by fully-qualified name.
 *
 * Routes through the resolved `DiscoveredMCPTool`, so classifier input and
 * trace behavior match eager registration. Safety and concurrency predicates
 * delegate to that tool; unknown names fail closed and default to serial.
 *
 * Permission rules are not handled here: the pipeline resolves this call's
 * rule identity from `params.toolName`, so `mcp__server__*` rules apply.
 */
export const McpCallTool = defineDeclarativeTool<
  McpCallParams,
  ToolResult,
  Config
>({
  name: MCP_CALL_TOOL_NAME,
  displayName: 'MCP Call',
  description: MCP_CALL_DESCRIPTION,
  kind: Kind.Other,
  exposureHints: { metaTool: 'mcp' },
  parameterSchema: {
    type: 'object',
    properties: {
      toolName: {
        type: 'string',
        description:
          'The fully-qualified MCP tool name, e.g. `mcp__weather__forecast`.',
      },
      arguments: {
        type: 'object',
        description:
          'Arguments object matching the tool input schema. May be omitted ' +
          'when the schema has no required properties.',
        additionalProperties: true,
      },
    },
    required: ['toolName'],
    additionalProperties: false,
  },
  validateParams: (params) => {
    if (typeof params.toolName !== 'string' || params.toolName.length === 0) {
      return 'toolName must be a non-empty string';
    }
    if (
      params.arguments !== undefined &&
      (typeof params.arguments !== 'object' ||
        params.arguments === null ||
        Array.isArray(params.arguments))
    ) {
      return 'arguments must be a plain object when provided';
    }
    return null;
  },
  isDestructive: (params, config) => {
    if (!params || !config) return false;
    const { tool } = resolveUnderlyingTool(config, params.toolName);
    return tool?.isDestructive(params.arguments) ?? false;
  },
  isConcurrencySafe: (params, config) => {
    if (!params || !config) return false;
    const { tool } = resolveUnderlyingTool(config, params.toolName);
    return tool?.isConcurrencySafe(params.arguments) ?? false;
  },
  toClassifierInput: (params, config) => {
    let argsSummary: string;
    try {
      argsSummary = JSON.stringify(params.arguments ?? {});
    } catch {
      argsSummary = '[unserializable arguments]';
    }
    // Delegate to the underlying tool's classifier input when resolvable so
    // auto-mode evaluates the actual MCP destination (server + tool +
    // description), not just the meta-tool wrapper. This mirrors what would
    // be evaluated had the tool been registered individually under eager
    // mode.
    const { tool } = resolveUnderlyingTool(config, params.toolName);
    if (tool) {
      try {
        const inner = tool.toClassifierInput(params.arguments ?? {});
        return {
          via_meta_tool: 'mcp_call',
          qualified_tool_name: params.toolName,
          underlying: inner,
        };
      } catch {
        // Fall through to the meta-only payload below.
      }
    }
    return {
      via_meta_tool: 'mcp_call',
      qualified_tool_name: params.toolName,
      arguments: argsSummary,
    };
  },
  execute: async (params, ctx, config) => {
    const { manager, entry, tool } = resolveUnderlyingTool(
      config,
      params.toolName,
    );
    if (!manager) {
      return {
        llmContent: 'Error: MCP client manager unavailable.',
        returnDisplay: 'MCP client manager unavailable.',
      };
    }
    if (!tool) {
      return {
        llmContent:
          `Error: MCP tool "${params.toolName}" not found. ` +
          `Call \`mcp_list\` to see available tools.`,
        returnDisplay: `MCP tool "${params.toolName}" not found.`,
      };
    }

    let preparedTool: AnyDeclarativeTool;
    try {
      preparedTool = (await manager.prepareLazyMcpTool(entry!, ctx.signal))
        .tool;
    } catch (error) {
      if (isCancelledError(error, ctx.signal)) throw error;
      return createMcpToolErrorResult(error);
    }
    let invocation: AnyToolInvocation;
    try {
      invocation = preparedTool.build(params.arguments ?? {});
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'MCP tool arguments failed validation.';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    try {
      const result = await (invocation.executeWithContext
        ? invocation.executeWithContext(ctx)
        : invocation.execute(ctx.signal));
      return result;
    } catch (error) {
      if (isCancelledError(error, ctx.signal)) throw error;
      return createMcpToolErrorResult(error);
    }
  },
});
