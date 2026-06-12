/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { keyMatchers, Command } from '../../../keyMatchers.js';
import { t } from '../../../../i18n/index.js';
import {
  type Config,
  type Extension,
  type ExtensionScope,
  type MCPServerConfig,
  SettingScope,
  MCPServerStatus,
  getMCPServerStatus,
  removeMCPServerStatus,
  addMCPStatusChangeListener,
  removeMCPStatusChangeListener,
  mcpServerRequiresOAuth,
  MCPOAuthTokenStorage,
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
import { McpServerActionsView } from '../views/McpServerActionsView.js';
import { ExtensionActionsView } from '../views/ExtensionActionsView.js';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';

const debugLogger = createDebugLogger('INSTALLED_TAB');

const GROUP_ORDER: InstalledGroup[] = [
  'favorites',
  'user',
  'project',
  'disabled',
];

// Localized group/scope label. Literal t() calls keep the strings extractable.
const groupLabel = (group: InstalledGroup): string => {
  switch (group) {
    case 'favorites':
      return t('Favorites');
    case 'user':
      return t('User level');
    case 'project':
      return t('Project level');
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
  // Guards against overlapping mutations (e.g. mashing Space) while an
  // enable/disable is still being applied.
  const mutatingRef = useRef(false);

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

      // MCP servers: standalone ones are top-level rows; extension-bundled
      // ones are nested under their parent extension.
      const mcpServers = config.getMcpServers() ?? {};
      const hasAnyMcp =
        Object.keys(mcpServers).length > 0 ||
        extensions.some((ext) => Object.keys(ext.mcpServers ?? {}).length > 0);
      // Only touch settings/tool registry when there are MCP servers.
      const workspaceMcp = hasAnyMcp
        ? loadSettings().forScope(CliSettingScope.Workspace).settings.mcpServers
        : undefined;
      const toolRegistry = hasAnyMcp ? config.getToolRegistry() : undefined;

      // Servers that need (re-)authentication: either the connect attempt hit
      // a 401 (runtime signal), or OAuth is declared but no token is stored.
      // Connected servers are skipped — they are evidently authenticated.
      const needsAuthNames = new Set<string>();
      for (const [name, sc] of Object.entries(mcpServers)) {
        if (getMCPServerStatus(name) === MCPServerStatus.CONNECTED) continue;
        if (mcpServerRequiresOAuth.get(name)) {
          needsAuthNames.add(name);
          continue;
        }
        if (sc.oauth?.enabled) {
          try {
            const creds = await new MCPOAuthTokenStorage().getCredentials(name);
            if (!creds) needsAuthNames.add(name);
          } catch {
            needsAuthNames.add(name);
          }
        }
      }

      const buildMcpInfo = (
        name: string,
        serverConfig: MCPServerConfig,
        scope: InstalledMcpInfo['scope'],
        isDisabled: boolean,
      ): InstalledMcpInfo => {
        // Status (and the status-derived needs-auth flag) are read here, in
        // the same synchronous tick as setItems, so a transition during the
        // earlier token-check awaits can't leave a stale combination.
        const status = getMCPServerStatus(name);
        return {
          name,
          status,
          scope,
          isDisabled,
          requiresAuth:
            status === MCPServerStatus.CONNECTED
              ? false
              : mcpServerRequiresOAuth.get(name) === true ||
                needsAuthNames.has(name),
          transport: serverConfig.command
            ? 'stdio'
            : serverConfig.httpUrl
              ? 'http'
              : serverConfig.url
                ? 'sse'
                : 'unknown',
          toolCount:
            toolRegistry
              ?.getAllTools()
              .filter(
                (tool) => (tool as { serverName?: string }).serverName === name,
              ).length ?? 0,
        };
      };

      const mcpItems: InstalledItem[] = [];
      for (const [name, serverConfig] of Object.entries(mcpServers)) {
        if (serverConfig.extensionName) continue;
        const scope: InstalledMcpInfo['scope'] = workspaceMcp?.[name]
          ? 'project'
          : 'user';
        const isDisabled = config.isMcpServerDisabled(name);
        const isFavorite = favorites.has(name);
        mcpItems.push({
          kind: 'mcp',
          key: `mcp:${name}`,
          name,
          mcp: buildMcpInfo(name, serverConfig, scope, isDisabled),
          isActive: !isDisabled,
          isFavorite,
          group: groupFor(!isDisabled, isFavorite, scope),
        });
      }

      // Extension-bundled MCP servers, keyed by parent extension name. They
      // inherit the parent's group so they always render right under it.
      const childMcpItems = new Map<string, InstalledItem[]>();
      for (const item of pluginItems) {
        if (item.kind !== 'plugin') continue;
        const ext = item.extension;
        const children: InstalledItem[] = [];
        for (const name of Object.keys(ext.mcpServers ?? {})) {
          const merged = mcpServers[name];
          // The merged runtime config wins on name collisions (a user/project
          // server, or another extension's, shadows this one) — don't render a
          // child row for a server this extension didn't actually contribute.
          if (merged && merged.extensionName !== ext.name) continue;
          // Active extension but absent from the runtime config: blocked by
          // the MCP allow-list. Hide it, matching standalone behavior.
          if (!merged && ext.isActive) continue;
          const isDisabled = !ext.isActive || config.isMcpServerDisabled(name);
          children.push({
            kind: 'mcp',
            key: `mcp:${ext.name}:${name}`,
            name,
            mcp: buildMcpInfo(
              name,
              merged ?? ext.mcpServers![name],
              'extension',
              isDisabled,
            ),
            isActive: !isDisabled,
            isFavorite: false,
            group: item.group,
            parentExtension: ext.name,
          });
        }
        if (children.length) childMcpItems.set(ext.name, children);
      }

      const topLevel = [...pluginItems, ...mcpItems];
      // Stable sort by group order then name.
      topLevel.sort((a, b) => {
        const ga = GROUP_ORDER.indexOf(a.group);
        const gb = GROUP_ORDER.indexOf(b.group);
        if (ga !== gb) return ga - gb;
        return a.name.localeCompare(b.name);
      });
      // Expand each extension's bundled MCP servers directly beneath it.
      const all: InstalledItem[] = [];
      for (const item of topLevel) {
        all.push(item);
        if (item.kind === 'plugin') {
          all.push(...(childMcpItems.get(item.name) ?? []));
        }
      }
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

  // Live-update MCP rows when a server's connection status changes (e.g. a
  // "connecting" server finishing) without re-running the full load().
  useEffect(() => {
    const listener = (serverName: string, status?: MCPServerStatus) => {
      if (status === undefined) return; // removals are handled by reloads
      setItems((prev) =>
        prev.map((it) =>
          it.kind === 'mcp' && it.mcp.name === serverName
            ? {
                ...it,
                mcp: {
                  ...it.mcp,
                  status,
                  requiresAuth:
                    status === MCPServerStatus.CONNECTED
                      ? false
                      : mcpServerRequiresOAuth.get(serverName) === true ||
                        it.mcp.requiresAuth,
                },
              }
            : it,
        ),
      );
    };
    addMCPStatusChangeListener(listener);
    return () => removeMCPStatusChangeListener(listener);
  }, []);

  const { rows: terminalRows } = useTerminalSize();
  // One line per display row; reserve space for the dialog border, tab bar,
  // scroll hints, status line (which may wrap) and footer around this tab.
  const visibleCount = Math.max(6, (terminalRows || 24) - 12);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Flatten the grouped list into display rows (headers, items, gaps) so the
  // list can be windowed to the terminal height.
  type DisplayRow =
    | { type: 'header'; group: InstalledGroup; count: number }
    | { type: 'item'; item: InstalledItem }
    | { type: 'gap' };
  const displayRows = useMemo(() => {
    const out: DisplayRow[] = [];
    for (const group of GROUP_ORDER) {
      const rows = items.filter((it) => it.group === group);
      if (!rows.length) continue;
      out.push({
        type: 'header',
        group,
        // Bundled MCP rows travel with their extension; the header counts
        // only top-level entries.
        count: rows.filter((it) => !(it.kind === 'mcp' && it.parentExtension))
          .length,
      });
      for (const item of rows) out.push({ type: 'item', item });
      out.push({ type: 'gap' });
    }
    if (out.at(-1)?.type === 'gap') out.pop();
    return out;
  }, [items]);

  // Keep the cursor — and its group header when directly above — visible,
  // and re-clamp the offset when the list shrinks or the window grows.
  useEffect(() => {
    const maxOffset = Math.max(0, displayRows.length - visibleCount);
    if (scrollOffset > maxOffset) {
      setScrollOffset(maxOffset);
      return;
    }
    const idx = displayRows.findIndex(
      (r) => r.type === 'item' && r.item.key === selectedItem?.key,
    );
    if (idx < 0) return;
    const top = displayRows[idx - 1]?.type === 'header' ? idx - 1 : idx;
    if (top < scrollOffset) {
      setScrollOffset(top);
    } else if (idx >= scrollOffset + visibleCount) {
      setScrollOffset(idx - visibleCount + 1);
    }
  }, [displayRows, selectedItem, scrollOffset, visibleCount]);

  const goToList = useCallback(() => {
    setView('list');
    onLockChange(false);
  }, [onLockChange]);

  // If a reload removed (or re-typed) the item whose detail is open, fall back
  // to the list — otherwise the tab stays locked with no active key handler.
  useEffect(() => {
    if (view === 'list' || loading) return;
    const matches =
      selectedItem && (view === 'mcp-detail') === (selectedItem.kind === 'mcp');
    if (!matches) goToList();
  }, [view, loading, selectedItem, goToList]);

  const isParentExtensionActive = useCallback(
    (item: Extract<InstalledItem, { kind: 'mcp' }>): boolean =>
      items.some(
        (p) =>
          p.kind === 'plugin' && p.name === item.parentExtension && p.isActive,
      ),
    [items],
  );

  const enterDetail = useCallback(
    (item: InstalledItem) => {
      // A disabled extension's servers are not loaded into the runtime config,
      // so the MCP detail view would have nothing to show.
      if (
        item.kind === 'mcp' &&
        item.parentExtension &&
        !isParentExtensionActive(item)
      ) {
        onStatus({
          type: 'info',
          text: t('Enable extension "{{name}}" to manage this MCP server.', {
            name: item.parentExtension,
          }),
        });
        return;
      }
      onStatus(null);
      setView(item.kind === 'plugin' ? 'plugin-detail' : 'mcp-detail');
      onLockChange(true);
    },
    [onLockChange, onStatus, isParentExtensionActive],
  );

  const togglePlugin = useCallback(
    async (item: Extract<InstalledItem, { kind: 'plugin' }>) => {
      if (!extensionManager || mutatingRef.current) return;
      const scope =
        item.scope === 'user' ? SettingScope.User : SettingScope.Workspace;
      mutatingRef.current = true;
      onStatus({
        type: 'info',
        text: item.isActive
          ? t('Disabling "{{name}}"...', { name: item.name })
          : t('Enabling "{{name}}"...', { name: item.name }),
      });
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
      } finally {
        mutatingRef.current = false;
      }
    },
    [extensionManager, load, onStatus],
  );

  const toggleMcp = useCallback(
    async (item: Extract<InstalledItem, { kind: 'mcp' }>) => {
      if (mutatingRef.current) return;
      if (item.parentExtension) {
        if (!isParentExtensionActive(item)) {
          onStatus({
            type: 'info',
            text: t('Enable extension "{{name}}" to manage this MCP server.', {
              name: item.parentExtension,
            }),
          });
          return;
        }
        if (item.isActive) {
          // Disable via the extension-scoped preference (not the global
          // mcp.excluded list) so same-named servers from other sources are
          // unaffected and uninstalling the extension cleans it up.
          if (!extensionManager) return;
          mutatingRef.current = true;
          onStatus({
            type: 'info',
            text: t('Disabling MCP "{{name}}"...', { name: item.name }),
          });
          try {
            extensionManager.setMcpServerDisabled(
              item.parentExtension,
              item.name,
              true,
            );
            await config.getToolRegistry()?.disconnectServer(item.name);
            // Drop the status entry so the footer health pill doesn't keep
            // counting an intentionally disabled server as offline.
            removeMCPServerStatus(item.name);
            // The per-extension disable record is user-global, unlike the
            // scope-aware standalone toggle — say so.
            onStatus({
              type: 'success',
              text: t('MCP "{{name}}" disabled for all projects.', {
                name: item.name,
              }),
            });
            await load();
          } catch (error) {
            onStatus({ type: 'error', text: getErrorMessage(error) });
          } finally {
            mutatingRef.current = false;
          }
          return;
        }
        // Enable: clear the extension-scoped flag, then fall through to the
        // shared enable path (which also clears any manual exclusions).
        extensionManager?.setMcpServerDisabled(
          item.parentExtension,
          item.name,
          false,
        );
      }
      const toolRegistry = config.getToolRegistry();
      mutatingRef.current = true;
      // Enabling rediscovers the server's tools, which can take a while.
      onStatus({
        type: 'info',
        text: item.isActive
          ? t('Disabling MCP "{{name}}"...', { name: item.name })
          : t('Enabling MCP "{{name}}"...', { name: item.name }),
      });
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
      } finally {
        mutatingRef.current = false;
      }
    },
    [config, extensionManager, load, onStatus, isParentExtensionActive],
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
        if (!selectedItem || mutatingRef.current) return;
        // Bundled MCP servers stay nested under their extension, so they
        // cannot be favorited independently.
        if (selectedItem.kind === 'mcp' && selectedItem.parentExtension) {
          onStatus({
            type: 'info',
            text: t('Extension-provided MCP servers cannot be favorited.'),
          });
          return;
        }
        void toggleFavorite(selectedItem);
      }
    },
    { isActive: isActive && view === 'list' },
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
    return (
      <McpServerActionsView
        config={config}
        serverName={selectedItem.mcp.name}
        isActive={isActive}
        onStatus={onStatus}
        onReload={load}
        onExit={goToList}
      />
    );
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

  // Windowed list rendering. A gap row at the window's top edge would render
  // as a stray blank line under the "more above" hint, so trim it.
  const visibleRows = displayRows.slice(
    scrollOffset,
    scrollOffset + visibleCount,
  );
  while (visibleRows[0]?.type === 'gap') visibleRows.shift();
  const hasAbove = scrollOffset > 0;
  const hasBelow = scrollOffset + visibleCount < displayRows.length;

  return (
    <Box flexDirection="column">
      {hasAbove ? (
        <Text color={theme.text.secondary}>{t('↑ more above')}</Text>
      ) : null}
      {visibleRows.map((row, i) => {
        if (row.type === 'gap') {
          return <Box key={`gap-${scrollOffset + i}`} height={1} />;
        }
        if (row.type === 'header') {
          return (
            <Text key={`header-${row.group}`} color={theme.text.accent} bold>
              {groupLabel(row.group)} ({row.count})
            </Text>
          );
        }
        const item = row.item;
        const globalIndex = items.indexOf(item);
        const isSelected = globalIndex === selectedIndex;
        const marker = isSelected ? '●' : ' ';
        const isChild = item.kind === 'mcp' && !!item.parentExtension;
        const kindBadge =
          item.kind === 'mcp'
            ? t('MCP')
            : t('Extension v{{version}}', {
                version: item.extension.version,
              });
        // MCP rows surface the live connection state — "enabled" alone would
        // read as usable even when the server failed to connect or still
        // needs authentication.
        let statusLabel: string;
        let statusColor: string;
        if (item.kind === 'mcp') {
          if (!item.isActive) {
            statusLabel = t('disabled');
            statusColor = theme.text.secondary;
          } else if (item.mcp.status === MCPServerStatus.CONNECTED) {
            statusLabel = t('connected');
            statusColor = theme.status.success;
          } else if (item.mcp.requiresAuth) {
            statusLabel = t('needs authentication');
            statusColor = theme.status.warning;
          } else if (item.mcp.status === MCPServerStatus.CONNECTING) {
            statusLabel = t('connecting');
            statusColor = theme.status.warning;
          } else {
            statusLabel = t('disconnected');
            statusColor = theme.status.error;
          }
        } else {
          statusLabel = item.isActive ? t('active') : t('disabled');
          statusColor = item.isActive
            ? theme.status.success
            : theme.text.secondary;
        }
        return (
          <Box key={item.key}>
            <Box minWidth={2} flexShrink={0}>
              <Text color={isSelected ? theme.text.accent : theme.text.primary}>
                {marker}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={isSelected ? theme.text.accent : theme.text.primary}>
                {isChild ? '  └ ' : ''}
                {item.name}
              </Text>
              {item.isFavorite ? (
                <Text color={theme.status.warning}> ★</Text>
              ) : null}
            </Box>
            <Text color={isSelected ? theme.text.accent : theme.text.secondary}>
              {kindBadge}{' '}
            </Text>
            <Text color={isSelected ? theme.text.accent : statusColor}>
              ({statusLabel})
            </Text>
          </Box>
        );
      })}
      {hasBelow ? (
        <Text color={theme.text.secondary}>{t('↓ more below')}</Text>
      ) : null}
    </Box>
  );
};
