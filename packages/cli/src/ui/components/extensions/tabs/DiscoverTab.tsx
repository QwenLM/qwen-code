/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback } from 'react';
import { Box, Text } from 'ink';
import open from 'open';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../../keyMatchers.js';
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
  reloadSignal: number;
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
      label: t('Project (All Collaborators)'),
      value: 'project',
    },
    { key: 'local', label: t('Local (Only You)'), value: 'local' },
  ];
}

export const DiscoverTab = ({
  config,
  isActive,
  onLockChange,
  onStatus,
  onInstalled,
  reloadSignal,
}: DiscoverTabProps) => {
  const [plugins, setPlugins] = useState<DiscoveredPlugin[]>([]);
  const [cursor, setCursor] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [view, setView] = useState<DiscoverView>('list');
  // Where Esc from the scope-select view should return to.
  const [scopeReturnView, setScopeReturnView] = useState<'list' | 'detail'>(
    'list',
  );
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  const extensionManager = config.getExtensionManager();

  const keyOf = (p: DiscoveredPlugin) => `${p.marketplaceName}/${p.name}`;

  const load = useCallback(async () => {
    if (!extensionManager) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const discovered = await extensionManager.discoverPlugins();
      setPlugins(discovered);
      setCursor((prev) => (prev < discovered.length ? prev : 0));
    } catch (error) {
      debugLogger.error('Failed to discover plugins:', error);
      onStatus({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [extensionManager, onStatus]);

  useEffect(() => {
    load();
  }, [load, reloadSignal]);

  const goToList = useCallback(() => {
    setView('list');
    onLockChange(false);
  }, [onLockChange]);

  const selected = plugins[cursor] ?? null;

  // Plugins queued for installation when the scope is chosen.
  const pendingInstall = useCallback((): DiscoveredPlugin[] => {
    const chosen = plugins.filter(
      (p) => selectedKeys.has(keyOf(p)) && !p.installed,
    );
    if (chosen.length > 0) return chosen;
    if (selected && !selected.installed) return [selected];
    return [];
  }, [plugins, selectedKeys, selected]);

  const beginInstall = useCallback(
    (from: 'list' | 'detail') => {
      if (pendingInstall().length === 0) {
        onStatus({ type: 'info', text: t('No installable plugins selected.') });
        return;
      }
      setScopeReturnView(from);
      setView('scope-select');
      onLockChange(true);
    },
    [pendingInstall, onLockChange, onStatus],
  );

  const installWithScope = useCallback(
    async (scope: ExtensionScope) => {
      if (!extensionManager) return;
      const targets = pendingInstall();
      setInstalling(true);
      let installed = 0;
      const errors: string[] = [];
      for (const plugin of targets) {
        try {
          const metadata = await parseInstallSource(plugin.installSource);
          const ext = await extensionManager.installExtension(metadata);
          extensionManager.setExtensionScope(ext.name, scope);
          // installExtension auto-enables at User (global) scope. For a
          // workspace-scoped choice, re-scope enablement to this workspace
          // only: disable the global enable and enable for the workspace path.
          if (scope !== 'user') {
            await extensionManager.disableExtension(
              ext.name,
              SettingScope.User,
            );
            await extensionManager.enableExtension(
              ext.name,
              SettingScope.Workspace,
            );
          }
          installed++;
        } catch (error) {
          errors.push(
            `${plugin.name}: ${redactUrlCredentials(getErrorMessage(error))}`,
          );
        }
      }
      setInstalling(false);
      setSelectedKeys(new Set());
      if (errors.length === 0) {
        onStatus({
          type: 'success',
          text: t('Installed {{count}} plugin(s).', {
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
      goToList();
    },
    [extensionManager, pendingInstall, onStatus, load, onInstalled, goToList],
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

  // List keyboard.
  useKeypress(
    (key) => {
      if (plugins.length === 0) return;
      if (keyMatchers[Command.SELECTION_UP](key)) {
        setCursor((prev) => (prev > 0 ? prev - 1 : plugins.length - 1));
      } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
        setCursor((prev) => (prev < plugins.length - 1 ? prev + 1 : 0));
      } else if (key.name === 'space' || key.sequence === ' ') {
        if (!selected || selected.installed) return;
        setSelectedKeys((prev) => {
          const next = new Set(prev);
          const k = keyOf(selected);
          if (next.has(k)) next.delete(k);
          else next.add(k);
          return next;
        });
      } else if (key.sequence === 'i' && !key.ctrl && !key.meta) {
        beginInstall('list');
      } else if (key.name === 'return') {
        if (selected) {
          onStatus(null);
          setView('detail');
          onLockChange(true);
        }
      }
    },
    { isActive: isActive && view === 'list' },
  );

  // Detail keyboard (Open homepage / install / back).
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        goToList();
      } else if (key.sequence === 'h' && !key.ctrl && !key.meta) {
        if (selected) void openHomepage(selected);
      } else if (key.sequence === 'i' && !key.ctrl && !key.meta) {
        if (selected && !selected.installed) {
          beginInstall('detail');
        }
      }
    },
    { isActive: isActive && view === 'detail' },
  );

  // Scope-select escape returns to wherever it was opened from.
  useKeypress(
    (key) => {
      if (key.name === 'escape' && !installing) {
        if (scopeReturnView === 'detail') {
          setView('detail');
        } else {
          goToList();
        }
      }
    },
    { isActive: isActive && view === 'scope-select' },
  );

  if (loading) {
    return (
      <Text color={theme.text.secondary}>{t('Discovering plugins...')}</Text>
    );
  }

  if (view === 'scope-select') {
    const count = pendingInstall().length;
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.text.primary}>
          {t('Install {{count}} plugin(s) to which scope?', {
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
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text color={theme.text.accent} bold>
            {selected.name}
          </Text>
          <Text color={theme.text.secondary}>
            {t('from {{marketplace}}', {
              marketplace: selected.marketplaceName,
            })}
          </Text>
        </Box>
        {selected.description ? <Text>{selected.description}</Text> : null}
        {selected.version ? (
          <Text color={theme.text.secondary}>
            {t('Version: {{v}}', { v: selected.version })}
          </Text>
        ) : null}
        {selected.author ? (
          <Text color={theme.text.secondary}>
            {t('Author: {{a}}', { a: selected.author })}
          </Text>
        ) : null}
        {selected.homepage ? (
          <Text color={theme.text.link}>{selected.homepage}</Text>
        ) : null}
        <Text color={theme.text.secondary}>
          {selected.installed
            ? t('Already installed.')
            : t('i to install · h to open homepage · Esc to go back')}
        </Text>
      </Box>
    );
  }

  if (plugins.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>{t('No plugins discovered.')}</Text>
        <Text color={theme.text.secondary}>
          {t('Add a marketplace in the Marketplaces tab to discover plugins.')}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.text.secondary}>
        {t('{{count}} plugin(s) available', { count: String(plugins.length) })}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {plugins.map((plugin, index) => {
          const isSelected = index === cursor;
          const isChecked = selectedKeys.has(keyOf(plugin));
          return (
            <Box key={keyOf(plugin)}>
              <Box minWidth={2} flexShrink={0}>
                <Text
                  color={isSelected ? theme.text.accent : theme.text.primary}
                >
                  {isSelected ? '●' : ' '}
                </Text>
              </Box>
              <Box minWidth={4} flexShrink={0}>
                <Text
                  color={
                    plugin.installed ? theme.status.success : theme.text.primary
                  }
                >
                  {plugin.installed ? '[✓]' : isChecked ? '[•]' : '[ ]'}
                </Text>
              </Box>
              <Box flexGrow={1}>
                <Text
                  color={isSelected ? theme.text.accent : theme.text.primary}
                >
                  {plugin.name}
                </Text>
              </Box>
              <Text color={theme.text.secondary}>
                {plugin.marketplaceName}
                {plugin.installed ? ` (${t('installed')})` : ''}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
