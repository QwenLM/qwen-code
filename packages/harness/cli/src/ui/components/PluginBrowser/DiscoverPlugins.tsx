/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DiscoverPlugins — Discover Tab content for the PluginBrowser.
 *
 * Loads all available plugins from configured marketplaces, filters out
 * already-installed and policy-blocked ones, and renders a searchable,
 * keyboard-navigable list for browsing and installing plugins.
 *
 * Features:
 * - Search/filter across name, description, marketplace
 * - Sorted by install counts (popularity) when available
 * - Enter opens plugin details (scope selection, install, homepage links)
 * - Esc returns from details to list (or closes dialog from list)
 */

import type React from 'react';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type {
  Config,
  PluginMarketplace,
  PluginMarketplaceEntrySchema,
} from '@qwen-code/core';
import {
  loadKnownMarketplacesConfig,
  isPluginInstalledForCwd,
  buildPluginId,
  getEffectiveBlockedMarketplaces,
  openBrowserSecurely,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../../config/settings.js';
import { installPluginForCommand } from '@qwen-code/core/plugin-management';
import {
  SettingsListPanel,
  type SettingsDialogItem,
} from '../shared/SettingsListPanel.js';
import type { Key } from '../../hooks/useKeypress.js';
import { Command } from '../../key/keyMatchers.js';
import { useKeyMatchers } from '../../hooks/useKeyMatchers.js';
import { useRegisterActionHandlers } from '../../contexts/ActionHandlerRegistry.js';
import { PluginTrustWarning } from './PluginTrustWarning.js';
import type { z } from 'zod';
import { getPluginBrowserCwd } from './pluginBrowserCwd.js';
import { usePluginManager } from './usePluginManager.js';

type PluginMarketplaceEntry = z.infer<typeof PluginMarketplaceEntrySchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ITEMS_TO_SHOW = 8;
const noop = () => {};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstallablePlugin {
  entry: PluginMarketplaceEntry;
  marketplaceName: string;
  pluginId: string;
  isInstalled: boolean;
}

export interface DiscoverPluginsProps {
  config: Config | null;
  settings: LoadedSettings;
  onClose: () => void;
  /** Callback invoked after a successful install operation. */
  onPluginsChanged?: () => void;
  targetPlugin?: string;
}

type ViewMode = 'list' | 'detail' | 'installing';

// ---------------------------------------------------------------------------
// Detail menu items
// ---------------------------------------------------------------------------

interface DetailMenuItem {
  label: string;
  action:
    | 'install-user'
    | 'install-project'
    | 'install-local'
    | 'homepage'
    | 'repository'
    | 'back';
  disabled?: boolean;
}

function buildDetailMenuItems(plugin: InstallablePlugin): DetailMenuItem[] {
  const items: DetailMenuItem[] = [];

  if (!plugin.isInstalled) {
    items.push({ label: 'Install (user scope)', action: 'install-user' });
    items.push({ label: 'Install (project scope)', action: 'install-project' });
    items.push({ label: 'Install (local scope)', action: 'install-local' });
  }

  if (plugin.entry.homepage) {
    items.push({
      label: `Homepage: ${plugin.entry.homepage}`,
      action: 'homepage',
    });
  }

  if (plugin.entry.repository) {
    items.push({
      label: `Repository: ${plugin.entry.repository}`,
      action: 'repository',
    });
  }

  items.push({ label: '← Back', action: 'back' });

  return items;
}

// ---------------------------------------------------------------------------
// Detail Row Component
// ---------------------------------------------------------------------------

interface DetailRowProps {
  label: string;
  value: string;
  isActive?: boolean;
  isAction?: boolean;
}

const DetailRow = ({
  label,
  value,
  isActive,
  isAction,
}: DetailRowProps): React.JSX.Element => {
  const labelColor = isActive ? theme.ui.focus : theme.text.primary;
  const valueColor = isAction
    ? isActive
      ? theme.ui.focus
      : theme.text.secondary
    : isActive
      ? theme.ui.focus
      : theme.text.secondary;
  const prefix = isActive ? '❯ ' : '  ';
  return (
    <Box flexDirection="row">
      <Text color={labelColor}>{prefix}</Text>
      <Box width={18}>
        <Text color={labelColor} bold={isActive}>
          {label}
        </Text>
      </Box>
      <Text color={valueColor}>{value}</Text>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function DiscoverPlugins({
  config,
  settings,
  onClose,
  onPluginsChanged,
  targetPlugin,
}: DiscoverPluginsProps): React.JSX.Element {
  const keyMatchers = useKeyMatchers();
  const cwd = getPluginBrowserCwd(config);
  const manager = usePluginManager(config, settings);

  // --- Data state ---
  const [availablePlugins, setAvailablePlugins] = useState<InstallablePlugin[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- View state ---
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedPlugin, setSelectedPlugin] =
    useState<InstallablePlugin | null>(null);
  const [detailMenuIndex, setDetailMenuIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const blockedMarketplaceSet = useMemo(
    () =>
      new Set(
        getEffectiveBlockedMarketplaces(settings.merged.blockedMarketplaces),
      ),
    [settings.merged.blockedMarketplaces],
  );

  // ---------------------------------------------------------------------------
  // Load all marketplace plugins
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function loadAllPlugins(): Promise<void> {
      try {
        const knownConfig = loadKnownMarketplacesConfig();
        const marketplaceNames = Object.keys(knownConfig).filter(
          (name) => !blockedMarketplaceSet.has(name.toLowerCase()),
        );

        if (marketplaceNames.length === 0) {
          setAvailablePlugins([]);
          setLoading(false);
          return;
        }

        // Load all marketplaces
        const allPlugins: InstallablePlugin[] = [];
        const failures: string[] = [];

        for (const name of marketplaceNames) {
          try {
            const marketplace: PluginMarketplace | null =
              await manager.getMarketplacePlugins(name);
            if (marketplace) {
              for (const entry of marketplace.plugins) {
                const pluginId = buildPluginId(entry.name, name);
                allPlugins.push({
                  entry,
                  marketplaceName: name,
                  pluginId,
                  isInstalled: isPluginInstalledForCwd(pluginId, cwd),
                });
              }
            } else {
              failures.push(name);
            }
          } catch {
            failures.push(name);
          }
        }

        if (cancelled) return;

        // Filter out already-installed plugins
        const uninstalled = allPlugins.filter((p) => !p.isInstalled);

        uninstalled.sort((a, b) => a.entry.name.localeCompare(b.entry.name));

        setAvailablePlugins(uninstalled);

        if (failures.length > 0 && uninstalled.length > 0) {
          setStatusMessage(
            `⚠ Some marketplaces failed to load: ${failures.join(', ')}`,
          );
        } else if (failures.length > 0 && uninstalled.length === 0) {
          setLoadError(`Failed to load marketplaces: ${failures.join(', ')}`);
        }

        // Handle targetPlugin — navigate directly to details
        if (targetPlugin && !cancelled) {
          const found = allPlugins.find((p) => p.entry.name === targetPlugin);
          if (found) {
            if (found.isInstalled) {
              setStatusMessage(
                `Plugin '${found.pluginId}' is already installed.`,
              );
            } else {
              setSelectedPlugin(found);
              setDetailMenuIndex(0);
              setViewMode('detail');
            }
          } else {
            setStatusMessage(
              `Plugin "${targetPlugin}" not found in any marketplace.`,
            );
          }
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : 'Failed to load plugins',
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadAllPlugins();
    return () => {
      cancelled = true;
    };
  }, [blockedMarketplaceSet, cwd, targetPlugin, manager]);

  // ---------------------------------------------------------------------------
  // Convert to SettingsDialogItem for the list panel
  // ---------------------------------------------------------------------------

  const pluginItems: SettingsDialogItem[] = useMemo(
    () =>
      availablePlugins.map((plugin) => {
        const parts: string[] = [plugin.marketplaceName];
        if (plugin.entry.version) {
          parts.push(`v${plugin.entry.version}`);
        }

        return {
          key: plugin.pluginId,
          label: plugin.entry.displayName ?? plugin.entry.name,
          description:
            plugin.entry.description ?? `from ${plugin.marketplaceName}`,
          type: 'string' as const,
          displayValue: parts.join(' · '),
          isGreyedOut: false,
          rawValue: '',
        };
      }),
    [availablePlugins],
  );

  // ---------------------------------------------------------------------------
  // List operations
  // ---------------------------------------------------------------------------


  const openDetail = useCallback(
    (pluginId: string) => {
      const plugin = availablePlugins.find((p) => p.pluginId === pluginId);
      if (!plugin) return;
      setSelectedPlugin(plugin);
      setDetailMenuIndex(0);
      setStatusMessage(null);
      setViewMode('detail');
    },
    [availablePlugins],
  );

  const closeDetail = useCallback(() => {
    setViewMode('list');
    setSelectedPlugin(null);
    setDetailMenuIndex(0);
  }, []);

  // ---------------------------------------------------------------------------
  // Install operations
  // ---------------------------------------------------------------------------

  const handleSingleInstall = useCallback(
    async (plugin: InstallablePlugin, scope: 'user' | 'project' | 'local') => {
      setViewMode('installing');
      const label = plugin.entry.displayName ?? plugin.entry.name;
      setStatusMessage(`Installing ${label} (${scope} scope)...`);

      try {
        await installPluginForCommand({
          plugin: plugin.pluginId,
          scope,
          settings,
          config,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setStatusMessage(`✗ Install failed: ${errorMsg}`);
        setViewMode('detail');
        return;
      }

      let reloadError: unknown;
      try {
        // Reload plugins from disk so Installed tab shows the new plugin.
        await config?.reloadPlugins?.();
      } catch (err) {
        reloadError = err;
      }

      setStatusMessage(
        reloadError
          ? `⚠ Installed ${label}, but failed to refresh plugins: ${
              reloadError instanceof Error
                ? reloadError.message
                : String(reloadError)
            }. Run /plugins reload to retry.`
          : `✓ Installed ${label}. Run /plugins reload to activate.`,
      );
      onPluginsChanged?.();
      // The install completed even if refreshing the in-memory plugin list failed.
      setAvailablePlugins((prev) =>
        prev.filter((p) => p.pluginId !== plugin.pluginId),
      );
      setViewMode('list');
      setSelectedPlugin(null);
    },
    [onPluginsChanged, config, settings],
  );

  const handleListKeyPress = useCallback(
    (key: Key, currentItem: SettingsDialogItem | undefined): boolean => {
      if (keyMatchers[Command.RETURN](key) && currentItem) {
        openDetail(currentItem.key);
        return true;
      }
      return false;
    },
    [keyMatchers, openDetail],
  );

  // ---------------------------------------------------------------------------
  // Detail view
  // ---------------------------------------------------------------------------

  const detailMenuItems = useMemo(
    () => (selectedPlugin ? buildDetailMenuItems(selectedPlugin) : []),
    [selectedPlugin],
  );

  const handleDetailAction = useCallback(
    (menuItem: DetailMenuItem) => {
      if (!selectedPlugin) return;

      switch (menuItem.action) {
        case 'install-user':
          void handleSingleInstall(selectedPlugin, 'user');
          break;
        case 'install-project':
          void handleSingleInstall(selectedPlugin, 'project');
          break;
        case 'install-local':
          void handleSingleInstall(selectedPlugin, 'local');
          break;
        case 'homepage':
          if (selectedPlugin.entry.homepage) {
            void openBrowserSecurely(selectedPlugin.entry.homepage);
          }
          break;
        case 'repository':
          if (selectedPlugin.entry.repository) {
            void openBrowserSecurely(selectedPlugin.entry.repository);
          }
          break;
        case 'back':
          closeDetail();
          break;
        default:
          break;
      }
    },
    [selectedPlugin, handleSingleInstall, closeDetail],
  );

  // Detail view keyboard handling
  const detailActionHandlers = useMemo(
    () => ({
      'dialog:navigate:up': () => {
        setDetailMenuIndex((i) => Math.max(0, i - 1));
        return true;
      },
      'dialog:navigate:down': () => {
        setDetailMenuIndex((i) => Math.min(detailMenuItems.length - 1, i + 1));
        return true;
      },
      'dialog:confirm': () => {
        const item = detailMenuItems[detailMenuIndex];
        if (item) {
          handleDetailAction(item);
        }
        return true;
      },
      'dialog:escape': () => {
        closeDetail();
        return true;
      },
    }),
    [detailMenuItems, detailMenuIndex, handleDetailAction, closeDetail],
  );

  useRegisterActionHandlers(
    'Dialog',
    detailActionHandlers,
    viewMode === 'detail',
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Loading state
  if (loading) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>Loading plugins from marketplaces…</Text>
      </Box>
    );
  }

  // Error state
  if (loadError) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.status.error}>{loadError}</Text>
        <Text dimColor>
          {'\n'}Check your network connection or add a marketplace first.
        </Text>
      </Box>
    );
  }

  // Empty state
  if (availablePlugins.length === 0 && !loading) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No new plugins available.</Text>
        <Text dimColor>
          All plugins may already be installed, or no marketplaces are
          configured.
        </Text>
        <Text dimColor>
          Use the Marketplaces tab to add a plugin marketplace.
        </Text>
      </Box>
    );
  }

  // Installing state overlay
  if (viewMode === 'installing') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="cyan" bold>
          Installing…
        </Text>
        {statusMessage && (
          <Box marginTop={1}>
            <Text
              bold={statusMessage.startsWith('✗')}
              color={
                statusMessage.startsWith('✗')
                  ? theme.status.error
                  : theme.text.secondary
              }
            >
              {statusMessage}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // --- Detail View ---
  if (viewMode === 'detail' && selectedPlugin) {
    const entry = selectedPlugin.entry;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text color="cyan" bold>
            {entry.displayName ?? entry.name}
          </Text>
          {entry.version && <Text dimColor> v{entry.version}</Text>}
        </Box>

        {/* Plugin info */}
        <DetailRow label="Marketplace" value={selectedPlugin.marketplaceName} />
        {entry.description && (
          <DetailRow label="Description" value={entry.description} />
        )}
        {entry.author && (
          <DetailRow
            label="Author"
            value={
              entry.author.name +
              (entry.author.email ? ` <${entry.author.email}>` : '')
            }
          />
        )}
        {entry.category && (
          <DetailRow label="Category" value={entry.category} />
        )}
        {entry.tags && entry.tags.length > 0 && (
          <DetailRow label="Tags" value={entry.tags.join(', ')} />
        )}

        {/* Trust warning */}
        <Box marginY={1}>
          <PluginTrustWarning
            pluginName={entry.name}
            marketplace={selectedPlugin.marketplaceName}
          />
        </Box>

        {/* Menu options */}
        {detailMenuItems.map((item, idx) => {
          const isActive = idx === detailMenuIndex;
          const prefix = isActive ? '❯ ' : '  ';
          return (
            <Box key={item.action} flexDirection="row">
              <Text
                color={isActive ? theme.ui.focus : theme.text.secondary}
                bold={isActive}
              >
                {prefix}
                {item.label}
              </Text>
            </Box>
          );
        })}

        {statusMessage && (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{statusMessage}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>↑↓ navigate · Enter: select · Esc: back</Text>
        </Box>
      </Box>
    );
  }

  // --- List View ---
  return (
    <Box flexDirection="column">
      <SettingsListPanel
        items={pluginItems}
        maxItemsToShow={MAX_ITEMS_TO_SHOW}
        onItemToggle={noop}
        onEditCommit={noop}
        onItemClear={noop}
        onClose={onClose}
        readOnly={true}
        onKeyPress={handleListKeyPress}
        searchPlaceholder="Search plugins..."
        searchFocused={true}
      />

      {statusMessage && (
        <Box paddingX={1}>
          <Text
            bold={statusMessage.startsWith('✗')}
            color={
              statusMessage.startsWith('✗')
                ? theme.status.error
                : theme.text.secondary
            }
          >
            {statusMessage}
          </Text>
        </Box>
      )}
    </Box>
  );
}
