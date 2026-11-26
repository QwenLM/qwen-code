/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { ExtensionExecutionRawRecord } from '../../extensions/extension-features.js';
import type { SessionMcpManager } from '../../mcp/sessionMcpManager/index.js';
import { defineDeclarativeTool } from '../define-tool.js';
import { extractPostMcpContext } from '../../core/coreToolHookTriggers.js';
import { normalizeMcpMarketplaceMetadata } from '@qwen-code/resource';
import {
  Kind,
  type AnyDeclarativeTool,
  type AnyToolInvocation,
  type ToolResult,
} from '../tools.js';
import { ToolErrorType } from '../tool-error.js';
import { MCP_CALL_DESCRIPTION, MCP_CALL_TOOL_NAME } from './constants.js';
import { lazyMcpTargetFields } from './result-buckets.js';
import { createMcpToolErrorResult } from '../../mcp/errors.js';
import { isCancelledError } from '../abort-utils.js';
import {
  firstMcpSuccessFields,
  searchRank,
  takeFirstMcpSuccess,
} from '../discovery-stats.js';

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
    const recordFeatures = (features: Partial<ExtensionExecutionRawRecord>): void => {
      if (ctx.extensionExecutionRawRecord) Object.assign(ctx.extensionExecutionRawRecord, features);
    };
    recordFeatures({
      mcpOperation: 'call',
      mcpInvocationPath: 'lazy',
      mcpTargetToolName: params.toolName,
    });
    const { manager, entry, tool } = resolveUnderlyingTool(
      config,
      params.toolName,
    );
    if (!manager) {
      recordFeatures({
        mcpOperationOutcome: 'manager_unavailable',
        mcpDispatchSuccess: false,
        mcpServerResponded: false,
      });
      return {
        llmContent: 'Error: MCP client manager unavailable.',
        returnDisplay: 'MCP client manager unavailable.',
        data: {
          mcp_operation: 'call',
          mcp_invocation_path: 'lazy',
          mcp_operation_outcome: 'manager_unavailable',
          mcp_dispatch_success: false,
          mcp_server_responded: false,
          mcp_target_tool_name: params.toolName,
        },
      };
    }
    if (!tool) {
      recordFeatures({
        mcpOperationOutcome: 'target_not_found',
        mcpDispatchSuccess: false,
        mcpServerResponded: false,
      });
      return {
        llmContent:
          `Error: MCP tool "${params.toolName}" not found. ` +
          `Call \`mcp_list\` to see available tools.`,
        returnDisplay: `MCP tool "${params.toolName}" not found.`,
        data: {
          mcp_operation: 'call',
          mcp_invocation_path: 'lazy',
          mcp_operation_outcome: 'target_not_found',
          mcp_dispatch_success: false,
          mcp_server_responded: false,
          mcp_target_tool_name: params.toolName,
        },
      };
    }

    const sessionId = ctx.sessionId ?? config.getSessionId();
    const rank = searchRank(sessionId, entry!.qualifiedName);
    let targetFields: Record<string, unknown> = {
      ...lazyMcpTargetFields(entry!),
      ...(rank === undefined ? {} : { mcp_list_rank: rank }),
    };
    const targetTransport = targetFields['mcp_transport'];
    recordFeatures({
      mcpServerName: entry!.serverName,
      // 准备失败时仍能记录选中插件；准备成功后再用实际目标覆盖。
      pluginName: tool.pluginName ?? '',
      pluginMarketplace: tool.pluginMarketplace,
      ...normalizeMcpMarketplaceMetadata(tool.mcpMarketplace),
      mcpTargetToolName: entry!.qualifiedName,
      mcpTransport: typeof targetTransport === 'string' ? targetTransport : '',
      mcpListRank: rank ?? '',
    });
    let preparedTool: AnyDeclarativeTool;
    try {
      const prepared = await manager.prepareLazyMcpTool(entry!, ctx.signal);
      preparedTool = prepared.tool;
      targetFields = { ...targetFields, ...lazyMcpTargetFields(prepared) };
      const preparedTransport = targetFields['mcp_transport'];
      recordFeatures({
        mcpServerName: prepared.serverName,
        // 恢复连接可能更换工具，归属必须以实际准备好的目标为准。
        pluginName: preparedTool.pluginName ?? '',
        pluginMarketplace: preparedTool.pluginMarketplace,
        ...normalizeMcpMarketplaceMetadata(preparedTool.mcpMarketplace),
        mcpTargetToolName: prepared.qualifiedName,
        mcpTransport:
          typeof preparedTransport === 'string' ? preparedTransport : '',
      });
    } catch (error) {
      if (isCancelledError(error, ctx.signal)) {
        recordFeatures({ mcpOperationOutcome: 'cancelled', mcpDispatchSuccess: false });
        throw error;
      }
      const failure = createMcpToolErrorResult(error);
      recordFeatures({
        mcpOperationOutcome:
          typeof failure.data?.['mcp_operation_outcome'] === 'string'
            ? failure.data['mcp_operation_outcome']
            : '',
        mcpDispatchSuccess: false,
        mcpServerResponded: false,
      });
      return {
        ...failure,
        data: {
          ...failure.data,
          mcp_operation: 'call',
          mcp_invocation_path: 'lazy',
          mcp_dispatch_success: false,
          ...targetFields,
        },
      };
    }
    let invocation: AnyToolInvocation;
    try {
      invocation = preparedTool.build(params.arguments ?? {});
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'MCP tool arguments failed validation.';
      recordFeatures({
        mcpOperationOutcome: 'invalid_tool_arguments',
        mcpDispatchSuccess: false,
        mcpServerResponded: false,
      });
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
        data: {
          mcp_operation: 'call',
          mcp_invocation_path: 'lazy',
          mcp_operation_outcome: 'invalid_tool_arguments',
          mcp_dispatch_success: false,
          mcp_server_responded: false,
          ...targetFields,
        },
      };
    }

    // Recovery may replace the catalog tool, so attribute the prepared and
    // built invocation. Carry its snapshot back to the outer mcp_call Post
    // event rather than firing a second set of hooks for the inner call.
    const mcpHookContext = extractPostMcpContext(invocation, config);
    try {
      const result = await (invocation.executeWithContext
        ? invocation.executeWithContext(ctx)
        : invocation.execute(ctx.signal));
      const serverResponded = result.isError !== undefined || !result.error;
      const semanticSuccess = serverResponded
        ? result.isError !== true && !result.error
        : undefined;
      const operationOutcome = result.isError
        ? 'server_error'
        : result.error?.type === ToolErrorType.MCP_TOOL_ERROR
          ? result.data?.['mcp_operation_outcome'] === 'timeout'
            ? 'timeout'
            : 'transport_error'
          : result.error
            ? 'internal_error'
            : 'success';
      const first =
        operationOutcome === 'success'
          ? takeFirstMcpSuccess(sessionId, ctx.promptId)
          : undefined;
      recordFeatures({
        mcpOperationOutcome: operationOutcome,
        mcpDispatchSuccess: true,
        mcpServerResponded: serverResponded,
        mcpSemanticSuccess: semanticSuccess ?? '',
        ...(first ? {
          mcpDiscoveryOps: first.operations,
          mcpDiscoveryFirstPromptId: first.firstPromptId ?? '',
          mcpDiscoverySameTurn: first.sameTurn,
        } : {}),
      });
      return {
        ...result,
        ...(mcpHookContext && { mcpHookContext }),
        data: {
          ...firstMcpSuccessFields(first, 'mcp_'),
          ...result.data,
          mcp_operation: 'call',
          mcp_invocation_path: 'lazy',
          mcp_operation_outcome: operationOutcome,
          mcp_dispatch_success: true,
          mcp_server_responded: serverResponded,
          ...(semanticSuccess === undefined
            ? {}
            : { mcp_semantic_success: semanticSuccess }),
          ...targetFields,
        },
      };
    } catch (error) {
      if (isCancelledError(error, ctx.signal)) {
        recordFeatures({ mcpOperationOutcome: 'cancelled', mcpDispatchSuccess: true });
        throw error;
      }
      const failure = createMcpToolErrorResult(error);
      recordFeatures({
        mcpOperationOutcome:
          typeof failure.data?.['mcp_operation_outcome'] === 'string'
            ? failure.data['mcp_operation_outcome']
            : '',
        mcpDispatchSuccess: true,
        mcpServerResponded: false,
      });
      return {
        ...failure,
        data: {
          ...failure.data,
          mcp_operation: 'call',
          mcp_invocation_path: 'lazy',
          mcp_dispatch_success: true,
          ...targetFields,
        },
        ...(mcpHookContext && { mcpHookContext }),
      };
    }
  },
});
