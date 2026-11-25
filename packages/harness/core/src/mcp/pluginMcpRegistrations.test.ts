/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { McpPluginOwner } from './mcpServerConfig.js';
import { pluginMcpRegistrations } from './pluginMcpRegistrations.js';

const owner = (overrides: Partial<McpPluginOwner> = {}): McpPluginOwner => ({
  id: 'linear@market',
  name: 'linear',
  path: '/plugins/linear',
  mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', headers: { a: '1', b: '2' } } },
  ...overrides,
});

const keyOf = (o: McpPluginOwner, rootsDir = '/fallback') =>
  pluginMcpRegistrations(o, rootsDir)[0].key;

describe('pluginMcpRegistrations', () => {
  it('stamps the plugin onto each server and roots it at the plugin directory', () => {
    expect(pluginMcpRegistrations(owner(), '/fallback')).toEqual([
      {
        key: {
          source: expect.stringMatching(/^plugin:linear@market~[0-9a-f]{8}$/),
          name: 'linear',
        },
        config: {
          url: 'https://mcp.linear.app/mcp',
          headers: { a: '1', b: '2' },
          plugin: { name: 'linear', path: '/plugins/linear', id: 'linear@market' },
        },
        rootsDir: '/plugins/linear',
      },
    ]);
  });

  it('gives the same config the same key, whatever the property order', () => {
    const reordered = owner({
      mcpServers: { linear: { headers: { b: '2', a: '1' }, url: 'https://mcp.linear.app/mcp' } },
    });

    expect(keyOf(reordered)).toEqual(keyOf(owner()));
  });

  it('ignores the runtime-only scope, as the pool does', () => {
    const scoped = owner({
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp', headers: { a: '1', b: '2' }, scope: 'user' },
      },
    });

    expect(keyOf(scoped)).toEqual(keyOf(owner()));
  });

  it('resolves a relative cwd against the plugin directory', () => {
    const [absolute, relative] = pluginMcpRegistrations(
      owner({
        mcpServers: {
          absolute: { command: 'node', cwd: '/work' },
          relative: { command: 'node', cwd: 'work' },
        },
      }),
      '/fallback',
    );

    expect(absolute.config.cwd).toBe('/work');
    expect(relative.config.cwd).toBe('/plugins/linear/work');
  });

  it('gives another config or another directory its own key', () => {
    const base = keyOf(owner());

    expect(keyOf(owner({ path: '/repo/.qoder/plugins/linear' }))).not.toEqual(base);
    expect(
      keyOf(owner({ mcpServers: { linear: { url: 'https://other.example/mcp' } } })),
    ).not.toEqual(base);
  });

  it('roots a server at the default directory when the plugin has no path', () => {
    const [registration] = pluginMcpRegistrations(owner({ path: undefined as never }), '/cwd');

    expect(registration.rootsDir).toBe('/cwd');
  });

  it('is empty for a plugin without MCP servers', () => {
    expect(pluginMcpRegistrations(owner({ mcpServers: undefined }), '/cwd')).toEqual([]);
  });
});
