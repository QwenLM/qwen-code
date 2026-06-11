/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { redactUrlCredentials } from './redaction.js';
import { loadMarketplaceConfigFromSource } from './marketplace.js';
import type {
  MarketplaceConfig,
  MarketplaceEntry,
  MarketplaceEntryComponents,
  MarketplaceFormat,
} from './marketplaceTypes.js';

const debugLogger = createDebugLogger('SOURCE_REGISTRY');

export type ExtensionSourceType = 'github' | 'git' | 'http' | 'local';

/**
 * A persisted marketplace source the user has added (Marketplaces tab).
 */
export interface ExtensionSource {
  /** Display name (from the marketplace config `name`, or derived). */
  name: string;
  /** Original input string used to add the source. */
  source: string;
  type: ExtensionSourceType;
  /**
   * Manifest format resolved when the source was added. Sources persisted
   * before this field existed have it unset; the loaders re-detect on fetch.
   */
  format?: MarketplaceFormat;
  /** ISO timestamp recorded when the source was added. */
  addedAt?: string;
  /** ISO timestamp of the last successful (re)fetch / update. */
  lastUpdatedAt?: string;
}

/** Components a plugin declares in its marketplace entry ("Will install"). */
export type DiscoveredPluginComponents = MarketplaceEntryComponents;

export interface DiscoveredPlugin {
  /** Name of the marketplace this plugin came from. */
  marketplaceName: string;
  /** Manifest format of the marketplace this plugin came from. */
  format?: MarketplaceFormat;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  homepage?: string;
  category?: string;
  /** Best-effort last-updated string when the marketplace entry provides one. */
  lastUpdated?: string;
  /** Best-effort install/download count when the marketplace entry provides one. */
  installs?: number;
  /** Components the plugin declares (for the "Will install" summary). */
  components?: DiscoveredPluginComponents;
  /** Source string suitable for `parseInstallSource`. */
  installSource: string;
  /** Whether an extension with this name is already installed. */
  installed: boolean;
}

/**
 * Classifies a marketplace source string into a {@link ExtensionSourceType}
 * using format heuristics only (no network / filesystem access required for a
 * confident answer, beyond an optional existence check the caller may do).
 */
export function parseExtensionSourceType(source: string): ExtensionSourceType {
  const trimmed = source.trim();
  if (trimmed.startsWith('git@') || trimmed.startsWith('sso://')) {
    return 'git';
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return isGitHubHost(trimmed) ? 'github' : 'http';
  }
  if (isOwnerRepoShorthand(trimmed)) {
    return 'github';
  }
  return 'local';
}

function isGitHubHost(url: string): boolean {
  try {
    return new URL(url).hostname === 'github.com';
  } catch {
    return false;
  }
}

function isOwnerRepoShorthand(source: string): boolean {
  return /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(source);
}

/**
 * Builds the install-source string fed to `parseInstallSource` for a discovered
 * plugin. For repo/local sources this is `<marketplace>:<pluginName>`,
 * which the existing installer resolves against the marketplace's manifest.
 * For direct-JSON (`http`) sources it is derived from the per-entry `source`
 * field, whose structured shapes differ between the Claude and Qwen formats.
 */
function resolveInstallSource(
  marketplace: ExtensionSource,
  entry: MarketplaceEntry,
): string {
  if (marketplace.type !== 'http') {
    return `${marketplace.source}:${entry.name}`;
  }
  const src = entry.source;
  if (typeof src === 'string') {
    return src.includes(':') ? src : `${src}:${entry.name}`;
  }
  if (!src) {
    return entry.name;
  }
  if ('source' in src) {
    // Claude-format structured source.
    if (src.source === 'github') {
      return `${src.repo}:${entry.name}`;
    }
    if (src.source === 'url' || src.source === 'git-subdir') {
      return src.url;
    }
  }
  if ('type' in src) {
    // Qwen-format structured source.
    if (src.type === 'github') {
      return `https://github.com/${src.repo}`;
    }
    if (src.type === 'git') {
      return src.url;
    }
    if (src.type === 'npm') {
      return src.package;
    }
  }
  return entry.name;
}

function pluginsFromConfig(
  marketplace: ExtensionSource,
  config: MarketplaceConfig,
  installedNames: ReadonlySet<string>,
): DiscoveredPlugin[] {
  return config.entries.map((entry) => ({
    marketplaceName: config.name || marketplace.name,
    format: config.format,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    author: entry.author,
    homepage: entry.homepage,
    category: entry.category,
    lastUpdated: entry.lastUpdated,
    installs: entry.installs,
    components: entry.components,
    installSource: resolveInstallSource(marketplace, entry),
    installed: installedNames.has(entry.name),
  }));
}

/**
 * Persists the list of marketplace sources the user has added.
 */
export class SourceRegistryStore {
  constructor(private readonly filePath: string) {}

  read(): ExtensionSource[] {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? (parsed as ExtensionSource[]) : [];
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return [];
      }
      debugLogger.error('Error reading marketplace registry:', error);
      return [];
    }
  }

  private write(sources: ExtensionSource[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    atomicWriteFileSync(this.filePath, JSON.stringify(sources, null, 2));
  }

  /**
   * Adds (or replaces, when name/source matches) a marketplace source.
   */
  add(source: ExtensionSource): void {
    const sources = this.read().filter(
      (existing) =>
        existing.name !== source.name && existing.source !== source.source,
    );
    sources.push(source);
    this.write(sources);
  }

  /** Removes a marketplace by name. Returns true if anything was removed. */
  remove(name: string): boolean {
    const sources = this.read();
    const next = sources.filter((s) => s.name !== name);
    if (next.length === sources.length) {
      return false;
    }
    this.write(next);
    return true;
  }
}

/**
 * Loads each configured marketplace and flattens their plugin lists into a
 * single de-duplicated {@link DiscoveredPlugin} array, tagging which entries are
 * already installed. Marketplaces that fail to load are skipped (and logged) so
 * one bad source does not break discovery.
 */
export async function discoverPlugins(
  sources: readonly ExtensionSource[],
  installedNames: ReadonlySet<string>,
): Promise<DiscoveredPlugin[]> {
  const results = await Promise.all(
    sources.map(async (marketplace) => {
      try {
        const config = await loadMarketplaceConfigFromSource(
          marketplace.source,
        );
        if (!config) {
          debugLogger.debug(
            `No marketplace config resolved for ${redactUrlCredentials(
              marketplace.source,
            )}`,
          );
          return [];
        }
        return pluginsFromConfig(marketplace, config, installedNames);
      } catch (error) {
        debugLogger.error(
          `Failed to discover plugins from ${redactUrlCredentials(
            marketplace.source,
          )}:`,
          error,
        );
        return [];
      }
    }),
  );

  // De-duplicate by `${marketplaceName}/${pluginName}` to keep distinct plugins
  // that happen to share a name across different sources.
  const seen = new Set<string>();
  const deduped: DiscoveredPlugin[] = [];
  for (const plugin of results.flat()) {
    const key = `${plugin.marketplaceName}/${plugin.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(plugin);
  }
  return deduped;
}
