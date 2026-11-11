/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ManageMarketplaces — Marketplaces Tab content for the PluginBrowser.
 *
 * Lists configured marketplace sources with status info, supports:
 *  - Viewing marketplace details (plugin count, last updated)
 *  - Refreshing marketplaces
 *  - Removing marketplaces
 *  - Adding new marketplace sources
 *  - Toggling auto-update
 */

import type React from 'react';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { Key } from '../../contexts/KeypressContext.js';
import { Command } from '../../key/keyMatchers.js';
import { useKeyMatchers } from '../../hooks/useKeyMatchers.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
} from '../../contexts/ActionHandlerRegistry.js';
import {
  SettingsListPanel,
  type SettingsDialogItem,
} from '../shared/SettingsListPanel.js';
import {
  loadKnownMarketplacesConfig,
  getMarketplace,
  getEffectiveBlockedMarketplaces,
  setMarketplaceAutoUpdate,
  getErrorMessage,
  type KnownMarketplace,
  type PluginMarketplace,
  type Config,
} from '@qwen-code/core';
import { AddMarketplace } from './AddMarketplace.js';
import type { LoadedSettings } from '../../../config/settings.js';
import { usePluginManager } from './usePluginManager.js';
import {
  formatMarketplaceOperationStatus,
  getMarketplaceOperationTimeoutMs,
  getRemainingOperationSeconds,
  removeMarketplaceForCommand,
  updateMarketplaceForCommand,
} from '@qwen-code/core/plugin-management';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InternalView = 'list' | 'details' | 'confirm-remove' | 'add';

interface MarketplaceState {
  name: string;
  known: KnownMarketplace;
  manifest: PluginMarketplace | null;
}

const ADD_MARKETPLACE_KEY = '__add_marketplace__';
const noop = () => {};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ManageMarketplacesProps {
  config?: Config | null;
  settings: LoadedSettings;
  onClose: () => void;
  /** Pre-filled source for the add-marketplace form. */
  addSource?: string;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ManageMarketplaces({
  config,
  settings,
  onClose,
  addSource,
}: ManageMarketplacesProps): React.JSX.Element {
  const keyMatchers = useKeyMatchers();
  const manager = usePluginManager(config, settings);

  const [view, setView] = useState<InternalView>(addSource ? 'add' : 'list');
  const [marketplaces, setMarketplaces] = useState<MarketplaceState[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedMarketplace, setSelectedMarketplace] =
    useState<MarketplaceState | null>(null);
  const [detailFieldIndex, setDetailFieldIndex] = useState(0);
  const [processing, setProcessing] = useState(false);
  const blockedMarketplaceSet = useMemo(
    () =>
      new Set(
        getEffectiveBlockedMarketplaces(settings.merged.blockedMarketplaces),
      ),
    [settings.merged.blockedMarketplaces],
  );

  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Load marketplaces
  // ---------------------------------------------------------------------------

  const loadMarketplaces = useCallback(async () => {
    setLoading(true);
    try {
      const config = loadKnownMarketplacesConfig();
      const entries = Object.entries(config).filter(
        ([name]) => !blockedMarketplaceSet.has(name.toLowerCase()),
      );

      const manifests = await Promise.allSettled(
        entries.map(([name]) => getMarketplace(name)),
      );
      const states: MarketplaceState[] = entries.map(([name, known], i) => ({
        name,
        known,
        manifest:
          manifests[i]?.status === 'fulfilled' ? manifests[i].value : null,
      }));

      // Sort: official marketplace first, then alphabetical
      states.sort((a, b) => {
        const aOfficial = a.name.includes('plugin-directory') ? 0 : 1;
        const bOfficial = b.name.includes('plugin-directory') ? 0 : 1;
        if (aOfficial !== bOfficial) return aOfficial - bOfficial;
        return a.name.localeCompare(b.name);
      });

      if (mountedRef.current) {
        setMarketplaces(states);
        setLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setStatusMessage(
          `Failed to load marketplaces: ${getErrorMessage(err)}`,
        );
        setLoading(false);
      }
    }
  }, [blockedMarketplaceSet]);

  useEffect(() => {
    void loadMarketplaces();
  }, [loadMarketplaces]);

  // ---------------------------------------------------------------------------
  // Convert to SettingsDialogItem for list view
  // ---------------------------------------------------------------------------

  const listItems: SettingsDialogItem[] = useMemo(
    () => [
      {
        key: ADD_MARKETPLACE_KEY,
        label: '+ Add marketplace...',
        description: 'Add a new marketplace source',
        type: 'string' as const,
        displayValue: '',
        rawValue: '',
      },
      ...marketplaces.map((mp) => {
        const pluginCount = mp.manifest
          ? `${mp.manifest.plugins.length} plugins`
          : 'not loaded';
        const autoUpdate = mp.known.autoUpdate !== false ? '↻' : '';
        const lastUpdated = mp.known.lastUpdated
          ? new Date(mp.known.lastUpdated).toLocaleDateString()
          : 'never';

        return {
          key: mp.name,
          label: mp.name,
          description: `${pluginCount} · Updated: ${lastUpdated}`,
          type: 'boolean' as const,
          displayValue: `${autoUpdate} ${mp.manifest ? '✓' : '○'}`.trim(),
          rawValue: mp.manifest !== null,
        };
      }),
    ],
    [marketplaces],
  );

  // ---------------------------------------------------------------------------
  // List actions
  // ---------------------------------------------------------------------------

  const openDetails = useCallback(
    (name: string) => {
      const mp = marketplaces.find((m) => m.name === name);
      if (!mp) return;
      setSelectedMarketplace(mp);
      setDetailFieldIndex(0);
      setStatusMessage(null);
      setView('details');
    },
    [marketplaces],
  );

  const handleRefresh = useCallback(
    async (name: string) => {
      setProcessing(true);
      const timeoutMs = getMarketplaceOperationTimeoutMs();
      let startedAt = Date.now();
      let detail: string | undefined;
      const updateStatus = () => {
        setStatusMessage(
          formatMarketplaceOperationStatus('Refreshing', {
            target: name,
            detail,
            remainingSeconds: getRemainingOperationSeconds(startedAt, timeoutMs),
          }),
        );
      };
      updateStatus();
      const countdownTimer = setInterval(updateStatus, 1000);
      countdownTimer.unref?.();
      try {
        await updateMarketplaceForCommand(name, (message) => {
          startedAt = Date.now();
          detail = message;
          updateStatus();
        });
        setStatusMessage(`✓ Refreshed ${name}`);
        await loadMarketplaces();
      } catch (err) {
        setStatusMessage(
          `✗ Failed to refresh ${name}: ${getErrorMessage(err)}`,
        );
      } finally {
        clearInterval(countdownTimer);
      }
      if (mountedRef.current) setProcessing(false);
    },
    [loadMarketplaces],
  );

  const handleRemove = useCallback(
    async (name: string) => {
      setProcessing(true);
      setStatusMessage(`Removing ${name}...`);
      try {
        const message = await removeMarketplaceForCommand({
          settings,
          name,
          manager,
        });
        setStatusMessage(`✓ ${message}`);
        setView('list');
        setSelectedMarketplace(null);
        await loadMarketplaces();
      } catch (err) {
        setStatusMessage(`✗ Failed to remove ${name}: ${getErrorMessage(err)}`);
      }
      if (mountedRef.current) setProcessing(false);
    },
    [loadMarketplaces, settings, manager],
  );

  const handleToggleAutoUpdate = useCallback(
    async (name: string, current: boolean) => {
      try {
        setMarketplaceAutoUpdate(name, !current);
        setStatusMessage(
          `Auto-update ${!current ? 'enabled' : 'disabled'} for ${name}`,
        );
        await loadMarketplaces();
      } catch (err) {
        setStatusMessage(
          `Failed to toggle auto-update: ${getErrorMessage(err)}`,
        );
      }
    },
    [loadMarketplaces],
  );

  const selectedInstalledPluginIds = useMemo(
    () =>
      selectedMarketplace
        ? manager.getInstalledPluginsForMarketplace(selectedMarketplace.name)
            .pluginIds
        : [],
    [selectedMarketplace, manager],
  );

  const handleListKeyPress = useCallback(
    (key: Key, currentItem: SettingsDialogItem | undefined): boolean => {
      if (keyMatchers[Command.RETURN](key) && currentItem) {
        if (currentItem.key === ADD_MARKETPLACE_KEY) {
          setView('add');
          return true;
        }
        openDetails(currentItem.key);
        return true;
      }
      return false;
    },
    [keyMatchers, openDetails],
  );

  // ---------------------------------------------------------------------------
  // Details view fields
  // ---------------------------------------------------------------------------

  interface DetailField {
    label: string;
    value: string;
    action?: 'refresh' | 'remove' | 'toggle-auto-update';
    disabled?: boolean;
  }

  const detailFields = useMemo<DetailField[]>(() => {
    if (!selectedMarketplace) return [];
    const mp = selectedMarketplace;
    const fields: DetailField[] = [
      { label: 'Name', value: mp.name },
      {
        label: 'Source',
        value:
          typeof mp.known.source === 'string'
            ? mp.known.source
            : JSON.stringify(mp.known.source),
      },
      {
        label: 'Plugins',
        value: mp.manifest ? `${mp.manifest.plugins.length}` : 'Not loaded',
      },
      {
        label: 'Installed',
        value: `${selectedInstalledPluginIds.length}`,
      },
      {
        label: 'Last Updated',
        value: mp.known.lastUpdated
          ? new Date(mp.known.lastUpdated).toLocaleString()
          : 'Never',
      },
      {
        label: 'Auto-Update',
        value: `${mp.known.autoUpdate !== false ? 'Enabled' : 'Disabled'} · marketplace data + installed plugins`,
      },
      {
        label: 'Source Reconcile',
        value: 'Settings source changes still apply',
      },
      { label: '──────────', value: '' },
      { label: '↻ Refresh', value: '', action: 'refresh' },
      {
        label: '⟳ Toggle Auto-Update',
        value: '',
        action: 'toggle-auto-update',
      },
      { label: '✗ Remove', value: '', action: 'remove' },
    ];
    return fields;
  }, [selectedMarketplace, selectedInstalledPluginIds.length]);

  // Detail keyboard
  const detailActionHandlers = useMemo(
    () => ({
      'dialog:navigate:up': () => {
        setDetailFieldIndex((i) => {
          let next = i - 1;
          // Skip separator
          while (next >= 0 && detailFields[next]?.label.startsWith('──')) {
            next--;
          }
          return Math.max(0, next);
        });
        return true;
      },
      'dialog:navigate:down': () => {
        setDetailFieldIndex((i) => {
          let next = i + 1;
          while (
            next < detailFields.length &&
            detailFields[next]?.label.startsWith('──')
          ) {
            next++;
          }
          return Math.min(detailFields.length - 1, next);
        });
        return true;
      },
      'dialog:confirm': () => {
        const field = detailFields[detailFieldIndex];
        if (!field?.action || !selectedMarketplace || processing) return true;
        switch (field.action) {
          case 'refresh':
            void handleRefresh(selectedMarketplace.name);
            break;
          case 'remove':
            setView('confirm-remove');
            break;
          case 'toggle-auto-update':
            void handleToggleAutoUpdate(
              selectedMarketplace.name,
              selectedMarketplace.known.autoUpdate !== false,
            );
            break;
          default:
            break;
        }
        return true;
      },
      'dialog:escape': () => {
        setView('list');
        setSelectedMarketplace(null);
        setStatusMessage(null);
        return true;
      },
    }),
    [
      detailFields,
      detailFieldIndex,
      selectedMarketplace,
      processing,
      handleRefresh,
      handleToggleAutoUpdate,
    ],
  );

  useRegisterActionHandlers('Dialog', detailActionHandlers, view === 'details');

  // ---------------------------------------------------------------------------
  // Confirm-remove keyboard — handles y/n character input
  // ---------------------------------------------------------------------------

  const confirmRemoveActionHandlers = useMemo(
    () => ({
      'dialog:escape': () => {
        setView('details');
        return true;
      },
    }),
    [],
  );

  const confirmRemoveFallbackHandler = useCallback(
    (key: Key): boolean | void => {
      if (key.insertable && !key.ctrl && !key.alt && !key.cmd) {
        const ch = key.sequence.toLowerCase();
        if (ch === 'y' && selectedMarketplace && !processing) {
          void handleRemove(selectedMarketplace.name);
          return true;
        }
        if (ch === 'n') {
          setView('details');
          return true;
        }
      }
      return false;
    },
    [selectedMarketplace, processing, handleRemove],
  );

  useRegisterActionHandlers(
    'Dialog',
    confirmRemoveActionHandlers,
    view === 'confirm-remove',
  );

  useRegisterFallbackHandler(
    'Dialog',
    confirmRemoveFallbackHandler,
    view === 'confirm-remove',
  );

  // List view fallback: handle 'a' key when SettingsListPanel is not rendered
  const listFallbackHandler = useCallback(
    (key: Key): boolean | void => {
      if (
        key.insertable &&
        key.sequence === 'a' &&
        !key.ctrl &&
        !key.alt &&
        !key.cmd
      ) {
        setView('add');
        return true;
      }
      return false;
    },
    [],
  );

  useRegisterFallbackHandler(
    'Dialog',
    listFallbackHandler,
    view === 'list' && marketplaces.length === 0,
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <Box paddingX={1}>
        <Text color="cyan">Loading marketplaces...</Text>
      </Box>
    );
  }

  // --- Add View ---
  if (view === 'add') {
    return (
      <AddMarketplace
        settings={settings}
        initialSource={addSource}
        onAdded={(message) => {
          setStatusMessage(`✓ ${message}`);
          setView('list');
          void loadMarketplaces();
        }}
        onCancel={() => {
          setView('list');
        }}
      />
    );
  }

  // --- Confirm Remove ---
  if (view === 'confirm-remove' && selectedMarketplace) {
    const installedPreview = selectedInstalledPluginIds.slice(0, 3).join(', ');
    const remainingInstalled = selectedInstalledPluginIds.length - 3;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.status.error} bold>
          Remove Marketplace
        </Text>
        <Box marginTop={1}>
          <Text>
            Are you sure you want to remove{' '}
            <Text bold>{selectedMarketplace.name}</Text>?
          </Text>
        </Box>
        <Text dimColor>
          {selectedInstalledPluginIds.length > 0
            ? `This will uninstall ${selectedInstalledPluginIds.length} installed ${
                selectedInstalledPluginIds.length === 1 ? 'plugin' : 'plugins'
              } from this marketplace${
                installedPreview
                  ? `: ${installedPreview}${remainingInstalled > 0 ? ` and ${remainingInstalled} more` : ''}`
                  : ''
              }.`
            : 'No installed plugins will be removed.'}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Press </Text>
          <Text color={theme.status.error}>y</Text>
          <Text dimColor> to confirm, </Text>
          <Text>n</Text>
          <Text dimColor> to cancel</Text>
        </Box>
        {processing && (
          <Box marginTop={1}>
            <Text color="cyan">Removing...</Text>
          </Box>
        )}
      </Box>
    );
  }

  // --- Details View ---
  if (view === 'details' && selectedMarketplace) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="cyan" bold>
          {selectedMarketplace.name}
        </Text>

        <Box marginTop={1} flexDirection="column">
          {detailFields.map((field, idx) => {
            const isActive = idx === detailFieldIndex;
            const isSeparator = field.label.startsWith('──');
            const isAction = !!field.action;

            if (isSeparator) {
              return (
                <Text key={idx} dimColor>
                  {'  '}
                  {field.label}
                </Text>
              );
            }

            const prefix = isActive ? '❯ ' : '  ';
            const labelColor = isActive ? theme.ui.focus : theme.text.primary;
            const valueColor = isAction
              ? isActive
                ? field.action === 'remove'
                  ? theme.status.error
                  : theme.ui.focus
                : theme.text.secondary
              : isActive
                ? theme.ui.focus
                : theme.text.secondary;

            return (
              <Box key={field.label} flexDirection="row">
                <Text color={labelColor}>{prefix}</Text>
                <Box width={22}>
                  <Text color={labelColor} bold={isActive}>
                    {field.label}
                  </Text>
                </Box>
                {field.value && <Text color={valueColor}>{field.value}</Text>}
              </Box>
            );
          })}
        </Box>

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
        items={listItems}
        maxItemsToShow={8}
        onItemToggle={noop}
        onEditCommit={noop}
        onItemClear={noop}
        onClose={onClose}
        readOnly={true}
        onKeyPress={handleListKeyPress}
      />

      {statusMessage && (
        <Box paddingX={1}>
          <Text color={theme.text.secondary}>{statusMessage}</Text>
        </Box>
      )}

      <Box paddingX={1}>
        <Text dimColor>Enter: Select · Esc: close</Text>
      </Box>
    </Box>
  );
}
