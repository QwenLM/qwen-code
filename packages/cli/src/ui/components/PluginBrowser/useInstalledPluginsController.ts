/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { buildPluginId, openBrowserSecurely } from '@qwen-code/core';
import {
  formatPluginMutationMessage,
  resolveScopeForPlugin,
  setPluginEnabledForCommand,
  uninstallPluginForCommand,
  type PluginCliScope,
} from '@qwen-code/core/plugin-management';
import type { Key } from '../../contexts/KeypressContext.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
} from '../../contexts/ActionHandlerRegistry.js';
import { usePagination } from './usePagination.js';
import type { ManagePluginsProps } from './ManagePlugins.js';
import type {
  UnifiedInstalledItem,
  UnifiedPluginItem,
} from './unifiedTypes.js';
import type { PluginDetailField } from './pluginDetailsHelpers.js';
import type { InstalledPluginPresentation } from './installedPluginPresentation.js';

const MAX_VISIBLE_ITEMS = 8;

type ViewMode =
  | 'list'
  | 'plugin-details'
  | 'confirm-uninstall'
  | 'confirm-data-cleanup'
  | 'failed-plugin-details'
  | 'mcp-detail'
  | 'pending-plugin-details';

/** Error message for attempting to toggle a flag-loaded (--plugin-dir) plugin. */
function flagPluginToggleError(name: string): string {
  return `Cannot toggle '${name}': plugins loaded via --plugin-dir are session-only and cannot be disabled.`;
}

function getInstalledToggleScope(
  item: UnifiedPluginItem | undefined,
): PluginCliScope | undefined {
  if (item?.plugin.isBuiltin) return 'user';
  const scope = item?.installScope;
  return scope === 'user' || scope === 'project' || scope === 'local'
    ? scope
    : undefined;
}

export function useInstalledPluginsController(
  {
    config,
    settings,
    onClose,
    onPluginsChanged,
    targetPlugin,
    targetAction,
  }: ManagePluginsProps,
  items: UnifiedInstalledItem[],
  presentation: ReadonlyMap<string, InstalledPluginPresentation>,
) {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const allPlugins = useMemo(
    () =>
      items.flatMap((item) => (item.type === 'plugin' ? [item.plugin] : [])),
    [items],
  );
  const unifiedItems = useMemo(
    () =>
      [...items].sort(
        (a, b) =>
          (presentation.get(a.id)?.groupOrder ?? 0) -
          (presentation.get(b.id)?.groupOrder ?? 0),
      ),
    [items, presentation],
  );
  const scopeGroupBoundaries = useMemo(() => {
    const boundaries = new Map<number, string>();
    let lastGroup: string | undefined;
    unifiedItems.forEach((item, index) => {
      const group = presentation.get(item.id)?.groupLabel ?? '';
      if (group !== lastGroup) {
        boundaries.set(index, group);
        lastGroup = group;
      }
    });
    return boundaries;
  }, [unifiedItems, presentation]);
  // Selectable items (non-header items)
  const selectableItems = useMemo(() => unifiedItems, [unifiedItems]);

  // Search filter
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  const filteredItems = useMemo(() => {
    if (!searchQuery) return selectableItems;
    const q = searchQuery.toLowerCase();
    return selectableItems.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.type === 'plugin' &&
          item.plugin.manifest.description?.toLowerCase().includes(q)),
    );
  }, [selectableItems, searchQuery]);

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const [detailFieldIndex, setDetailFieldIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  // Derive detailItem and detailPlugin from live unifiedItems
  const detailItem = useMemo(
    () =>
      detailItemId
        ? (unifiedItems.find((i) => i.id === detailItemId) ?? null)
        : null,
    [detailItemId, unifiedItems],
  );

  const detailPlugin = useMemo(
    () => (detailItem?.type === 'plugin' ? detailItem.plugin : null),
    [detailItem],
  );

  // Pagination
  const pagination = usePagination<UnifiedInstalledItem>({
    totalItems: filteredItems.length,
    maxVisible: MAX_VISIBLE_ITEMS,
    selectedIndex,
  });

  const visibleItems = pagination.getVisibleItems(filteredItems);
  const togglingPluginIdsRef = useRef(new Set<string>());

  const togglePlugin = useCallback(
    async (
      pluginId: string,
      label: string,
      enabled: boolean,
      scope: ReturnType<typeof resolveScopeForPlugin>,
    ) => {
      if (togglingPluginIdsRef.current.has(pluginId)) return;
      togglingPluginIdsRef.current.add(pluginId);
      const isBuiltin = config
        ?.getPlugins()
        .some(
          (plugin) =>
            plugin.isBuiltin &&
            buildPluginId(plugin.name, plugin.source) === pluginId,
        );
      try {
        await setPluginEnabledForCommand({
          plugin: pluginId,
          enabled,
          settings,
          config,
          scope,
        });
        if (!mountedRef.current) return;
        onPluginsChanged?.();
        setStatusMessage(
          `✓ ${label} ${enabled ? 'enabled' : 'disabled'}.${isBuiltin ? '' : ' Run /plugins reload to apply.'}`,
        );
      } catch (err) {
        if (!mountedRef.current) return;
        setStatusMessage(
          `✗ ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        togglingPluginIdsRef.current.delete(pluginId);
      }
    },
    [onPluginsChanged, settings, config],
  );

  // Auto-execute target action on mount
  const autoExecutedRef = useRef(false);
  useEffect(() => {
    if (targetPlugin && targetAction && !autoExecutedRef.current) {
      autoExecutedRef.current = true;
      const plugin = allPlugins.find((p) => p.name === targetPlugin);
      if (!plugin) {
        setStatusMessage(`Plugin '${targetPlugin}' not found.`);
        return;
      }

      if (targetAction === 'enable' || targetAction === 'disable') {
        if (plugin.source === 'flag') {
          setStatusMessage(flagPluginToggleError(targetPlugin));
          return;
        }
        const enabled = targetAction === 'enable';
        const pluginId = buildPluginId(plugin.name, plugin.source);
        const targetItem = unifiedItems.find(
          (item): item is UnifiedPluginItem =>
            item.type === 'plugin' &&
            item.id === `plugin-${plugin.name}` &&
            !item.shadowed,
        );
        if (targetItem?.canToggle === false) {
          setStatusMessage(
            presentation.get(targetItem.id)?.toggleDisabledReason ??
              `Plugin "${targetPlugin}" cannot be toggled.`,
          );
          return;
        }
        const scope =
          getInstalledToggleScope(targetItem) ??
          resolveScopeForPlugin(pluginId, settings);
        void togglePlugin(pluginId, targetPlugin, enabled, scope);
      } else if (targetAction === 'uninstall') {
        // Find the unified item for this plugin to get its id
        const targetItem = unifiedItems.find(
          (i) => i.type === 'plugin' && i.id === `plugin-${plugin.name}`,
        );
        if (
          targetItem &&
          !presentation
            .get(targetItem.id)
            ?.fields.some(
              (field) => field.action === 'uninstall' && !field.disabled,
            )
        ) {
          setStatusMessage(
            presentation.get(targetItem.id)?.uninstallDisabledReason ??
              `Plugin "${targetPlugin}" cannot be uninstalled.`,
          );
          return;
        }
        if (targetItem) {
          setDetailItemId(targetItem.id);
        } else {
          setDetailItemId(`plugin-${plugin.name}`);
        }
        setViewMode('confirm-uninstall');
      }
    }
  }, [
    targetPlugin,
    targetAction,
    allPlugins,
    unifiedItems,
    settings,
    togglePlugin,
    presentation,
  ]);

  // ---------------------------------------------------------------------------
  // List operations
  // ---------------------------------------------------------------------------

  const handleToggle = useCallback(
    (item: UnifiedInstalledItem) => {
      if (item.type !== 'plugin') {
        if (item.type === 'pending-plugin') {
          if (item.shadowed) {
            setStatusMessage(
              `This "${item.name}" installation (${item.scope} scope) is shadowed by ${item.shadowedBy} scope.`,
            );
          } else {
            setStatusMessage(
              `Plugin "${item.name}" needs reload first. Run /plugins reload to activate.`,
            );
          }
        }
        return;
      }
      if (item.shadowed) {
        setStatusMessage(
          `This "${item.name}" installation (${item.installScope} scope) is shadowed by ${item.shadowedBy} scope.`,
        );
        return;
      }
      if (item.plugin.source === 'flag') {
        setStatusMessage(flagPluginToggleError(item.name));
        return;
      }
      if (item.canToggle === false) {
        setStatusMessage(
          presentation.get(item.id)?.toggleDisabledReason ??
            `Plugin "${item.name}" cannot be toggled.`,
        );
        return;
      }

      const currentlyEnabled = item.isEnabled;
      const newEnabled = !currentlyEnabled;
      const pluginId = buildPluginId(item.plugin.name, item.plugin.source);
      const scope =
        getInstalledToggleScope(item) ??
        resolveScopeForPlugin(pluginId, settings);
      void togglePlugin(pluginId, item.name, newEnabled, scope);
    },
    [settings, togglePlugin, presentation],
  );

  const openDetail = useCallback((item: UnifiedInstalledItem) => {
    setDetailItemId(item.id);
    setDetailFieldIndex(0);
    setStatusMessage(null);

    switch (item.type) {
      case 'plugin':
        setViewMode('plugin-details');
        break;
      case 'failed-plugin':
        setViewMode('failed-plugin-details');
        break;
      case 'mcp-server':
        setViewMode('mcp-detail');
        break;
      case 'pending-plugin':
        setViewMode('pending-plugin-details');
        break;
      default:
        break;
    }
  }, []);

  const backToList = useCallback(() => {
    setViewMode('list');
    setDetailItemId(null);
    setDetailFieldIndex(0);
  }, []);

  // ---------------------------------------------------------------------------
  // List keyboard handling — new action handler system
  // ---------------------------------------------------------------------------

  const listActionHandlers = useMemo(
    () => ({
      'dialog:navigate:up': () => {
        if (isSearching) return false;
        setSelectedIndex((i) => Math.max(0, i - 1));
        return true;
      },
      'dialog:navigate:down': () => {
        if (isSearching) return false;
        setSelectedIndex((i) => Math.min(filteredItems.length - 1, i + 1));
        return true;
      },
      'dialog:confirm': () => {
        if (isSearching) {
          setIsSearching(false);
          return true;
        }
        const item = filteredItems[selectedIndex];
        if (item) openDetail(item);
        return true;
      },
      'dialog:escape': () => {
        if (isSearching) {
          if (searchQuery) {
            setSearchQuery('');
          } else {
            setIsSearching(false);
          }
          return true;
        }
        if (searchQuery) {
          setSearchQuery('');
          return true;
        }
        onClose();
        return true;
      },
      'edit:deleteLeft': () => {
        if (isSearching) {
          setSearchQuery((prev) => prev.slice(0, -1));
          return true;
        }
        return false;
      },
    }),
    [
      isSearching,
      searchQuery,
      filteredItems,
      selectedIndex,
      openDetail,
      onClose,
    ],
  );

  const listFallbackHandler = useCallback(
    (key: Key): boolean | void => {
      if (isSearching) {
        // Search mode: printable chars
        if (key.insertable && !key.ctrl && !key.alt && !key.cmd) {
          setSearchQuery((prev) => prev + key.sequence);
          setSelectedIndex(0);
          return true;
        }
        return false;
      }

      // Non-search mode fallbacks
      // Space: toggle enable/disable
      if (key.insertable && key.sequence === ' ') {
        const item = filteredItems[selectedIndex];
        if (item) handleToggle(item);
        return true;
      }

      // '/': activate search
      if (key.insertable && key.sequence === '/') {
        setIsSearching(true);
        return true;
      }

      return false;
    },
    [isSearching, filteredItems, selectedIndex, handleToggle],
  );

  useRegisterActionHandlers('Dialog', listActionHandlers, viewMode === 'list');

  useRegisterFallbackHandler(
    'Dialog',
    listFallbackHandler,
    viewMode === 'list',
  );

  // ---------------------------------------------------------------------------
  // Plugin details view
  // ---------------------------------------------------------------------------

  const detailFields = useMemo(
    () => (detailItem ? (presentation.get(detailItem.id)?.fields ?? []) : []),
    [detailItem, presentation],
  );

  const handleDetailAction = useCallback(
    (field: PluginDetailField) => {
      if (!detailPlugin || !detailItem) return;

      switch (field.action) {
        case 'toggle': {
          if (detailItem.type === 'plugin') {
            handleToggle(detailItem);
          }
          break;
        }
        case 'uninstall':
          setViewMode('confirm-uninstall');
          break;
        case 'open-homepage':
          if (field.value) {
            void openBrowserSecurely(field.value);
          }
          break;
        case 'view-repository':
          if (field.value) {
            void openBrowserSecurely(field.value);
          }
          break;
        default:
          break;
      }
    },
    [detailPlugin, detailItem, handleToggle],
  );

  const detailActionHandlers = useMemo(
    () => ({
      'dialog:navigate:up': () => {
        setDetailFieldIndex((i) => Math.max(0, i - 1));
        return true;
      },
      'dialog:navigate:down': () => {
        setDetailFieldIndex((i) => Math.min(detailFields.length - 1, i + 1));
        return true;
      },
      'dialog:confirm': () => {
        const field = detailFields[detailFieldIndex];
        if (field?.action && !field.disabled) handleDetailAction(field);
        return true;
      },
      'dialog:escape': () => {
        backToList();
        return true;
      },
    }),
    [detailFields, detailFieldIndex, handleDetailAction, backToList],
  );

  useRegisterActionHandlers(
    'Dialog',
    detailActionHandlers,
    viewMode === 'plugin-details',
  );

  // ---------------------------------------------------------------------------
  // Confirm uninstall
  // ---------------------------------------------------------------------------

  const handleUninstall = useCallback(
    async (deleteData: boolean) => {
      if (!detailPlugin || processing) return;
      setProcessing(true);
      setStatusMessage(`Uninstalling ${detailPlugin.name}...`);

      try {
        const pluginId = buildPluginId(detailPlugin.name, detailPlugin.source);
        const itemScope =
          detailItem?.type === 'plugin' ? detailItem.installScope : undefined;
        const targetScope =
          itemScope === 'user' ||
          itemScope === 'project' ||
          itemScope === 'local'
            ? itemScope
            : resolveScopeForPlugin(pluginId, settings);
        const operation = await uninstallPluginForCommand({
          plugin: pluginId,
          scope: targetScope,
          settings,
          config,
          keepData: !deleteData,
        });

        if (mountedRef.current) {
          onPluginsChanged?.();
          setStatusMessage(`✓ ${formatPluginMutationMessage(operation)}`);
          backToList();
          setProcessing(false);
        }
      } catch (err) {
        if (mountedRef.current) {
          setStatusMessage(
            `✗ Failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          setViewMode('plugin-details');
          setProcessing(false);
        }
      }
    },
    [
      config,
      detailPlugin,
      detailItem,
      processing,
      backToList,
      onPluginsChanged,
      settings,
    ],
  );

  const confirmActionHandlers = useMemo(
    () => ({
      'dialog:escape': () => {
        setViewMode('plugin-details');
        return true;
      },
    }),
    [],
  );

  const confirmFallbackHandler = useCallback(
    (key: Key): boolean | void => {
      if (key.insertable && !key.ctrl && !key.alt && !key.cmd) {
        const ch = key.sequence.toLowerCase();
        if (ch === 'y') {
          if (viewMode === 'confirm-uninstall') {
            // Ask about data cleanup
            setViewMode('confirm-data-cleanup');
          } else if (viewMode === 'confirm-data-cleanup') {
            void handleUninstall(true);
          }
          return true;
        }
        if (ch === 'n') {
          if (viewMode === 'confirm-data-cleanup') {
            void handleUninstall(false);
          } else {
            setViewMode('plugin-details');
          }
          return true;
        }
      }
      return false;
    },
    [viewMode, handleUninstall],
  );

  useRegisterActionHandlers(
    'Dialog',
    confirmActionHandlers,
    viewMode === 'confirm-uninstall' || viewMode === 'confirm-data-cleanup',
  );

  useRegisterFallbackHandler(
    'Dialog',
    confirmFallbackHandler,
    viewMode === 'confirm-uninstall' || viewMode === 'confirm-data-cleanup',
  );

  // ---------------------------------------------------------------------------
  // Shared escape-to-list handler for simple detail views
  // ---------------------------------------------------------------------------

  const escapeToListHandlers = useMemo(
    () => ({
      'dialog:escape': () => {
        backToList();
        return true;
      },
    }),
    [backToList],
  );

  useRegisterActionHandlers(
    'Dialog',
    escapeToListHandlers,
    viewMode === 'failed-plugin-details' ||
      viewMode === 'mcp-detail' ||
      viewMode === 'pending-plugin-details',
  );

  return {
    selectableItems,
    viewMode,
    detailPlugin,
    detailItem,
    detailFields,
    detailFieldIndex,
    processing,
    statusMessage,
    isSearching,
    searchQuery,
    filteredItems,
    pagination,
    visibleItems,
    selectedIndex,
    scopeGroupBoundaries,
    presentation,
  };
}

export type InstalledPluginsController = ReturnType<
  typeof useInstalledPluginsController
>;
