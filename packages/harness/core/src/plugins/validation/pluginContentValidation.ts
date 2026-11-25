/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PLUGIN_CONVENTION_ENTRIES } from '../pluginLoader.js';
import type { LoadedPlugin } from '../types.js';

/** Return true when the loader found at least one installable plugin resource. */
export function hasInstallablePluginContent(plugin: LoadedPlugin): boolean {
  return !!(
    plugin.commandsPath ||
    plugin.agentsPath ||
    plugin.skillsPath ||
    plugin.outputStylesPath ||
    plugin.workflowsPath ||
    plugin.binPath ||
    plugin.hooksConfig ||
    plugin.mcpServers ||
    plugin.commandsPaths?.length ||
    plugin.agentsPaths?.length ||
    plugin.skillsPaths?.length ||
    plugin.outputStylesPaths?.length ||
    plugin.workflowsPaths?.length ||
    (plugin.commandsMetadata && Object.keys(plugin.commandsMetadata).length > 0)
  );
}

/**
 * Return the local-install validation error for a loaded plugin, if any.
 * Validation and installation share this policy so their readiness verdicts
 * cannot drift.
 */
export function getPluginContentValidationError(
  plugin: LoadedPlugin,
  pluginPath: string,
): string | undefined {
  if (hasInstallablePluginContent(plugin)) return undefined;
  return (
    `No plugin content found in "${pluginPath}". ` +
    `Expected at least one of: ${PLUGIN_CONVENTION_ENTRIES.map((entry) => entry.label).join(', ')}.`
  );
}
