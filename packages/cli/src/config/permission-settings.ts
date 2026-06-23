/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseRule } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from './settings.js';

export const PERMISSION_RULE_TYPES = ['allow', 'ask', 'deny'] as const;

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
    readonly code: 'invalid_rules' | 'invalid_rule',
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

export function normalizePermissionRules(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new PermissionRulesValidationError(
      'rules must be an array',
      'invalid_rules',
    );
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new PermissionRulesValidationError(
        'rules must contain only non-empty strings',
        'invalid_rules',
      );
    }
    const rule = item.trim();
    if (parseRule(rule).invalid) {
      throw new PermissionRulesValidationError(
        `Malformed permission rule: ${rule}`,
        'invalid_rule',
      );
    }
    if (!seen.has(rule)) {
      seen.add(rule);
      result.push(rule);
    }
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
