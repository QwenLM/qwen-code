/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SettingScope,
  type LoadedSettings,
  type LoadableSettingScope,
  type MergedSettings,
} from '@qwen-code/resource';
import { getEffectiveBlockedMarketplaces } from '../pluginPolicy.js';
import type { PluginScope } from '../schemas.js';
import {
  createDefaultPluginManager,
  getDisabledPluginIds,
  getEnabledPluginIds,
  type PluginManagementScope,
  type PluginManagerMergedSettings,
  type PluginManager,
  type PluginManagerFactory,
  type PluginManagerSettingsStore,
} from './pluginManager.js';

function toSettingScope(
  scope: PluginScope | 'user',
): SettingScope.User | SettingScope.Project | SettingScope.Local {
  switch (scope) {
    case 'project':
      return SettingScope.Project;
    case 'local':
    case 'managed':
      return SettingScope.Local;
    case 'user':
    default:
      return SettingScope.User;
  }
}

export type PluginSettingsReader = {
  isTrusted: boolean;
  merged: MergedSettings;
  forScope(scope: LoadableSettingScope): {
    settings: Pick<
      LoadedSettings['user']['settings'],
      'enabledPlugins' | 'extraKnownMarketplaces'
    >;
  };
};
export type PluginSettingsAccess = PluginSettingsReader &
  Partial<Pick<LoadedSettings, 'setValue' | 'mutateScope'>>;

export function createPluginSettingsAccessor(
  settings: PluginSettingsAccess,
): PluginManagerSettingsStore {
  // Legacy LoadedSettings hides the project layer in untrusted workspaces.
  // SettingsService snapshots retain raw layers, so preserve that boundary here.
  const scopedSettings = (scope: PluginManagementScope) =>
    scope === 'project' && !settings.isTrusted
      ? {}
      : settings.forScope(toSettingScope(scope)).settings;
  return {
    getEnabledPlugins: () => getEnabledPluginIds(settings.merged),
    getDisabledPlugins: () => getDisabledPluginIds(settings.merged),
    getPluginsSettings: () => ({
      disabled: getDisabledPluginIds(settings.merged),
      blockedMarketplaces: getEffectiveBlockedMarketplaces(
        settings.merged.blockedMarketplaces,
      ),
    }),
    setPluginEnabled: (scope, pluginId, enabled) => {
      const settingScope = toSettingScope(scope);
      if (!settings.setValue)
        return EMPTY_PLUGIN_SETTINGS.setPluginEnabled(scope, pluginId, enabled);
      return settings.setValue(
        settingScope,
        ['enabledPlugins', pluginId],
        enabled,
      );
    },
    getMergedSettings: () => ({
      enabledPlugins: settings.merged.enabledPlugins,
      blockedMarketplaces: settings.merged.blockedMarketplaces,
      strictKnownMarketplaces: settings.merged.strictKnownMarketplaces,
      extraKnownMarketplaces: settings.merged.extraKnownMarketplaces,
    }),
    getScopedEnabledPlugins: (scope) =>
      scopedSettings(scope).enabledPlugins ?? {},
    getScopedExtraKnownMarketplaces: (scope) =>
      (scopedSettings(scope).extraKnownMarketplaces ?? {}) as Record<
        string,
        { source: unknown }
      >,
    patchScopedEnabledPlugins: (scope, patch) => {
      if (!settings.mutateScope)
        return EMPTY_PLUGIN_SETTINGS.patchScopedEnabledPlugins(scope, patch);
      return settings.mutateScope(toSettingScope(scope), (editor) => {
        for (const [id, enabled] of Object.entries(patch)) {
          if (enabled === undefined) editor.delete(['enabledPlugins', id]);
          else editor.set(['enabledPlugins', id], enabled);
        }
      });
    },
  };
}

const EMPTY_PLUGIN_SETTINGS: PluginManagerSettingsStore = {
  getEnabledPlugins: () => [],
  getDisabledPlugins: () => [],
  getPluginsSettings: () => ({}),
  setPluginEnabled: () => {
    throw new Error('Plugin settings are read-only in this context.');
  },
  getMergedSettings: () => ({}),
  getScopedEnabledPlugins: () => ({}),
  getScopedExtraKnownMarketplaces: () => ({}),
  patchScopedEnabledPlugins: () => {
    throw new Error('Plugin settings are read-only in this context.');
  },
};

function createReadOnlyPluginSettingsAccessor(
  settings: MergedSettings | PluginManagerMergedSettings,
): PluginManagerSettingsStore {
  return {
    getEnabledPlugins: () => getEnabledPluginIds(settings),
    getDisabledPlugins: () => getDisabledPluginIds(settings),
    getPluginsSettings: () => ({
      disabled: getDisabledPluginIds(settings),
      blockedMarketplaces: getEffectiveBlockedMarketplaces(
        settings.blockedMarketplaces,
      ),
    }),
    setPluginEnabled: EMPTY_PLUGIN_SETTINGS.setPluginEnabled,
    getMergedSettings: () => ({
      enabledPlugins: settings.enabledPlugins,
      blockedMarketplaces: settings.blockedMarketplaces,
      strictKnownMarketplaces: settings.strictKnownMarketplaces,
      extraKnownMarketplaces: settings.extraKnownMarketplaces,
    }),
    getScopedEnabledPlugins: EMPTY_PLUGIN_SETTINGS.getScopedEnabledPlugins,
    getScopedExtraKnownMarketplaces: (scope) =>
      scope === 'user'
        ? ((settings.extraKnownMarketplaces ?? {}) as Record<
            string,
            { source: unknown }
          >)
        : {},
    patchScopedEnabledPlugins: EMPTY_PLUGIN_SETTINGS.patchScopedEnabledPlugins,
  };
}

export function createCorePluginManager(
  settings?: PluginSettingsAccess,
  options?: {
    mergedSettings?: MergedSettings | PluginManagerMergedSettings;
    cwd?: string;
    factory?: PluginManagerFactory;
  },
): PluginManager {
  const create = options?.factory ?? createDefaultPluginManager;
  return create({
    settings: settings
      ? createPluginSettingsAccessor(settings)
      : options?.mergedSettings
        ? createReadOnlyPluginSettingsAccessor(options.mergedSettings)
        : EMPTY_PLUGIN_SETTINGS,
    cwd: options?.cwd ?? process.cwd(),
    installRemotePluginZip: async (...args) => {
      const { installRemotePluginZip } = await import('./pluginZipUtils.js');
      return installRemotePluginZip(...args);
    },
  });
}
