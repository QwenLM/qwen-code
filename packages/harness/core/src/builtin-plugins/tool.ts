/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyDeclarativeTool } from '../tools/tools.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { runLogger } from '../utils/runLogger.js';
import type { BuiltinPluginContributions } from './registry.js';

/**
 * Plugin tools take precedence over host tools of the same name: the product
 * build replaces the open implementation outright, with no fallback.
 *
 * A contribution with an unusable name, or a name another contribution already
 * claimed, is skipped with a warning rather than failing the whole batch.
 */
export function syncBuiltinPluginTools(
  registry: ToolRegistry,
  owned: Set<string>,
  contributions?: BuiltinPluginContributions,
): void {
  const tools = contributions?.isReady() ? contributions.getTools() : [];
  // Previously registered tools must still be removed when contributions empty.
  if (tools.length === 0 && owned.size === 0) return;
  const accepted: AnyDeclarativeTool[] = [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(tool.name)) {
      runLogger.warn('[builtin-plugins] Skipping tool with an invalid name', {
        name: tool.name,
      });
      continue;
    }
    if (names.has(tool.name)) {
      runLogger.warn('[builtin-plugins] Skipping duplicate plugin tool', {
        name: tool.name,
      });
      continue;
    }
    names.add(tool.name);
    accepted.push(tool);
  }
  for (const name of owned) {
    if (!names.has(name)) registry.unregisterTool(name);
  }
  owned.clear();
  for (const tool of accepted) {
    // Re-registering a tool the layer already owns only makes the registry log
    // a misleading "already registered" warning, so leave it in place.
    if (registry.getKnownTool(tool.name) !== tool) {
      registry.registerTool(tool);
    }
    owned.add(tool.name);
  }
}
