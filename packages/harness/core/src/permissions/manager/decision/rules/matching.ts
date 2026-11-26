/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// 规则集上的工具名匹配。只按工具名筛选；ruleContent 是否命中调用输入
// 由宿主自检判断（本包不知道工具输入的形状）。

import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRules,
  PermissionRulesBySourceForTool,
  RulesForTool,
} from '../types/decision.js';
import { permissionRuleValueFromString } from './parser.js';
import { isMcpName, mcpToolNameMatchesRule } from './mcp-names.js';

function collectRules(
  rules: PermissionRules,
  behavior: PermissionBehavior,
  aliases: Record<string, string> = {},
): PermissionRule[] {
  let bucket;
  if (behavior === 'allow') {
    bucket = rules.allow;
  } else if (behavior === 'deny') {
    bucket = rules.deny;
  } else {
    bucket = rules.ask;
  }

  const result: PermissionRule[] = [];
  const sources = Object.keys(bucket);
  for (const source of sources) {
    const ruleSource = source as PermissionRuleSource;
    const ruleStrings = bucket[ruleSource];
    if (!ruleStrings) continue;
    for (const ruleString of ruleStrings) {
      result.push({
        source: ruleSource,
        ruleBehavior: behavior,
        ruleValue: permissionRuleValueFromString(ruleString, aliases),
      });
    }
  }
  return result;
}


// 精确相等、裸通配 *，任一侧是 MCP 名字则走 MCP 通配约定。
export function toolNameMatchesRule(
  toolName: string,
  ruleToolName: string,
): boolean {
  if (toolName === ruleToolName) return true;
  if (ruleToolName === '*') return true;
  if (isMcpName(toolName) || isMcpName(ruleToolName)) {
    return mcpToolNameMatchesRule(toolName, ruleToolName);
  }
  return false;
}

// 取某工具名下的规则，按粒度×行为×来源索引；只出现确有规则的来源。
export function rulesForToolName(
  rules: PermissionRules,
  toolName: string,
  aliases: Record<string, string> = {},
): RulesForTool {
  const toolLevel: RulesForTool['toolLevel'] = { allow: {}, deny: {}, ask: {} };
  const toolDetailLevel: RulesForTool['toolDetailLevel'] = {
    allow: {},
    deny: {},
    ask: {},
  };

  const behaviors: PermissionBehavior[] = ['allow', 'deny', 'ask'];
  for (const behavior of behaviors) {
    // 本行为下、按来源分组的两个粒度桶。
    const perSourceLevel: PermissionRulesBySourceForTool = {};
    const perSourceDetail: PermissionRulesBySourceForTool = {};

    const allRules = collectRules(rules, behavior, aliases);
    for (const rule of allRules) {
      if (!toolNameMatchesRule(toolName, rule.ruleValue.toolName)) continue;
      // 无 ruleContent 归工具级，有则归明细级。
      const target =
        rule.ruleValue.ruleContent === undefined
          ? perSourceLevel
          : perSourceDetail;
      const existing = target[rule.source] as PermissionRule[] | undefined;
      if (existing) {
        existing.push(rule);
      } else {
        target[rule.source] = [rule];
      }
    }

    toolLevel[behavior] = perSourceLevel;
    toolDetailLevel[behavior] = perSourceDetail;
  }

  return { toolLevel, toolDetailLevel };
}
