/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * headless 的 named-tool 权限通道：把宿主的 `canUseTool` 落到
 * `--permission-prompt-tool <tool-name>` 指向的本地工具上。
 *
 * stdio 通道复用 `sdk/handlers/session/sessionHost.ts` 的 `can_use_tool` 反向请求；
 * named 通道没有 wire，只有「执行工具 → 解析 JSON 判决」两步，所以实现放在这里，
 * 由 headlessSession 在构造 ThreadHost 时替换 `requests.canUseTool`。
 */

import { randomUUID } from 'node:crypto';
import {
  applyUpdatesToRules,
  partListUnionToString,
  type AnyDeclarativeTool,
  type Config,
  type PermissionUpdate,
  type ToolResult,
} from '@qwen-code/core';
import type {
  ThreadCanUseToolDecision,
  ThreadCanUseToolRequest,
  ThreadReverseRequestOptions,
} from '../thread-manager/thread-session/contract/hostContext.js';
import { normalizeProtocolError } from '../thread-manager/support/protocolError.js';

interface ParsedPermissionDecision {
  allowed: boolean;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionUpdate[];
  permissionScope?: 'once' | 'session' | 'persist';
  interrupt?: boolean;
}

export function createNamedToolAskHandler(params: {
  readonly getConfig: () => Config;
  readonly permissionPromptToolName: string;
}): (
  request: ThreadCanUseToolRequest,
  options?: ThreadReverseRequestOptions,
) => Promise<ThreadCanUseToolDecision> {
  return async (request, options) => {
    const decision = await callNamedPermissionPromptTool({
      config: params.getConfig(),
      permissionPromptToolName: params.permissionPromptToolName,
      requestedToolName: request.toolName,
      requestedToolInput: isRecord(request.input) ? request.input : {},
      requestedToolUseId: request.toolUseId || randomUUID(),
      ...(request.permissionKind === undefined
        ? {}
        : { permissionKind: request.permissionKind }),
      details: request.details,
      signal: options?.signal,
    });
    if (decision.allowed) {
      applyUpdatedPermissions(
        params.getConfig(),
        decision.updatedPermissions,
      );
      return {
        behavior: 'allow',
        updatedInput: decision.updatedInput ?? request.input,
        ...(decision.permissionScope === undefined
          ? {}
          : { permissionScope: decision.permissionScope }),
      };
    }
    return {
      behavior: 'deny',
      message:
        decision.reason ?? 'Permission denied by permission prompt tool',
      interrupt: decision.interrupt === true,
    };
  };
}

export async function callNamedPermissionPromptTool(params: {
  readonly config: Config;
  readonly permissionPromptToolName: string;
  readonly requestedToolName: string;
  readonly requestedToolInput: Record<string, unknown>;
  readonly requestedToolUseId: string;
  readonly permissionKind?: string;
  readonly details?: unknown;
  readonly signal: AbortSignal | undefined;
}): Promise<ParsedPermissionDecision> {
  const promptTool = resolveNamedPermissionPromptTool(
    params.config,
    params.permissionPromptToolName,
  );
  if (!promptTool) {
    return deny(
      `Permission prompt tool "${params.permissionPromptToolName}" was not found.`,
    );
  }

  let result: ToolResult;
  try {
    const promptInput: Record<string, unknown> = {
      tool_name: params.requestedToolName,
      input: params.requestedToolInput,
      tool_use_id: params.requestedToolUseId,
    };
    if (params.permissionKind) {
      promptInput['permission_kind'] = params.permissionKind;
    }
    if (params.details !== undefined) {
      promptInput['details'] = params.details;
    }
    result = await promptTool
      .build(promptInput)
      .execute(params.signal ?? new AbortController().signal);
  } catch (error) {
    return deny(
      `Permission prompt tool "${params.permissionPromptToolName}" failed: ${normalizeProtocolError(error).error}`,
    );
  }

  if (result.error) {
    return deny(
      result.error.message ||
        `Permission prompt tool "${params.permissionPromptToolName}" failed.`,
    );
  }

  const responseText = extractNamedPermissionPromptToolResponse(result);
  if (!responseText) {
    return deny(
      `Permission prompt tool "${params.permissionPromptToolName}" returned an empty response.`,
    );
  }

  try {
    const decision = parsePermissionDecision(JSON.parse(responseText));
    if (
      decision.allowed &&
      decision.updatedInput &&
      Object.keys(decision.updatedInput).length === 0
    ) {
      return { ...decision, updatedInput: params.requestedToolInput };
    }
    return decision;
  } catch (error) {
    return deny(
      `Permission prompt tool "${params.permissionPromptToolName}" returned invalid JSON: ${normalizeProtocolError(error).error}`,
    );
  }
}

export function applyUpdatedPermissions(
  config: Config,
  updatedPermissions: readonly PermissionUpdate[] | undefined,
): void {
  if (!updatedPermissions?.length) return;
  const permission = config.permission;
  if (!permission) return;
  permission.setRules(
    applyUpdatesToRules(permission.getRules(), [...updatedPermissions]).rules,
  );
}

function resolveNamedPermissionPromptTool(
  config: Config,
  permissionPromptToolName: string,
): AnyDeclarativeTool | undefined {
  return (
    config.toolRegistry?.getTool(permissionPromptToolName) ??
    config.getToolRegistry?.().getTool?.(permissionPromptToolName)
  );
}

function extractNamedPermissionPromptToolResponse(
  result: ToolResult,
): string | undefined {
  const llmText = partListUnionToString(result.llmContent).trim();
  if (llmText) {
    return llmText;
  }
  return typeof result.returnDisplay === 'string'
    ? result.returnDisplay.trim()
    : undefined;
}

function deny(reason: string): ParsedPermissionDecision {
  return { allowed: false, reason };
}

function parsePermissionDecision(inner: unknown): ParsedPermissionDecision {
  if (!inner || typeof inner !== 'object') {
    return { allowed: false, reason: 'Unrecognizable permission response' };
  }

  const record = inner as Record<string, unknown>;
  const updatedPermissions = Array.isArray(record['updatedPermissions'])
    ? (record['updatedPermissions'] as PermissionUpdate[])
    : undefined;

  if ('behavior' in record) {
    if (
      record['behavior'] === 'allow' ||
      record['behavior'] === 'allow_session'
    ) {
      return {
        allowed: true,
        permissionScope:
          record['behavior'] === 'allow_session'
            ? 'session'
            : extractPermissionScope(record),
        updatedInput: extractUpdatedInput(record),
        updatedPermissions,
      };
    }
    return {
      allowed: false,
      reason: isStringProp(record, 'message')
        ? record['message']
        : 'Permission denied by SDK',
      interrupt: isBooleanProp(record, 'interrupt')
        ? record['interrupt']
        : undefined,
    };
  }

  if ('allowed' in record && isBooleanProp(record, 'allowed')) {
    return record['allowed']
      ? {
          allowed: true,
          permissionScope: extractPermissionScope(record),
          updatedInput: extractUpdatedInput(record),
          updatedPermissions,
        }
      : {
          allowed: false,
          reason: isStringProp(record, 'reason')
            ? record['reason']
            : undefined,
        };
  }

  return {
    allowed: false,
    reason: 'Unrecognizable permission response format',
  };
}

function extractPermissionScope(
  record: Record<string, unknown>,
): 'once' | 'session' | 'persist' | undefined {
  const value =
    record['permission_scope'] ??
    record['permissionScope'] ??
    record['scope'];
  return value === 'session' || value === 'once' || value === 'persist'
    ? value
    : undefined;
}

function extractUpdatedInput(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const updatedInput = record['updatedInput'];
  return isRecord(updatedInput) ? updatedInput : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringProp(
  record: Record<string, unknown>,
  key: string,
): record is Record<string, string> {
  return typeof record[key] === 'string';
}

function isBooleanProp(
  record: Record<string, unknown>,
  key: string,
): record is Record<string, boolean> {
  return typeof record[key] === 'boolean';
}
