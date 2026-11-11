/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// 公开入口。判定执行在会话 manager 的 check 里；这里只保留契约类型与规则工具。

// 模式词表统一收在这里，宿主、模块、落盘配置三方不会各拼各的。
export {
  PERMISSION_MODES,
  PermissionModes,
  normalizePermissionMode,
  isDefaultMode,
  isAcceptEditsMode,
  isAutoMode,
  isDontAskMode,
  isYoloMode,
} from './types/decision.js';

export type {
  AskSettlementKind,
  DecisionKind,
  PermissionBehavior,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRule,
  PermissionRules,
  PermissionRulesBySource,
  PermissionRulesBySourceForTool,
  PermissionRuleSource,
  PermissionRuleValue,
  PreToolUseHookVerdict,
  RulesForTool,
  StageKind,
  ToolCheckResult,
} from './types/decision.js';

export type {
  AskHandleContext,
  AskHandleResult,
  AskHandler,
  PermissionOptions,
  CheckPermissionOptions,
} from './types/options.js';

export type {
  ToolCheckContext,
  AutoClassifierView,
  ToolPermissionChecker,
} from './types/tool-check.js';

// 规则字符串工具：纯数据变换，无 I/O、不感知工具形状。
export {
  escapeRuleContent,
  getLegacyToolNames,
  normalizeLegacyToolName,
  permissionRuleValueFromString,
  permissionRuleValueToString,
  unescapeRuleContent,
} from './rules/parser.js';

export {
  MCP_GLOBAL_WILDCARD,
  composeMcpRuleName,
  composeMcpServerWildcard,
  isMcpName,
  mcpToolNameMatchesRule,
  normalizeMcpSegment,
} from './rules/mcp-names.js';

// rulesForToolName 即递给 checker 的 ctx.rulesForTool；
// toolNameMatchesRule 用于自检之外判断规则是否针对某工具。
export {
  rulesForToolName,
  toolNameMatchesRule,
} from './rules/matching.js';
