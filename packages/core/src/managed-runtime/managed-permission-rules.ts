/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ManagedPermissionRules {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
}

const RULE_KINDS = ['allow', 'ask', 'deny'] as const;
const SHELL = new Set([
  'Bash',
  'Shell',
  'ShellTool',
  'run_shell_command',
  'monitor',
  'Monitor',
  'MonitorTool',
]);
const WEB = new Set(['WebFetch', 'WebFetchTool', 'web_fetch']);
const TOOL = /^[A-Za-z_][A-Za-z0-9_.:-]*$/u;
const MCP = /^mcp__[A-Za-z0-9_.:-]+(?:__[A-Za-z0-9_.:-]+)?\*?$/u;
const DOMAIN = /^domain:(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;
const encoder = new TextEncoder();

function validRule(rule: string): boolean {
  if (
    !rule ||
    rule !== rule.trim() ||
    /\p{Cc}/u.test(rule) ||
    encoder.encode(rule).length > 512
  )
    return false;
  const open = rule.indexOf('(');
  if (open < 0)
    return rule.startsWith('mcp__') ? MCP.test(rule) : TOOL.test(rule);
  if (!rule.endsWith(')')) return false;
  const tool = rule.slice(0, open);
  const specifier = rule.slice(open + 1, -1);
  return (
    !!specifier &&
    specifier === specifier.trim() &&
    (SHELL.has(tool) || (WEB.has(tool) && DOMAIN.test(specifier)))
  );
}

export function parseManagedPermissionRules(
  value: unknown,
): ManagedPermissionRules {
  const invalid = () => new Error('Invalid portable permission rules.');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 3 ||
    RULE_KINDS.some((kind) => !Object.hasOwn(fields, kind))
  )
    throw invalid();
  let total = 0;
  const result = {} as Record<(typeof RULE_KINDS)[number], string[]>;
  for (const kind of RULE_KINDS) {
    const rules = fields[kind];
    if (
      !Array.isArray(rules) ||
      rules.length > 32 ||
      rules.some((rule) => typeof rule !== 'string' || !validRule(rule)) ||
      new Set(rules).size !== rules.length
    )
      throw invalid();
    total += rules.length;
    result[kind] = [...rules] as string[];
  }
  if (total > 64 || encoder.encode(JSON.stringify(result)).length > 8192)
    throw invalid();
  return result;
}

export function nonEmptyManagedPermissionRules(
  rules: ManagedPermissionRules | undefined,
): ManagedPermissionRules | undefined {
  return rules && RULE_KINDS.some((kind) => rules[kind].length > 0)
    ? rules
    : undefined;
}
