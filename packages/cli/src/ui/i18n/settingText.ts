/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CONFIG_DIR,
  getUserConfigDisplayPath,
  type UiLocale,
} from '@qwen-code/core';
import {
  getLoadableSettingScopes,
  SettingScope,
  type LoadableSettingScope,
  type Settings,
} from '../../config/settings.js';
import type { SettingDefinition } from '../../config/settingsSchema.js';
import {
  type DialogSettingOption,
  getEffectiveValue,
  isInSettingsScope,
} from '../../utils/settingsUtils.js';
import type { SettingsState } from '../contexts/SettingsContext.js';
import type { I18nService } from '@qwen-code/core';
import type { UiMessageKey } from './types.js';

type SettingTextKeys = { label: UiMessageKey; description: UiMessageKey };

export const SETTING_TEXT_KEYS: Readonly<Record<string, SettingTextKeys>> = {
  autoMemoryEnabled: settingKeys('autoMemoryEnabled'),
  autoMemoryUserScopeEnabled: settingKeys('autoMemoryUserScopeEnabled'),
  promptSuggestionEnabled: settingKeys('promptSuggestionEnabled'),
  'dream.enabled': settingKeys('dream.enabled'),
  'codeMode.mode': settingKeys('codeMode.mode'),
  respondToBashCommands: settingKeys('respondToBashCommands'),
  'general.vimMode': settingKeys('general.vimMode'),
  'general.defaultPermissionMode': settingKeys('general.defaultPermissionMode'),
  'general.enableAutoUpdate': settingKeys('general.enableAutoUpdate'),
  'general.plan.enabled': settingKeys('general.plan.enabled'),
  'ui.language': {
    label: 'settings.language.label',
    description: 'settings.language.description',
  },
  'ui.inlineThinkingMode': settingKeys('ui.inlineThinkingMode'),
  'ui.maxTurns': settingKeys('ui.maxTurns'),
  'ui.escapePastedAtSymbols': settingKeys('ui.escapePastedAtSymbols'),
  'ui.showShortcutsHint': settingKeys('ui.showShortcutsHint'),
  'ui.copyFullResponse': settingKeys('ui.copyFullResponse'),
  'privacy.usageStatisticsEnabled': settingKeys(
    'privacy.usageStatisticsEnabled',
  ),
  'context.loadMemoryFromIncludeDirectories': settingKeys(
    'context.loadMemoryFromIncludeDirectories',
  ),
  'security.folderTrust.enabled': settingKeys('security.folderTrust.enabled'),
  'advanced.useProxyFromEnvironment': settingKeys(
    'advanced.useProxyFromEnvironment',
  ),
  'experimental.useOSC52Paste': settingKeys('experimental.useOSC52Paste'),
  'experimental.useOSC52Copy': settingKeys('experimental.useOSC52Copy'),
  'skills.loadFromAgentsDirectory': settingKeys(
    'skills.loadFromAgentsDirectory',
  ),
  agentsMdExcludes: settingKeys('agentsMdExcludes'),
};

function settingKeys(path: string): SettingTextKeys {
  return {
    label: `settings.${path}.label` as UiMessageKey,
    description: `settings.${path}.description` as UiMessageKey,
  };
}

export const SETTING_OPTION_KEYS: Readonly<Record<string, UiMessageKey>> = {
  'codeMode.mode:off': 'settings.codeMode.mode.option.off',
  'codeMode.mode:on': 'settings.codeMode.mode.option.on',
  'codeMode.mode:only': 'settings.codeMode.mode.option.only',
  'general.defaultPermissionMode:default':
    'settings.general.defaultPermissionMode.option.default',
  'general.defaultPermissionMode:accept_edits':
    'settings.general.defaultPermissionMode.option.acceptEdits',
  'general.defaultPermissionMode:auto':
    'settings.general.defaultPermissionMode.option.auto',
  'general.defaultPermissionMode:bypass_permissions':
    'settings.general.defaultPermissionMode.option.yolo',
  'general.defaultPermissionMode:dont_ask':
    'settings.general.defaultPermissionMode.option.dontAsk',
  'ui.language:auto': 'settings.language.option.auto',
  'ui.language:zh-CN': 'settings.language.option.zhCN',
  'ui.language:en': 'settings.language.option.en',
  'ui.inlineThinkingMode:off': 'settings.ui.inlineThinkingMode.option.off',
  'ui.inlineThinkingMode:full': 'settings.ui.inlineThinkingMode.option.full',
  'ui.maxTurns:1000': 'settings.ui.maxTurns.option.1000',
  'ui.maxTurns:2000': 'settings.ui.maxTurns.option.2000',
  'ui.maxTurns:3000': 'settings.ui.maxTurns.option.3000',
  'ui.maxTurns:unlimited': 'settings.ui.maxTurns.option.unlimited',
};

export function getLocalizedSettingText(
  settingKey: string,
  definition: SettingDefinition | undefined,
  t: I18nService['get'],
  locale: UiLocale,
): { label: string; description?: string } {
  if (locale === 'en') {
    return {
      label: definition?.label ?? settingKey,
      description: definition?.description,
    };
  }
  const keys = SETTING_TEXT_KEYS[settingKey];
  return {
    label: keys ? t(keys.label) : (definition?.label ?? settingKey),
    description: keys ? t(keys.description) : definition?.description,
  };
}

export function getLocalizedSettingOption(
  settingKey: string,
  option: DialogSettingOption | undefined,
  t: I18nService['get'],
  locale: UiLocale,
): string | undefined {
  if (!option) return undefined;
  if (locale === 'en') return option.label;
  const key = SETTING_OPTION_KEYS[`${settingKey}:${String(option.value)}`];
  return key ? t(key) : option.label;
}

export function getLocalizedScopeLabel(
  scope: LoadableSettingScope,
  t: I18nService['get'],
): string {
  return scope === SettingScope.Project
    ? t('settings.scope.project.label')
    : t('settings.scope.user.label');
}

export function getLocalizedScopeDescription(
  scope: LoadableSettingScope,
  t: I18nService['get'],
): string {
  return scope === SettingScope.Project
    ? t('settings.scope.project.description', {
        path: `./${CONFIG_DIR}/settings.json`,
      })
    : t('settings.scope.user.description', {
        path: getUserConfigDisplayPath('settings.json'),
      });
}

export function getLocalizedScopeMessageForSetting(
  settingKey: string,
  selectedScope: LoadableSettingScope,
  settings: SettingsState,
  t: I18nService['get'],
): string {
  const modifiedScopes = getLoadableSettingScopes()
    .filter((scope) => scope !== selectedScope)
    .filter((scope) =>
      isInSettingsScope(settingKey, settings.forScope(scope).settings),
    );
  if (modifiedScopes.length === 0) return '';

  const also = isInSettingsScope(
    settingKey,
    settings.forScope(selectedScope).settings,
  );
  const isModifiedInUser = modifiedScopes.includes(SettingScope.User);
  const isModifiedInProject = modifiedScopes.includes(SettingScope.Project);

  if (also && selectedScope === SettingScope.User && isModifiedInProject) {
    const effectiveValue = getLocalizedScopeValue(
      settingKey,
      settings.merged,
      t,
    );
    return effectiveValue
      ? t('settings.scope.overriddenByProjectWithEffectiveValue', {
          value: effectiveValue,
        })
      : t('settings.scope.overriddenByProject');
  }

  if (also && selectedScope === SettingScope.Project && isModifiedInUser) {
    const userValue = getLocalizedScopeValue(
      settingKey,
      settings.forScope(SettingScope.User).settings,
      t,
    );
    return userValue
      ? t('settings.scope.overridesUserWithValue', { value: userValue })
      : t('settings.scope.overridesUser');
  }

  const scopes = modifiedScopes
    .map((scope) =>
      scope === SettingScope.Project
        ? t('settings.scope.project.short')
        : t('settings.scope.user.short'),
    )
    .join(', ');
  return t(
    also ? 'settings.scope.alsoModifiedIn' : 'settings.scope.modifiedIn',
    { scopes },
  );
}

function getLocalizedScopeValue(
  settingKey: string,
  scopeSettings: Settings,
  t: I18nService['get'],
): string | undefined {
  if (settingKey !== 'ui.language') return undefined;
  const value = getEffectiveValue(settingKey, scopeSettings);
  const optionKey = SETTING_OPTION_KEYS[`${settingKey}:${String(value)}`];
  return optionKey ? t(optionKey) : undefined;
}
