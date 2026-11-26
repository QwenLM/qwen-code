/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import type { SkillDefinition } from '@qwen-code/resource';
import type { ToolResult } from '../tools/tools.js';
import { partToString } from '../utils/partUtils.js';
import { sanitizeErrorMessage } from '../utils/agent-sanitization-utils.js';
import { captureExtensionCommonFeatures } from './extension-feature-common.js';
import {
  normalizeContentLength,
  normalizeExtensionFeatures,
  normalizePluginMarketplaceFeatures,
  type ExtensionExecutionRawRecord,
  type ExtensionExecutionSnapshot,
} from './extension-features.js';

/** 将一次扩展执行的原始记录拆成固定字段和 features；采集入口决定计时起止。 */
export async function captureExtensionExecution(
  config: Config,
  kind: 'skill' | 'subagent' | 'mcp' | 'plugin',
  rawRecord: Partial<ExtensionExecutionRawRecord>,
  result: ToolResult | undefined,
  error: unknown,
  eventTs: string,
): Promise<ExtensionExecutionSnapshot> {
  const facts = { ...rawRecord };
  const marketplaceFeatures = normalizePluginMarketplaceFeatures(
    facts.pluginMarketplace,
  );

  const failed =
    error !== undefined ||
    result?.error !== undefined ||
    result?.isError === true;
  const rawMessage =
    error !== undefined
      ? error instanceof Error
        ? error.message
        : String(error)
      : (result?.error?.message ??
        (result?.isError
          ? partToString(
            result.llmContent,
            { verbose: true }
          )
          : ''));
  const errorType =
    result?.error?.type ?? (kind === 'plugin' ? (facts.errorType ?? '') : '');
  // 返回工具错误时沿用错误结果的长度；直接抛异常没有结果，长度留空。
  const length =
    result === undefined
      ? undefined
      : result.error
        ? result.error.message.length
        : partToString(
          result.llmContent,
          { verbose: true }
        ).length;
  const contentLength = normalizeContentLength(
    result !== undefined,
    length
  );

  const originalError =
    error !== undefined && typeof error === 'object' && error !== null
      ? (error as {
        name?: unknown;
        code?: unknown;
        cause?: { code?: unknown };
      })
      : undefined;
  const timedOut =
    originalError?.name === 'TimeoutError' ||
    [
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'ERR_MCP_REQUEST_TIMEOUT',
    ].includes(String(originalError?.code ?? '')) ||
    dataOutcome(result) === 'timeout';
  const status =
    facts.status ||
    (timedOut
      ? 'timeout'
      : originalError?.name === 'AbortError'
        ? 'cancelled'
        : failed
          ? 'error'
          : 'success');

  // 错误码只取明确的 code，不从错误文本猜测，也不生成兜底码。
  const selected: Partial<ExtensionExecutionRawRecord> = {
    ...facts,
    ...(kind === 'mcp' ? {} : marketplaceFeatures),
    success: !failed && status === 'success',
    status,
    errorMessage: rawMessage ? sanitizeErrorMessage(rawMessage) : '',
    errorType,
    errorCode:
      explicitCode(facts.errorCode) ??
      explicitCode(originalError?.code) ??
      explicitCode(originalError?.cause?.code) ??
      (kind === 'mcp' ? mcpErrorCode(result) : undefined) ??
      '',
    contentLength,
    resultKind:
      result === undefined
        ? ''
        : status !== 'success'
          ? status
          : contentLength === 0
            ? 'empty'
            : kind === 'mcp'
              ? facts.toolOrigin === 'mcp'
                ? 'mcp'
                : 'text'
              : kind,
  };
  // 只读取约定的 MCP 诊断项，不把工具的整个 data 对象带入度量。
  const data = result?.data;
  const diagnosticKeys = [
    ['mcpServerName', 'mcp_server_name'],
    ['mcpTransport', 'mcp_transport'],
    ['mcpOperation', 'mcp_operation'],
    ['mcpInvocationPath', 'mcp_invocation_path'],
    ['mcpTargetToolName', 'mcp_target_tool_name'],
    ['mcpOperationOutcome', 'mcp_operation_outcome'],
    ['mcpDiscoveryFirstPromptId', 'mcp_discovery_first_prompt_id'],
    ['mcpListRank', 'mcp_list_rank'],
    ['mcpDiscoveryOps', 'mcp_discovery_ops'],
    ['mcpDispatchSuccess', 'mcp_dispatch_success'],
    ['mcpServerResponded', 'mcp_server_responded'],
    ['mcpSemanticSuccess', 'mcp_semantic_success'],
    ['mcpListKeywordUsed', 'mcp_list_keyword_used'],
    ['mcpListServerUsed', 'mcp_list_server_used'],
    ['mcpListIncludeDescription', 'mcp_list_include_description'],
    ['mcpDiscoverySameTurn', 'mcp_discovery_same_turn'],
  ] as const;
  for (const [key, source] of diagnosticKeys) {
    if (kind === 'mcp' && data?.[source] !== undefined)
      Object.assign(
        selected,
        { [key]: data[source] }
      );
  }
  const common = await captureExtensionCommonFeatures(
    config,
    randomUUID(),
    eventTs,
  );
  const name =
    kind === 'skill'
      ? selected.skillName || selected.toolName || 'unknown'
      : kind === 'subagent'
        ? selected.subagentType || selected.toolName || 'unknown'
        : kind === 'plugin'
          ? selected.pluginName || 'unknown'
          : selected.mcpTargetToolName || selected.toolName || 'unknown';

  // Hook 触发前固定快照：名称、耗时、状态和错误信息始终独立于 features。
  return {
    extensionExecution: Object.freeze({
      kind,
      ...(kind === 'mcp' ? { pluginMarketplaceFeatures: marketplaceFeatures } : {}),
      ...(kind !== 'plugin' && selected.pluginName?.trim()
        ? { pluginName: selected.pluginName.trim() }
        : {}),
      name,
      status,
      ...(typeof selected.durationMs === 'number' &&
        Number.isFinite(selected.durationMs) &&
        selected.durationMs >= 0
        ? { durationMs: selected.durationMs }
        : {}),
      ...(errorType ? { errorType } : {}),
      ...(selected.errorCode ? { errorCode: selected.errorCode } : {}),
    }),
    extensionFeatures: normalizeExtensionFeatures(
      kind,
      {
        ...selected,
        ...common,
      }
    ),
  };
}

function dataOutcome(result: ToolResult | undefined): unknown {
  return result?.data?.['mcp_operation_outcome'];
}

function explicitCode(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function mcpErrorCode(result: ToolResult | undefined): string | undefined {
  // MCP 只读取协议层保留下来的明确错误码，不解析展示给模型的错误文本。
  const diagnostic = result?.data?.['mcp_error'];
  if (!diagnostic || typeof diagnostic !== 'object') return undefined;
  const codes = diagnostic as { errorCode?: unknown; errorCauseCode?: unknown };
  return explicitCode(codes.errorCode) ?? explicitCode(codes.errorCauseCode);
}

/** 记录实际激活的 Skill，包括被 PreToolUse 改写后的目标。 */
export function captureSkillFeatureFacts(
  skill: SkillDefinition | null | undefined,
  activationSource: string,
): Partial<ExtensionExecutionRawRecord> {
  return {
    skillName: skill?.name ?? '',
    pluginMarketplace: skill?.source === 'plugin' && skill.plugin
      ? { ...skill.plugin }
      : undefined,
    ...(skill?.source === 'plugin' && skill.pluginName
      ? { pluginName: skill.pluginName }
      : {}),
    skillSource: skill?.source ?? (skill?.isBuiltin ? 'built-in' : ''),
    activationSource,
    resourceSoftlink: skill?.resourceLocation?.softlink ?? '',
    resourcePathBase: skill?.resourceLocation?.base ?? '',
    resourceRelativePath: skill?.resourceLocation?.relativePath ?? '',
  };
}
