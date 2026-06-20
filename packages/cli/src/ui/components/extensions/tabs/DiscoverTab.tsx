/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import open from 'open';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { t } from '../../../../i18n/index.js';
import {
  type Config,
  type DiscoveredPlugin,
  type ExtensionScope,
  SettingScope,
  parseInstallSource,
  redactUrlCredentials,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../../../utils/errors.js';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';

const debugLogger = createDebugLogger('DISCOVER_TAB');

type DiscoverView = 'list' | 'detail' | 'scope-select';

interface DiscoverTabProps {
  config: Config;
  isActive: boolean;
  onLockChange: (locked: boolean) => void;
  onStatus: (status: StatusMessage | null) => void;
  onInstalled: () => void;
  /** When set, only plugins from this marketplace are shown. */
  marketplaceFilter?: string;
  reloadSignal: number;
}

/** Formats a raw install count like 787100 -> "787.1K". */
function formatInstalls(n?: number): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function truncateText(text: string, max: number): string {
  if (max <= 1 || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// Built per-render so the literal t() labels stay extractable and localize.
function scopeItems(): Array<{
  key: string;
  label: string;
  value: ExtensionScope;
}> {
  return [
    { key: 'user', label: t('Global (User Scope)'), value: 'user' },
    {
      key: 'project',
      label: t('Project (Workspace)'),
      value: 'project',
    },
  ];
}

export const DiscoverTab = ({
  config,
  isActive,
  onLockChange,
  onStatus,
  onInstalled,
  marketplaceFilter,
  reloadSignal,
}: DiscoverTabProps) => {
  const [plugins, setPlugins] = useState<DiscoveredPlugin[]>([]);
  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [view, setView] = useState<DiscoverView>('list');
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  const { columns, rows } = useTerminalSize();
  const availableWidth = Math.max(24, columns - 8);
  // Each item renders as 3 lines (title, description, gap). Reserve rows for
  // the tab bar, header, search box, scroll hints, status and footer.
  const visibleCount = Math.max(
    3,
    Math.min(6, Math.floor(((rows || 24) - 13) / 3)),
  );

  const extensionManager = config.getExtensionManager();

  const keyOf = (p: DiscoveredPlugin) => `${p.marketplaceName}/${p.name}`;

  const filtered = useMemo(() => {
    const byMarketplace = marketplaceFilter
      ? plugins.filter((p) => p.marketplaceName === marketplaceFilter)
      : plugins;
    const q = query.trim().toLowerCase();
    if (!q) return byMarketplace;
    return byMarketplace.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.marketplaceName.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false),
    );
  }, [plugins, query, marketplaceFilter]);

  // Reset the cursor to the top when the marketplace filter changes.
  useEffect(() => {
    setCursor(0);
    setScrollOffset(0);
  }, [marketplaceFilter]);

  const load = useCallback(
    async (options?: { refresh?: boolean }) => {
      if (!extensionManager) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const discovered = await extensionManager.discoverPlugins(options);
        setPlugins(discovered);
        setCursor((prev) => (prev < discovered.length ? prev : 0));
        if (options?.refresh) {
          onStatus({
            type: 'success',
            text: t('Refreshed {{count}} extension(s).', {
              count: String(discovered.length),
            }),
          });
        }
      } catch (error) {
        debugLogger.error('Failed to discover plugins:', error);
        onStatus({ type: 'error', text: getErrorMessage(error) });
      } finally {
        setLoading(false);
      }
    },
    [extensionManager, onStatus],
  );

  const handleReload = useCallback(() => {
    // Ignore repeat presses while a refresh is in flight so rapid Ctrl+R
    // doesn't stack concurrent network fetches across every marketplace.
    if (loading) return;
    void load({ refresh: true });
  }, [load, loading]);

  useEffect(() => {
    load();
  }, [load, reloadSignal]);

  const goToList = useCallback(() => {
    setView('list');
    onLockChange(false);
  }, [onLockChange]);

  const selected = filtered[cursor] ?? null;

  // Keep the cursor in range as the filtered list changes (e.g. while typing).
  useEffect(() => {
    if (cursor > filtered.length - 1) {
      setCursor(filtered.length > 0 ? filtered.length - 1 : 0);
    }
  }, [filtered.length, cursor]);

  // Keep the cursor inside the visible window (scrolling viewport).
  useEffect(() => {
    if (cursor < scrollOffset) {
      setScrollOffset(cursor);
    } else if (cursor >= scrollOffset + visibleCount) {
      setScrollOffset(cursor - visibleCount + 1);
    }
  }, [cursor, scrollOffset, visibleCount]);

  // Plugins queued for installation when the scope is chosen.
  const pendingInstall = useCallback((): DiscoveredPlugin[] => {
    const chosen = plugins.filter(
      (p) => selectedKeys.has(keyOf(p)) && !p.installed,
    );
    if (chosen.length > 0) return chosen;
    if (selected && !selected.installed) return [selected];
    return [];
  }, [plugins, selectedKeys, selected]);

  const beginInstall = useCallback(() => {
    if (pendingInstall().length === 0) {
      onStatus({
        type: 'info',
        text: t('No installable extensions selected.'),
      });
      return;
    }
    setView('scope-select');
    onLockChange(true);
  }, [pendingInstall, onLockChange, onStatus]);

  const runInstall = useCallback(
    async (
      targets: DiscoveredPlugin[],
      scope: ExtensionScope,
      origin: 'detail' | 'list',
    ) => {
      if (!extensionManager || targets.length === 0) return;
      setInstalling(true);
      let installed = 0;
      const errors: string[] = [];
      for (const plugin of targets) {
        let ext;
        try {
          const metadata = await parseInstallSource(plugin.installSource);
          ext = await extensionManager.installExtension(metadata);
        } catch (error) {
          errors.push(
            `${plugin.name}: ${redactUrlCredentials(getErrorMessage(error))}`,
          );
          continue;
        }
        // The extension is installed on disk now. Recording the scope/enablement
        // preference below is non-critical: a failure there must not flip a
        // successful install to "failed" (which would prompt a confusing retry).
        installed++;
        try {
          // installExtension auto-enables at User (global) scope. For a
          // workspace-scoped choice, re-scope enablement to this workspace
          // only: disable the global enable and enable for the workspace path.
          if (scope !== 'user') {
            await extensionManager.disableExtension(
              ext.name,
              SettingScope.User,
            );
            try {
              await extensionManager.enableExtension(
                ext.name,
                SettingScope.Workspace,
              );
            } catch (enableError) {
              // The User-scope disable already landed; roll it back so a failed
              // Workspace enable doesn't leave the extension disabled at every
              // scope (the outer catch only logs, so the install still reports
              // success — without this the extension would be silently dead).
              try {
                await extensionManager.enableExtension(
                  ext.name,
                  SettingScope.User,
                );
              } catch (rollbackError) {
                // Rollback failed: the extension is now disabled at every scope.
                // The outer catch only debug-logs, so surface it through the
                // batch error list — otherwise the user is told the install
                // succeeded with no hint the extension is silently dead.
                debugLogger.error(
                  'Scope rollback failed after install:',
                  rollbackError,
                );
                errors.push(
                  t(
                    '{{name}}: installed, but the scope rollback failed — it may be disabled at all scopes; re-enable it from the Installed tab.',
                    { name: plugin.name },
                  ),
                );
              }
              throw enableError;
            }
          }
          // Record the scope preference only after enablement succeeds, so the
          // Installed tab can't show a "Project level" extension that is
          // actually enabled at User scope after a rollback.
          extensionManager.setExtensionScope(ext.name, scope);
        } catch (scopeError) {
          debugLogger.error(
            'Installed extension but failed to apply scope preference:',
            scopeError,
          );
        }
      }
      setInstalling(false);
      setSelectedKeys(new Set());
      if (errors.length === 0) {
        onStatus({
          type: 'success',
          text: t('Installed {{count}} extension(s).', {
            count: String(installed),
          }),
        });
      } else {
        onStatus({
          type: 'error',
          text: t('Installed {{ok}}, failed {{fail}}: {{detail}}', {
            ok: String(installed),
            fail: String(errors.length),
            detail: errors.join('; '),
          }),
        });
      }
      await load();
      onInstalled();
      if (errors.length === 0) {
        goToList();
      } else if (origin === 'detail') {
        // Single install from a plugin's detail: stay on detail so the error
        // remains visible over the right plugin and the user can retry.
        setView('detail');
        onLockChange(true);
      } else {
        // Batch install started from the list: the detail view renders
        // filtered[cursor] — an arbitrary row unrelated to what failed — so
        // returning there would offer a misleading retry. Keep the error over
        // the list instead.
        goToList();
      }
    },
    [extensionManager, onStatus, load, onInstalled, goToList, onLockChange],
  );

  const installWithScope = useCallback(
    (scope: ExtensionScope) => void runInstall(pendingInstall(), scope, 'list'),
    [runInstall, pendingInstall],
  );

  const openHomepage = useCallback(
    async (plugin: DiscoveredPlugin) => {
      if (!plugin.homepage) {
        onStatus({ type: 'info', text: t('No homepage available.') });
        return;
      }
      if (process.env['NODE_ENV'] === 'test') {
        onStatus({
          type: 'info',
          text: t('Would open: {{url}}', { url: plugin.homepage }),
        });
        return;
      }
      // homepage comes from untrusted marketplace metadata; only follow web
      // links. `open()` would otherwise launch file:// / other schemes in the
      // OS default handler (e.g. file:///Users/victim/.ssh/id_rsa).
      let protocol: string;
      try {
        protocol = new URL(plugin.homepage).protocol;
      } catch {
        protocol = '';
      }
      if (protocol !== 'http:' && protocol !== 'https:') {
        onStatus({
          type: 'error',
          text: t('Failed to open {{url}}', { url: plugin.homepage }),
        });
        return;
      }
      try {
        await open(plugin.homepage);
      } catch {
        onStatus({
          type: 'error',
          text: t('Failed to open {{url}}', { url: plugin.homepage }),
        });
      }
    },
    [onStatus],
  );

  // Inline action selector on the detail page (mirrors Claude Code).
  type DetailAction = ExtensionScope | 'homepage' | 'back';
  const handleDetailAction = useCallback(
    (action: DetailAction) => {
      if (action === 'back') {
        goToList();
      } else if (action === 'homepage') {
        if (selected) void openHomepage(selected);
      } else if (selected) {
        void runInstall([selected], action, 'detail');
      }
    },
    [selected, goToList, openHomepage, runInstall],
  );

  const detailActionItems = useCallback(() => {
    const items: Array<{ key: string; label: string; value: DetailAction }> =
      [];
    if (selected && !selected.installed) {
      items.push(
        {
          key: 'user',
          label: t('Install for you (user scope)'),
          value: 'user',
        },
        {
          key: 'project',
          label: t('Install for the current workspace (project scope)'),
          value: 'project',
        },
      );
    }
    if (selected?.homepage) {
      items.push({
        key: 'homepage',
        label: t('Open homepage'),
        value: 'homepage',
      });
    }
    items.push({
      key: 'back',
      label: t('Back to extension list'),
      value: 'back',
    });
    return items;
  }, [selected]);

  // List keyboard: navigate, type-to-search, Space to toggle, Enter to view
  // (or install the selected set), matching Claude Code's Discover list.
  // Note: navigation here intentionally bypasses the global SELECTION_UP/DOWN
  // matchers (which include bare j/k) so that j and k stay available as
  // printable characters for the type-to-search query.
  useKeypress(
    (key) => {
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        if (filtered.length > 0)
          setCursor((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
        return;
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        if (filtered.length > 0)
          setCursor((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
        return;
      }
      if (key.name === 'return') {
        if (selectedKeys.size > 0) {
          beginInstall();
        } else if (selected) {
          onStatus(null);
          setView('detail');
          onLockChange(true);
        }
        return;
      }
      if (key.name === 'space' || key.sequence === ' ') {
        if (!selected || selected.installed) return;
        setSelectedKeys((prev) => {
          const next = new Set(prev);
          const k = keyOf(selected);
          if (next.has(k)) next.delete(k);
          else next.add(k);
          return next;
        });
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      // Ctrl+R: refresh / re-discover all sources.
      if (key.ctrl && key.name === 'r') {
        handleReload();
        return;
      }
      // Printable character -> append to the search query.
      if (
        !key.ctrl &&
        !key.meta &&
        key.sequence &&
        key.sequence.length === 1 &&
        key.sequence >= ' '
      ) {
        setQuery((q) => q + key.sequence);
      }
    },
    { isActive: isActive && view === 'list' },
  );

  // Detail: Escape goes back; the action selector (RadioButtonSelect) owns Enter.
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        goToList();
      }
    },
    { isActive: isActive && view === 'detail' },
  );

  // Scope-select (batch install from the list) escape returns to the list.
  useKeypress(
    (key) => {
      if (key.name === 'escape' && !installing) {
        goToList();
      }
    },
    { isActive: isActive && view === 'scope-select' },
  );

  if (loading) {
    return (
      <Text color={theme.text.secondary}>{t('Discovering extensions...')}</Text>
    );
  }

  if (view === 'scope-select') {
    const count = pendingInstall().length;
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.text.primary}>
          {t('Install {{count}} extension(s) to which scope?', {
            count: String(count),
          })}
        </Text>
        {installing ? (
          <Text color={theme.text.secondary}>{t('Installing...')}</Text>
        ) : (
          <RadioButtonSelect
            items={scopeItems()}
            isFocused={isActive}
            showNumbers={false}
            onSelect={(scope) => void installWithScope(scope)}
          />
        )}
      </Box>
    );
  }

  if (view === 'detail' && selected) {
    const comps = selected.components;
    const componentLines: Array<{ label: string; names: string[] }> = [];
    if (comps?.skills?.length)
      componentLines.push({ label: t('Skills'), names: comps.skills });
    if (comps?.commands?.length)
      componentLines.push({ label: t('Commands'), names: comps.commands });
    if (comps?.agents?.length)
      componentLines.push({ label: t('Agents'), names: comps.agents });
    if (comps?.mcpServers?.length)
      componentLines.push({
        label: t('MCP servers'),
        names: comps.mcpServers,
      });

    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.text.primary} bold>
          {t('Extension details')}
        </Text>

        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>
            {selected.name}
          </Text>
          <Text color={theme.text.secondary}>
            {t('from {{marketplace}}', {
              marketplace: selected.marketplaceName,
            })}
          </Text>
          {selected.lastUpdated ? (
            <Text color={theme.text.secondary}>
              {t('Last updated: {{date}}', { date: selected.lastUpdated })}
            </Text>
          ) : selected.version ? (
            <Text color={theme.text.secondary}>
              {t('Version: {{v}}', { v: selected.version })}
            </Text>
          ) : null}
        </Box>

        {selected.description ? <Text>{selected.description}</Text> : null}

        {selected.author ? (
          <Text color={theme.text.secondary}>
            {t('By: {{a}}', { a: selected.author })}
          </Text>
        ) : null}

        {componentLines.length > 0 ? (
          <Box flexDirection="column">
            <Text color={theme.text.primary} bold>
              {t('Will install:')}
            </Text>
            {componentLines.map((line) => (
              <Text key={line.label} color={theme.text.secondary}>
                {`· ${line.label}: ${line.names.join(', ')}`}
              </Text>
            ))}
          </Box>
        ) : null}

        <Text color={theme.text.secondary} italic>
          {t(
            '⚠ Make sure you trust an extension before installing, updating, or using it. We cannot verify what MCP servers, files, or other software an extension includes, or that it works as intended. See the extension homepage for more information.',
          )}
        </Text>

        {installing ? (
          <Text color={theme.text.secondary}>{t('Installing...')}</Text>
        ) : (
          <RadioButtonSelect
            items={detailActionItems()}
            isFocused={isActive}
            showNumbers={false}
            onSelect={handleDetailAction}
          />
        )}
      </Box>
    );
  }

  if (plugins.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('No extensions discovered.')}
        </Text>
        <Text color={theme.text.secondary}>
          {t('Add a marketplace in the Sources tab to discover extensions.')}
        </Text>
      </Box>
    );
  }

  const windowItems = filtered.slice(scrollOffset, scrollOffset + visibleCount);
  const hasAbove = scrollOffset > 0;
  const hasBelow = scrollOffset + visibleCount < filtered.length;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.text.primary} bold>
          {t('Discover extensions')}
        </Text>
        <Text color={theme.text.secondary}>
          {` (${filtered.length ? cursor + 1 : 0}/${filtered.length})`}
        </Text>
        {marketplaceFilter ? (
          <Text color={theme.text.secondary}>
            {t(' · {{marketplace}} (Tab to clear)', {
              marketplace: marketplaceFilter,
            })}
          </Text>
        ) : null}
      </Box>

      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
        width={availableWidth}
      >
        <Text color={theme.text.secondary}>{'⌕ '}</Text>
        {query ? (
          <Text color={theme.text.primary}>{query}</Text>
        ) : (
          <Text color={theme.text.secondary}>{t('Search…')}</Text>
        )}
      </Box>

      {filtered.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('No extensions match your search.')}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {hasAbove ? (
            <Text color={theme.text.secondary}>{t('↑ more above')}</Text>
          ) : null}
          {windowItems.map((plugin, i) => {
            const absIndex = scrollOffset + i;
            const isCursor = absIndex === cursor;
            const isChecked = selectedKeys.has(keyOf(plugin));
            const installs = formatInstalls(plugin.installs);
            const checkbox = plugin.installed ? '✓' : isChecked ? '●' : '○';
            const titleColor = isCursor
              ? theme.text.accent
              : theme.text.primary;
            const meta =
              ` · ${plugin.marketplaceName}` +
              (installs ? ` · ${installs} installs` : '') +
              (plugin.installed ? ` · ${t('installed')}` : '');
            return (
              <Box key={keyOf(plugin)} flexDirection="column" marginBottom={1}>
                <Box>
                  <Box minWidth={2} flexShrink={0}>
                    <Text color={theme.text.accent}>
                      {isCursor ? '›' : ' '}
                    </Text>
                  </Box>
                  <Box minWidth={2} flexShrink={0}>
                    <Text
                      color={
                        plugin.installed
                          ? theme.status.success
                          : theme.text.primary
                      }
                    >
                      {checkbox}
                    </Text>
                  </Box>
                  <Text bold color={titleColor}>
                    {plugin.name}
                  </Text>
                  <Text color={theme.text.secondary}>{meta}</Text>
                </Box>
                {plugin.description ? (
                  <Box paddingLeft={4}>
                    <Text color={theme.text.secondary}>
                      {truncateText(plugin.description, availableWidth - 4)}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
          {hasBelow ? (
            <Text color={theme.text.secondary}>{t('↓ more below')}</Text>
          ) : null}
        </Box>
      )}
    </Box>
  );
};
