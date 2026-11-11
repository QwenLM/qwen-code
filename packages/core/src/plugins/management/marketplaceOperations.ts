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
} from '@qwen-code/resource';
import { parseMarketplaceInput } from '../parseMarketplaceInput.js';
import { clearAllPluginCaches } from '../refresh.js';
import type { MarketplaceSource } from '../schemas.js';
import {
  getInstalledPluginsForMarketplace,
  invalidateInstalledPluginsCache,
} from './installedPluginsManager.js';
import {
  addMarketplaceSourceFromSource,
  loadKnownMarketplacesConfig,
  removeMarketplaceSource,
} from './marketplaceManager.js';
import type { PluginManagementScope } from './pluginManager.js';

type MarketplaceSettings = Pick<
  LoadedSettings,
  'forScope' | 'setValue' | 'deleteValue' | 'mutateScope'
>;

const SETTINGS_SCOPES = {
  user: SettingScope.User,
  project: SettingScope.Project,
  local: SettingScope.Local,
} satisfies Record<PluginManagementScope, LoadableSettingScope>;

function sourceWithSparse(
  source: MarketplaceSource,
  sparsePaths?: string[],
): MarketplaceSource {
  if (!sparsePaths?.length) return source;
  if (source.source === 'github' || source.source === 'git') {
    return { ...source, sparsePaths };
  }
  throw new Error(
    `--sparse is only supported for github and git marketplace sources (got: ${source.source}).`,
  );
}

function sourceForSettings(
  source: MarketplaceSource,
  scope: PluginManagementScope,
  sourceInput: string,
): MarketplaceSource {
  const input = sourceInput.trim();
  if (
    scope !== 'user' &&
    (source.source === 'file' || source.source === 'directory') &&
    /^\.{1,2}[/\\]/u.test(input)
  ) {
    return { ...source, path: input };
  }
  return source;
}

export async function addConfiguredMarketplace(args: {
  settings: MarketplaceSettings;
  sourceInput: string;
  scope: PluginManagementScope;
  sparsePaths?: string[];
  onProgress?: (message: string) => void;
}): Promise<{ name: string; alreadyMaterialized: boolean }> {
  const parsed = await parseMarketplaceInput(args.sourceInput);
  if (!parsed) {
    throw new Error(
      'Invalid marketplace source format. Try: owner/repo, https://..., or ./path',
    );
  }
  if ('error' in parsed) {
    throw new Error(parsed.error);
  }

  const source = sourceWithSparse(parsed, args.sparsePaths);
  const { name, resolvedSource, alreadyMaterialized } =
    await addMarketplaceSourceFromSource(source, args.onProgress);
  const saved = args.settings.setValue(
    SETTINGS_SCOPES[args.scope],
    ['extraKnownMarketplaces', name],
    { source: sourceForSettings(resolvedSource, args.scope, args.sourceInput) },
  );
  if (!saved) {
    throw new Error(`Failed to persist marketplace "${name}" settings.`);
  }
  clearAllPluginCaches({ clearOrphanExclusions: false });

  return { name, alreadyMaterialized };
}

function removeMarketplaceDeclarations(
  settings: MarketplaceSettings,
  name: string,
  scopes: readonly LoadableSettingScope[],
): void {
  for (const scope of scopes) {
    if (!settings.deleteValue(scope, ['extraKnownMarketplaces', name])) {
      throw new Error(`Failed to persist marketplace "${name}" settings.`);
    }
  }
}

function removeMarketplaceEnabledPlugins(
  settings: MarketplaceSettings,
  name: string,
  isPluginExcluded: (pluginId: string) => boolean,
): void {
  for (const scope of Object.values(SETTINGS_SCOPES)) {
    const ids = Object.keys(
      settings.forScope(scope).settings.enabledPlugins ?? {},
    ).filter((id) => id.endsWith(`@${name}`) && !isPluginExcluded(id));
    if (ids.length === 0) continue;
    const saved = settings.mutateScope(scope, (editor) => {
      for (const id of ids) editor.delete(['enabledPlugins', id]);
    });
    if (!saved) {
      throw new Error(`Failed to persist plugins from marketplace "${name}".`);
    }
  }
}

type RemoveConfiguredMarketplaceResult =
  | { kind: 'scope-only'; scope: PluginManagementScope; keptCount: number }
  | { kind: 'removed'; removedCount: number; skippedCacheRemoval: boolean };

export async function removeConfiguredMarketplace(args: {
  settings: MarketplaceSettings;
  name: string;
  scope?: PluginManagementScope;
  isPluginExcluded?: (pluginId: string) => boolean;
}): Promise<RemoveConfiguredMarketplaceResult> {
  const { settings, name, scope, isPluginExcluded = () => false } = args;
  if (!loadKnownMarketplacesConfig()[name]) {
    throw new Error(`Marketplace "${name}" not found.`);
  }

  const allScopes = Object.values(SETTINGS_SCOPES);
  const isDeclaredIn = (settingScope: LoadableSettingScope) =>
    Boolean(
      settings.forScope(settingScope).settings.extraKnownMarketplaces?.[name],
    );

  if (scope) {
    const settingScope = SETTINGS_SCOPES[scope];
    if (!isDeclaredIn(settingScope)) {
      throw new Error(
        `Marketplace "${name}" is not declared in ${scope} settings. Omit --scope to remove it from all scopes.`,
      );
    }
    if (
      allScopes.some((other) => other !== settingScope && isDeclaredIn(other))
    ) {
      const { pluginIds } = getInstalledPluginsForMarketplace(
        name,
        isPluginExcluded,
      );
      removeMarketplaceDeclarations(settings, name, [settingScope]);
      clearAllPluginCaches({ clearOrphanExclusions: false });
      return { kind: 'scope-only', scope, keptCount: pluginIds.length };
    }
  }

  const removal = await removeMarketplaceSource(name, isPluginExcluded);
  removeMarketplaceDeclarations(
    settings,
    name,
    scope ? [SETTINGS_SCOPES[scope]] : allScopes,
  );
  removeMarketplaceEnabledPlugins(settings, name, isPluginExcluded);
  clearAllPluginCaches({ clearOrphanExclusions: false });
  invalidateInstalledPluginsCache();
  return {
    kind: 'removed',
    removedCount: removal.removedPluginIds.length,
    skippedCacheRemoval: removal.skippedCacheRemoval ?? false,
  };
}
