/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parsed plugin identifier with name and optional marketplace.
 */
export interface ParsedPluginIdentifier {
  name: string;
  marketplace?: string;
}

/**
 * Parse a plugin identifier string into name and marketplace components.
 *
 * Only the first '@' is used as separator. If the input contains multiple
 * '@' symbols (e.g., "plugin@market@place"), everything after the second
 * '@' is ignored. This is intentional as marketplace names should not
 * contain '@'.
 *
 * @param plugin The plugin identifier (name or name@marketplace)
 * @returns Parsed plugin name and optional marketplace
 */
export function parsePluginIdentifier(plugin: string): ParsedPluginIdentifier {
  if (plugin.includes('@')) {
    const parts = plugin.split('@');
    return { name: parts[0] || '', marketplace: parts[1] };
  }
  return { name: plugin };
}

/**
 * Build a plugin ID from name and marketplace.
 *
 * @param name The plugin name
 * @param marketplace Optional marketplace name
 * @returns Plugin ID in format "name" or "name@marketplace"
 */
export function buildPluginId(name: string, marketplace?: string): string {
  return marketplace ? `${name}@${marketplace}` : name;
}

/**
 * Sanitize a plugin ID for use in filesystem paths.
 * Replaces any character that isn't alphanumeric, dash, or underscore
 * with a dash.
 */
export function sanitizePluginId(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9\-_]/g, '-');
}
