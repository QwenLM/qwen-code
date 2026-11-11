/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  commitLegacyMarketplaceAliases,
  discoverLegacyMarketplaceAliases,
  migrateInstalledPluginIds,
  type LegacyMarketplaceAliases,
} from '../legacyPluginIdentityMigration.js';
import { buildPluginId, parsePluginIdentifier } from '../pluginIdentifier.js';
import { runLogger } from '../../utils/runLogger.js';

import {
  SettingScope,
  type LoadedSettings,
  type LoadableSettingScope,
} from '@qwen-code/resource';

const PERSISTED_SCOPES: LoadableSettingScope[] = [
  SettingScope.User,
  SettingScope.Project,
  SettingScope.Local,
];

/**
 * Normalize legacy source-shaped marketplace identities before startup
 * reconciliation can materialize them again.
 *
 * Installed state and settings are migrated first. The known-marketplace key
 * is committed last so any interrupted/failed migration remains discoverable
 * and can be retried on the next startup.
 */
export async function migrateLegacyPluginIdentities(
  settings: LoadedSettings,
): Promise<boolean> {
  const aliases = await discoverLegacyMarketplaceAliases();
  if (Object.keys(aliases).length === 0) return false;

  const installed = migrateInstalledPluginIds(aliases);
  if (!installed.success) {
    throw new Error(
      'Legacy plugin identity migration could not update installed plugin state',
    );
  }

  const settingsChanged = migrateSettingsReferences(settings, aliases);
  const marketplaces = commitLegacyMarketplaceAliases(aliases);
  if (!marketplaces.success) {
    throw new Error(
      'Legacy plugin identity migration could not update known marketplaces',
    );
  }

  const changed = installed.changed || settingsChanged || marketplaces.changed;
  if (changed) {
    const summary = Object.entries(aliases)
      .map(([legacy, canonical]) => `"${legacy}" → "${canonical}"`)
      .join(', ');
    runLogger.log(`[PluginMigration] Normalized legacy identities: ${summary}`);
  }
  return changed;
}

function migrateSettingsReferences(
  settings: LoadedSettings,
  aliases: LegacyMarketplaceAliases,
): boolean {
  let changed = false;

  for (const scope of PERSISTED_SCOPES) {
    let scopeChanged = false;
    const success = settings.mutateScope(scope, (editor) => {
      const scoped = editor.get([]) as Record<string, unknown>;
      const enabledPlugins = rewritePluginIdRecord(
        scoped['enabledPlugins'] as Record<string, boolean> | undefined,
        aliases,
      );
      if (enabledPlugins) {
        editor.set('enabledPlugins', enabledPlugins);
        scopeChanged = true;
      }

      const pluginConfigs = rewritePluginIdRecord(
        scoped['pluginConfigs'] as Record<string, unknown> | undefined,
        aliases,
      );
      if (pluginConfigs) {
        editor.set('pluginConfigs', pluginConfigs);
        scopeChanged = true;
      }

      const extraKnownMarketplaces = rewriteMarketplaceRecord(
        scoped['extraKnownMarketplaces'] as Record<string, unknown> | undefined,
        aliases,
      );
      if (extraKnownMarketplaces) {
        editor.set('extraKnownMarketplaces', extraKnownMarketplaces);
        scopeChanged = true;
      }

      const blockedMarketplaces = rewriteMarketplaceList(
        scoped['blockedMarketplaces'] as string[] | undefined,
        aliases,
      );
      if (blockedMarketplaces) {
        editor.set('blockedMarketplaces', blockedMarketplaces);
        scopeChanged = true;
      }
    });
    if (!success) {
      throw new Error(
        'Legacy plugin identity migration could not save settings',
      );
    }
    changed ||= scopeChanged;
  }

  return changed;
}

function rewritePluginIdRecord<T>(
  record: Record<string, T> | undefined,
  aliases: LegacyMarketplaceAliases,
): Record<string, T> | null {
  if (!record) return null;
  const next = { ...record };
  let changed = false;

  for (const pluginId of Object.keys(record)) {
    const { name, marketplace } = parsePluginIdentifier(pluginId);
    if (!marketplace || !aliases[marketplace]) continue;
    const canonicalId = buildPluginId(name, aliases[marketplace]);
    if (!(canonicalId in next)) next[canonicalId] = record[pluginId];
    delete next[pluginId];
    changed = true;
  }

  return changed ? next : null;
}

function rewriteMarketplaceRecord<T>(
  record: Record<string, T> | undefined,
  aliases: LegacyMarketplaceAliases,
): Record<string, T> | null {
  if (!record) return null;
  const next = { ...record };
  let changed = false;

  for (const [legacyName, canonicalName] of Object.entries(aliases)) {
    if (!(legacyName in next)) continue;
    if (!(canonicalName in next)) next[canonicalName] = next[legacyName];
    delete next[legacyName];
    changed = true;
  }

  return changed ? next : null;
}

function rewriteMarketplaceList(
  marketplaces: string[] | undefined,
  aliases: LegacyMarketplaceAliases,
): string[] | null {
  if (!marketplaces) return null;
  let changed = false;
  const normalized = marketplaces.map((marketplace) => {
    const canonical = aliases[marketplace];
    if (!canonical) return marketplace;
    changed = true;
    return canonical;
  });
  if (!changed) return null;
  return [...new Set(normalized)];
}
