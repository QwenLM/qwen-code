/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpPluginOwner } from '../../mcp/mcpServerConfig.js';
import type { LoadedPlugin } from '../types.js';
import { getLoadedPluginId } from './pluginDependencies.js';

/**
 * The plugin as its MCP servers are registered (see `pluginMcpRegistrations`).
 * A projection, not the loader model: the MCP registration only needs this
 * stable identity and the servers the plugin declares.
 */
export function toMcpPluginOwner(plugin: LoadedPlugin): McpPluginOwner {
  return {
    name: plugin.name,
    path: plugin.path,
    mcpServers: plugin.mcpServers,
    id: getLoadedPluginId(plugin),
  };
}
