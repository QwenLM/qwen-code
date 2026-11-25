/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { LoadedPlugin } from '../types.js';
import { getLoadedPluginId } from './pluginDependencies.js';
import { toMcpPluginOwner } from './pluginMcpOwner.js';

function plugin(overrides: Partial<LoadedPlugin> = {}): LoadedPlugin {
  return {
    name: 'demo',
    source: 'market',
    path: '/plugins/demo',
    mcpServers: { first: { url: 'https://mcp.example.com/mcp' } },
    ...overrides,
  } as LoadedPlugin;
}

describe('toMcpPluginOwner', () => {
  it('projects the loader identity and the declared servers', () => {
    const loaded = plugin();

    expect(toMcpPluginOwner(loaded)).toEqual({
      name: 'demo',
      path: '/plugins/demo',
      mcpServers: { first: { url: 'https://mcp.example.com/mcp' } },
      id: getLoadedPluginId(loaded),
    });
  });

  it('keeps a plugin without MCP servers valid for an owner', () => {
    const loaded = plugin({ mcpServers: undefined });

    expect(toMcpPluginOwner(loaded).mcpServers).toBeUndefined();
  });
});
