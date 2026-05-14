/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Detection of allow rules whose breadth would defeat the AUTO mode
 * classifier. Such rules are stripped from the working PermissionManager
 * while the user is in AUTO and restored when they leave (see
 * PermissionManager.stripDangerousRulesForAutoMode / restoreDangerousRules).
 *
 * `settings.json` is never modified — strip / restore is a runtime-only
 * concern.
 */

import { ToolNames } from '../tools/tool-names.js';
import type { PermissionRule } from './types.js';

/**
 * Shell interpreters whose name (or wildcard form) embedded in a Bash allow
 * rule would let the model execute arbitrary code under the AUTO classifier's
 * nose. Mirrors ClaudeCode's `DANGEROUS_BASH_PATTERNS`.
 */
const DANGEROUS_BASH_INTERPRETERS: readonly string[] = Object.freeze([
  'bash',
  'sh',
  'zsh',
  'fish',
  'python',
  'python3',
  'node',
  'deno',
  'bun',
  'ruby',
  'perl',
]);

/**
 * Returns true when an allow rule on the Bash / SHELL tool is broad enough
 * to defeat the classifier:
 *   - Tool-level (no specifier, `*`, `""`)
 *   - An interpreter name, with or without trailing wildcards
 *   - An interpreter command-line pattern (e.g. `python -c *`)
 */
export function isDangerousBashRule(rule: PermissionRule): boolean {
  if (rule.toolName !== ToolNames.SHELL) return false;

  if (!rule.specifier || rule.specifier === '*') return true;

  const content = rule.specifier.trim().toLowerCase();
  if (content === '' || content === '*') return true;

  for (const interp of DANGEROUS_BASH_INTERPRETERS) {
    if (content === interp) return true;
    if (content === `${interp}:*`) return true;
    if (content === `${interp}*`) return true;
    if (content === `${interp} *`) return true;
    if (content.startsWith(`${interp} -`) && content.endsWith('*')) {
      return true;
    }
  }
  return false;
}

/**
 * Any allow rule on the Agent (sub-agent spawn) tool defeats the classifier:
 * once a sub-agent is launched, its own prompt evades classifier review
 * because the orchestrator only sees the outer Agent call.
 */
export function isDangerousAgentRule(rule: PermissionRule): boolean {
  return rule.toolName === ToolNames.AGENT;
}

/**
 * Any allow rule on the Skill tool defeats the classifier: skill execution
 * loads user-defined code, which can perform arbitrary actions outside the
 * classifier's view.
 */
export function isDangerousSkillRule(rule: PermissionRule): boolean {
  return rule.toolName === ToolNames.SKILL;
}

/**
 * Aggregate predicate combining all dangerous-rule categories.
 */
export function isDangerousAllowRule(rule: PermissionRule): boolean {
  return (
    isDangerousBashRule(rule) ||
    isDangerousAgentRule(rule) ||
    isDangerousSkillRule(rule)
  );
}

/**
 * Filter a list of allow rules to those that would defeat the classifier.
 * Caller is expected to physically remove these from the active rule set
 * (via PermissionManager.stripDangerousRulesForAutoMode) and stash them
 * for restore on AUTO exit.
 */
export function findDangerousAllowRules(
  allowRules: readonly PermissionRule[],
): PermissionRule[] {
  return allowRules.filter(isDangerousAllowRule);
}
