/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRules,
  PermissionRuleSource,
  PermissionRuleValue,
} from '../manager/decision/index.js';
import { normalizeMcpRuleName } from '../../mcp/tools/mcp-names.js';
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from '../manager/decision/index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * The subset of a settings JSON file that contains permission rules.
 * Matches the SettingsJson permission format.
 */
export type PermissionsSettingsJson = {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  /**
   * When true, only policy-managed permission rules are respected.
   * Set in organizational policy settings to enforce managed-only mode.
   */
  allowManagedPermissionRulesOnly?: boolean;
};

/**
 * Settings sources that support write operations (add/delete rules).
 * Policy and flag settings are read-only; CLI arg, command, and session
 * are transient.
 */
export type EditableSettingSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings';

/**
 * A permission rule from an editable settings source.
 * Used by deletePermissionRuleFromSettings to ensure only editable
 * sources are modified.
 */
export type PermissionRuleFromEditableSettings = PermissionRule & {
  source: EditableSettingSource;
};

/**
 * Interface for settings access. Injected into I/O functions to allow
 * testing without filesystem access and to support bridge-layer delegation.
 */
export type SettingsAccessor = {
  /**
   * Read settings data for a given source.
   * Returns null if the source is not available or cannot be read.
   */
  getSettingsForSource: (
    source: PermissionRuleSource,
  ) => PermissionsSettingsJson | null;

  /**
   * Get the list of enabled setting sources, in load order.
   * Typically: userSettings, projectSettings, localSettings, flagSettings, policySettings.
   */
  getEnabledSources: () => PermissionRuleSource[];
};

/**
 * Interface for settings write operations. Injected into persistence functions.
 */
export type SettingsWriter = {
  /**
   * Read settings for an editable source (strict validation).
   */
  getSettingsForSource: (
    source: EditableSettingSource,
  ) => PermissionsSettingsJson | null;

  /** Read、compute and persist must run in one host-provided transaction. */
  mutateSettingsForSource: (
    source: EditableSettingSource,
    mutation: (data: PermissionsSettingsJson) => boolean,
  ) => { error?: Error };
};

// ============================================================================
// Constants
// ============================================================================

const SUPPORTED_RULE_BEHAVIORS = [
  'allow',
  'deny',
  'ask',
] as const satisfies PermissionBehavior[];

/** Sources that can be modified via add/delete operations. */
const EDITABLE_SOURCES: EditableSettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
];

// ============================================================================
// Pure Conversion Functions
// ============================================================================

/**
 * Returns an empty settings object with the permissions structure initialized.
 * Used as fallback when creating new settings files.
 */
export function getEmptyPermissionSettingsJson(): PermissionsSettingsJson {
  return {
    permissions: {},
  };
}

/**
 * Converts a settings JSON object's `permissions` field into an array
 * of PermissionRule objects.
 *
 * Iterates over the three supported behaviors (allow, deny, ask) and
 * parses each rule string via `permissionRuleValueFromString`.
 *
 * @param data The parsed settings JSON (may be null)
 * @param source The source these rules came from
 * @returns Array of PermissionRule objects (empty if no permissions found)
 */
export function settingsJsonToRules(
  data: PermissionsSettingsJson | null,
  source: PermissionRuleSource,
): PermissionRule[] {
  if (!data || !data.permissions) {
    return [];
  }

  const { permissions } = data;
  const rules: PermissionRule[] = [];
  for (const behavior of SUPPORTED_RULE_BEHAVIORS) {
    const behaviorArray = permissions[behavior];
    if (behaviorArray) {
      for (const ruleString of behaviorArray) {
        rules.push({
          source,
          ruleBehavior: behavior,
          ruleValue: permissionRuleValueFromString(ruleString),
        });
      }
    }
  }
  return rules;
}

// ============================================================================
// Managed Permission Rules Policy
// ============================================================================

/**
 * Returns true if `allowManagedPermissionRulesOnly` is enabled in
 * the given policy settings data.
 *
 * When enabled, only permission rules from managed (policy) settings
 * are respected. User/project/local settings rules are ignored.
 *
 * @param policySettingsData The policy settings data (or null if unavailable)
 */
export function shouldAllowManagedPermissionRulesOnly(
  policySettingsData: PermissionsSettingsJson | null,
): boolean {
  return policySettingsData?.allowManagedPermissionRulesOnly === true;
}

/**
 * Returns true if "always allow" options should be shown in permission
 * prompts. When managed-only mode is active, these options are hidden
 * since users cannot persist their own rules.
 *
 * @param policySettingsData The policy settings data (or null if unavailable)
 */
export function shouldShowAlwaysAllowOptions(
  policySettingsData: PermissionsSettingsJson | null,
): boolean {
  return !shouldAllowManagedPermissionRulesOnly(policySettingsData);
}

// ============================================================================
// Rule Loading (with injected I/O)
// ============================================================================

/**
 * Loads permission rules from a specific settings source.
 *
 * @param source The source to load from
 * @param accessor Settings reader (injected for testability)
 * @returns Array of permission rules from that source
 */
export function getPermissionRulesForSource(
  source: PermissionRuleSource,
  accessor: Pick<SettingsAccessor, 'getSettingsForSource'>,
): PermissionRule[] {
  const settingsData = accessor.getSettingsForSource(source);
  return settingsJsonToRules(settingsData, source);
}

/**
 * Loads all permission rules from all relevant sources.
 *
 * If `allowManagedPermissionRulesOnly` is enabled in policy settings,
 * only rules from 'policySettings' are returned. Otherwise, rules from
 * all enabled sources are loaded and concatenated.
 *
 * @param accessor Settings reader (injected for testability)
 * @returns Array of all permission rules from enabled sources
 */
export function loadAllPermissionRulesFromDisk(
  accessor: SettingsAccessor,
): PermissionRule[] {
  // Check if managed-only mode is active
  const policyData = accessor.getSettingsForSource('policySettings');
  if (shouldAllowManagedPermissionRulesOnly(policyData)) {
    return getPermissionRulesForSource('policySettings', accessor);
  }

  // Load from all enabled sources
  const rules: PermissionRule[] = [];
  for (const source of accessor.getEnabledSources()) {
    rules.push(...getPermissionRulesForSource(source, accessor));
  }
  return rules;
}

// ============================================================================
// Pure Computation Helpers (for persistence operations)
// ============================================================================

/**
 * Normalizes a raw rule string via roundtrip parse→serialize.
 * This ensures legacy tool names (e.g., "search_file_content") are
 * normalized to their canonical form (e.g., "Grep") for
 * consistent comparison.
 */
function normalizeRuleEntry(raw: string): string {
  return permissionRuleValueToString(permissionRuleValueFromString(raw));
}

/**
 * Computes the new rule strings to add to a behavior array, deduplicating
 * against existing entries. Both existing and new entries are normalized
 * via roundtrip parse→serialize before comparison.
 *
 * @param existingRules Current rule strings in the behavior array
 * @param newRuleValues New rule values to add
 * @returns Array of new rule strings not already present (empty if all duplicates)
 */
export function computeRulesToAdd(
  existingRules: string[],
  newRuleValues: PermissionRuleValue[],
): string[] {
  const existingNormalized = new Set(existingRules.map(normalizeRuleEntry));
  const newRuleStrings = newRuleValues.map(permissionRuleValueToString);

  return newRuleStrings.filter((rule) => !existingNormalized.has(rule));
}

/**
 * Computes the updated behavior array after removing a rule.
 * Uses normalized comparison so legacy tool names match their canonical form.
 *
 * @param existingRules Current rule strings in the behavior array
 * @param ruleToRemove The rule value to remove
 * @returns Updated array with the rule removed, or null if not found
 */
export function computeRulesAfterDelete(
  existingRules: string[],
  ruleToRemove: PermissionRuleValue,
): string[] | null {
  const targetString = permissionRuleValueToString(ruleToRemove);

  const hasMatch = existingRules.some(
    (raw) => normalizeRuleEntry(raw) === targetString,
  );
  if (!hasMatch) {
    return null;
  }

  return existingRules.filter(
    (raw) => normalizeRuleEntry(raw) !== targetString,
  );
}

// ============================================================================
// Rule Persistence (with injected I/O)
// ============================================================================

/**
 * Type guard: checks if a source is an editable settings source.
 */
export function isEditableSource(
  source: PermissionRuleSource,
): source is EditableSettingSource {
  return EDITABLE_SOURCES.includes(source as EditableSettingSource);
}

/**
 * Deletes a permission rule from an editable settings source.
 *
 * Performs normalized comparison (via roundtrip parse→serialize) so legacy
 * tool names match their canonical form when searching for the rule to delete.
 *
 * @param rule The rule to delete (must be from an editable source)
 * @param writer Settings writer (injected for testability)
 * @returns true if the rule was successfully deleted, false otherwise
 */
export function deletePermissionRuleFromSettings(
  rule: PermissionRuleFromEditableSettings,
  writer: SettingsWriter,
): boolean {
  // Runtime check to ensure source is actually editable
  if (!isEditableSource(rule.source)) {
    return false;
  }

  try {
    let removed = false;
    const { error } = writer.mutateSettingsForSource(
      rule.source,
      (settingsData) => {
        const behaviorArray = settingsData.permissions?.[rule.ruleBehavior];
        if (!behaviorArray) return false;
        const updatedBehaviorArray = computeRulesAfterDelete(
          behaviorArray,
          rule.ruleValue,
        );
        if (updatedBehaviorArray === null) return false;
        settingsData.permissions = {
          ...settingsData.permissions,
          [rule.ruleBehavior]: updatedBehaviorArray,
        };
        removed = true;
        return true;
      },
    );
    return !error && removed;
  } catch {
    return false;
  }
}

/**
 * Add permission rules to an editable settings source.
 *
 * Deduplicates against existing rules and falls back to lenient loading if
 * strict validation fails. When `allowManagedPermissionRulesOnly` is active,
 * nothing is persisted. Returns true when the rules were added or already
 * present.
 */
export function addPermissionRulesToSettings(
  {
    ruleValues,
    ruleBehavior,
  }: {
    ruleValues: PermissionRuleValue[];
    ruleBehavior: PermissionBehavior;
  },
  source: EditableSettingSource,
  writer: SettingsWriter,
  policySettingsData?: PermissionsSettingsJson | null,
): boolean {
  // When managed-only mode is active, don't persist new permission rules
  if (shouldAllowManagedPermissionRulesOnly(policySettingsData ?? null)) {
    return false;
  }

  if (ruleValues.length < 1) {
    // No rules to add — trivially successful
    return true;
  }

  try {
    const { error } = writer.mutateSettingsForSource(
      source,
      (settingsData) => {
        const existingPermissions = settingsData.permissions || {};
        const existingRules = existingPermissions[ruleBehavior] || [];
        const newRules = computeRulesToAdd(existingRules, ruleValues);
        if (newRules.length === 0) return false;
        settingsData.permissions = {
          ...existingPermissions,
          [ruleBehavior]: [...existingRules, ...newRules],
        };
        return true;
      },
    );
    return !error;
  } catch {
    return false;
  }
}

// ============================================================================
// Handing rules to the permission module
// ============================================================================

/**
 * Group a flat rule list into the shape `permission.setRules` takes.
 *
 * The two representations exist for different jobs and neither is redundant:
 * a flat list is what the settings files and the rule-management UI work in
 * (one row per rule, source attached), while the module is asked "what does
 * this tool's deny bucket contain" thousands of times and wants that indexed.
 *
 * This is the only conversion between them, so a rule read from disk and a rule
 * the module judges against cannot drift apart.
 */
export function rulesToPermissionRules(rules: PermissionRule[]): PermissionRules {
  const grouped: PermissionRules = { allow: {}, deny: {}, ask: {} };

  for (const rule of rules) {
    const bucket = grouped[rule.ruleBehavior];
    const existing = bucket[rule.source] ?? [];
    existing.push(
      permissionRuleValueToString(normalizePermissionRuleValue(rule.ruleValue)),
    );
    bucket[rule.source] = existing;
  }

  return grouped;
}

/** Keep settings readable while matching Unicode MCP rules against registry IDs. */
export function normalizePermissionRuleValue(
  value: PermissionRuleValue,
): PermissionRuleValue {
  return { ...value, toolName: normalizeMcpRuleName(value.toolName) };
}

/**
 * Read every enabled settings source and return them in the module's shape.
 *
 * This is what a settings-file change handler calls: read, convert, hand to
 * `setRules`. Rules already pending judgement are then re-checked by the module
 * against the new set.
 */
export function loadPermissionRulesForModule(
  accessor: SettingsAccessor,
): PermissionRules {
  return rulesToPermissionRules(loadAllPermissionRulesFromDisk(accessor));
}
