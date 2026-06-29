/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseRule } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from './settings.js';

export const PERMISSION_RULE_TYPES = ['allow', 'ask', 'deny'] as const;
export const MAX_PERMISSION_RULES_COUNT = 500;
export const MAX_PERMISSION_RULE_LENGTH = 512;

export type PermissionRuleType = (typeof PERMISSION_RULE_TYPES)[number];
export type PermissionSettingsScope = 'user' | 'workspace';

export interface PermissionRuleSet {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface PermissionSettingsScopeState {
  path: string;
  rules: PermissionRuleSet;
}

export interface QwenPermissionSettings {
  v: 1;
  user: PermissionSettingsScopeState;
  workspace: PermissionSettingsScopeState;
  merged: PermissionRuleSet;
  isTrusted: boolean;
}

export class PermissionRulesValidationError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_rules',
  ) {
    super(message);
    this.name = 'PermissionRulesValidationError';
  }
}

export function isPermissionRuleType(
  value: unknown,
): value is PermissionRuleType {
  return (
    typeof value === 'string' &&
    PERMISSION_RULE_TYPES.includes(value as PermissionRuleType)
  );
}

export function readPermissionRuleSet(settings: unknown): PermissionRuleSet {
  const permissions =
    settings && typeof settings === 'object'
      ? (
          settings as {
            permissions?: Partial<Record<PermissionRuleType, unknown>>;
          }
        ).permissions
      : undefined;

  const readRules = (type: PermissionRuleType): string[] => {
    const value = permissions?.[type];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  };

  return {
    allow: readRules('allow'),
    ask: readRules('ask'),
    deny: readRules('deny'),
  };
}

export function normalizePermissionRules(
  value: unknown,
  opts?: { existingRules?: readonly string[] },
): string[] {
  const inputRules = normalizePermissionRuleInputs(value);
  const result: string[] = [];
  const seen = new Set<string>();
  const existingRules = new Set(
    (opts?.existingRules ?? []).map((rule) => rule.trim()),
  );
  for (const rule of inputRules) {
    if (parseRule(rule).invalid) {
      if (existingRules.has(rule)) {
        if (!seen.has(rule)) {
          seen.add(rule);
          result.push(rule);
        }
        continue;
      }
      throw new PermissionRulesValidationError(
        `Malformed permission rule: ${rule}`,
        'invalid_rules',
      );
    }
    if (!seen.has(rule)) {
      seen.add(rule);
      result.push(rule);
    }
  }
  return result;
}

export function normalizePermissionRuleInputs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new PermissionRulesValidationError(
      'rules must be an array',
      'invalid_rules',
    );
  }
  if (value.length > MAX_PERMISSION_RULES_COUNT) {
    throw new PermissionRulesValidationError(
      `rules array exceeds ${MAX_PERMISSION_RULES_COUNT} entries`,
      'invalid_rules',
    );
  }

  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new PermissionRulesValidationError(
        'rules must contain only non-empty strings',
        'invalid_rules',
      );
    }
    const rule = item.trim();
    if (rule.length > MAX_PERMISSION_RULE_LENGTH) {
      throw new PermissionRulesValidationError(
        `rule exceeds ${MAX_PERMISSION_RULE_LENGTH}-character limit`,
        'invalid_rules',
      );
    }
    result.push(rule);
  }
  return result;
}

export function buildPermissionSettings(
  settings: LoadedSettings,
): QwenPermissionSettings {
  return {
    v: 1,
    user: {
      path: settings.user.path,
      rules: readPermissionRuleSet(settings.user.settings),
    },
    workspace: {
      path: settings.workspace.path,
      rules: readPermissionRuleSet(settings.workspace.settings),
    },
    merged: readPermissionRuleSet(settings.merged),
    isTrusted: settings.isTrusted,
  };
}
