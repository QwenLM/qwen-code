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
 * Tokens that, when used as the leading command of a Bash allow rule, let the
 * model execute arbitrary code under the AUTO classifier's nose. Covers
 * shell interpreters, scripting-language interpreters, and build/package
 * tools that themselves run arbitrary scripts (`cargo run`, `npm run`, …).
 * Mirrors and extends ClaudeCode's `DANGEROUS_BASH_PATTERNS`.
 */
const DANGEROUS_BASH_INTERPRETERS: readonly string[] = Object.freeze([
  // Shells
  'bash',
  'sh',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'dash',
  'ksh',
  'pwsh',
  'powershell',
  // Scripting-language interpreters
  'python',
  'python3',
  'python2',
  'node',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'lua',
  'julia',
  'r',
  'rscript',
  'groovy',
  'awk',
  'gawk',
  // Build / package tools that execute arbitrary scripts
  'cargo',
  'npm',
  'pnpm',
  'yarn',
  'make',
  'gmake',
  'gradle',
  'mvn',
  'rake',
  'task',
  'just',
  // Generic eval-y commands
  'eval',
  'exec',
  'source',
]);

/**
 * Tools whose allow rules carry shell-like risk. `monitor` is a long-running
 * shell-command runner and should be treated the same as `shell` for the
 * AUTO mode strip — a broad `Monitor(*)` or `Monitor(python *)` allow rule
 * would bypass the classifier just like its `Bash(...)` counterpart.
 */
const SHELL_LIKE_TOOLS: readonly string[] = Object.freeze([
  ToolNames.SHELL,
  ToolNames.MONITOR,
]);

/**
 * Returns true when `token` looks like a dangerous interpreter, considering
 *   - bare names (`python`, `bun`)
 *   - absolute-path forms (`/usr/bin/python3` → trailing segment `python3`)
 *   - trailing-wildcard forms (`python3*`)
 *   - colon form (`python:`)
 */
function isInterpreterToken(rawToken: string): boolean {
  if (!rawToken) return false;
  // Strip trailing wildcards / colons / arguments after `:`
  const noWildcard = rawToken.replace(/[*]+$/, '');
  const beforeColon = noWildcard.split(':')[0];
  // Last path segment so `/usr/bin/python3` → `python3`
  const lastSegment = (beforeColon ?? '').split('/').pop() ?? '';
  return DANGEROUS_BASH_INTERPRETERS.includes(lastSegment);
}

/**
 * Returns true when an allow rule on the Bash / Monitor tools is broad enough
 * to defeat the classifier:
 *   - Tool-level (no specifier, `*`, `""`)
 *   - An interpreter token paired with a wildcard, in any of:
 *     - `python` / `python:*` / `python*` / `python *` (bare or wildcard)
 *     - `python -c *`, `node -e *` (flag-style)
 *     - `bun run *`, `npm run *` (multi-token subcommand)
 *     - `/usr/bin/python3 *` (absolute-path form)
 *
 * Literal concrete commands like `Bash(python script.py)` or `Bash(npm test)`
 * are NOT flagged — the user has spelled out the exact command they trust,
 * which is precisely what the strip is meant to *not* override.
 */
export function isDangerousBashRule(rule: PermissionRule): boolean {
  if (!SHELL_LIKE_TOOLS.includes(rule.toolName)) return false;

  if (!rule.specifier || rule.specifier === '*') return true;

  const content = rule.specifier.trim().toLowerCase();
  if (content === '' || content === '*') return true;

  const firstToken = content.split(/\s+/)[0] ?? '';
  const beforeColon = content.includes(':')
    ? (content.split(':')[0] ?? '')
    : '';
  const startsWithInterpreter =
    isInterpreterToken(firstToken) || isInterpreterToken(beforeColon);

  if (!startsWithInterpreter) return false;

  // Bare interpreter name (`python`, `/usr/bin/python3`) is always dangerous
  // — it means "run this interpreter, the caller decides what to do".
  if (firstToken === content) return true;

  // Wildcard anywhere in the specifier, paired with an interpreter, defeats
  // the classifier: covers `python *`, `python -c *`, `bun run *`,
  // `/usr/bin/python3 *`, `python:*`, `node*`, etc.
  if (content.includes('*')) return true;

  // Colon form without `*` (e.g. `python:eval`) — still dangerous because
  // the colon grammar tells the matcher "any command under this verb".
  if (content.includes(':') && isInterpreterToken(beforeColon)) return true;

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
