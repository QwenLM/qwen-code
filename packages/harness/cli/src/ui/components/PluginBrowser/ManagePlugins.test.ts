/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import type { Config, LoadedPlugin } from '@qwen-code/core';
import {
  MCPServerStatus,
  loadInstalledPluginsFromDisk,
  makeFakeConfig,
} from '@qwen-code/core';
import { ManagePlugins } from './ManagePlugins.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/settings.js';
import type { Key } from '../../contexts/KeypressContext.js';

const mockSetPluginEnabledForCommand = vi.hoisted(() => vi.fn());
const mockUninstallPluginForCommand = vi.hoisted(() => vi.fn());
const SPACE_KEY: Key = {
  name: 'space',
  sequence: ' ',
  insertable: true,
  shift: false,
  alt: false,
  ctrl: false,
  cmd: false,
};

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    loadInstalledPluginsFromDisk: vi.fn(() => ({
      version: 2,
      plugins: {},
    })),
  };
});

vi.mock('@qwen-code/core/plugin-management', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@qwen-code/core/plugin-management')
  >();
  return {
    ...actual,
    resolveScopeForPlugin: vi.fn(() => 'user'),
    setPluginEnabledForCommand: mockSetPluginEnabledForCommand,
    uninstallPluginForCommand: mockUninstallPluginForCommand,
  };
});

function createRuntimePlugin(
  name: string,
  source: string,
): LoadedPlugin {
  return {
    name,
    source,
    repository: source,
    path: `/plugins/${name}`,
    enabled: true,
    manifest: {
      name,
      version: '1.0.0',
    },
  } as LoadedPlugin;
}

function createMultiScopeInstalledState(
  projectPath: string,
): ReturnType<typeof loadInstalledPluginsFromDisk> {
  return {
    version: 2,
    plugins: {
      'demo@market': [
        {
          scope: 'local',
          installPath: '/plugins/demo',
          projectPath: '/session/other',
        },
        {
          scope: 'project',
          installPath: '/plugins/demo',
          projectPath: '/session/other',
        },
        { scope: 'user', installPath: '/plugins/demo' },
        { scope: 'project', installPath: '/plugins/demo', projectPath },
      ],
    },
  };
}

describe('ManagePlugins', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mockSetPluginEnabledForCommand.mockReset();
    mockSetPluginEnabledForCommand.mockResolvedValue('updated');
    mockUninstallPluginForCommand.mockReset();
  });

  it.each([true, false])(
    'toggles a builtin from the installed list (currently enabled=%s)',
    async (enabled) => {
      const settings = createMockSettings();
      const config = makeFakeConfig();
      const plugin = {
        ...createRuntimePlugin('demo-builtin', 'builtin'),
        isBuiltin: true,
        enabled,
      };
      vi.spyOn(config, 'getPlugins').mockReturnValue([plugin]);
      vi.spyOn(config, 'getPluginErrors').mockReturnValue([]);
      vi.mocked(loadInstalledPluginsFromDisk).mockReturnValue({
        version: 2,
        plugins: {},
      });
      const { capturedRegistry, waitUntilReady, lastFrame, unmount } =
        await renderWithProviders(
          createElement(ManagePlugins, { config, settings, onClose: vi.fn() }),
          { config, settings },
        );
      await waitUntilReady();
      act(() => {
        capturedRegistry?.invokeFallback('Dialog', SPACE_KEY);
      });
      await vi.waitFor(() =>
        expect(mockSetPluginEnabledForCommand).toHaveBeenCalledWith({
          plugin: 'demo-builtin@builtin',
          enabled: !enabled,
          scope: 'user',
          settings,
          config,
        }),
      );
      await waitUntilReady();
      expect(lastFrame()).not.toContain('Run /plugins reload');
      unmount();
    },
  );

  it.each([
    [MCPServerStatus.DISCONNECTED, 'failed'],
    [MCPServerStatus.CONNECTED, 'connected'],
  ])(
    'shows the live MCP connection state for an enabled plugin (status=%s)',
    async (connectionStatus, expectedLabel) => {
      const settings = createMockSettings({
        merged: { enabledPlugins: { 'presentation@local': true } },
      });
      const config = makeFakeConfig();
      const plugin = createRuntimePlugin('presentation', 'local');
      plugin.mcpServers = { office: { command: 'node', args: ['office.js'] } };
      vi.spyOn(config, 'getPlugins').mockReturnValue([plugin]);
      vi.spyOn(config, 'getPluginErrors').mockReturnValue([]);
      vi.mocked(loadInstalledPluginsFromDisk).mockReturnValue({
        version: 2,
        plugins: {
          'presentation@local': [
            { scope: 'user', installPath: '/plugins/presentation' },
          ],
        },
      });
      vi.spyOn(config, 'getMcpClientManager').mockReturnValue({
        getMcpServers: () => ({ office: { command: 'node' } }),
        getServerStatus: () => connectionStatus,
        getMcpServerConfigurationError: () => undefined,
        isMcpServerBlockedByHostPolicy: () => false,
      } as never);

      const { lastFrame, waitUntilReady, unmount } =
        await renderWithProviders(
          createElement(ManagePlugins, { config, settings, onClose: vi.fn() }),
          { config, settings },
        );
      await waitUntilReady();

      const frame = lastFrame();
      expect(frame).toContain('office');
      expect(frame).toContain(expectedLabel);
      if (expectedLabel === 'failed') {
        expect(frame).not.toContain('connected');
      }
      unmount();
    },
  );

  it('keeps local installation scope anchored to the original project', async () => {
    const settings = createMockSettings({
      merged: { enabledPlugins: { 'demo@market': true } },
    });
    const config = makeFakeConfig();
    vi.spyOn(config, 'getWorkingDir').mockReturnValue('/session/worktree');
    vi.spyOn(config, 'getSessionArtifactProjectRoot').mockReturnValue(
      '/session/original',
    );
    vi.spyOn(config, 'getPlugins').mockReturnValue([
      createRuntimePlugin('demo', 'market'),
    ]);
    vi.spyOn(config, 'getPluginErrors').mockReturnValue([]);
    vi.mocked(loadInstalledPluginsFromDisk).mockReturnValue({
      version: 2,
      plugins: {
        'demo@market': [
          {
            scope: 'local',
            installPath: '/plugins/demo',
            projectPath: '/session/original',
          },
        ],
      },
    });

    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      createElement(ManagePlugins, {
        config: config as Config,
        settings,
        onClose: vi.fn(),
      }),
      { config, settings },
    );
    await waitUntilReady();

    expect(lastFrame()).toContain('Local');
    expect(lastFrame()).not.toContain('Removing');
    unmount();
  });

  it.each([
    ['enable', true, 'local'],
    ['disable', false, 'local'],
    ['enable', true, 'project'],
    ['disable', false, 'project'],
  ] as const)(
    'routes automatic %s (enabled=%s) through the %s installation scope',
    async (targetAction, enabled, scope) => {
      const settings = createMockSettings({
        merged: { enabledPlugins: { 'demo@market': false } },
      });
      const config = makeFakeConfig();
      let resolveToggle!: (value: string) => void;
      mockSetPluginEnabledForCommand.mockReturnValue(
        new Promise<string>((resolve) => {
          resolveToggle = resolve;
        }),
      );
      vi.spyOn(config, 'getPlugins').mockReturnValue([
        createRuntimePlugin('demo', 'market'),
      ]);
      vi.spyOn(config, 'getPluginErrors').mockReturnValue([]);
      vi.mocked(loadInstalledPluginsFromDisk).mockReturnValue(
        scope === 'project'
          ? createMultiScopeInstalledState(
              config.getSessionArtifactProjectRoot(),
            )
          : {
              version: 2,
              plugins: {
                'demo@market': [
                  {
                    scope: 'local',
                    installPath: '/plugins/demo',
                    projectPath: config.getWorkingDir(),
                  },
                ],
              },
            },
      );
      const onPluginsChanged = vi.fn();

      const { waitUntilReady, unmount } = await renderWithProviders(
        createElement(ManagePlugins, {
          config: config as Config,
          settings,
          onClose: vi.fn(),
          onPluginsChanged,
          targetPlugin: 'demo',
          targetAction,
        }),
        { config, settings },
      );
      await waitUntilReady();

      await vi.waitFor(() => {
        expect(mockSetPluginEnabledForCommand).toHaveBeenCalledWith({
          plugin: 'demo@market',
          enabled,
          settings,
          config,
          scope,
        });
      });
      await act(async () => {
        resolveToggle('updated');
      });
      await waitUntilReady();
      await vi.waitFor(() => {
        expect(onPluginsChanged).toHaveBeenCalledOnce();
      });
      unmount();
    },
  );

  it('uses the selected installation scope when toggling interactively', async () => {
    const settings = createMockSettings({
      merged: { enabledPlugins: { 'demo@market': false } },
    });
    const config = makeFakeConfig();
    let resolveToggle!: (value: string) => void;
    mockSetPluginEnabledForCommand.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveToggle = resolve;
      }),
    );
    vi.mocked(loadInstalledPluginsFromDisk).mockReturnValue({
      version: 2,
      plugins: {
        'demo@market': [
          {
            scope: 'local',
            installPath: '/plugins/demo',
            projectPath: config.getWorkingDir(),
          },
        ],
      },
    });
    vi.spyOn(config, 'getPlugins').mockReturnValue([
      createRuntimePlugin('demo', 'market'),
    ]);
    vi.spyOn(config, 'getPluginErrors').mockReturnValue([]);

    const { capturedRegistry, waitUntilReady, unmount } =
      await renderWithProviders(
        createElement(ManagePlugins, {
          config: config as Config,
          settings,
          onClose: vi.fn(),
        }),
        { config, settings },
      );
    await waitUntilReady();

    act(() => {
      capturedRegistry?.invokeFallback('Dialog', SPACE_KEY);
    });

    await vi.waitFor(() => {
      expect(mockSetPluginEnabledForCommand).toHaveBeenCalledWith({
        plugin: 'demo@market',
        enabled: true,
        settings,
          config,
        scope: 'local',
      });
    });
    await act(async () => {
      resolveToggle('updated');
    });
    await waitUntilReady();
    unmount();
  });

  it.each([true, false])(
    'shows the current-project row first and keeps the user installation shadowed (enabled=%s)',
    async (enabled) => {
      const settings = createMockSettings({
        merged: { enabledPlugins: { 'demo@market': enabled } },
      });
      const config = makeFakeConfig();
      vi.spyOn(config, 'getWorkingDir').mockReturnValue('/session/worktree');
      vi.spyOn(config, 'getSessionArtifactProjectRoot').mockReturnValue(
        '/session/original',
      );
      vi.spyOn(config, 'getPlugins').mockReturnValue([
        { ...createRuntimePlugin('demo', 'market'), enabled },
      ]);
      vi.spyOn(config, 'getPluginErrors').mockReturnValue([]);
      vi.mocked(loadInstalledPluginsFromDisk).mockReturnValue(
        createMultiScopeInstalledState('/session/original'),
      );
      mockUninstallPluginForCommand.mockResolvedValue({
        message: 'Plugin "demo@market" removed from scope "project".',
        runtimeReloadRequired: true,
        pluginId: 'demo@market',
        fullyRemoved: false,
        reverseDependents: [],
      });

      const { capturedRegistry, lastFrame, waitUntilReady, unmount } =
        await renderWithProviders(
          createElement(ManagePlugins, { config, settings, onClose: vi.fn() }),
          { config, settings },
        );
      await waitUntilReady();
      expect(lastFrame()?.match(/\bdemo\b/g)).toHaveLength(2);
      expect(lastFrame()).toContain('Project');
      expect(lastFrame()).toContain('User');
      expect(lastFrame()).toContain('shadowed');
      expect(lastFrame()).not.toContain('Removing');

      await act(async () => {
        capturedRegistry?.invokeFallback('Dialog', SPACE_KEY);
      });
      await vi.waitFor(() => {
        expect(mockSetPluginEnabledForCommand).toHaveBeenCalledWith({
          plugin: 'demo@market',
          enabled: !enabled,
          settings,
          config,
          scope: 'project',
        });
      });

      const enterKey: Key = {
        ...SPACE_KEY,
        name: 'return',
        sequence: '\r',
        insertable: false,
      };
      act(() => {
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', enterKey);
      });
      await waitUntilReady();
      expect(lastFrame()).toMatch(/Scope\s+Project/);

      // Status, Version, Scope, Source, Path, then Uninstall for this fixture.
      act(() => {
        for (let i = 0; i < 5; i++) {
          capturedRegistry?.invokeAction('Dialog', 'dialog:navigate:down', {
            ...enterKey,
            name: 'down',
            sequence: '\u001b[B',
          });
        }
      });
      await waitUntilReady();
      act(() => {
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', enterKey);
      });
      await waitUntilReady();
      expect(lastFrame()).toContain('Are you sure you want to uninstall');
      act(() => {
        capturedRegistry?.invokeFallback('Dialog', {
          ...SPACE_KEY,
          name: 'y',
          sequence: 'y',
        });
      });
      await waitUntilReady();
      expect(lastFrame()).toContain('Delete Plugin Data?');
      await act(async () => {
        capturedRegistry?.invokeFallback('Dialog', {
          ...SPACE_KEY,
          name: 'n',
          sequence: 'n',
        });
      });
      await vi.waitFor(() => {
        expect(mockUninstallPluginForCommand).toHaveBeenCalledWith({
          plugin: 'demo@market',
          scope: 'project',
          settings,
          config,
          keepData: true,
        });
      });
      await waitUntilReady();
      unmount();
    },
  );

  it('shows the service error without reporting a plugin change', async () => {
    const settings = createMockSettings();
    const config = makeFakeConfig();
    let rejectToggle!: (reason: Error) => void;
    mockSetPluginEnabledForCommand.mockReturnValue(
      new Promise<string>((_resolve, reject) => {
        rejectToggle = reject;
      }),
    );
    vi.spyOn(config, 'getPlugins').mockReturnValue([
      createRuntimePlugin('demo', 'market'),
    ]);
    vi.spyOn(config, 'getPluginErrors').mockReturnValue([]);
    const onPluginsChanged = vi.fn();

    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      createElement(ManagePlugins, {
        config: config as Config,
        settings,
        onClose: vi.fn(),
        onPluginsChanged,
        targetPlugin: 'demo',
        targetAction: 'enable',
      }),
      { config, settings },
    );
    await waitUntilReady();
    await vi.waitFor(() => {
      expect(mockSetPluginEnabledForCommand).toHaveBeenCalledOnce();
    });

    await act(async () => {
      rejectToggle(new Error('toggle failed'));
    });
    await waitUntilReady();

    expect(lastFrame()).toContain('✗ toggle failed');
    expect(onPluginsChanged).not.toHaveBeenCalled();
    unmount();
  });

  it('ignores repeated toggles while the same plugin update is in flight', async () => {
    const settings = createMockSettings({
      merged: { enabledPlugins: { 'demo@market': true } },
    });
    const config = makeFakeConfig();
    let resolveToggle!: (value: string) => void;
    const pendingToggle = new Promise<string>((resolve) => {
      resolveToggle = resolve;
    });
    mockSetPluginEnabledForCommand.mockReturnValue(pendingToggle);
    vi.mocked(loadInstalledPluginsFromDisk).mockReturnValue({
      version: 2,
      plugins: {
        'demo@market': [
          { scope: 'user', installPath: '/plugins/demo' },
        ],
      },
    });
    vi.spyOn(config, 'getPlugins').mockReturnValue([
      createRuntimePlugin('demo', 'market'),
    ]);
    vi.spyOn(config, 'getPluginErrors').mockReturnValue([]);

    const { capturedRegistry, waitUntilReady, unmount } =
      await renderWithProviders(
        createElement(ManagePlugins, {
          config: config as Config,
          settings,
          onClose: vi.fn(),
        }),
        { config, settings },
      );
    await waitUntilReady();

    act(() => {
      capturedRegistry?.invokeFallback('Dialog', SPACE_KEY);
      capturedRegistry?.invokeFallback('Dialog', SPACE_KEY);
    });
    expect(mockSetPluginEnabledForCommand).toHaveBeenCalledOnce();

    await act(async () => {
      resolveToggle('updated');
    });
    await waitUntilReady();
    await act(async () => {
      capturedRegistry?.invokeFallback('Dialog', SPACE_KEY);
      await pendingToggle;
    });
    await vi.waitFor(() => {
      expect(mockSetPluginEnabledForCommand).toHaveBeenCalledTimes(2);
    });
    unmount();
  });
});
