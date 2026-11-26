/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  PermissionRule,
  PermissionRuleSource,
  PermissionRules,
} from '../manager/decision/index.js';
import { permissionRuleValueFromString } from '../manager/decision/index.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * All permission rule sources in evaluation order.
 * Used to flatten rules from the context maps.
 */
const PERMISSION_RULE_SOURCES: readonly PermissionRuleSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
  'cliArg',
  'command',
  'session',
] as const;

// ============================================================================
// Types
// ============================================================================

/**
 * Type of shadowing that makes a rule unreachable.
 * - 'deny': rule is completely blocked by a deny rule (severe)
 * - 'ask': rule is shadowed by an ask rule (user will always be prompted)
 */
export type ShadowType = 'ask' | 'deny';

/**
 * Represents an unreachable permission rule with explanation.
 */
export type UnreachableRule = {
  /** The rule that is unreachable */
  rule: PermissionRule;
  /** Human-readable explanation of why it's unreachable */
  reason: string;
  /** The rule that shadows it */
  shadowedBy: PermissionRule;
  /** Whether it's blocked by deny or ask */
  shadowType: ShadowType;
  /** Suggestion for fixing the configuration */
  fix: string;
};

/**
 * Result of checking if a rule is shadowed.
 * Uses discriminated union for type safety.
 */
type ShadowResult =
  | { shadowed: false }
  | { shadowed: true; shadowedBy: PermissionRule; shadowType: ShadowType };

// ============================================================================
// Source Display & Classification
// ============================================================================

/**
 * Display strings for permission rule sources.
 */
const SOURCE_DISPLAY_NAMES: Record<PermissionRuleSource, string> = {
  userSettings: 'user settings',
  projectSettings: 'project settings',
  localSettings: 'local settings',
  flagSettings: 'flag settings',
  policySettings: 'policy settings',
  cliArg: 'CLI argument',
  command: 'command',
  session: 'session',
};

/**
 * Get a human-readable display string for a permission rule source.
 */
export function permissionRuleSourceDisplayString(
  source: PermissionRuleSource,
): string {
  return SOURCE_DISPLAY_NAMES[source] ?? source;
}

/**
 * Whether a rule source is shared with other users: project settings (git),
 * policy settings (enterprise), and command frontmatter. User, local, flag,
 * CLI-arg and session sources are personal.
 */
export function isSharedSettingSource(source: PermissionRuleSource): boolean {
  return (
    source === 'projectSettings' ||
    source === 'policySettings' ||
    source === 'command'
  );
}

// ============================================================================
// Rule Extraction from Context
// ============================================================================

/**
 * Extract all allow rules from the rule set, tagged with source.
 */
export function getAllowRules(
  rules: PermissionRules,
): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap((source) =>
    (rules.allow[source] || []).map(
      (ruleString): PermissionRule => ({
        source,
        ruleBehavior: 'allow',
        ruleValue: permissionRuleValueFromString(ruleString),
      }),
    ),
  );
}

/**
 * Extract all deny rules from the rule set, tagged with source.
 */
export function getDenyRules(rules: PermissionRules): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap((source) =>
    (rules.deny[source] || []).map(
      (ruleString): PermissionRule => ({
        source,
        ruleBehavior: 'deny',
        ruleValue: permissionRuleValueFromString(ruleString),
      }),
    ),
  );
}

/**
 * Extract all ask rules from the rule set, tagged with source.
 */
export function getAskRules(rules: PermissionRules): PermissionRule[] {
  return PERMISSION_RULE_SOURCES.flatMap((source) =>
    (rules.ask[source] || []).map(
      (ruleString): PermissionRule => ({
        source,
        ruleBehavior: 'ask',
        ruleValue: permissionRuleValueFromString(ruleString),
      }),
    ),
  );
}

// ============================================================================
// Shadow Detection Helpers
// ============================================================================

/**
 * Format a rule source for display in warning messages.
 */
function formatSource(source: PermissionRuleSource): string {
  return permissionRuleSourceDisplayString(source);
}

/**
 * Generate a fix suggestion based on the shadow type.
 */
function generateFixSuggestion(
  shadowType: ShadowType,
  shadowingRule: PermissionRule,
  shadowedRule: PermissionRule,
): string {
  const shadowingSource = formatSource(shadowingRule.source);
  const shadowedSource = formatSource(shadowedRule.source);
  const toolName = shadowingRule.ruleValue.toolName;

  if (shadowType === 'deny') {
    return `Remove the "${toolName}" deny rule from ${shadowingSource}, or remove the specific allow rule from ${shadowedSource}`;
  }
  return `Remove the "${toolName}" ask rule from ${shadowingSource}, or remove the specific allow rule from ${shadowedSource}`;
}

/**
 * Check if a specific allow rule is shadowed (unreachable) by an ask rule.
 *
 * An allow rule is unreachable when:
 * 1. There's a tool-wide ask rule (e.g., "Bash" in ask list)
 * 2. And a specific allow rule (e.g., "Bash(ls:*)" in allow list)
 *
 * The ask rule takes precedence, making the specific allow rule unreachable
 * because the user will always be prompted first.
 */
function isAllowRuleShadowedByAskRule(
  allowRule: PermissionRule,
  askRules: PermissionRule[],
): ShadowResult {
  const { toolName, ruleContent } = allowRule.ruleValue;

  // Only check allow rules that have specific content (e.g., "Shell(ls:*)")
  // Tool-wide allow rules cannot be shadowed by ask rules
  if (ruleContent === undefined) {
    return { shadowed: false };
  }

  // Find any tool-wide ask rule for the same tool
  const shadowingAskRule = askRules.find(
    (askRule) =>
      askRule.ruleValue.toolName === toolName &&
      askRule.ruleValue.ruleContent === undefined,
  );

  if (!shadowingAskRule) {
    return { shadowed: false };
  }

  return { shadowed: true, shadowedBy: shadowingAskRule, shadowType: 'ask' };
}

/**
 * Check if an allow rule is shadowed (completely blocked) by a deny rule.
 *
 * An allow rule is unreachable when:
 * 1. There's a tool-wide deny rule (e.g., "Bash" in deny list)
 * 2. And a specific allow rule (e.g., "Bash(ls:*)" in allow list)
 *
 * Deny rules are checked first in the permission evaluation order,
 * so the allow rule will never be reached — the tool is always denied.
 */
function isAllowRuleShadowedByDenyRule(
  allowRule: PermissionRule,
  denyRules: PermissionRule[],
): ShadowResult {
  const { toolName, ruleContent } = allowRule.ruleValue;

  // Only check allow rules that have specific content
  // Tool-wide allow rules conflict with tool-wide deny rules but are not "shadowed"
  if (ruleContent === undefined) {
    return { shadowed: false };
  }

  // Find any tool-wide deny rule for the same tool
  const shadowingDenyRule = denyRules.find(
    (denyRule) =>
      denyRule.ruleValue.toolName === toolName &&
      denyRule.ruleValue.ruleContent === undefined,
  );

  if (!shadowingDenyRule) {
    return { shadowed: false };
  }

  return { shadowed: true, shadowedBy: shadowingDenyRule, shadowType: 'deny' };
}

// ============================================================================
// Main Detection
// ============================================================================

/**
 * Detect all unreachable permission rules in the given rule set.
 *
 * Currently detects:
 * - Allow rules shadowed by tool-wide deny rules (more severe — completely blocked)
 * - Allow rules shadowed by tool-wide ask rules (will always prompt)
 *
 * @returns Array of unreachable rules with explanations and fix suggestions
 */
export function detectUnreachableRules(
  rules: PermissionRules,
): UnreachableRule[] {
  const unreachable: UnreachableRule[] = [];

  const allowRules = getAllowRules(rules);
  const askRules = getAskRules(rules);
  const denyRules = getDenyRules(rules);

  // Check each allow rule for shadowing
  for (const allowRule of allowRules) {
    // Check deny shadowing first (more severe)
    const denyResult = isAllowRuleShadowedByDenyRule(allowRule, denyRules);
    if (denyResult.shadowed) {
      const shadowSource = formatSource(denyResult.shadowedBy.source);
      unreachable.push({
        rule: allowRule,
        reason: `Blocked by "${denyResult.shadowedBy.ruleValue.toolName}" deny rule (from ${shadowSource})`,
        shadowedBy: denyResult.shadowedBy,
        shadowType: 'deny',
        fix: generateFixSuggestion('deny', denyResult.shadowedBy, allowRule),
      });
      continue; // Don't also report ask-shadowing if deny-shadowed
    }

    // Check ask shadowing
    const askResult = isAllowRuleShadowedByAskRule(
      allowRule,
      askRules,
    );
    if (askResult.shadowed) {
      const shadowSource = formatSource(askResult.shadowedBy.source);
      unreachable.push({
        rule: allowRule,
        reason: `Shadowed by "${askResult.shadowedBy.ruleValue.toolName}" ask rule (from ${shadowSource})`,
        shadowedBy: askResult.shadowedBy,
        shadowType: 'ask',
        fix: generateFixSuggestion('ask', askResult.shadowedBy, allowRule),
      });
    }
  }

  return unreachable;
}
