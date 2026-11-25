/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  pluginMcpRegistrations,
  type LoadedPlugin,
} from '@qwen-code/core';
import type { LoadedSettings } from '../config/settings.js';
import {
  collectDaemonUserMcpRegistrations,
  collectUserMcpRegistrations,
  collectUserPluginMcpRegistrations,
  userMcpServerKey,
} from './framework.js';

const pluginLoad = vi.hoisted(() => ({
  plugins: [] as unknown[],
  error: undefined as Error | undefined,
}));
vi.mock('../services/plugins/pluginManager.js', () => ({
  createCorePluginManager: () => ({
    loadUserPlugins: async () => {
      if (pluginLoad.error) throw pluginLoad.error;
      return { plugins: pluginLoad.plugins, errors: [] };
    },
  }),
}));

function userSettings(
  mcpServers: Record<string, unknown> = {},
  pluginConfigs?: Record<string, unknown>,
): LoadedSettings {
  return {
    user: { settings: { mcpServers } },
    merged: { mcpServers, ...(pluginConfigs ? { pluginConfigs } : {}) },
  } as unknown as LoadedSettings;
}

function plugin(
  name: string,
  mcpServers: Record<string, unknown> | undefined,
  enabled = true,
): LoadedPlugin {
  return {
    name,
    path: `/plugins/${name}`,
    source: 'market',
    repository: 'market',
    enabled,
    manifest: { name },
    ...(mcpServers ? { mcpServers } : {}),
  } as unknown as LoadedPlugin;
}

describe('collectUserMcpRegistrations', () => {
  it('keeps enabled user servers warm and skips disabled ones', () => {
    const settings = {
      user: {
        settings: {
          mcpServers: {
            github: { url: 'https://example.com/github' },
            off: { command: 'node', disabled: true },
            explicit: { command: 'node', disabled: false },
          },
        },
      },
    } as unknown as LoadedSettings;

    const registrations = collectUserMcpRegistrations(settings);

    expect(registrations.map((r) => r.key)).toEqual([
      userMcpServerKey('github'),
      userMcpServerKey('explicit'),
    ]);
    expect(registrations.map((r) => r.key.name)).toEqual([
      'github',
      'explicit',
    ]);
  });
});

describe('collectUserPluginMcpRegistrations', () => {
  it('registers enabled user plugins the way a session starts them', async () => {
    pluginLoad.error = undefined;
    pluginLoad.plugins = [
      plugin('linear', { linear: { url: 'https://mcp.linear.app/mcp' } }),
      plugin('off', { off: { command: 'node' } }, false),
      plugin('skills-only', undefined),
    ];

    const registrations = await collectUserPluginMcpRegistrations(userSettings());

    expect(registrations).toEqual([
      {
        key: {
          source: expect.stringMatching(/^plugin:linear@market~[0-9a-f]{8}$/),
          name: 'linear',
        },
        config: {
          url: 'https://mcp.linear.app/mcp',
          plugin: { name: 'linear', path: '/plugins/linear', id: 'linear@market' },
        },
        rootsDir: '/plugins/linear',
      },
    ]);
    // The same key a session registers for this plugin.
    expect(registrations[0].key).toEqual(
      pluginMcpRegistrations(
        {
          id: 'linear@market',
          name: 'linear',
          path: '/plugins/linear',
          mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } },
        },
        '/elsewhere',
      )[0].key,
    );
  });
});

describe('collectDaemonUserMcpRegistrations', () => {
  it('combines user settings servers with user plugin servers', async () => {
    pluginLoad.error = undefined;
    pluginLoad.plugins = [plugin('linear', { linear: { url: 'https://x' } })];

    const registrations = await collectDaemonUserMcpRegistrations(
      userSettings({ github: { url: 'https://github' } }),
    );

    expect(registrations?.map((r) => r.key)).toEqual([
      userMcpServerKey('github'),
      {
        source: expect.stringMatching(/^plugin:linear@market~/),
        name: 'linear',
      },
    ]);
  });

  it('is undefined when plugins cannot be loaded, so a sync can be skipped', async () => {
    pluginLoad.error = new Error('installed_plugins.json is corrupt');

    await expect(
      collectDaemonUserMcpRegistrations(userSettings({ github: { url: 'x' } })),
    ).resolves.toBeUndefined();
  });
});
