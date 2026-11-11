/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getPluginDataDir } from '../pluginDirectories.js';
import { ENV_PLUGIN_ROOT, ENV_PLUGIN_DATA } from '../../config/brand.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PluginOptionValues = Record<string, string | number | boolean>;

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

const RE_USER_CONFIG = /\$\{user_config\.([^}]+)\}/g;

/**
 * Substitute the branded plugin root/data variables (and the
 * `${CLAUDE_*}` aliases, for compatibility with upstream plugins) with their
 * paths. On Windows, normalizes backslashes to forward slashes so shell
 * commands don't interpret them as escape characters.
 *
 * `pluginId` is the canonical plugin id (`getLoadedPluginId`) used to resolve
 * the data dir. It is optional: when absent (e.g. a hook whose root is a skill
 * directory without a plugin context), the `${*_PLUGIN_DATA}` placeholder is
 * left literal and no data dir is created (lazy — `getPluginDataDir` is only
 * called when the placeholder actually appears AND an id is provided).
 *
 * When `sessionId` is provided, also substitutes `${CLAUDE_SESSION_ID}` (the
 * plugin-only alias for the branded session placeholder, which
 * is handled by the generic skill-body substitution path). Keeping the alias
 * scoped here avoids leaking CC-flavoured names into non-plugin skill bodies.
 *
 * Replacements use the function-replacement form of .replace() so
 * `$`-patterns in paths aren't interpreted.
 */
export function substitutePluginVariables(
  value: string,
  plugin: { path: string; pluginId?: string; sessionId?: string },
): string {
  const normalize = (p: string) =>
    process.platform === 'win32' ? p.replace(/\\/g, '/') : p;

  return value.replace(/\$\{([^{}]+)\}/g, (match, name: string) => {
    if (name === ENV_PLUGIN_ROOT || name === 'CLAUDE_PLUGIN_ROOT') {
      return normalize(plugin.path);
    }
    if (
      (name === ENV_PLUGIN_DATA || name === 'CLAUDE_PLUGIN_DATA') &&
      plugin.pluginId
    ) {
      return normalize(getPluginDataDir(plugin.pluginId));
    }
    if (name === 'CLAUDE_SESSION_ID' && plugin.sessionId) {
      return plugin.sessionId;
    }
    return match;
  });
}

/**
 * Substitute ${user_config.KEY} with values from `settings.pluginConfigs`.
 *
 * Throws on missing keys. The one caller (`pluginConfigSubstitution`) catches
 * and leaves the placeholder literal, so a miss means the plugin references a
 * key the user never configured.
 */
export function substituteUserConfigVariables(
  value: string,
  userConfig: PluginOptionValues,
): string {
  return value.replace(RE_USER_CONFIG, (_match, key) => {
    const configValue = userConfig[key as string];
    if (configValue === undefined) {
      throw new Error(
        `Missing required user configuration value: ${key}. ` +
          `This should have been validated before variable substitution.`,
      );
    }
    return String(configValue);
  });
}
