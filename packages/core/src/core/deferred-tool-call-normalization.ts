/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolRegistry } from '../tools/tool-registry.js';
import { ToolNames, ToolNamesMigration } from '../tools/tool-names.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { ToolCallRequestInfo } from './turn.js';

export type DeferredToolCallNormalizationResult =
  | { ok: true; request: ToolCallRequestInfo }
  | {
      ok: false;
      error: Error;
      providerName: string;
      errorType: ToolErrorType;
    };

export function canonicalToolName(toolName: string): string {
  return (ToolNamesMigration as Record<string, string>)[toolName] ?? toolName;
}

export function providerToolName(request: ToolCallRequestInfo): string {
  return request.providerName ?? request.name;
}

/**
 * Convert the stable provider-facing `deferred_tool_call` wrapper into the
 * real deferred tool request used internally. Callers should run permissions,
 * validation, hooks, execution, and telemetry against the real target, while
 * function responses still use `providerName` so the provider sees the
 * declared wrapper tool name.
 */
export async function normalizeDeferredToolCallRequest(
  request: ToolCallRequestInfo,
  toolRegistry: ToolRegistry,
): Promise<DeferredToolCallNormalizationResult> {
  if (request.name !== ToolNames.DEFERRED_TOOL_CALL) {
    return { ok: true, request };
  }

  const fail = (message: string): DeferredToolCallNormalizationResult => ({
    ok: false,
    error: new Error(message),
    providerName: ToolNames.DEFERRED_TOOL_CALL,
    errorType: ToolErrorType.INVALID_TOOL_PARAMS,
  });

  const targetName = request.args['name'];
  const targetArgs = request.args['arguments'];
  if (typeof targetName !== 'string' || targetName.trim().length === 0) {
    return fail(
      '`deferred_tool_call.name` must be the exact deferred tool name returned by tool_search.',
    );
  }
  if (
    !targetArgs ||
    typeof targetArgs !== 'object' ||
    Array.isArray(targetArgs)
  ) {
    return fail(
      '`deferred_tool_call.arguments` must be an object matching the target tool schema returned by tool_search.',
    );
  }

  const canonicalTarget = canonicalToolName(targetName);
  if (canonicalTarget === ToolNames.DEFERRED_TOOL_CALL) {
    return fail(
      '`deferred_tool_call` cannot target itself. Use tool_search to fetch the real deferred tool schema, then call deferred_tool_call with that real target name.',
    );
  }

  const targetTool = await toolRegistry.ensureTool(canonicalTarget);
  if (!targetTool) {
    return fail(
      `Deferred tool "${targetName}" is not available. Use tool_search to find the current deferred tool name and schema.`,
    );
  }
  if (!toolRegistry.isProxyEligibleDeferredTool(canonicalTarget)) {
    return fail(
      `Tool "${canonicalTarget}" is not eligible for deferred_tool_call. Call directly if it is visible, or use tool_search for deferred tools.`,
    );
  }
  if (!toolRegistry.hasPresentedProxySchema(canonicalTarget)) {
    return fail(
      `Schema for deferred tool "${canonicalTarget}" has not been fetched in the active context. Use tool_search first, then call deferred_tool_call on a later turn.`,
    );
  }

  return {
    ok: true,
    request: {
      ...request,
      name: canonicalTarget,
      args: targetArgs as Record<string, unknown>,
      providerName: ToolNames.DEFERRED_TOOL_CALL,
    },
  };
}
