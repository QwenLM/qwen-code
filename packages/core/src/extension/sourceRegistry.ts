/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { atomicWriteFileSync } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { redactUrlCredentials } from './redaction.js';
import { loadMarketplaceConfigFromSource } from './marketplace.js';
import type {
  ClaudeMarketplaceConfig,
  ClaudeMarketplacePluginConfig,
} from './claude-converter.js';

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
  /** ISO timestamp recorded when the source was added. */
  addedAt?: string;
  /** ISO timestamp of the last successful (re)fetch / update. */
  lastUpdatedAt?: string;
}

/**
 * A single installable plugin surfaced by the Discover view.
 */
/** Components a plugin declares in its marketplace entry ("Will install"). */
export interface DiscoveredPluginComponents {
  skills?: string[];
  commands?: string[];
  agents?: string[];
  mcpServers?: string[];
}

export interface DiscoveredPlugin {
  /** Name of the marketplace this plugin came from. */
  marketplaceName: string;
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

function asNameList(
  value: string | string[] | undefined,
): string[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function asMcpNames(
  value: string | Record<string, unknown> | undefined,
): string[] | undefined {
  if (value && typeof value === 'object') {
    const names = Object.keys(value);
    return names.length > 0 ? names : undefined;
  }
  return undefined;
}

function pluginComponents(
  plugin: ClaudeMarketplacePluginConfig,
): DiscoveredPluginComponents | undefined {
  const components: DiscoveredPluginComponents = {
    skills: asNameList(plugin.skills),
    commands: asNameList(plugin.commands),
    agents: asNameList(plugin.agents),
    mcpServers: asMcpNames(plugin.mcpServers),
  };
  return Object.values(components).some(Boolean) ? components : undefined;
}

function pluginLastUpdated(
  plugin: ClaudeMarketplacePluginConfig,
): string | undefined {
  const record = plugin as unknown as Record<string, unknown>;
  const value =
    record['lastUpdated'] ?? record['updatedAt'] ?? record['updated'];
  return typeof value === 'string' ? value : undefined;
}

function pluginInstalls(
  plugin: ClaudeMarketplacePluginConfig,
): number | undefined {
  const record = plugin as unknown as Record<string, unknown>;
  const value =
    record['installs'] ?? record['installCount'] ?? record['downloads'];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
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
 * which the existing installer resolves against the marketplace's
 * `marketplace.json`. For direct-JSON (`http`) sources it is derived from
 * the per-plugin `source` field.
 */
function resolveInstallSource(
  marketplace: ExtensionSource,
  plugin: ClaudeMarketplacePluginConfig,
): string {
  if (marketplace.type !== 'http') {
    return `${marketplace.source}:${plugin.name}`;
  }
  const src = plugin.source;
  if (typeof src === 'string') {
    // A remote marketplace must not be able to point the installer at an
    // arbitrary local filesystem path (e.g. "/opt/secret" or "../../etc").
    if (path.isAbsolute(src) || src.startsWith('.') || src.startsWith('~')) {
      debugLogger.warn(
        `Ignoring local path source "${src}" from remote marketplace "${marketplace.source}".`,
      );
      return plugin.name;
    }
    return src.includes(':') ? src : `${src}:${plugin.name}`;
  }
  if (src && src.source === 'github') {
    return `${src.repo}:${plugin.name}`;
  }
  if (src && src.source === 'url') {
    return src.url;
  }
  return plugin.name;
}

// C0/C1 control chars left behind after escape-sequence stripping.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Strips terminal escape/control sequences from untrusted marketplace text.
 * Plugin metadata is rendered in the TUI before the user consents to install,
 * so a hostile source could otherwise embed ANSI/OSC sequences to move the
 * cursor, clear lines, or spoof UI. Install resolution uses the raw plugin
 * fields, so sanitizing the display copy here is safe.
 */

function sanitizeDisplay(text: string): string;
function sanitizeDisplay(text: string | undefined): string | undefined;
function sanitizeDisplay(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  // Drop ANSI/VT escape sequences, then any remaining C0/C1 control chars.
  return stripVTControlCharacters(text).replace(CONTROL_CHARS_RE, '');
}

function pluginsFromConfig(
  marketplace: ExtensionSource,
  config: ClaudeMarketplaceConfig,
  installedNames: ReadonlySet<string>,
): DiscoveredPlugin[] {
  return (config.plugins ?? []).map((plugin) => ({
    marketplaceName: sanitizeDisplay(config.name || marketplace.name),
    name: sanitizeDisplay(plugin.name),
    description: sanitizeDisplay(plugin.description),
    version: plugin.version,
    author: sanitizeDisplay(plugin.author?.name),
    homepage: sanitizeDisplay(plugin.homepage),
    category: plugin.category,
    lastUpdated: pluginLastUpdated(plugin),
    installs: pluginInstalls(plugin),
    components: pluginComponents(plugin),
    installSource: resolveInstallSource(marketplace, plugin),
    installed: installedNames.has(plugin.name),
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
