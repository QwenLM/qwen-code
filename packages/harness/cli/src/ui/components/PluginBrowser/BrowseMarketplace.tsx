/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BrowseMarketplace — Browse plugins from a single marketplace.
 *
 * Shows a list of plugins from one marketplace, with search, details,
 * scope-selection install, and post-install options flow.
 *
 * Views:
 *   marketplace-list → select a marketplace to browse
 *   plugin-list      → list plugins from the selected marketplace
 *   plugin-details   → details + install actions for a single plugin
 *   installing       → in-progress install
 */

import type React from 'react';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import {
  SettingsListPanel,
  type SettingsDialogItem,
} from '../shared/SettingsListPanel.js';
import type { Key } from '../../hooks/useKeypress.js';
import { Command } from '../../key/keyMatchers.js';
import { useKeyMatchers } from '../../hooks/useKeyMatchers.js';
import { useRegisterActionHandlers } from '../../contexts/ActionHandlerRegistry.js';
import { PluginTrustWarning } from './PluginTrustWarning.js';
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
import type { z } from 'zod';
import { getPluginBrowserCwd } from './pluginBrowserCwd.js';
import { usePluginManager } from './usePluginManager.js';

type PluginMarketplaceEntry = z.infer<typeof PluginMarketplaceEntrySchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ITEMS = 8;
const noop = () => {};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowseMarketplaceProps {
  /** Pre-selected marketplace name; if provided, skips the marketplace list. */
  marketplace?: string;
  /** Called to close or return to the parent view. */
  onClose: () => void;
  /** Callback invoked after a successful install operation. */
  onPluginsChanged?: () => void;
  /** Active session config for cwd resolution and post-install reload. */
  config: Config | null;
  settings: LoadedSettings;
}

interface BrowsablePlugin {
  entry: PluginMarketplaceEntry;
  marketplaceName: string;
  pluginId: string;
  isInstalled: boolean;
}

type ViewMode =
  | 'marketplace-list'
  | 'plugin-list'
  | 'plugin-details'
  | 'installing';

// ---------------------------------------------------------------------------
// Detail menu
// ---------------------------------------------------------------------------

interface DetailAction {
  label: string;
  action:
    | 'install-user'
    | 'install-project'
    | 'install-local'
    | 'homepage'
    | 'repository'
    | 'back';
}

function buildDetailActions(plugin: BrowsablePlugin): DetailAction[] {
  const actions: DetailAction[] = [];

  if (!plugin.isInstalled) {
    actions.push({ label: 'Install (user scope)', action: 'install-user' });
    actions.push({
      label: 'Install (project scope)',
      action: 'install-project',
    });
    actions.push({ label: 'Install (local scope)', action: 'install-local' });
  }

  if (plugin.entry.homepage) {
    actions.push({
      label: `Homepage: ${plugin.entry.homepage}`,
      action: 'homepage',
    });
  }
  if (plugin.entry.repository) {
    actions.push({
      label: `Repository: ${plugin.entry.repository}`,
      action: 'repository',
    });
  }

  actions.push({ label: '← Back to list', action: 'back' });
  return actions;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BrowseMarketplace({
  marketplace: initialMarketplace,
  onClose,
  onPluginsChanged,
  config,
  settings,
}: BrowseMarketplaceProps): React.JSX.Element {
  const keyMatchers = useKeyMatchers();
  const cwd = getPluginBrowserCwd(config);
  const manager = usePluginManager(config, settings);
  const blockedMarketplaceSet = useMemo(
    () =>
      new Set(
        getEffectiveBlockedMarketplaces(settings.merged.blockedMarketplaces),
      ),
    [settings.merged.blockedMarketplaces],
  );
  const visibleInitialMarketplace =
    initialMarketplace &&
    !blockedMarketplaceSet.has(initialMarketplace.toLowerCase())
      ? initialMarketplace
      : undefined;

  // --- State ---
  const [viewMode, setViewMode] = useState<ViewMode>(
    visibleInitialMarketplace ? 'plugin-list' : 'marketplace-list',
  );
  const [selectedMarketplace, setSelectedMarketplace] = useState<string | null>(
    visibleInitialMarketplace ?? null,
  );
  const [plugins, setPlugins] = useState<BrowsablePlugin[]>([]);
  const [loading, setLoading] = useState(!!visibleInitialMarketplace);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPlugin, setSelectedPlugin] = useState<BrowsablePlugin | null>(
    null,
  );
  const [detailIndex, setDetailIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // --- Marketplace list ---
  const knownMarketplaces = useMemo(() => {
    const config = loadKnownMarketplacesConfig();
    return Object.keys(config).filter(
      (name) => !blockedMarketplaceSet.has(name.toLowerCase()),
    );
  }, [blockedMarketplaceSet]);

  const marketplaceItems: SettingsDialogItem[] = useMemo(
    () =>
      knownMarketplaces.map((name) => ({
        key: name,
        label: name,
        description: 'Press Enter to browse',
        type: 'boolean' as const,
        displayValue: '',
        isGreyedOut: false,
        rawValue: false,
      })),
    [knownMarketplaces],
  );

  // --- Load plugins for selected marketplace ---
  useEffect(() => {
    if (!selectedMarketplace) return;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setPlugins([]);

    async function load(): Promise<void> {
      try {
        const marketplace: PluginMarketplace | null =
          await manager.getMarketplacePlugins(selectedMarketplace!);

        if (cancelled) return;

        if (!marketplace) {
          setLoadError(`Failed to load marketplace: ${selectedMarketplace}`);
          setLoading(false);
          return;
        }

        const items: BrowsablePlugin[] = marketplace.plugins.flatMap(
          (entry) => {
            const pluginId = buildPluginId(entry.name, selectedMarketplace!);
            return [
              {
                entry,
                marketplaceName: selectedMarketplace!,
                pluginId,
                isInstalled: isPluginInstalledForCwd(pluginId, cwd),
              },
            ];
          },
        );

        items.sort((a, b) => a.entry.name.localeCompare(b.entry.name));

        setPlugins(items);
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : 'Failed to load marketplace',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [cwd, selectedMarketplace, manager]);

  // --- Plugin list items ---
  const pluginItems: SettingsDialogItem[] = useMemo(
    () =>
      plugins.map((p) => {
        const parts: string[] = [];
        if (p.entry.version) parts.push(`v${p.entry.version}`);
        if (p.isInstalled) parts.push('installed');

        return {
          key: p.pluginId,
          label: p.entry.displayName ?? p.entry.name,
          description: p.entry.description ?? `from ${p.marketplaceName}`,
          type: 'string' as const,
          displayValue: parts.join(' · '),
          isGreyedOut: p.isInstalled,
          rawValue: '',
        };
      }),
    [plugins],
  );

  // --- Detail actions ---
  const detailActions = useMemo(
    () => (selectedPlugin ? buildDetailActions(selectedPlugin) : []),
    [selectedPlugin],
  );

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const selectMarketplace = useCallback((name: string) => {
    if (blockedMarketplaceSet.has(name.toLowerCase())) return;
    setSelectedMarketplace(name);
    setViewMode('plugin-list');
    setStatusMessage(null);
  }, [blockedMarketplaceSet]);

  const openPluginDetail = useCallback(
    (pluginId: string) => {
      const plugin = plugins.find((p) => p.pluginId === pluginId);
      if (!plugin) return;
      setSelectedPlugin(plugin);
      setDetailIndex(0);
      setStatusMessage(null);
      setViewMode('plugin-details');
    },
    [plugins],
  );

  const closeDetail = useCallback(() => {
    setViewMode('plugin-list');
    setSelectedPlugin(null);
    setDetailIndex(0);
  }, []);

  const handleInstall = useCallback(
    async (plugin: BrowsablePlugin, scope: 'user' | 'project' | 'local') => {
      setViewMode('installing');
      setStatusMessage(`Installing ${plugin.entry.name} (${scope} scope)…`);

      try {
        await installPluginForCommand({
          plugin: plugin.pluginId,
          scope,
          settings,
          config,
        });
      } catch (err) {
        setStatusMessage(
          `✗ Install failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        setViewMode('plugin-details');
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
          ? `⚠ Installed ${plugin.entry.name}, but failed to refresh plugins: ${
              reloadError instanceof Error
                ? reloadError.message
                : String(reloadError)
            }. Run /plugins reload to retry.`
          : `✓ Installed ${plugin.entry.name}. Run /plugins reload to activate.`,
      );
      onPluginsChanged?.();
      // The install completed even if refreshing the in-memory plugin list failed.
      setPlugins((prev) =>
        prev.map((p) =>
          p.pluginId === plugin.pluginId ? { ...p, isInstalled: true } : p,
        ),
      );
      setViewMode('plugin-list');
      setSelectedPlugin(null);
    },
    [onPluginsChanged, config, settings],
  );

  const handleDetailAction = useCallback(
    (action: DetailAction) => {
      if (!selectedPlugin) return;

      switch (action.action) {
        case 'install-user':
          void handleInstall(selectedPlugin, 'user');
          break;
        case 'install-project':
          void handleInstall(selectedPlugin, 'project');
          break;
        case 'install-local':
          void handleInstall(selectedPlugin, 'local');
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
    [selectedPlugin, handleInstall, closeDetail],
  );

  // --- Marketplace list key handler ---
  const handleMarketplaceKey = useCallback(
    (key: Key, currentItem: SettingsDialogItem | undefined): boolean => {
      if (keyMatchers[Command.RETURN](key) && currentItem) {
        selectMarketplace(currentItem.key);
        return true;
      }
      return false;
    },
    [keyMatchers, selectMarketplace],
  );

  // --- Plugin list key handler ---
  const handlePluginListKey = useCallback(
    (key: Key, currentItem: SettingsDialogItem | undefined): boolean => {
      if (keyMatchers[Command.RETURN](key) && currentItem) {
        openPluginDetail(currentItem.key);
        return true;
      }
      return false;
    },
    [keyMatchers, openPluginDetail],
  );

  // --- Detail view keyboard ---
  const detailActionHandlers = useMemo(
    () => ({
      'dialog:navigate:up': () => {
        setDetailIndex((i) => Math.max(0, i - 1));
        return true;
      },
      'dialog:navigate:down': () => {
        setDetailIndex((i) => Math.min(detailActions.length - 1, i + 1));
        return true;
      },
      'dialog:confirm': () => {
        const action = detailActions[detailIndex];
        if (action) handleDetailAction(action);
        return true;
      },
      'dialog:escape': () => {
        closeDetail();
        return true;
      },
    }),
    [detailActions, detailIndex, handleDetailAction, closeDetail],
  );

  useRegisterActionHandlers(
    'Dialog',
    detailActionHandlers,
    viewMode === 'plugin-details',
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // --- Marketplace list ---
  if (viewMode === 'marketplace-list') {
    if (knownMarketplaces.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>No marketplaces configured.</Text>
          <Text dimColor>
            Use the Marketplaces tab to add a plugin marketplace.
          </Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Box paddingX={1} marginBottom={1}>
          <Text color="cyan" bold>
            Select a marketplace to browse
          </Text>
        </Box>
        <SettingsListPanel
          items={marketplaceItems}
          maxItemsToShow={MAX_ITEMS}
          onItemToggle={noop}
          onEditCommit={noop}
          onItemClear={noop}
          onClose={onClose}
          readOnly={true}
          onKeyPress={handleMarketplaceKey}
          searchPlaceholder="Search marketplaces..."
          searchFocused={true}
        />
      </Box>
    );
  }

  // --- Installing ---
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

  // --- Loading ---
  if (loading) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>Loading plugins from {selectedMarketplace}…</Text>
      </Box>
    );
  }

  // --- Load error ---
  if (loadError) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.status.error}>{loadError}</Text>
        <Box marginTop={1}>
          <Text dimColor>Press Esc to go back.</Text>
        </Box>
      </Box>
    );
  }

  // --- Plugin details ---
  if (viewMode === 'plugin-details' && selectedPlugin) {
    const entry = selectedPlugin.entry;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text color="cyan" bold>
            {entry.displayName ?? entry.name}
          </Text>
          {entry.version && <Text dimColor> v{entry.version}</Text>}
          <Text dimColor> — {selectedMarketplace}</Text>
        </Box>

        {entry.description && (
          <Box marginBottom={1}>
            <Text>{entry.description}</Text>
          </Box>
        )}

        {entry.author && (
          <Box>
            <Box width={14}>
              <Text dimColor>Author</Text>
            </Box>
            <Text>
              {entry.author.name}
              {entry.author.email ? ` <${entry.author.email}>` : ''}
            </Text>
          </Box>
        )}

        {entry.category && (
          <Box>
            <Box width={14}>
              <Text dimColor>Category</Text>
            </Box>
            <Text>{entry.category}</Text>
          </Box>
        )}

        {entry.tags && entry.tags.length > 0 && (
          <Box>
            <Box width={14}>
              <Text dimColor>Tags</Text>
            </Box>
            <Text>{entry.tags.join(', ')}</Text>
          </Box>
        )}

        {selectedPlugin.isInstalled && (
          <Box marginTop={1}>
            <Text color={theme.status.success}>✓ Already installed</Text>
          </Box>
        )}

        {/* Trust warning */}
        {!selectedPlugin.isInstalled && (
          <Box marginY={1}>
            <PluginTrustWarning
              pluginName={entry.name}
              marketplace={selectedMarketplace ?? undefined}
            />
          </Box>
        )}

        {/* Action menu */}
        {detailActions.map((action, idx) => {
          const isActive = idx === detailIndex;
          const prefix = isActive ? '❯ ' : '  ';
          return (
            <Box key={action.action} flexDirection="row">
              <Text
                color={isActive ? theme.ui.focus : theme.text.secondary}
                bold={isActive}
              >
                {prefix}
                {action.label}
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

  // --- Plugin list ---
  return (
    <Box flexDirection="column">
      <Box paddingX={1} marginBottom={1}>
        <Text color="cyan" bold>
          {selectedMarketplace}
        </Text>
        <Text dimColor>
          {' '}
          — {plugins.length} plugin{plugins.length !== 1 ? 's' : ''}
        </Text>
      </Box>

      <SettingsListPanel
        items={pluginItems}
        maxItemsToShow={MAX_ITEMS}
        onItemToggle={noop}
        onEditCommit={noop}
        onItemClear={noop}
        onClose={() => {
          if (initialMarketplace) {
            onClose();
          } else {
            setViewMode('marketplace-list');
            setSelectedMarketplace(null);
            setStatusMessage(null);
          }
        }}
        readOnly={true}
        onKeyPress={handlePluginListKey}
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
