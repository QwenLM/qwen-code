/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PluginMarketplaceMetadata } from '@qwen-code/resource';

export interface ExtensionMarketplaceFeatures {
  marketSourceId: string;
  marketOrgId: string;
  extensionKind: string;
  extensionId: string;
  extensionVersion: string;
}

/** Internal, selected extension execution attributes. Never serialized into hook input. */
export interface ExtensionFeatures extends Partial<ExtensionMarketplaceFeatures> {
  marketItemId?: string;
  displayName?: string;
  version?: string;
  eventId: string;
  eventTs: string;
  sessionId: string;
  cliVersion: string;
  product: string;
  productVersion: string;
  agentSdkEntrypoint: string;
  agentSdkVersion: string;
  agentSdkLanguage: string;
  principalType: string;
  principalId: string;
  userId: string;
  accountId: string;
  organizationId: string;
  parentSurface: string;
  os: string;
  locale: string;
  tzOffsetMin: number | '';
  toolCallId: string;
  toolOrigin: string;
  toolKind: string;
  success: boolean | '';
  errorMessage: string;
  contentLength: number | '';
  resultKind: string;
  finalStatus: string;
  lifecycleErrorType: string;
  toolTotalDurationMs: number | '';
  mcpServerName?: string;
  mcpTransport?: string;
  mcpOperation?: string;
  mcpInvocationPath?: string;
  mcpOperationOutcome?: string;
  mcpListResultCount?: number | '';
  mcpDiscoveryFirstPromptId?: string;
  mcpListRank?: number | '';
  mcpDiscoveryOps?: number | '';
  mcpDispatchSuccess?: boolean | '';
  mcpServerResponded?: boolean | '';
  mcpSemanticSuccess?: boolean | '';
  mcpListKeywordUsed?: boolean | '';
  mcpListServerUsed?: boolean | '';
  mcpListIncludeDescription?: boolean | '';
  mcpDiscoverySameTurn?: boolean | '';
  activationSource?: string;
  skillSource?: string;
  resourceSoftlink?: boolean | '';
  resourcePathBase?: string;
  resourceRelativePath?: string;
  taskId?: string;
  agentId?: string;
  subagentCredits?: number | '';
  agentSource?: string;
  subagentLoopIterationCount?: number | '';
  subagentDurationMs?: number | '';
  subagentStatus?: string;
  subagentErrorType?: string;
}

/** 对应上报顶层的固定字段，经过 Hook 时与 features 分开传递。 */
export interface ExtensionExecutionFields {
  /** 已采集的类别；未携带时由消费端沿用 Hook 上下文识别。 */
  kind?: 'skill' | 'subagent' | 'mcp' | 'plugin';
  /** 实际加载的所属插件名称，商城元数据缺失时用于插件事件的名称与归属。 */
  pluginName?: string;
  /** MCP 所属插件的文件身份，与 MCP initialize 身份独立保存。 */
  pluginMarketplaceFeatures?: Readonly<ExtensionMarketplaceFeatures>;
  name: string;
  durationMs?: number;
  status: string;
  errorType?: string;
  errorCode?: string;
}

/** 采集阶段的原始记录；触发 Hook 前再拆成固定字段和白名单 features。 */
export interface ExtensionExecutionRawRecord extends ExtensionFeatures {
  pluginName?: string;
  pluginMarketplace?: Readonly<PluginMarketplaceMetadata>;
  toolName: string;
  skillName?: string;
  subagentType?: string;
  mcpTargetToolName?: string;
  durationMs: number | '';
  status: string;
  errorType: string;
  errorCode?: string;
}

export interface ExtensionExecutionSnapshot {
  readonly extensionExecution: Readonly<ExtensionExecutionFields>;
  readonly extensionFeatures: Readonly<ExtensionFeatures>;
}

export const COMMON_EXTENSION_KEYS = [
  'eventId',
  'eventTs',
  'sessionId',
  'cliVersion',
  'product',
  'productVersion',
  'agentSdkEntrypoint',
  'agentSdkVersion',
  'agentSdkLanguage',
  'principalType',
  'principalId',
  'userId',
  'accountId',
  'organizationId',
  'parentSurface',
  'os',
  'locale',
  'tzOffsetMin',
] as const satisfies Array<keyof ExtensionFeatures>;

export const TOOL_EXTENSION_KEYS = [
  'toolCallId',
  'toolOrigin',
  'toolKind',
  'success',
  'errorMessage',
  'contentLength',
  'resultKind',
  'finalStatus',
  'lifecycleErrorType',
  'toolTotalDurationMs',
] as const satisfies Array<keyof ExtensionFeatures>;

export const MCP_EXTENSION_KEYS = [
  'marketItemId',
  'displayName',
  'version',
  'mcpServerName',
  'mcpTransport',
  'mcpOperation',
  'mcpInvocationPath',
  'mcpOperationOutcome',
  'mcpListResultCount',
  'mcpDiscoveryFirstPromptId',
  'mcpListRank',
  'mcpDiscoveryOps',
  'mcpDispatchSuccess',
  'mcpServerResponded',
  'mcpSemanticSuccess',
  'mcpListKeywordUsed',
  'mcpListServerUsed',
  'mcpListIncludeDescription',
  'mcpDiscoverySameTurn',
] as const satisfies Array<keyof ExtensionFeatures>;

export const MARKETPLACE_EXTENSION_KEYS = [
  'marketSourceId',
  'marketOrgId',
  'extensionKind',
  'extensionId',
  'extensionVersion',
] as const satisfies Array<keyof ExtensionFeatures>;

/** 只映射文件中的身份字段，缺失时留空，不用运行时名称或版本补造。 */
export function normalizePluginMarketplaceFeatures(
  metadata?: Partial<PluginMarketplaceMetadata>,
): Readonly<ExtensionMarketplaceFeatures> {
  const value = (key: keyof PluginMarketplaceMetadata): string => {
    const field = metadata?.[key];
    return typeof field === 'string' ? field : '';
  };

  return Object.freeze({
    marketSourceId: value('marketSourceId'),
    marketOrgId: value('orgId'),
    extensionKind: value('itemKind'),
    extensionId: value('marketItemId'),
    extensionVersion: value('version'),
  });
}

export const SKILL_EXTENSION_KEYS = [
  'activationSource',
  'skillSource',
  'resourceSoftlink',
  'resourcePathBase',
  'resourceRelativePath',
] as const satisfies Array<keyof ExtensionFeatures>;

export const SUBAGENT_EXTENSION_KEYS = [
  'taskId',
  'agentId',
  'subagentCredits',
  'agentSource',
  'subagentLoopIterationCount',
  'subagentDurationMs',
  'subagentStatus',
  'subagentErrorType',
] as const satisfies Array<keyof ExtensionFeatures>;

const numberKeys = new Set<keyof ExtensionFeatures>([
  'tzOffsetMin',
  'contentLength',
  'toolTotalDurationMs',
  'mcpListResultCount',
  'mcpListRank',
  'mcpDiscoveryOps',
  'subagentCredits',
  'subagentLoopIterationCount',
  'subagentDurationMs',
]);
const booleanKeys = new Set<keyof ExtensionFeatures>([
  'success',
  'resourceSoftlink',
  'mcpDispatchSuccess',
  'mcpServerResponded',
  'mcpSemanticSuccess',
  'mcpListKeywordUsed',
  'mcpListServerUsed',
  'mcpListIncludeDescription',
  'mcpDiscoverySameTurn',
]);

export function normalizeContentLength(
  sourceAvailable: boolean,
  value: number | undefined,
): number | '' {
  // 有结果但内容为空时填 0；根本没有结果来源时留空，二者不能混为一谈。
  return sourceAvailable
    ? typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : 0
    : '';
}

export function normalizeExtensionFeatures(
  kind: 'skill' | 'subagent' | 'mcp' | 'plugin',
  input: Partial<ExtensionFeatures>,
): Readonly<ExtensionFeatures> {
  // 只保留该类扩展的特征；普通插件、Skill、子代理不混入 MCP 专属字段。
  const keys: Array<keyof ExtensionFeatures> = [
    ...COMMON_EXTENSION_KEYS,
    ...TOOL_EXTENSION_KEYS,
    ...(kind === 'mcp' ? [] : MARKETPLACE_EXTENSION_KEYS),
    ...(kind === 'skill'
      ? SKILL_EXTENSION_KEYS
      : kind === 'subagent'
        ? SUBAGENT_EXTENSION_KEYS
        : kind === 'mcp'
          ? MCP_EXTENSION_KEYS
          : []),
  ];
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => {
        const value = input[key];
        const valid = numberKeys.has(key)
          ? typeof value === 'number' && Number.isFinite(value)
          : booleanKeys.has(key)
            ? typeof value === 'boolean'
            : typeof value === 'string';
        // 无法采集或类型不符时保持空值，不替换成看似有效的 0 或 false。
        return [key, valid ? value : ''];
      }),
    ),
  ) as unknown as Readonly<ExtensionFeatures>;
}
