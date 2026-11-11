/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LoadedPlugin, PluginError } from '../types.js';
import type { InstalledPluginsState } from './installedPluginsManager.js';
import { buildPluginRuntimeItems } from './pluginRuntimeState.js';

function createRuntimePlugin(name: string, source: string): LoadedPlugin {
  return {
    name,
    source,
    repository: source,
    path: `/plugins/${name}`,
    enabled: true,
    manifest: { name, version: '1.0.0' },
  } as LoadedPlugin;
}

function createState(
  plugins: InstalledPluginsState['plugins'],
): InstalledPluginsState {
  return { version: 2, plugins };
}

function createManagedInstallation(orgId: string, userVisible = true) {
  return {
    scope: 'managed' as const,
    installPath: `/plugins/${orgId}`,
    orgId,
    userVisible,
    userCanDisable: userVisible,
  };
}

function build(
  overrides: Partial<Parameters<typeof buildPluginRuntimeItems>[0]> = {},
) {
  return buildPluginRuntimeItems({
    runtimePlugins: [],
    pluginErrors: [],
    enabledPlugins: {},
    installedState: createState({}),
    cwd: '/workspace/project',
    ...overrides,
  });
}

describe('buildPluginRuntimeItems', () => {
  const cwd = resolve('/workspace/当前项目 with spaces');
  const otherProject = resolve('/workspace/other');
  const pluginId = 'presentation@local';
  const installations: InstalledPluginsState['plugins'][string] = [
    { scope: 'user', installPath: '/plugins/presentation' },
    {
      scope: 'local',
      projectPath: otherProject,
      installPath: '/plugins/presentation',
    },
    {
      scope: 'project',
      projectPath: otherProject,
      installPath: '/plugins/presentation',
    },
    {
      scope: 'project',
      projectPath: cwd,
      installPath: '/plugins/presentation',
    },
  ];

  it.each(
    [
      installations,
      [...installations].reverse(),
      [
        installations[1]!,
        installations[2]!,
        installations[3]!,
        installations[0]!,
      ],
    ].map((entries) => [entries]),
  )(
    'shows the current project installation first and keeps other applicable scopes as shadowed rows regardless of record order',
    (entries) => {
      const items = build({
        cwd,
        runtimePlugins: [createRuntimePlugin('presentation', 'local')],
        enabledPlugins: { [pluginId]: true },
        installedState: createState({ [pluginId]: entries }),
      });

      expect(items).toEqual([
        expect.objectContaining({
          type: 'plugin',
          installScope: 'project',
          needsReload: false,
        }),
        expect.objectContaining({
          type: 'plugin',
          installScope: 'user',
          shadowed: true,
          shadowedBy: 'project',
        }),
      ]);
      expect(items[0]).not.toHaveProperty('pendingRemoval');
      expect(entries).toHaveLength(4);
    },
  );

  it('prefers local over project and user installations in the current project', () => {
    const items = build({
      cwd,
      runtimePlugins: [createRuntimePlugin('presentation', 'local')],
      enabledPlugins: { [pluginId]: true },
      installedState: createState({
        [pluginId]: [
          ...installations,
          { scope: 'local', projectPath: cwd, installPath: '/plugins/local' },
        ],
      }),
    });

    expect(items).toEqual([
      expect.objectContaining({ type: 'plugin', installScope: 'local' }),
      expect.objectContaining({
        type: 'plugin',
        installScope: 'project',
        shadowed: true,
        shadowedBy: 'local',
      }),
      expect.objectContaining({
        type: 'plugin',
        installScope: 'user',
        shadowed: true,
        shadowedBy: 'local',
      }),
    ]);
  });

  it('shows the selected pending installation first and keeps other applicable scopes as shadowed pending rows', () => {
    expect(
      build({
        cwd,
        enabledPlugins: { [pluginId]: false },
        installedState: createState({ [pluginId]: installations }),
      }),
    ).toEqual([
      expect.objectContaining({
        type: 'pending-plugin',
        scope: 'project',
        isEnabled: false,
        needsReload: true,
      }),
      expect.objectContaining({
        type: 'pending-plugin',
        scope: 'user',
        isEnabled: false,
        needsReload: true,
        shadowed: true,
        shadowedBy: 'project',
      }),
    ]);
  });

  it('falls back to user after removing project, then marks removal only without an applicable installation', () => {
    const runtimePlugins = [createRuntimePlugin('presentation', 'local')];
    const remaining = installations.filter(
      (entry) => entry.projectPath !== cwd,
    );
    const options = {
      cwd,
      runtimePlugins,
      enabledPlugins: { [pluginId]: true },
    };
    const items = build({
      ...options,
      installedState: createState({ [pluginId]: remaining }),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'plugin',
      installScope: 'user',
      needsReload: false,
    });
    expect(items[0]).not.toHaveProperty('pendingRemoval');

    const installedState = createState({
      [pluginId]: remaining.filter((entry) => entry.scope !== 'user'),
    });
    expect(build({ ...options, installedState })).toEqual([
      expect.objectContaining({
        type: 'plugin',
        pendingRemoval: true,
        needsReload: true,
      }),
    ]);
    expect(build({ ...options, installedState, runtimePlugins: [] })).toEqual(
      [],
    );
  });

  it.each([cwd, resolve(cwd, 'nested')])(
    'keeps project installations visible from %s',
    (currentDirectory) => {
      expect(
        build({
          cwd: currentDirectory,
          enabledPlugins: { [pluginId]: true },
          installedState: createState({ [pluginId]: [installations[3]!] }),
        }),
      ).toEqual([
        expect.objectContaining({ type: 'pending-plugin', scope: 'project' }),
      ]);
    },
  );

  it('does not match another project sharing a path prefix', () => {
    expect(
      build({
        cwd: `${cwd}-other`,
        enabledPlugins: { [pluginId]: true },
        installedState: createState({ [pluginId]: [installations[3]!] }),
      }),
    ).toEqual([]);
  });

  it('keeps one MCP row and an enabled-state reload marker under the selected scope', () => {
    const plugin = createRuntimePlugin('presentation', 'local');
    plugin.mcpServers = { office: { command: 'node', args: ['office.js'] } };
    const items = build({
      cwd,
      runtimePlugins: [plugin],
      enabledPlugins: { [pluginId]: false },
      installedState: createState({ [pluginId]: installations }),
    });
    expect(items).toEqual([
      expect.objectContaining({
        type: 'plugin',
        installScope: 'project',
        isEnabled: false,
        needsReload: true,
      }),
      expect.objectContaining({
        type: 'mcp-server',
        name: 'office',
        parentScope: 'project',
        status: 'disabled',
      }),
      expect.objectContaining({
        type: 'plugin',
        installScope: 'user',
        shadowed: true,
        shadowedBy: 'project',
      }),
    ]);
  });

  it('reports live MCP status instead of deriving it from the enabled flag', () => {
    const plugin = createRuntimePlugin('presentation', 'local');
    plugin.mcpServers = {
      office: { command: 'node', args: ['office.js'] },
      browser: { command: 'node', args: ['browser.js'] },
      sheets: { command: 'node', args: ['sheets.js'] },
    };
    const items = build({
      cwd,
      runtimePlugins: [plugin],
      enabledPlugins: { [pluginId]: true },
      installedState: createState({ [pluginId]: installations }),
      mcpServerStatuses: new Map([
        ['office', 'failed'],
        ['browser', 'connected'],
      ]),
    });
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'mcp-server', name: 'office', status: 'failed' }),
        expect.objectContaining({ type: 'mcp-server', name: 'browser', status: 'connected' }),
        expect.objectContaining({ type: 'mcp-server', name: 'sheets', status: 'pending' }),
      ]),
    );
  });

  it('keeps MCP servers disabled when their plugin is disabled', () => {
    const plugin = createRuntimePlugin('presentation', 'local');
    plugin.mcpServers = { office: { command: 'node', args: ['office.js'] } };
    const items = build({
      cwd,
      runtimePlugins: [plugin],
      enabledPlugins: { [pluginId]: false },
      installedState: createState({ [pluginId]: installations }),
      mcpServerStatuses: new Map([['office', 'connected']]),
    });
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'mcp-server', name: 'office', status: 'disabled' }),
      ]),
    );
  });

  it('keeps plugins with the same name from different marketplaces separate', () => {
    const items = build({
      cwd,
      runtimePlugins: [
        createRuntimePlugin('presentation', 'local'),
        createRuntimePlugin('presentation', 'market'),
      ],
      enabledPlugins: { [pluginId]: true, 'presentation@market': true },
      installedState: createState({
        [pluginId]: installations,
        'presentation@market': [
          { scope: 'user', installPath: '/plugins/market' },
        ],
      }),
    });
    expect(items).toHaveLength(3);
    expect(items).toEqual([
      expect.objectContaining({
        marketplace: 'local',
        installScope: 'project',
      }),
      expect.objectContaining({
        marketplace: 'local',
        installScope: 'user',
        shadowed: true,
        shadowedBy: 'project',
      }),
      expect.objectContaining({ marketplace: 'market', installScope: 'user' }),
    ]);
  });

  it('shows a built-in plugin without an installation record as active', () => {
    const plugin = createRuntimePlugin('demo-builtin', 'builtin');
    plugin.isBuiltin = true;

    expect(build({ runtimePlugins: [plugin] })).toEqual([
      expect.objectContaining({
        type: 'plugin',
        name: 'demo-builtin',
        installScope: 'builtin',
        isEnabled: true,
        pendingRemoval: false,
        needsReload: false,
      }),
    ]);
  });

  it('still marks an installed plugin removed from disk as pending removal', () => {
    expect(
      build({
        runtimePlugins: [createRuntimePlugin('regular', 'marketplace')],
      }),
    ).toEqual([
      expect.objectContaining({
        type: 'plugin',
        pendingRemoval: true,
        needsReload: true,
      }),
    ]);
  });

  it('does not require installation records for flag-loaded plugins', () => {
    expect(
      build({ runtimePlugins: [createRuntimePlugin('local-plugin', 'flag')] }),
    ).toEqual([
      expect.objectContaining({
        type: 'plugin',
        installScope: 'flag',
        pendingRemoval: false,
        needsReload: false,
      }),
    ]);
  });

  it('hides disk-only plugins selected by the supplied product exclusion', () => {
    const items = build({
      isPluginExcluded: (id) => id === 'host-scan@host-market',
      enabledPlugins: {
        'ordinary@host-market': true,
        'host-scan@host-market': true,
        'regular@openai': true,
      },
      installedState: createState({
        'ordinary@host-market': [
          { scope: 'user', installPath: '/plugins/ordinary' },
        ],
        'host-scan@host-market': [
          { scope: 'user', installPath: '/plugins/host-scan' },
        ],
        'regular@openai': [{ scope: 'user', installPath: '/plugins/regular' }],
      }),
    });

    expect(items.map((item) => item.name)).toEqual(['ordinary', 'regular']);
    expect(items[0]?.type).toBe('pending-plugin');
  });

  it('hides runtime-only plugins selected by the supplied product exclusion', () => {
    const items = build({
      isPluginExcluded: (id) => id === 'host-context@host-market',
      runtimePlugins: [
        createRuntimePlugin('host-context', 'host-market'),
        createRuntimePlugin('regular', 'openai'),
      ],
    });

    expect(items.map((item) => item.name)).toEqual(['regular']);
  });

  it('renders only externally managed plugins explicitly supplied by the product', () => {
    const organizationId = 'test-org';
    const marketplace = `external-${organizationId}`;
    const items = build({
      additionalPluginStates: new Map([[`visible@${marketplace}`, { enabled: true, canToggle: true }]]),
      installedState: createState({
        [`visible@${marketplace}`]: [
          createManagedInstallation(organizationId),
        ],
        [`hidden@${marketplace}`]: [
          createManagedInstallation(organizationId, false),
        ],
      }),
      runtimePlugins: [
        createRuntimePlugin('visible', marketplace),
        createRuntimePlugin('hidden', marketplace),
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'plugin',
      name: 'visible',
      installScope: 'managed',
    });
    expect(items[0]).not.toHaveProperty('pendingRemoval');
  });

  it('hides externally managed installations without product state', () => {
    const marketplace = 'external-other-org';
    const items = build({
      installedState: createState({
        [`foreign@${marketplace}`]: [
          createManagedInstallation('other-org'),
        ],
      }),
      runtimePlugins: [createRuntimePlugin('foreign', marketplace)],
    });

    expect(items).toEqual([]);
  });

  it.each(['user', 'project', 'local'] as const)(
    'keeps the ordinary %s installation visible alongside a managed record',
    (scope) => {
      const id = 'mixed@external-other-org';
      const items = build({
        cwd,
        enabledPlugins: { [id]: true },
        installedState: createState({
          [id]: [
            createManagedInstallation('other-org'),
            { scope, installPath: '/plugins/mixed', projectPath: cwd },
          ],
        }),
        runtimePlugins: [createRuntimePlugin('mixed', 'external-other-org')],
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: 'plugin',
        name: 'mixed',
        installScope: scope,
        isEnabled: true,
      });
      expect(items[0]).not.toHaveProperty('pendingRemoval');
    },
  );

  it('keeps a disabled ordinary installation pending alongside a managed record', () => {
    const id = 'mixed@external-other-org';
    const items = build({
      enabledPlugins: { [id]: false },
      installedState: createState({
        [id]: [
          createManagedInstallation('other-org'),
          { scope: 'user', installPath: '/plugins/mixed' },
        ],
      }),
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'pending-plugin',
      name: 'mixed',
      scope: 'user',
      isEnabled: false,
    });
  });

  it('does not expose another project installation alongside a managed record', () => {
    const id = 'mixed@external-other-org';
    expect(
      build({
        cwd,
        enabledPlugins: { [id]: true },
        installedState: createState({
          [id]: [
            createManagedInstallation('other-org'),
            {
              scope: 'project',
              installPath: '/plugins/mixed',
              projectPath: otherProject,
            },
          ],
        }),
      }),
    ).toEqual([]);
  });

  it('hides failed plugin rows from blocked marketplaces', () => {
    const pluginErrors: PluginError[] = [
      {
        type: 'plugin-not-found',
        source: 'host-market',
        pluginId: 'host-scan@host-market',
        marketplace: 'host-market',
      },
      {
        type: 'generic-error',
        source: 'custom-blocked',
        plugin: 'custom',
        error: 'boom',
      },
    ];

    expect(
      build({
        pluginErrors,
        blockedMarketplaces: ['custom-blocked'],
        isPluginExcluded: (id) => id === 'host-scan@host-market',
      }),
    ).toEqual([]);
  });

  it('groups producer-formatted failures under the canonical plugin name', () => {
    const error: PluginError = {
      type: 'generic-error',
      source: 'sync',
      plugin: 'canonical-plugin',
      pluginId: 'canonical-plugin',
      error: 'manifest.name does not match the configured plugin name',
    };

    expect(build({ pluginErrors: [error] })).toEqual([
      expect.objectContaining({
        type: 'failed-plugin',
        name: 'canonical-plugin',
        marketplace: 'sync',
        errorCount: 1,
        errors: [error],
      }),
    ]);
  });
});
