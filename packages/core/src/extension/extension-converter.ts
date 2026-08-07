/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';
import {
  convertGeminiExtensionPackage,
  isGeminiExtensionConfig,
  realPathWithin,
} from './gemini-converter.js';
import {
  convertClaudePluginPackage,
  convertClaudePluginStandalone,
} from './claude-converter.js';
import type { ExtensionConfig } from './extensionManager.js';
import type {
  ExtensionNetworkPolicy,
  ExtensionOriginSource,
  ExtensionPluginSourceKind,
} from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('EXTENSION_CONVERTER');

export const SUPPORTED_EXTENSION_MANIFESTS = [
  EXTENSIONS_CONFIG_FILENAME,
  'gemini-extension.json',
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
] as const;

function removeConvertedDirectory(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors so they do not mask the conversion result.
  }
}

type MarketplacePluginLocation = 'root' | 'other' | 'missing-marketplace';

function selectedMarketplacePluginLocation(
  extensionDir: string,
  pluginName: string,
): MarketplacePluginLocation {
  const marketplacePath = path.join(
    extensionDir,
    SUPPORTED_EXTENSION_MANIFESTS[2],
  );
  try {
    fs.lstatSync(marketplacePath);
  } catch {
    return 'missing-marketplace';
  }
  if (
    !fs.existsSync(marketplacePath) ||
    !realPathWithin(marketplacePath, extensionDir)
  ) {
    return 'other';
  }

  try {
    const marketplace: unknown = JSON.parse(
      fs.readFileSync(marketplacePath, 'utf-8'),
    );
    if (
      typeof marketplace !== 'object' ||
      marketplace === null ||
      !Array.isArray((marketplace as { plugins?: unknown }).plugins)
    ) {
      return 'other';
    }

    const selectedPlugin = (
      marketplace as { plugins: Array<Record<string, unknown>> }
    ).plugins.find((plugin) => plugin['name'] === pluginName);
    if (!selectedPlugin) {
      return 'other';
    }

    const source = selectedPlugin['source'];
    // Claude marketplaces allow an entry without `source`; that entry refers
    // to the marketplace root itself.
    if (source === undefined || source === null) return 'root';
    if (typeof source !== 'string') return 'other';

    return path.resolve(path.join(extensionDir, source)) ===
      path.resolve(extensionDir)
      ? 'root'
      : 'other';
  } catch {
    return 'other';
  }
}

type ExtensionHooks = NonNullable<ExtensionConfig['hooks']>;

function loadConventionalHooks(
  convertedDir: string,
): ExtensionHooks | undefined {
  const hooksPath = path.join(convertedDir, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksPath) || !realPathWithin(hooksPath, convertedDir)) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const hooks = (parsed as { hooks?: unknown }).hooks ?? parsed;
    return typeof hooks === 'object' && hooks !== null
      ? (hooks as ExtensionHooks)
      : undefined;
  } catch (error) {
    debugLogger.warn(
      `Failed to parse hooks file ${hooksPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

function mergeHooks(
  ...sources: Array<ExtensionHooks | undefined>
): ExtensionHooks | undefined {
  const merged: ExtensionHooks = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [event, definitions] of Object.entries(source)) {
      if (!Array.isArray(definitions)) continue;
      const existing = merged[event as keyof ExtensionHooks] ?? [];
      const serialized = new Set(
        existing.map((entry) => JSON.stringify(entry)),
      );
      const uniqueDefinitions = definitions.filter((entry) => {
        const key = JSON.stringify(entry);
        if (serialized.has(key)) return false;
        serialized.add(key);
        return true;
      });
      merged[event as keyof ExtensionHooks] = [
        ...existing,
        ...uniqueDefinitions,
      ];
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export async function convertGeminiOrClaudeExtension(
  extensionDir: string,
  pluginName?: string,
  networkPolicy?: ExtensionNetworkPolicy,
  signal?: AbortSignal,
  pluginSourceKind?: ExtensionPluginSourceKind,
): Promise<{
  extensionDir: string;
  originSource: ExtensionOriginSource;
  requiresClaudeFileAdaptation: boolean;
}> {
  signal?.throwIfAborted();
  let newExtensionDir = extensionDir;
  let originSource: ExtensionOriginSource = 'QwenCode';
  let requiresClaudeFileAdaptation = false;
  const configFilePath = path.join(
    extensionDir,
    SUPPORTED_EXTENSION_MANIFESTS[0],
  );
  const hasQwenConfig = fs.existsSync(configFilePath);
  const isGeminiExtension =
    !hasQwenConfig && isGeminiExtensionConfig(extensionDir);
  const hasClaudePlugin = fs.existsSync(
    path.join(extensionDir, SUPPORTED_EXTENSION_MANIFESTS[3]),
  );
  // `pluginName` has two meanings: a selector inside a marketplace repo, or an
  // alias retained for a direct plugin-root install. New metadata disambiguates
  // them. Legacy metadata keeps the old manifest-first behavior so an update
  // cannot suddenly replace a previously installed root Gemini/Qwen extension
  // with a marketplace subplugin.
  const marketplaceLocation = pluginName
    ? selectedMarketplacePluginLocation(extensionDir, pluginName)
    : 'missing-marketplace';
  const isExplicitMarketplaceEntry = pluginSourceKind === 'marketplace-entry';
  const isExplicitExtensionRoot = pluginSourceKind === 'extension-root';
  const selectedMarketplaceEntryUsesRoot = marketplaceLocation === 'root';
  const rootMarketplacePluginName =
    pluginName && !isExplicitExtensionRoot && selectedMarketplaceEntryUsesRoot
      ? pluginName
      : undefined;

  // A selected subdirectory/remote marketplace plugin must win over manifests
  // at the marketplace repository root. Only explicit new metadata opts into
  // this precedence; legacy installs retain their previous root selection.
  if (
    isExplicitMarketplaceEntry &&
    pluginName &&
    !selectedMarketplaceEntryUsesRoot
  ) {
    newExtensionDir = (
      await convertClaudePluginPackage(
        extensionDir,
        pluginName,
        networkPolicy,
        signal,
        true,
      )
    ).convertedDir;
    originSource = 'Claude';
  } else if (hasQwenConfig) {
    newExtensionDir = extensionDir;
  } else if (isGeminiExtension && hasClaudePlugin) {
    const geminiConversion = await convertGeminiExtensionPackage(extensionDir);
    let claudeConversion:
      | Awaited<ReturnType<typeof convertClaudePluginStandalone>>
      | undefined;
    try {
      signal?.throwIfAborted();
      try {
        claudeConversion = rootMarketplacePluginName
          ? await convertClaudePluginPackage(
              extensionDir,
              rootMarketplacePluginName,
              networkPolicy,
              signal,
              true,
            )
          : await convertClaudePluginStandalone(extensionDir, true);
      } catch (error) {
        signal?.throwIfAborted();
        debugLogger.warn(
          `Failed to import Claude plugin metadata; keeping the Gemini extension: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (!claudeConversion) {
        newExtensionDir = geminiConversion.convertedDir;
        originSource = 'Gemini';
        return {
          extensionDir: newExtensionDir,
          originSource,
          requiresClaudeFileAdaptation,
        };
      }

      const geminiHooks =
        geminiConversion.config.hooks ??
        loadConventionalHooks(geminiConversion.convertedDir);
      const claudeHooks = claudeConversion.config.hooks;
      const mergedConfig = {
        ...geminiConversion.config,
        hooks: mergeHooks(geminiHooks, claudeHooks),
      };
      signal?.throwIfAborted();
      fs.writeFileSync(
        path.join(geminiConversion.convertedDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(mergedConfig, null, 2),
        'utf-8',
      );
      newExtensionDir = geminiConversion.convertedDir;
      originSource = 'Gemini';
      requiresClaudeFileAdaptation = Boolean(claudeHooks);
    } catch (error) {
      removeConvertedDirectory(geminiConversion.convertedDir);
      throw error;
    } finally {
      if (claudeConversion) {
        removeConvertedDirectory(claudeConversion.convertedDir);
      }
    }
  } else if (isGeminiExtension) {
    newExtensionDir = (await convertGeminiExtensionPackage(extensionDir))
      .convertedDir;
    originSource = 'Gemini';
  } else if (pluginName && !isExplicitExtensionRoot) {
    newExtensionDir = (
      await convertClaudePluginPackage(
        extensionDir,
        pluginName,
        networkPolicy,
        signal,
        true,
      )
    ).convertedDir;
    originSource = 'Claude';
  } else if (hasClaudePlugin) {
    newExtensionDir = (await convertClaudePluginStandalone(extensionDir, true))
      .convertedDir;
    originSource = 'Claude';
  }
  signal?.throwIfAborted();
  return {
    extensionDir: newExtensionDir,
    originSource,
    requiresClaudeFileAdaptation,
  };
}
