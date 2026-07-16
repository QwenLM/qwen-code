/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolRegistry } from '../tools/tool-registry.js';
import { ToolNames, ToolNamesMigration } from '../tools/tool-names.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import type { ToolCallRequestInfo } from './turn.js';

export type DeferredToolCallNormalizationResult =
  | {
      ok: true;
      request: ToolCallRequestInfo;
      resolvedTool?: AnyDeclarativeTool;
    }
  | {
      ok: false;
      error: Error;
      providerName: string;
      /** Canonical attempted target used only for internal diagnostics. */
      targetName?: string;
      errorType: ToolErrorType;
    };

export function canonicalToolName(toolName: string): string {
  return (ToolNamesMigration as Record<string, string>)[toolName] ?? toolName;
}

export function providerToolName(request: ToolCallRequestInfo): string {
  return request.providerName ?? request.name;
}

/**
 * Permission checks run against the normalized target, but a proxied request
 * entered through the provider-declared wrapper. Show both identities to the
 * user without changing the response name selected by {@link providerToolName}.
 */
export function formatPermissionToolIdentity(
  request: ToolCallRequestInfo,
): string {
  const targetName = canonicalToolName(request.name);
  return request.providerName
    ? `"${targetName}" via "${request.providerName}"`
    : `"${targetName}"`;
}

/**
 * Policy rules and PermissionRequest hooks may provide an authoritative custom
 * reason that omits tool identity. Preserve that reason and append identity
 * only for proxy calls; ordinary tool denial text remains byte-for-byte intact.
 */
export function withPermissionToolIdentity(
  message: string,
  request: ToolCallRequestInfo,
): string {
  return request.providerName
    ? `${message} (tool ${formatPermissionToolIdentity(request)})`
    : message;
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

  const fail = (
    message: string,
    errorType: ToolErrorType = ToolErrorType.INVALID_TOOL_PARAMS,
    targetName?: string,
  ): DeferredToolCallNormalizationResult => ({
    ok: false,
    error: new Error(message),
    providerName: ToolNames.DEFERRED_TOOL_CALL,
    ...(targetName ? { targetName } : {}),
    errorType,
  });

  const targetName = request.args['name'];
  if (typeof targetName !== 'string' || targetName.trim().length === 0) {
    return fail(
      '`deferred_tool_call.name` must be the exact deferred tool name returned by tool_search.',
    );
  }
  // Resolve the attempted identity before validating target arguments so a
  // malformed call can still be counted and observed against the right tool.
  const canonicalTarget = canonicalToolName(targetName);
  const targetArgs = request.args['arguments'];
  if (
    !targetArgs ||
    typeof targetArgs !== 'object' ||
    Array.isArray(targetArgs)
  ) {
    return fail(
      '`deferred_tool_call.arguments` must be an object matching the target tool schema returned by tool_search.',
      ToolErrorType.INVALID_TOOL_PARAMS,
      canonicalTarget,
    );
  }

  if (canonicalTarget === ToolNames.DEFERRED_TOOL_CALL) {
    return fail(
      '`deferred_tool_call` cannot target itself. Use tool_search to fetch the real deferred tool schema, then call deferred_tool_call with that real target name.',
      ToolErrorType.INVALID_TOOL_PARAMS,
      canonicalTarget,
    );
  }

  let targetTool;
  try {
    targetTool = await toolRegistry.ensureTool(canonicalTarget);
  } catch (error) {
    return fail(
      `Failed to load deferred tool "${targetName}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      ToolErrorType.EXECUTION_FAILED,
      canonicalTarget,
    );
  }
  if (!targetTool) {
    return fail(
      `Deferred tool "${targetName}" is not available. Use tool_search to find the current deferred tool name and schema.`,
      ToolErrorType.TOOL_NOT_REGISTERED,
      canonicalTarget,
    );
  }
  if (toolRegistry.getTool(canonicalTarget) !== targetTool) {
    return fail(
      `Deferred tool "${canonicalTarget}" changed while the request was being normalized. Use tool_search to fetch its current schema, then try again on a later turn.`,
      ToolErrorType.EXECUTION_DENIED,
      canonicalTarget,
    );
  }
  if (!toolRegistry.isProxyEligibleDeferredTool(canonicalTarget)) {
    return fail(
      `Tool "${canonicalTarget}" is not eligible for deferred_tool_call. Call directly if it is visible, or use tool_search for deferred tools.`,
      ToolErrorType.EXECUTION_DENIED,
      canonicalTarget,
    );
  }
  if (!toolRegistry.hasPresentedProxySchema(canonicalTarget)) {
    return fail(
      `Schema for deferred tool "${canonicalTarget}" has not been fetched in the active context. Use tool_search first, then call deferred_tool_call on a later turn.`,
      ToolErrorType.EXECUTION_DENIED,
      canonicalTarget,
    );
  }

  return {
    ok: true,
    resolvedTool: targetTool,
    request: {
      ...request,
      name: canonicalTarget,
      args: targetArgs as Record<string, unknown>,
      providerName: ToolNames.DEFERRED_TOOL_CALL,
    },
  };
}
