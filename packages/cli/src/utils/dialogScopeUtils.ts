/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getLoadableSettingScopes,
  SettingScope,
  type LoadableSettingScope,
  type Settings,
} from '../config/settings.js';
import { isInSettingsScope } from './settingsUtils.js';
import {
  CONFIG_DIR,
  getUserConfigDisplayPath,
} from '@qwen-code/core';

/**
 * Shared scope labels for dialog components that need to display setting scopes
 */
export const SCOPE_LABELS = {
  [SettingScope.User]: 'User Settings',
  [SettingScope.Project]: 'Project Settings',
} as const;

/**
 * Scope description hints shown below tabs in Settings dialog.
 * Each describes the storage location and priority relative to other scopes.
 */
export const SCOPE_DESCRIPTIONS: Partial<Record<LoadableSettingScope, string>> =
  {
    [SettingScope.User]: `Stored in ${getUserConfigDisplayPath('settings.json')}. Lower priority than Project settings.`,
    [SettingScope.Project]: `Stored in ./${CONFIG_DIR}/settings.json. Overrides User settings.`,
  };

/**
 * Helper function to get scope items for radio button selects
 */
export function getScopeItems(): Array<{
  label: string;
  value: LoadableSettingScope;
}> {
  return [
    { label: SCOPE_LABELS[SettingScope.User], value: SettingScope.User },
    {
      label: SCOPE_LABELS[SettingScope.Project],
      value: SettingScope.Project,
    },
  ];
}

/**
 * Human-readable short names for scopes used in annotation messages.
 */
const SCOPE_DISPLAY_NAMES: Partial<Record<string, string>> = {
  [SettingScope.User]: 'User',
  [SettingScope.Project]: 'Project',
};

/**
 * Generate scope message for a specific setting
 */
export function getScopeMessageForSetting(
  settingKey: string,
  selectedScope: LoadableSettingScope,
  settings: {
    forScope: (scope: LoadableSettingScope) => { settings: Settings };
  },
): string {
  const otherScopes = getLoadableSettingScopes()
    .filter((scope) => scope !== selectedScope);

  const modifiedInOtherScopes = otherScopes.filter((scope) => {
    const scopeSettings = settings.forScope(scope).settings;
    return isInSettingsScope(settingKey, scopeSettings);
  });

  if (modifiedInOtherScopes.length === 0) {
    return '';
  }

  const modifiedScopesStr = modifiedInOtherScopes
    .map((s) => SCOPE_DISPLAY_NAMES[s] ?? s)
    .join(', ');
  const currentScopeSettings = settings.forScope(selectedScope).settings;
  const existsInCurrentScope = isInSettingsScope(
    settingKey,
    currentScopeSettings,
  );

  return existsInCurrentScope
    ? `(Also modified in ${modifiedScopesStr})`
    : `(Modified in ${modifiedScopesStr})`;
}
