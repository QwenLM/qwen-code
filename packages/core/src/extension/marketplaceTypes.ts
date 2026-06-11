/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ClaudeMarketplaceConfig,
  ClaudeMarketplacePluginConfig,
  ClaudePluginSource,
} from './claude-converter.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MARKETPLACE_TYPES');

/** Which on-disk manifest format a marketplace was authored in. */
export type MarketplaceFormat = 'claude' | 'qwen';

/**
 * Where a Qwen marketplace entry's extension code lives.
 * A string is either a path relative to the marketplace root (honoring
 * `metadata.extensionRoot`) or a git/https URL.
 */
export type QwenMarketplaceEntrySource =
  | string
  | { type: 'github'; repo: string; path?: string; ref?: string }
  | { type: 'git'; url: string; path?: string; ref?: string }
  | { type: 'npm'; package: string };

/** Components an entry declares (drives the "Will install" summary). */
export interface MarketplaceEntryComponents {
  skills?: string[];
  commands?: string[];
  agents?: string[];
  mcpServers?: string[];
}

/** A single extension entry in a `qwen-marketplace.json`. */
export interface QwenMarketplaceEntryConfig {
  name: string;
  source: QwenMarketplaceEntrySource;
  version?: string;
  description?: string;
  author?: string | { name?: string; email?: string; url?: string };
  homepage?: string;
  category?: string;
  tags?: string[];
  lastUpdated?: string;
  installs?: number;
  components?: MarketplaceEntryComponents;
}

/** The Qwen-native marketplace manifest (`qwen-marketplace.json` at repo root). */
export interface QwenMarketplaceConfig {
  name: string;
  extensions: QwenMarketplaceEntryConfig[];
  description?: string;
  version?: string;
  owner?: { name?: string; email?: string };
  metadata?: { extensionRoot?: string };
}

/**
 * A marketplace entry normalized from either manifest format. Downstream
 * consumers (discovery, UI, install metadata) only deal with this shape.
 */
export interface MarketplaceEntry {
  name: string;
  description?: string;
  version?: string;
  author?: string;
  homepage?: string;
  category?: string;
  tags?: string[];
  lastUpdated?: string;
  installs?: number;
  components?: MarketplaceEntryComponents;
  /** Raw per-entry source spec, kept for deriving direct install sources. */
  source?:
    | string
    | ClaudePluginSource
    | Exclude<QwenMarketplaceEntrySource, string>;
}

/** Format-agnostic marketplace model used everywhere past the loaders. */
export interface MarketplaceConfig {
  format: MarketplaceFormat;
  name: string;
  description?: string;
  version?: string;
  entries: MarketplaceEntry[];
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

function claudePluginComponents(
  plugin: ClaudeMarketplacePluginConfig,
): MarketplaceEntryComponents | undefined {
  const components: MarketplaceEntryComponents = {
    skills: asNameList(plugin.skills),
    commands: asNameList(plugin.commands),
    agents: asNameList(plugin.agents),
    mcpServers: asMcpNames(plugin.mcpServers),
  };
  return Object.values(components).some(Boolean) ? components : undefined;
}

function claudePluginLastUpdated(
  plugin: ClaudeMarketplacePluginConfig,
): string | undefined {
  const record = plugin as unknown as Record<string, unknown>;
  const value =
    record['lastUpdated'] ?? record['updatedAt'] ?? record['updated'];
  return typeof value === 'string' ? value : undefined;
}

function claudePluginInstalls(
  plugin: ClaudeMarketplacePluginConfig,
): number | undefined {
  const record = plugin as unknown as Record<string, unknown>;
  const value =
    record['installs'] ?? record['installCount'] ?? record['downloads'];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function fromClaudeMarketplace(
  config: ClaudeMarketplaceConfig,
): MarketplaceConfig {
  return {
    format: 'claude',
    name: config.name,
    description: config.metadata?.description,
    version: config.metadata?.version,
    entries: (config.plugins ?? []).map((plugin) => ({
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      author: plugin.author?.name,
      homepage: plugin.homepage,
      category: plugin.category,
      tags: plugin.tags,
      lastUpdated: claudePluginLastUpdated(plugin),
      installs: claudePluginInstalls(plugin),
      components: claudePluginComponents(plugin),
      source: plugin.source,
    })),
  };
}

function qwenEntryAuthor(
  author: QwenMarketplaceEntryConfig['author'],
): string | undefined {
  if (typeof author === 'string') {
    return author;
  }
  return author?.name;
}

/**
 * Sanitizes the components a Qwen entry declares. The values come from an
 * untrusted manifest, so each field is coerced to a string-name list (or
 * dropped); this keeps the "Will install" summary from crashing on malformed
 * input, matching how Claude entries are normalized.
 */
function normalizeEntryComponents(
  value: QwenMarketplaceEntryConfig['components'],
): MarketplaceEntryComponents | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const components: MarketplaceEntryComponents = {
    skills: asNameList(value.skills),
    commands: asNameList(value.commands),
    agents: asNameList(value.agents),
    mcpServers: asNameList(value.mcpServers),
  };
  return Object.values(components).some(Boolean) ? components : undefined;
}

export function fromQwenMarketplace(
  config: QwenMarketplaceConfig,
): MarketplaceConfig {
  const entries: MarketplaceEntry[] = [];
  for (const entry of config.extensions ?? []) {
    if (typeof entry?.name !== 'string' || !entry.name || !entry.source) {
      debugLogger.warn(
        `Skipping invalid qwen marketplace entry in "${config.name}": ` +
          `entries need a name and a source.`,
      );
      continue;
    }
    entries.push({
      name: entry.name,
      description: entry.description,
      version: entry.version,
      author: qwenEntryAuthor(entry.author),
      homepage: entry.homepage,
      category: entry.category,
      tags: entry.tags,
      lastUpdated: entry.lastUpdated,
      installs:
        typeof entry.installs === 'number' && Number.isFinite(entry.installs)
          ? entry.installs
          : undefined,
      components: normalizeEntryComponents(entry.components),
      source: entry.source,
    });
  }
  return {
    format: 'qwen',
    name: config.name,
    description: config.description,
    version: config.version,
    entries,
  };
}

/**
 * Parses an arbitrary JSON document into the unified marketplace model by
 * detecting its shape: an already-unified config (`format` + `entries`, as
 * persisted in install metadata), a Qwen manifest (`extensions` array), or a
 * Claude manifest (`plugins` array). Returns null when none match.
 */
export function parseMarketplaceDocument(
  value: unknown,
): MarketplaceConfig | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['name'] !== 'string' || !record['name']) {
    return null;
  }
  if (
    (record['format'] === 'claude' || record['format'] === 'qwen') &&
    Array.isArray(record['entries'])
  ) {
    return value as MarketplaceConfig;
  }
  if (Array.isArray(record['extensions'])) {
    return fromQwenMarketplace(value as QwenMarketplaceConfig);
  }
  if (Array.isArray(record['plugins'])) {
    return fromClaudeMarketplace(value as ClaudeMarketplaceConfig);
  }
  return null;
}
