/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Allow rules that Auto mode must not honour.
 *
 * Auto mode replaces the prompt with a classifier, so an allow rule that grants
 * something *before* the classifier sees it defeats the whole arrangement. Three
 * shapes do that: a shell grant broad enough to run an interpreter, the same for
 * PowerShell, and any Agent grant at all — a subagent spawn approved up front is
 * a prompt the classifier never gets to read, which is exactly how a delegation
 * attack gets through.
 *
 * So entering Auto strips those rules and leaving Auto puts them back. The stash
 * lives in this module rather than in the rule set, because it is not
 * configuration — it is what Auto mode borrowed and owes back.
 */

import type {
  PermissionRule,
  PermissionRules,
  PermissionRuleSource,
  PermissionRulesBySource,
  PermissionRuleValue,
} from '../../manager/decision/index.js';
import {
  normalizeLegacyToolName,
  permissionRuleValueFromString,
} from '../../manager/decision/index.js';
import {
  CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS,
} from '../../../tools/shell-permissions/dangerousPatterns.js';
import { SHELL_TOOL_NAME } from '../../../tools/tool-names.js';

/** The Agent tool, as permission rules name it. */
const AGENT_TOOL_NAME = 'Agent';

/**
 * PowerShell as a rule may name it. This host runs one unified shell tool, but a
 * user's settings may still carry PowerShell-shaped rules, and a rule nobody
 * matches is still a rule that must not be treated as safe.
 */
const POWERSHELL_TOOL_NAME = 'PowerShell';

/**
 * Checks if a shell permission rule is dangerous for auto mode.
 * A rule is dangerous if it would auto-allow commands that execute arbitrary code,
 * bypassing the classifier's safety evaluation.
 *
 * Dangerous patterns:
 * 1. Tool-level allow (Shell with no ruleContent) — allows ALL commands
 * 2. Prefix rules for script interpreters (python:*, node:*, etc.)
 * 3. Wildcard rules matching interpreters (python*, node*, etc.)
 *
 * Handles both our SHELL_TOOL_NAME ('Bash') and legacy 'run_shell_command' name
 * for compatibility with migrated rule sets.
 */
export function isDangerousShellPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  // Only check Shell/Bash rules
  if (toolName !== SHELL_TOOL_NAME && toolName !== 'Bash') {
    return false;
  }

  // Tool-level allow (Shell with no content, or Shell(*)) — allows ALL commands
  if (ruleContent === undefined || ruleContent === '') {
    return true;
  }

  const content = ruleContent.trim().toLowerCase();

  // Standalone wildcard (*) matches everything
  if (content === '*') {
    return true;
  }

  // Check for dangerous patterns with prefix syntax (e.g., "python:*")
  // or wildcard syntax (e.g., "python*")
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    const lowerPattern = pattern.toLowerCase();

    // Exact match to the pattern itself (e.g., "python" as a rule)
    if (content === lowerPattern) {
      return true;
    }

    // Prefix syntax: "python:*" allows any python command
    if (content === `${lowerPattern}:*`) {
      return true;
    }

    // Wildcard at end: "python*" matches python, python3, etc.
    if (content === `${lowerPattern}*`) {
      return true;
    }

    // Wildcard with space: "python *" would match "python script.py"
    if (content === `${lowerPattern} *`) {
      return true;
    }

    // Check for patterns like "python -*" which would match "python -c 'code'"
    if (content.startsWith(`${lowerPattern} -`) && content.endsWith('*')) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Dangerous Rule Detection — PowerShell
// ============================================================================

/**
 * Checks if a PowerShell permission rule is dangerous for auto mode.
 * A rule is dangerous if it would auto-allow commands that execute arbitrary
 * code (nested shells, Invoke-Expression, Start-Process, etc.), bypassing the
 * classifier's safety evaluation.
 *
 * PowerShell is case-insensitive, so rule content is lowercased before matching.
 *
 * Note: Our project uses a unified SHELL_TOOL_NAME, but this function handles
 * explicit 'PowerShell' rules for compatibility with legacy rule sets.
 */
export function isDangerousPowerShellPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== POWERSHELL_TOOL_NAME) {
    return false;
  }

  // Tool-level allow (PowerShell with no content, or PowerShell(*)) — allows ALL commands
  if (ruleContent === undefined || ruleContent === '') {
    return true;
  }

  const content = ruleContent.trim().toLowerCase();

  // Standalone wildcard (*) matches everything
  if (content === '*') {
    return true;
  }

  // PS-specific cmdlet names. CROSS_PLATFORM_CODE_EXEC is shared with bash.
  const patterns: readonly string[] = [
    ...CROSS_PLATFORM_CODE_EXEC,
    // Nested PS + shells launchable from PS
    'pwsh',
    'powershell',
    'cmd',
    'wsl',
    // String/scriptblock evaluators
    'iex',
    'invoke-expression',
    'icm',
    'invoke-command',
    // Process spawners
    'start-process',
    'saps',
    'start',
    'start-job',
    'sajb',
    'start-threadjob',
    // Event/session code exec
    'register-objectevent',
    'register-engineevent',
    'register-wmievent',
    'register-scheduledjob',
    'new-pssession',
    'nsn',
    'enter-pssession',
    'etsn',
    // .NET escape hatches
    'add-type',
    'new-object',
  ];

  for (const pattern of patterns) {
    if (content === pattern) return true;
    if (content === `${pattern}:*`) return true;
    if (content === `${pattern}*`) return true;
    if (content === `${pattern} *`) return true;
    if (content.startsWith(`${pattern} -`) && content.endsWith('*'))
      return true;
    // .exe variants for Windows
    const sp = pattern.indexOf(' ');
    const exe =
      sp === -1
        ? `${pattern}.exe`
        : `${pattern.slice(0, sp)}.exe${pattern.slice(sp)}`;
    if (content === exe) return true;
    if (content === `${exe}:*`) return true;
    if (content === `${exe}*`) return true;
    if (content === `${exe} *`) return true;
    if (content.startsWith(`${exe} -`) && content.endsWith('*')) return true;
  }
  return false;
}

// ============================================================================
// Dangerous Rule Detection — Agent
// ============================================================================

/**
 * Checks if an Agent (sub-agent) permission rule is dangerous for auto mode.
 * Any Agent allow rule would auto-approve sub-agent spawns before the auto mode
 * classifier can evaluate the sub-agent's prompt, defeating delegation attack
 * prevention.
 */
export function isDangerousAgentPermission(
  toolName: string,
  _ruleContent: string | undefined,
): boolean {
  return normalizeLegacyToolName(toolName) === AGENT_TOOL_NAME;
}

// ============================================================================
// Dangerous Rule Detection — Combined
// ============================================================================

/**
 * Checks if a permission rule is dangerous for auto mode.
 * A rule is dangerous if it would auto-allow actions before the auto mode
 * classifier can evaluate them, bypassing safety checks.
 */
export function isDangerousClassifierPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  return (
    isDangerousShellPermission(toolName, ruleContent) ||
    isDangerousPowerShellPermission(toolName, ruleContent) ||
    isDangerousAgentPermission(toolName, ruleContent)
  );
}

// ============================================================================
// Stripping and restoring
// ============================================================================

/**
 * What Auto mode took away, so it can be given back.
 *
 * Not part of the rule set: a stripped rule is not configuration any more, and
 * writing it into the rules would mean the next reader has to know to ignore it.
 *
 * One stash per session, owned by that session's `AutoClassifier`. A single
 * shared slot let one session's Auto entry overwrite another's stash — the loser
 * got back rules it had never been granted, and its own were gone for good.
 * Keying it on the permission object fixed that; hanging it off the classifier
 * removes the module state entirely, and is sturdier besides, because a
 * session's `permission` is assigned from outside and could in principle be
 * replaced, while its classifier is created with its `Config` and never is.
 */
export interface DangerousRuleStash {
  read(): PermissionRulesBySource | undefined;
  replace(stash: PermissionRulesBySource): void;
  clear(): void;
}

export function createDangerousRuleStash(): DangerousRuleStash {
  let stashed: PermissionRulesBySource | undefined;
  return {
    read: () => stashed,
    replace: (stash) => {
      stashed = stash;
    },
    clear: () => {
      stashed = undefined;
    },
  };
}

/** Every allow rule in the set, flattened with its source attached. */
function allowRulesOf(rules: PermissionRules): PermissionRule[] {
  const flat: PermissionRule[] = [];
  for (const [source, ruleStrings] of Object.entries(rules.allow)) {
    for (const ruleString of ruleStrings ?? []) {
      flat.push({
        source: source as PermissionRuleSource,
        ruleBehavior: 'allow',
        ruleValue: permissionRuleValueFromString(ruleString),
      });
    }
  }
  return flat;
}

function isSameRule(a: PermissionRuleValue, b: PermissionRuleValue): boolean {
  return a.toolName === b.toolName && a.ruleContent === b.ruleContent;
}

export function filterDangerousAllowRules(
  rules: PermissionRules,
): PermissionRules {
  let allow: PermissionRulesBySource | undefined;
  for (const [source, ruleStrings] of Object.entries(rules.allow)) {
    if (!ruleStrings) continue;
    const kept = ruleStrings.filter((ruleString) => {
      const { toolName, ruleContent } =
        permissionRuleValueFromString(ruleString);
      return !isDangerousClassifierPermission(toolName, ruleContent);
    });
    if (kept.length !== ruleStrings.length) {
      allow ??= { ...rules.allow };
      allow[source as PermissionRuleSource] = kept;
    }
  }
  return allow ? { ...rules, allow } : rules;
}

/**
 * Remove the allow rules Auto mode must not honour, remembering them.
 *
 * Called when entering Auto. Returns the rule set unchanged when there is
 * nothing dangerous, so the caller can skip a pointless `setRules`.
 *
 * `ruleStash` is the session's own; concurrent sessions cannot take each
 * other's rules.
 */
export function stripDangerousAllowRules(
  ruleStash: DangerousRuleStash,
  rules: PermissionRules,
): PermissionRules {
  const dangerous = allowRulesOf(rules).filter((rule) =>
    isDangerousClassifierPermission(
      rule.ruleValue.toolName,
      rule.ruleValue.ruleContent,
    ),
  );

  if (dangerous.length === 0) {
    ruleStash.replace({});
    return rules;
  }

  const stash: PermissionRulesBySource = {};
  const allow: PermissionRulesBySource = {};

  for (const [source, ruleStrings] of Object.entries(rules.allow)) {
    const kept: string[] = [];
    for (const ruleString of ruleStrings ?? []) {
      const value = permissionRuleValueFromString(ruleString);
      const isDangerous = dangerous.some(
        (rule) => rule.source === source && isSameRule(rule.ruleValue, value),
      );
      if (isDangerous) {
        (stash[source as PermissionRuleSource] ??= []).push(ruleString);
      } else {
        kept.push(ruleString);
      }
    }
    allow[source as PermissionRuleSource] = kept;
  }

  ruleStash.replace(stash);
  return { allow, deny: rules.deny, ask: rules.ask };
}

/**
 * Put back what `stripDangerousAllowRules` took.
 *
 * Called when leaving Auto, so a user's `Bash(python:*)` works again. Clears the
 * stash, which makes a second call a no-op — leaving Auto twice must not
 * duplicate the rules.
 */
export function restoreDangerousAllowRules(
  ruleStash: DangerousRuleStash,
  rules: PermissionRules,
): PermissionRules {
  const stash = ruleStash.read();
  ruleStash.clear();

  if (!stash || Object.keys(stash).length === 0) {
    return rules;
  }

  const allow: PermissionRulesBySource = { ...rules.allow };
  for (const [source, ruleStrings] of Object.entries(stash)) {
    const key = source as PermissionRuleSource;
    const existing = allow[key] ?? [];
    const missing = (ruleStrings ?? []).filter(
      (rule) => !existing.includes(rule),
    );
    allow[key] = [...existing, ...missing];
  }

  return { allow, deny: rules.deny, ask: rules.ask };
}
