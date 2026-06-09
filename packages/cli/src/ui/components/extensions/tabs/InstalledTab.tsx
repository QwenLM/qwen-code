/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../../keyMatchers.js';
import { t } from '../../../../i18n/index.js';
import {
  type Config,
  type Extension,
  type ExtensionScope,
  SettingScope,
  getMCPServerStatus,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import {
  loadSettings,
  SettingScope as CliSettingScope,
} from '../../../../config/settings.js';
import { getErrorMessage } from '../../../../utils/errors.js';
import type {
  InstalledItem,
  InstalledGroup,
  InstalledMcpInfo,
} from '../types.js';
import { McpDetailView } from '../views/McpDetailView.js';
import { ExtensionActionsView } from '../views/ExtensionActionsView.js';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';

const debugLogger = createDebugLogger('INSTALLED_TAB');

const GROUP_ORDER: InstalledGroup[] = [
  'favorites',
  'local',
  'user',
  'project',
  'disabled',
];

// Localized group/scope label. Literal t() calls keep the strings extractable.
const groupLabel = (group: InstalledGroup): string => {
  switch (group) {
    case 'favorites':
      return t('Favorites');
    case 'local':
      return t('Local');
    case 'user':
      return t('User');
    case 'project':
      return t('Project');
    case 'disabled':
      return t('Disabled');
    default:
      return group;
  }
};

type InstalledView = 'list' | 'plugin-detail' | 'mcp-detail';

interface InstalledTabProps {
  config: Config;
  isActive: boolean;
  onLockChange: (locked: boolean) => void;
  onStatus: (status: StatusMessage | null) => void;
  extensionsUpdateState: Map<string, string>;
  reloadSignal: number;
}

function groupFor(
  isActive: boolean,
  isFavorite: boolean,
  scope: InstalledGroup | ExtensionScope,
): InstalledGroup {
  if (!isActive) return 'disabled';
  if (isFavorite) return 'favorites';
  if (scope === 'project') return 'project';
  if (scope === 'local') return 'local';
  return 'user';
}

export const InstalledTab = ({
  config,
  isActive,
  onLockChange,
  onStatus,
  extensionsUpdateState,
  reloadSignal,
}: InstalledTabProps) => {
  const [items, setItems] = useState<InstalledItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<InstalledView>('list');
  const [loading, setLoading] = useState(true);
  // Tracks the currently-selected item's stable key so that after a reload
  // re-sorts the list (e.g. favorite/enable/disable moves an item to another
  // group) the cursor — and any open detail view — stays on the SAME item
  // rather than whatever now sits at the old index.
  const selectedKeyRef = useRef<string | null>(null);

  const extensionManager = config.getExtensionManager();

  const load = useCallback(async () => {
    if (!extensionManager) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      await extensionManager.refreshCache();
      const extensions = extensionManager.getLoadedExtensions();
      const favorites = new Set(extensionManager.getFavorites());
      const scopes = extensionManager.getExtensionScopes();

      const pluginItems: InstalledItem[] = extensions.map((ext: Extension) => {
        const isFavorite = favorites.has(ext.name);
        const scope: ExtensionScope = scopes[ext.name] ?? 'user';
        return {
          kind: 'plugin',
          key: `plugin:${ext.name}`,
          name: ext.name,
          extension: ext,
          isActive: ext.isActive,
          isFavorite,
          scope,
          group: groupFor(ext.isActive, isFavorite, scope),
        };
      });

      // Standalone MCP servers (those owned by extensions are surfaced as the
      // plugin's components, so they are excluded here).
      const mcpItems: InstalledItem[] = [];
      const mcpServers = config.getMcpServers() ?? {};
      const standaloneNames = Object.keys(mcpServers).filter(
        (name) => !mcpServers[name].extensionName,
      );
      // Only touch settings/tool registry when there are standalone MCP servers.
      const workspaceMcp = standaloneNames.length
        ? loadSettings().forScope(CliSettingScope.Workspace).settings.mcpServers
        : undefined;
      const toolRegistry = standaloneNames.length
        ? config.getToolRegistry()
        : undefined;
      for (const [name, serverConfig] of Object.entries(mcpServers)) {
        if (serverConfig.extensionName) continue;
        const scope: InstalledMcpInfo['scope'] = workspaceMcp?.[name]
          ? 'project'
          : 'user';
        const isDisabled = config.isMcpServerDisabled(name);
        const isFavorite = favorites.has(name);
        const toolCount =
          toolRegistry
            ?.getAllTools()
            .filter(
              (tool) => (tool as { serverName?: string }).serverName === name,
            ).length ?? 0;
        const transport = serverConfig.command
          ? 'stdio'
          : serverConfig.httpUrl
            ? 'http'
            : serverConfig.url
              ? 'sse'
              : 'unknown';
        const mcp: InstalledMcpInfo = {
          name,
          status: getMCPServerStatus(name),
          scope,
          isDisabled,
          transport,
          toolCount,
        };
        mcpItems.push({
          kind: 'mcp',
          key: `mcp:${name}`,
          name,
          mcp,
          isActive: !isDisabled,
          isFavorite,
          group: groupFor(!isDisabled, isFavorite, scope),
        });
      }

      const all = [...pluginItems, ...mcpItems];
      // Stable sort by group order then name.
      all.sort((a, b) => {
        const ga = GROUP_ORDER.indexOf(a.group);
        const gb = GROUP_ORDER.indexOf(b.group);
        if (ga !== gb) return ga - gb;
        return a.name.localeCompare(b.name);
      });
      setItems(all);
      // Re-point the cursor at the same item by key (it may have moved groups).
      const prevKey = selectedKeyRef.current;
      setSelectedIndex((prev) => {
        if (prevKey) {
          const idx = all.findIndex((it) => it.key === prevKey);
          if (idx >= 0) return idx;
        }
        return prev < all.length ? prev : 0;
      });
    } catch (error) {
      debugLogger.error('Failed to load installed items:', error);
    } finally {
      setLoading(false);
    }
  }, [config, extensionManager]);

  useEffect(() => {
    load();
  }, [load, reloadSignal]);

  const selectedItem = items[selectedIndex] ?? null;

  // Keep the stable-key ref in sync with the current selection.
  useEffect(() => {
    selectedKeyRef.current = selectedItem?.key ?? null;
  }, [selectedItem]);

  const goToList = useCallback(() => {
    setView('list');
    onLockChange(false);
  }, [onLockChange]);

  const enterDetail = useCallback(
    (item: InstalledItem) => {
      onStatus(null);
      setView(item.kind === 'plugin' ? 'plugin-detail' : 'mcp-detail');
      onLockChange(true);
    },
    [onLockChange, onStatus],
  );

  const togglePlugin = useCallback(
    async (item: Extract<InstalledItem, { kind: 'plugin' }>) => {
      if (!extensionManager) return;
      const scope =
        item.scope === 'user' ? SettingScope.User : SettingScope.Workspace;
      try {
        if (item.isActive) {
          await extensionManager.disableExtension(item.name, scope);
        } else {
          await extensionManager.enableExtension(item.name, scope);
        }
        onStatus({
          type: 'success',
          text: t('"{{name}}" {{state}}.', {
            name: item.name,
            state: item.isActive ? t('disabled') : t('enabled'),
          }),
        });
        await load();
      } catch (error) {
        onStatus({ type: 'error', text: getErrorMessage(error) });
      }
    },
    [extensionManager, load, onStatus],
  );

  const toggleMcp = useCallback(
    async (item: Extract<InstalledItem, { kind: 'mcp' }>) => {
      const toolRegistry = config.getToolRegistry();
      try {
        const settings = loadSettings();
        const targetScope =
          item.mcp.scope === 'project'
            ? CliSettingScope.Workspace
            : CliSettingScope.User;
        if (item.isActive) {
          // Disable: add to excluded + disconnect.
          const excluded =
            settings.forScope(targetScope).settings.mcp?.excluded ?? [];
          if (!excluded.includes(item.name)) {
            settings.setValue(targetScope, 'mcp.excluded', [
              ...excluded,
              item.name,
            ]);
          }
          await toolRegistry?.disableMcpServer(item.name);
        } else {
          // Enable: remove from excluded in both scopes + rediscover.
          for (const scope of [
            CliSettingScope.User,
            CliSettingScope.Workspace,
          ]) {
            const excluded =
              settings.forScope(scope).settings.mcp?.excluded ?? [];
            if (excluded.includes(item.name)) {
              settings.setValue(
                scope,
                'mcp.excluded',
                excluded.filter((n: string) => n !== item.name),
              );
            }
          }
          const runtimeExcluded = config.getExcludedMcpServers() ?? [];
          config.setExcludedMcpServers(
            runtimeExcluded.filter((n) => n !== item.name),
          );
          await toolRegistry?.discoverToolsForServer(item.name);
        }
        onStatus({
          type: 'success',
          text: t('MCP "{{name}}" {{state}}.', {
            name: item.name,
            state: item.isActive ? t('disabled') : t('enabled'),
          }),
        });
        await load();
      } catch (error) {
        onStatus({ type: 'error', text: getErrorMessage(error) });
      }
    },
    [config, load, onStatus],
  );

  const toggleFavorite = useCallback(
    async (item: InstalledItem) => {
      if (!extensionManager) return;
      const nowFavorite = extensionManager.toggleFavorite(item.name);
      onStatus({
        type: 'info',
        text: nowFavorite
          ? t('Added "{{name}}" to favorites.', { name: item.name })
          : t('Removed "{{name}}" from favorites.', { name: item.name }),
      });
      await load();
    },
    [extensionManager, load, onStatus],
  );

  // List keyboard handling.
  useKeypress(
    (key) => {
      if (items.length === 0) return;
      if (keyMatchers[Command.SELECTION_UP](key)) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : items.length - 1));
      } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
        setSelectedIndex((prev) => (prev < items.length - 1 ? prev + 1 : 0));
      } else if (key.name === 'return') {
        if (selectedItem) enterDetail(selectedItem);
      } else if (key.name === 'space' || key.sequence === ' ') {
        if (!selectedItem) return;
        if (selectedItem.kind === 'plugin') {
          void togglePlugin(selectedItem);
        } else {
          void toggleMcp(selectedItem);
        }
      } else if (key.sequence === 'f' && !key.ctrl && !key.meta) {
        if (selectedItem) void toggleFavorite(selectedItem);
      }
    },
    { isActive: isActive && view === 'list' },
  );

  // Escape handling for sub-views (the container handles Escape on the list).
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        goToList();
      }
    },
    { isActive: isActive && view === 'mcp-detail' },
  );

  if (loading) {
    return <Text color={theme.text.secondary}>{t('Loading...')}</Text>;
  }

  if (view === 'plugin-detail' && selectedItem?.kind === 'plugin') {
    return (
      <ExtensionActionsView
        config={config}
        extension={selectedItem.extension}
        isActive={isActive}
        updateState={extensionsUpdateState.get(selectedItem.name)}
        onStatus={onStatus}
        onReload={load}
        onExit={goToList}
      />
    );
  }

  if (view === 'mcp-detail' && selectedItem?.kind === 'mcp') {
    return <McpDetailView mcp={selectedItem.mcp} />;
  }

  if (items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('No plugins or MCP servers installed.')}
        </Text>
        <Text color={theme.text.secondary}>
          {t('Use the Discover tab to find and install plugins.')}
        </Text>
      </Box>
    );
  }

  // Grouped list rendering.
  const groups = GROUP_ORDER.map((group) => ({
    group,
    rows: items.filter((it) => it.group === group),
  })).filter((g) => g.rows.length > 0);

  return (
    <Box flexDirection="column">
      {groups.map(({ group, rows }) => (
        <Box key={group} flexDirection="column" marginBottom={1}>
          <Text color={theme.text.accent} bold>
            {groupLabel(group)} ({rows.length})
          </Text>
          {rows.map((item) => {
            const globalIndex = items.indexOf(item);
            const isSelected = globalIndex === selectedIndex;
            const marker = isSelected ? '●' : ' ';
            const kindBadge =
              item.kind === 'mcp'
                ? t('MCP')
                : t('Extension v{{version}}', {
                    version: item.extension.version,
                  });
            const statusColor = item.isActive
              ? theme.status.success
              : theme.text.secondary;
            return (
              <Box key={item.key}>
                <Box minWidth={2} flexShrink={0}>
                  <Text
                    color={isSelected ? theme.text.accent : theme.text.primary}
                  >
                    {marker}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text
                    color={isSelected ? theme.text.accent : theme.text.primary}
                  >
                    {item.name}
                  </Text>
                  {item.isFavorite ? (
                    <Text color={theme.status.warning}> ★</Text>
                  ) : null}
                </Box>
                <Text color={theme.text.secondary}>{kindBadge} </Text>
                <Text color={statusColor}>
                  ({item.isActive ? t('active') : t('disabled')})
                </Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
};
