/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoadedSettings } from '@qwen-code/resource';
import {
  permissionRuleValueFromString,
  type PermissionRule,
  type PermissionRuleSource,
} from '../manager/decision/index.js';

/** 企业策略要求只认托管规则时，普通设置里的权限规则一律不生效。 */
export function hasManagedPermissionRulesOnly(settings: unknown): boolean {
  return (
    typeof settings === 'object' &&
    settings !== null &&
    (settings as { allowManagedPermissionRulesOnly?: unknown })
      .allowManagedPermissionRulesOnly === true
  );
}

/** 把一层设置的 permissions 映射成带来源的规则。 */
export function settingsToPermissionRules(
  settings: unknown,
  source: PermissionRuleSource,
): PermissionRule[] {
  if (typeof settings !== 'object' || settings === null) {
    return [];
  }

  const permissions = (settings as { permissions?: unknown }).permissions;
  if (typeof permissions !== 'object' || permissions === null) {
    return [];
  }

  const rules: PermissionRule[] = [];
  for (const behavior of ['allow', 'deny', 'ask'] as const) {
    const entries = (permissions as Record<string, unknown>)[behavior];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (typeof entry !== 'string') {
        continue;
      }
      rules.push({
        source,
        ruleBehavior: behavior,
        ruleValue: permissionRuleValueFromString(entry),
      });
    }
  }
  return rules;
}

/** 按 user → project → local → flag 顺序汇总会话启动规则。 */
export function loadPermissionRulesFromLoadedSettings(
  loadedSettings: LoadedSettings,
): PermissionRule[] {
  if (hasManagedPermissionRulesOnly(loadedSettings.merged)) {
    return [];
  }

  return [
    ...settingsToPermissionRules(loadedSettings.user.settings, 'userSettings'),
    ...settingsToPermissionRules(
      loadedSettings.project.settings,
      'projectSettings',
    ),
    ...settingsToPermissionRules(
      loadedSettings.local.settings,
      'localSettings',
    ),
    ...settingsToPermissionRules(loadedSettings.flag.settings, 'flagSettings'),
  ];
}
