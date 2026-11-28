/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// 规则字符串的解析与序列化。格式：`工具名` 或 `工具名(内容)`。
// 只管字符串层面，内容的含义由宿主自检判断。

import type { PermissionRuleValue } from '../types/decision.js';

// 旧工具名归一。别名表由宿主装配时注入（工具改名是宿主的历史，组件不内置）；
// 未注入时原样返回。
export function normalizeLegacyToolName(
  name: string,
  aliases: Record<string, string> = {},
): string {
  const canonical = aliases[name];
  if (canonical !== undefined) {
    return canonical;
  }
  return name;
}

// 反查映射到某规范名的所有旧名。
export function getLegacyToolNames(
  canonicalName: string,
  aliases: Record<string, string> = {},
): string[] {
  const result: string[] = [];
  const legacyNames = Object.keys(aliases);
  for (const legacy of legacyNames) {
    if (aliases[legacy] === canonicalName) {
      result.push(legacy);
    }
  }
  return result;
}

// 转义顺序：先反斜杠后括号，否则新加的反斜杠会被二次转义。
// 反转义（unescapeRuleContent）顺序相反。
export function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

export function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

// 前面有奇数个连续反斜杠视为被转义。
function findFirstUnescapedChar(str: string, char: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && str[j] === '\\') {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) {
        return i;
      }
    }
  }
  return -1;
}

function findLastUnescapedChar(str: string, char: string): number {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && str[j] === '\\') {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) {
        return i;
      }
    }
  }
  return -1;
}

// 畸形输入一律退化成整串当工具名：规则来自用户配置，不能因一条坏规则崩掉解析。
// 空内容或单独 *（如 Bash()、Bash(*)）等价于整工具规则，不带 ruleContent。
export function permissionRuleValueFromString(
  ruleString: string,
  aliases: Record<string, string> = {},
): PermissionRuleValue {
  const openParenIndex = findFirstUnescapedChar(ruleString, '(');
  if (openParenIndex === -1) {
    return { toolName: normalizeLegacyToolName(ruleString, aliases) };
  }

  const closeParenIndex = findLastUnescapedChar(ruleString, ')');
  if (closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
    return { toolName: normalizeLegacyToolName(ruleString, aliases) };
  }

  if (closeParenIndex !== ruleString.length - 1) {
    return { toolName: normalizeLegacyToolName(ruleString, aliases) };
  }

  const toolName = ruleString.substring(0, openParenIndex);
  const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex);

  if (!toolName) {
    return { toolName: normalizeLegacyToolName(ruleString, aliases) };
  }

  if (rawContent === '' || rawContent === '*') {
    return { toolName: normalizeLegacyToolName(toolName, aliases) };
  }

  const ruleContent = unescapeRuleContent(rawContent);
  return { toolName: normalizeLegacyToolName(toolName, aliases), ruleContent };
}

export function permissionRuleValueToString(
  ruleValue: PermissionRuleValue,
): string {
  if (!ruleValue.ruleContent) {
    return ruleValue.toolName;
  }
  const escapedContent = escapeRuleContent(ruleValue.ruleContent);
  return `${ruleValue.toolName}(${escapedContent})`;
}
