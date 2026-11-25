/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// MCP 工具名的拼装与命名空间匹配。


// 全限定名格式：mcp__服务名__工具名（注册表与规则同形）。
const MCP_RULE_PREFIX = 'mcp__';
const MCP_RULE_SEPARATOR = '__';

// 匹配所有 MCP 工具的全局通配。
export const MCP_GLOBAL_WILDCARD = `${MCP_RULE_PREFIX}*`;


// 段归一：非法字符转下划线、连续压一个、去首尾。
export function normalizeMcpSegment(segment: string): string {
  return segment
    .replace(/[^a-zA-Z0-9_-]/g, '_') // 非法字符 → 下划线
    .replace(/_+/g, '_') // 连续下划线压成一个
    .replace(/^_|_$/g, ''); // 去掉首尾下划线
}


// composeMcpRuleName('myserver', 'search') => 'mcp__myserver__search'
export function composeMcpRuleName(
  serverName: string,
  toolName: string,
): string {
  return `${MCP_RULE_PREFIX}${normalizeMcpSegment(serverName)}${MCP_RULE_SEPARATOR}${normalizeMcpSegment(toolName)}`;
}

// composeMcpServerWildcard('myserver') => 'mcp__myserver__*'
export function composeMcpServerWildcard(serverName: string): string {
  return `${MCP_RULE_PREFIX}${normalizeMcpSegment(serverName)}${MCP_RULE_SEPARATOR}*`;
}



export function isMcpName(name: string): boolean {
  return name.startsWith(MCP_RULE_PREFIX);
}

// 四种命中形态：精确、服务通配 mcp__server__*、裸服务名 mcp__server、全局 mcp__*。
export function mcpToolNameMatchesRule(
  qualifiedName: string,
  ruleToolName: string,
): boolean {
  // 精确匹配（双下划线形式），最高优先级，先拦下。
  if (qualifiedName === ruleToolName) return true;

  // 只有带 mcp__ 前缀的名字，才可能命中 MCP 通配规则。
  if (!qualifiedName.startsWith(MCP_RULE_PREFIX)) return false;

  // 全局通配："mcp__*" 匹配任何 MCP 工具。
  if (ruleToolName === MCP_GLOBAL_WILDCARD) return true;

  // 下面按服务名段比对。规则必须以 mcp__ 开头才有可比性。
  if (ruleToolName.startsWith(MCP_RULE_PREFIX)) {
    const ruleRest = ruleToolName.slice(MCP_RULE_PREFIX.length);
    const ruleSepIdx = ruleRest.indexOf(MCP_RULE_SEPARATOR);

    const nameRest = qualifiedName.slice(MCP_RULE_PREFIX.length);
    const nameSepIdx = nameRest.indexOf(MCP_RULE_SEPARATOR);
    const nameServer =
      nameSepIdx >= 0 ? nameRest.slice(0, nameSepIdx) : nameRest;

    if (ruleSepIdx >= 0) {
      // 规则带工具段："mcp__server__*" 或 "mcp__server__tool"。
      const ruleServer = ruleRest.slice(0, ruleSepIdx);
      const ruleTool = ruleRest.slice(ruleSepIdx + MCP_RULE_SEPARATOR.length);
      if (ruleTool === '*') {
        // 服务通配：服务名相同即命中。
        return nameServer === ruleServer;
      }
      // 带具体工具名但不是通配的情况，已在最上面的精确匹配里处理；这里不再命中。
    } else {
      // 裸服务名："mcp__server"（没有工具段）匹配该服务下的所有工具。
      const ruleServer = ruleRest;
      return nameServer === ruleServer;
    }
  }

  return false;
}
