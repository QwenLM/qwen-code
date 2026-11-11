/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfigFields } from '../../config/config.js';
import type { LoadedPlugin } from '../types.js';
import {
  substituteUserConfigVariables,
  substitutePluginVariables,
} from './pluginOptionsStorage.js';
import { getLoadedPluginId } from '../management/pluginDependencies.js';

/**
 * Per-plugin configuration values, sourced from `settings.pluginConfigs`.
 * Mirrors the cc-sdk `pluginConfigs` settings field shape.
 */
export interface PluginConfigsRoot {
  [pluginId: string]: {
    mcpServers?: Record<
      string,
      Record<string, string | number | boolean | string[]>
    >;
  };
}

/**
 * Stable lookup key for a plugin in `settings.pluginConfigs`.
 *
 * - Local / flag / builtin plugins: bare `plugin.name` (they have no marketplace).
 * - Marketplace plugins: `${name}@${marketplace}` (matches cc-sdk convention).
 *
 * Reserved source names (`flag`, `local`, `builtin`) are NOT valid marketplace
 * names, so callers should also try the bare name as a fallback for marketplace
 * plugins to ease config-file authoring.
 */
const RESERVED_SOURCES = new Set(['flag', 'local', 'builtin']);

export function getPluginConfigKey(plugin: LoadedPlugin): string {
  if (RESERVED_SOURCES.has(plugin.source)) return plugin.name;
  return `${plugin.name}@${plugin.source}`;
}

/**
 * Lookup helper that tries the canonical id first, then falls back to the bare
 * plugin name. Lets users key marketplace plugins either way in settings.
 */
function lookupPluginConfig(
  plugin: LoadedPlugin,
  configs: PluginConfigsRoot | undefined,
): PluginConfigsRoot[string] | undefined {
  if (!configs) return undefined;
  const canonical = getPluginConfigKey(plugin);
  return configs[canonical] ?? configs[plugin.name];
}

/**
 * Flatten a user-config dictionary by joining array values into space-separated
 * strings, producing a shape accepted by `substituteUserConfigVariables`.
 */
function flattenUserConfig(
  userConfig: Record<string, string | number | boolean | string[]>,
): Record<string, string | number | boolean> {
  const flat: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(userConfig)) {
    flat[k] = Array.isArray(v) ? v.join(' ') : v;
  }
  return flat;
}

/**
 * Substitute `${user_config.<key>}` placeholders in a string using the supplied
 * pre-flattened config dictionary. Returns the original value if there are no
 * substitutions or no matching keys.
 */
function substituteIfNeeded(
  value: unknown,
  flat: Record<string, string | number | boolean>,
): unknown {
  if (typeof value !== 'string') return value;
  if (!value.includes('${user_config.')) return value;
  try {
    return substituteUserConfigVariables(value, flat);
  } catch {
    // Missing keys: leave the original string so we don't crash the loader.
    return value;
  }
}

/**
 * Apply a string-transform to every substitutable field of an MCP server config
 * (`command`, `args`, `env` values, `url`, `httpUrl`, `headers` values),
 * mutating in place. Shared by user_config and plugin-path substitution so the
 * field list lives in one spot.
 */
function applyToMcpServerStringFields(
  cfg: MCPServerConfigFields,
  sub: (value: string) => string,
  additionalStringFields: readonly string[],
): void {
  if (typeof cfg.command === 'string') cfg.command = sub(cfg.command);
  if (Array.isArray(cfg.args)) {
    cfg.args = cfg.args.map((a) => (typeof a === 'string' ? sub(a) : a));
  }
  if (cfg.env && typeof cfg.env === 'object') {
    for (const [k, v] of Object.entries(cfg.env)) {
      if (typeof v === 'string') cfg.env[k] = sub(v);
    }
  }
  if (typeof cfg.url === 'string') cfg.url = sub(cfg.url);
  if (typeof cfg.httpUrl === 'string') cfg.httpUrl = sub(cfg.httpUrl);
  const extended = cfg as Record<string, unknown>;
  for (const field of additionalStringFields) {
    if (typeof extended[field] === 'string') {
      extended[field] = sub(extended[field]);
    }
  }
  if (cfg.headers && typeof cfg.headers === 'object') {
    for (const [k, v] of Object.entries(cfg.headers)) {
      if (typeof v === 'string') cfg.headers[k] = sub(v);
    }
  }
}

/**
 * Apply `pluginConfigs.<pid>.mcpServers.<server>` values into the plugin's
 * resolved MCP server configs, substituting `${user_config.<key>}` placeholders
 * in `command`, `args`, `env` values, `url`, `httpUrl`, and `headers`.
 *
 * Mutates `plugin.mcpServers` in place. `plugin.mcpServers` entries are plain
 * objects at this stage (resolveManifestMcpServers returns parsed JSON), so
 * mutation is safe — they're not yet class instances.
 *
 * No-op if the plugin has no MCP servers or no matching pluginConfigs entry.
 */
export function applyPluginConfigsToMcpServers(
  plugin: LoadedPlugin,
  pluginConfigs: PluginConfigsRoot | undefined,
  additionalStringFields: readonly string[] = [],
): void {
  if (!plugin.mcpServers || Object.keys(plugin.mcpServers).length === 0) return;
  const entry = lookupPluginConfig(plugin, pluginConfigs);
  if (!entry?.mcpServers) return;

  for (const [serverName, serverConfig] of Object.entries(plugin.mcpServers)) {
    const userConfig = entry.mcpServers[serverName];
    if (!userConfig) continue;

    // Build the flattened config once per server, avoiding repeated work inside
    // substituteIfNeeded for each field/element.
    const flat = flattenUserConfig(userConfig);
    applyToMcpServerStringFields(
      serverConfig as MCPServerConfigFields,
      (v) => substituteIfNeeded(v, flat) as string,
      additionalStringFields,
    );
  }
}

/**
 * Substitute branded plugin root/data variables (and `${CLAUDE_*}`
 * aliases) in a plugin's MCP server configs. Runs unconditionally for every
 * plugin MCP server — independent of `settings.pluginConfigs` — so a plugin
 * that only references plugin paths (no `${user_config.*}`) still gets resolved.
 */
export function applyPluginVariablesToMcpServers(
  plugin: LoadedPlugin,
  additionalStringFields: readonly string[] = [],
): void {
  if (!plugin.mcpServers || Object.keys(plugin.mcpServers).length === 0) return;

  const ctx = { path: plugin.path, pluginId: getLoadedPluginId(plugin) };
  for (const serverConfig of Object.values(plugin.mcpServers)) {
    applyToMcpServerStringFields(
      serverConfig as MCPServerConfigFields,
      (v) => substitutePluginVariables(v, ctx),
      additionalStringFields,
    );
  }
}

/**
 * Convenience wrapper: apply substitution to every plugin in the list.
 *
 * Branded plugin path variables are substituted
 * unconditionally; `${user_config.*}` substitution only runs when the user has
 * configured `pluginConfigs`.
 */
export function applyPluginConfigsToPlugins(
  plugins: LoadedPlugin[],
  pluginConfigs: PluginConfigsRoot | undefined,
  additionalStringFields: readonly string[] = [],
): void {
  for (const plugin of plugins) {
    applyPluginVariablesToMcpServers(plugin, additionalStringFields);
  }
  if (!pluginConfigs) return;
  for (const plugin of plugins) {
    applyPluginConfigsToMcpServers(plugin, pluginConfigs, additionalStringFields);
  }
}
