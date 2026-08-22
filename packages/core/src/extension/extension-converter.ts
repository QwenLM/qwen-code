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
  loadClaudePluginHooks,
  type ClaudeMarketplacePluginConfig,
} from './claude-converter.js';
import {
  convertQoderPlugin,
  QODER_PLUGIN_MANIFEST,
} from './qoder-converter.js';
import type { ExtensionConfig } from './extensionManager.js';
import type {
  ExtensionNetworkPolicy,
  ExtensionOriginSource,
  ExtensionPluginSourceKind,
} from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  AGENT_PLUGIN_MANIFEST,
  AGENT_PLUGIN_SCHEMA,
  getAgentPluginSchemaStatus,
} from './agent-plugins-v1/manifest.js';

const debugLogger = createDebugLogger('EXTENSION_CONVERTER');

export const SUPPORTED_EXTENSION_MANIFESTS = [
  EXTENSIONS_CONFIG_FILENAME,
  'gemini-extension.json',
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  QODER_PLUGIN_MANIFEST,
] as const;

async function removeConvertedDirectory(directory: string): Promise<void> {
  try {
    await fs.promises.rm(directory, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors so they do not mask the conversion result.
  }
}

type MarketplacePluginSelection =
  | {
      location: 'root';
      version?: string;
      plugin: ClaudeMarketplacePluginConfig;
    }
  | { location: 'other' | 'missing-marketplace' };

function selectedMarketplacePlugin(
  extensionDir: string,
  pluginName: string,
): MarketplacePluginSelection {
  const marketplacePath = path.join(
    extensionDir,
    SUPPORTED_EXTENSION_MANIFESTS[2],
  );
  try {
    fs.lstatSync(marketplacePath);
  } catch {
    return { location: 'missing-marketplace' };
  }
  if (
    !fs.existsSync(marketplacePath) ||
    !realPathWithin(marketplacePath, extensionDir)
  ) {
    return { location: 'other' };
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
      return { location: 'other' };
    }

    const selectedPlugin = (
      marketplace as { plugins: Array<Record<string, unknown>> }
    ).plugins.find((plugin) => plugin['name'] === pluginName);
    if (!selectedPlugin) {
      return { location: 'other' };
    }

    const source = selectedPlugin['source'];
    const version =
      typeof selectedPlugin['version'] === 'string'
        ? selectedPlugin['version']
        : undefined;
    // Claude marketplaces allow an entry without `source`; that entry refers
    // to the marketplace root itself.
    if (source === undefined || source === null) {
      return {
        location: 'root',
        version,
        plugin: selectedPlugin as unknown as ClaudeMarketplacePluginConfig,
      };
    }
    if (typeof source !== 'string') return { location: 'other' };

    return path.resolve(path.join(extensionDir, source)) ===
      path.resolve(extensionDir)
      ? {
          location: 'root',
          version,
          plugin: selectedPlugin as unknown as ClaudeMarketplacePluginConfig,
        }
      : { location: 'other' };
  } catch {
    return { location: 'other' };
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
  const merged = Object.create(null) as ExtensionHooks;
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

export async function convertCompatibleExtension(
  extensionDir: string,
  pluginName?: string,
  networkPolicy?: ExtensionNetworkPolicy,
  signal?: AbortSignal,
  pluginSourceKind?: ExtensionPluginSourceKind,
): Promise<{
  extensionDir: string;
  originSource: ExtensionOriginSource;
  externalContent: boolean;
  requiresClaudeFileAdaptation: boolean;
}> {
  signal?.throwIfAborted();
  let newExtensionDir = extensionDir;
  let originSource: ExtensionOriginSource = 'QwenCode';
  let externalContent = false;
  let requiresClaudeFileAdaptation = false;
  const isExplicitMarketplaceEntry = pluginSourceKind === 'marketplace-entry';
  const isExplicitExtensionRoot = pluginSourceKind === 'extension-root';
  // A direct-root alias must not suppress Agent Plugins detection. Legacy
  // named installs and explicit marketplace selectors retain selector-first
  // behavior.
  const agentPluginStatus =
    pluginName && !isExplicitExtensionRoot
      ? 'unrelated'
      : getAgentPluginSchemaStatus(extensionDir);
  const configFilePath = path.join(
    extensionDir,
    SUPPORTED_EXTENSION_MANIFESTS[0],
  );
  const hasQwenConfig = fs.existsSync(configFilePath);
  const isGeminiExtension =
    agentPluginStatus === 'unrelated' &&
    !hasQwenConfig &&
    isGeminiExtensionConfig(extensionDir);
  const hasClaudePlugin = fs.existsSync(
    path.join(extensionDir, SUPPORTED_EXTENSION_MANIFESTS[3]),
  );

  // `pluginName` has two meanings: a selector inside a marketplace repo, or an
  // alias retained for a direct plugin-root install. New metadata disambiguates
  // them. Legacy metadata keeps the old manifest-first behavior so an update
  // cannot suddenly replace a previously installed root Gemini/Qwen extension
  // with a marketplace subplugin.
  const marketplaceSelection = pluginName
    ? selectedMarketplacePlugin(extensionDir, pluginName)
    : { location: 'missing-marketplace' as const };
  const selectedMarketplaceEntryUsesRoot =
    marketplaceSelection.location === 'root';
  const rootMarketplacePluginName =
    pluginName && !isExplicitExtensionRoot && selectedMarketplaceEntryUsesRoot
      ? pluginName
      : undefined;

  if (agentPluginStatus === 'unsupported') {
    throw new Error(
      `Unsupported Agent Plugins schema. Supported schema: "${AGENT_PLUGIN_SCHEMA}".`,
    );
  } else if (agentPluginStatus === 'supported') {
    originSource = 'AgentPlugins';
    // A selected subdirectory/remote marketplace plugin must win over manifests
    // at the marketplace repository root. Only explicit new metadata opts into
    // this precedence; legacy installs retain their previous root selection.
  } else if (
    isExplicitMarketplaceEntry &&
    pluginName &&
    marketplaceSelection.location !== 'missing-marketplace' &&
    !selectedMarketplaceEntryUsesRoot
  ) {
    const converted = await convertClaudePluginPackage(
      extensionDir,
      pluginName,
      networkPolicy,
      signal,
      true,
    );
    newExtensionDir = converted.convertedDir;
    if (getAgentPluginSchemaStatus(newExtensionDir) !== 'unrelated') {
      fs.rmSync(path.join(newExtensionDir, AGENT_PLUGIN_MANIFEST), {
        force: true,
      });
    }
    originSource = 'Claude';
    externalContent = converted.externalContent;
  } else if (hasQwenConfig) {
    newExtensionDir = extensionDir;
  } else if (isGeminiExtension && hasClaudePlugin) {
    const geminiConversion = await convertGeminiExtensionPackage(
      extensionDir,
      signal,
    );
    try {
      signal?.throwIfAborted();
      let claudeHooks: ExtensionHooks | undefined;
      let claudeMetadataLoaded = false;
      try {
        claudeHooks = loadClaudePluginHooks(
          extensionDir,
          rootMarketplacePluginName && marketplaceSelection.location === 'root'
            ? marketplaceSelection.plugin
            : undefined,
          signal,
        );
        claudeMetadataLoaded = true;
      } catch (error) {
        signal?.throwIfAborted();
        debugLogger.warn(
          `Failed to import Claude plugin metadata; keeping the Gemini extension: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (!claudeMetadataLoaded) {
        newExtensionDir = geminiConversion.convertedDir;
        originSource = 'Gemini';
        return {
          extensionDir: newExtensionDir,
          originSource,
          externalContent,
          requiresClaudeFileAdaptation,
        };
      }

      const conventionalHooks = loadConventionalHooks(
        geminiConversion.convertedDir,
      );
      const geminiHooks = geminiConversion.config.hooks ?? conventionalHooks;
      const mergedConfig = {
        ...geminiConversion.config,
        ...(rootMarketplacePluginName &&
        marketplaceSelection.location === 'root' &&
        marketplaceSelection.version
          ? { version: marketplaceSelection.version }
          : {}),
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
      requiresClaudeFileAdaptation = Boolean(conventionalHooks || claudeHooks);
    } catch (error) {
      await removeConvertedDirectory(geminiConversion.convertedDir);
      throw error;
    }
  } else if (isGeminiExtension) {
    newExtensionDir = (
      await convertGeminiExtensionPackage(extensionDir, signal)
    ).convertedDir;
    originSource = 'Gemini';
  } else if (pluginName && !isExplicitExtensionRoot) {
    const converted = await convertClaudePluginPackage(
      extensionDir,
      pluginName,
      networkPolicy,
      signal,
      true,
    );
    newExtensionDir = converted.convertedDir;
    if (getAgentPluginSchemaStatus(newExtensionDir) !== 'unrelated') {
      fs.rmSync(path.join(newExtensionDir, AGENT_PLUGIN_MANIFEST), {
        force: true,
      });
    }
    originSource = 'Claude';
    externalContent = converted.externalContent;
  } else if (fs.existsSync(path.join(extensionDir, QODER_PLUGIN_MANIFEST))) {
    newExtensionDir = (await convertQoderPlugin(extensionDir, signal))
      .convertedDir;
    originSource = 'Qoder';
  } else if (hasClaudePlugin) {
    newExtensionDir = (
      await convertClaudePluginStandalone(extensionDir, true, signal)
    ).convertedDir;
    originSource = 'Claude';
  }
  signal?.throwIfAborted();
  return {
    extensionDir: newExtensionDir,
    originSource,
    externalContent,
    requiresClaudeFileAdaptation,
  };
}
