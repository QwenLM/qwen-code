/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../../keyMatchers.js';
import { TextInput } from '../../shared/TextInput.js';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { t } from '../../../../i18n/index.js';
import {
  type Config,
  type Extension,
  type MarketplaceSource,
  type ClaudeMarketplaceConfig,
  parseInstallSource,
  redactUrlCredentials,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../../../utils/errors.js';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';

const debugLogger = createDebugLogger('MARKETPLACES_TAB');

type MarketplacesView =
  | 'list'
  | 'install-extension'
  | 'add'
  | 'detail'
  | 'extension-detail'
  | 'remove-confirm';
type MarketplaceDetailAction = 'browse' | 'update' | 'remove';
type ExtensionDetailAction = 'uninstall' | 'back';

// Flat, navigable entries shown on the Marketplaces tab list.
type Entry =
  | { kind: 'install-extension' }
  | { kind: 'add-marketplace' }
  | { kind: 'extension'; extension: Extension }
  | { kind: 'marketplace'; source: MarketplaceSource };

interface MarketplacesTabProps {
  config: Config;
  isActive: boolean;
  onLockChange: (locked: boolean) => void;
  onStatus: (status: StatusMessage | null) => void;
  onChanged: () => void;
  /** Switch to the Discover tab filtered to the given marketplace. */
  onBrowse: (marketplaceName: string) => void;
  reloadSignal: number;
}

function formatDate(iso?: string): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Date(time).toLocaleDateString();
}

function extensionSourceLabel(ext: Extension): string {
  const meta = ext.installMetadata;
  if (!meta) return t('local');
  return `${redactUrlCredentials(meta.source)} (${meta.type})`;
}

export const MarketplacesTab = ({
  config,
  isActive,
  onLockChange,
  onStatus,
  onChanged,
  onBrowse,
  reloadSignal,
}: MarketplacesTabProps) => {
  const [sources, setSources] = useState<MarketplaceSource[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<MarketplacesView>('list');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [detailConfig, setDetailConfig] =
    useState<ClaudeMarketplaceConfig | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // The marketplace / extension currently being viewed or confirmed.
  const [detailSource, setDetailSource] = useState<MarketplaceSource | null>(
    null,
  );
  const [detailExtension, setDetailExtension] = useState<Extension | null>(
    null,
  );

  const extensionManager = config.getExtensionManager();

  const load = useCallback(async () => {
    if (!extensionManager) return;
    try {
      await extensionManager.refreshCache();
    } catch (error) {
      debugLogger.error('Failed to refresh extensions:', error);
    }
    setExtensions(extensionManager.getLoadedExtensions());
    setSources(extensionManager.getMarketplaces());
  }, [extensionManager]);

  useEffect(() => {
    load();
  }, [load, reloadSignal]);

  // Entries: two action rows, then installed extensions, then marketplaces.
  const entries = useMemo<Entry[]>(
    () => [
      { kind: 'install-extension' },
      { kind: 'add-marketplace' },
      ...extensions.map((extension) => ({
        kind: 'extension' as const,
        extension,
      })),
      ...sources.map((source) => ({ kind: 'marketplace' as const, source })),
    ],
    [extensions, sources],
  );

  // Keep the cursor in range as the list changes.
  useEffect(() => {
    if (selectedIndex >= entries.length) {
      setSelectedIndex(0);
    }
  }, [entries.length, selectedIndex]);

  const selectedEntry = entries[selectedIndex];

  const goToList = useCallback(() => {
    setView('list');
    setInput('');
    setDetailConfig(null);
    setDetailSource(null);
    setDetailExtension(null);
    onLockChange(false);
  }, [onLockChange]);

  const submitAdd = useCallback(async () => {
    if (!extensionManager || !input.trim()) return;
    setBusy(true);
    try {
      const entry = await extensionManager.addMarketplace(input.trim());
      onStatus({
        type: 'success',
        text: t('Added marketplace "{{name}}".', { name: entry.name }),
      });
      await load();
      onChanged();
      goToList();
    } catch (error) {
      onStatus({
        type: 'error',
        text: redactUrlCredentials(getErrorMessage(error)),
      });
    } finally {
      setBusy(false);
    }
  }, [extensionManager, input, onStatus, load, onChanged, goToList]);

  const submitInstall = useCallback(async () => {
    if (!extensionManager || !input.trim()) return;
    setBusy(true);
    try {
      const metadata = await parseInstallSource(input.trim());
      const ext = await extensionManager.installExtension(metadata);
      onStatus({
        type: 'success',
        text: t('Installed extension "{{name}}".', { name: ext.name }),
      });
      await load();
      onChanged();
      goToList();
    } catch (error) {
      onStatus({
        type: 'error',
        text: redactUrlCredentials(getErrorMessage(error)),
      });
    } finally {
      setBusy(false);
    }
  }, [extensionManager, input, onStatus, load, onChanged, goToList]);

  const openMarketplaceDetail = useCallback(
    async (source: MarketplaceSource) => {
      onStatus(null);
      setDetailSource(source);
      setView('detail');
      onLockChange(true);
      setDetailLoading(true);
      setDetailConfig(null);
      try {
        const cfg = await extensionManager?.loadMarketplace(source.source);
        setDetailConfig(cfg ?? null);
      } catch (error) {
        debugLogger.error('Failed to load marketplace detail:', error);
      } finally {
        setDetailLoading(false);
      }
    },
    [extensionManager, onLockChange, onStatus],
  );

  const openExtensionDetail = useCallback(
    (extension: Extension) => {
      onStatus(null);
      setDetailExtension(extension);
      setView('extension-detail');
      onLockChange(true);
    },
    [onLockChange, onStatus],
  );

  const removeMarketplace = useCallback(() => {
    if (!extensionManager || !detailSource) return;
    const removed = extensionManager.removeMarketplace(detailSource.name);
    if (removed) {
      onStatus({
        type: 'success',
        text: t('Removed marketplace "{{name}}".', { name: detailSource.name }),
      });
      void load();
      onChanged();
    }
    goToList();
  }, [extensionManager, detailSource, onStatus, load, onChanged, goToList]);

  const uninstallExtension = useCallback(async () => {
    if (!extensionManager || !detailExtension) return;
    try {
      await extensionManager.uninstallExtension(detailExtension.name, false);
      onStatus({
        type: 'success',
        text: t('Uninstalled extension "{{name}}".', {
          name: detailExtension.name,
        }),
      });
      await load();
      onChanged();
    } catch (error) {
      onStatus({
        type: 'error',
        text: redactUrlCredentials(getErrorMessage(error)),
      });
    }
    goToList();
  }, [extensionManager, detailExtension, onStatus, load, onChanged, goToList]);

  const updateMarketplace = useCallback(async () => {
    if (!extensionManager || !detailSource) return;
    setDetailLoading(true);
    try {
      const cfg = await extensionManager.loadMarketplace(detailSource.source);
      setDetailConfig(cfg ?? null);
      extensionManager.markMarketplaceUpdated(detailSource.name);
      await load();
      onChanged();
      onStatus({
        type: 'success',
        text: t('Updated marketplace "{{name}}".', { name: detailSource.name }),
      });
    } catch (error) {
      onStatus({
        type: 'error',
        text: redactUrlCredentials(getErrorMessage(error)),
      });
    } finally {
      setDetailLoading(false);
    }
  }, [extensionManager, detailSource, load, onChanged, onStatus]);

  const handleMarketplaceDetailAction = useCallback(
    (action: MarketplaceDetailAction) => {
      if (!detailSource) return;
      if (action === 'browse') {
        onBrowse(detailSource.name);
      } else if (action === 'update') {
        void updateMarketplace();
      } else if (action === 'remove') {
        setView('remove-confirm');
      }
    },
    [detailSource, onBrowse, updateMarketplace],
  );

  const handleExtensionDetailAction = useCallback(
    (action: ExtensionDetailAction) => {
      if (action === 'uninstall') {
        setView('remove-confirm');
      } else {
        goToList();
      }
    },
    [goToList],
  );

  // List keyboard: navigate entries, Enter dispatches by kind, d removes.
  useKeypress(
    (key) => {
      if (entries.length === 0) return;
      if (keyMatchers[Command.SELECTION_UP](key)) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : entries.length - 1));
        return;
      }
      if (keyMatchers[Command.SELECTION_DOWN](key)) {
        setSelectedIndex((prev) => (prev < entries.length - 1 ? prev + 1 : 0));
        return;
      }
      if (key.name === 'return') {
        if (!selectedEntry) return;
        onStatus(null);
        switch (selectedEntry.kind) {
          case 'install-extension':
            setView('install-extension');
            onLockChange(true);
            break;
          case 'add-marketplace':
            setView('add');
            onLockChange(true);
            break;
          case 'extension':
            openExtensionDetail(selectedEntry.extension);
            break;
          case 'marketplace':
            void openMarketplaceDetail(selectedEntry.source);
            break;
          default:
            break;
        }
        return;
      }
      if (
        (key.sequence === 'd' || key.sequence === 'x') &&
        !key.ctrl &&
        !key.meta &&
        selectedEntry?.kind === 'marketplace'
      ) {
        setDetailSource(selectedEntry.source);
        setView('remove-confirm');
        onLockChange(true);
      }
    },
    { isActive: isActive && view === 'list' },
  );

  // Input views: Escape cancels.
  useKeypress(
    (key) => {
      if (key.name === 'escape' && !busy) {
        goToList();
      }
    },
    {
      isActive: isActive && (view === 'add' || view === 'install-extension'),
    },
  );

  // Detail views: Escape goes back; the selector owns Enter.
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        goToList();
      }
    },
    {
      isActive: isActive && (view === 'detail' || view === 'extension-detail'),
    },
  );

  // Remove/uninstall confirmation.
  useKeypress(
    (key) => {
      if (key.name === 'return' || key.sequence === 'y') {
        if (detailExtension) {
          void uninstallExtension();
        } else {
          removeMarketplace();
        }
      } else if (key.name === 'escape' || key.sequence === 'n') {
        // Return to the originating detail view if there was one.
        if (detailExtension) {
          setView('extension-detail');
        } else if (detailSource) {
          setView('detail');
        } else {
          goToList();
        }
      }
    },
    { isActive: isActive && view === 'remove-confirm' },
  );

  if (view === 'install-extension') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.text.primary} bold>
          {t('Install Extension')}
        </Text>

        <Box flexDirection="column">
          <Text color={theme.text.primary}>{t('Enter extension source:')}</Text>
          <Text color={theme.text.secondary}>{t('Examples:')}</Text>
          <Text color={theme.text.secondary}>{' · owner/repo (GitHub)'}</Text>
          <Text color={theme.text.secondary}>
            {' · git@github.com:owner/repo.git (SSH)'}
          </Text>
          <Text color={theme.text.secondary}>{' · @scope/name (npm)'}</Text>
          <Text color={theme.text.secondary}>{' · ./path/to/extension'}</Text>
        </Box>

        {busy ? (
          <Text color={theme.text.secondary}>{t('Installing...')}</Text>
        ) : (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={() => void submitInstall()}
            isActive={isActive}
          />
        )}
      </Box>
    );
  }

  if (view === 'add') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.text.primary} bold>
          {t('Add Marketplace')}
        </Text>

        <Box flexDirection="column">
          <Text color={theme.text.primary}>
            {t('Enter marketplace source (Claude format):')}
          </Text>
          <Text color={theme.text.secondary}>{t('Examples:')}</Text>
          <Text color={theme.text.secondary}>{' · owner/repo (GitHub)'}</Text>
          <Text color={theme.text.secondary}>
            {' · git@github.com:owner/repo.git (SSH)'}
          </Text>
          <Text color={theme.text.secondary}>
            {' · https://example.com/marketplace.json'}
          </Text>
          <Text color={theme.text.secondary}>{' · ./path/to/marketplace'}</Text>
        </Box>

        {busy ? (
          <Text color={theme.text.secondary}>{t('Adding...')}</Text>
        ) : (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={() => void submitAdd()}
            isActive={isActive}
          />
        )}
      </Box>
    );
  }

  if (view === 'extension-detail' && detailExtension) {
    const ext = detailExtension;
    const parts: string[] = [];
    const mcpCount = ext.mcpServers ? Object.keys(ext.mcpServers).length : 0;
    if (mcpCount) parts.push(t('{{count}} MCP', { count: String(mcpCount) }));
    if (ext.skills?.length)
      parts.push(t('{{count}} Skills', { count: String(ext.skills.length) }));
    if (ext.commands?.length)
      parts.push(
        t('{{count}} Commands', { count: String(ext.commands.length) }),
      );
    if (ext.agents?.length)
      parts.push(t('{{count}} Agents', { count: String(ext.agents.length) }));

    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.text.primary} bold>
          {t('Extension details')}
        </Text>
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>
            {ext.name}
          </Text>
          <Text color={theme.text.secondary}>{`v${ext.version}`}</Text>
          <Text color={theme.text.secondary}>{extensionSourceLabel(ext)}</Text>
          <Text color={theme.text.secondary}>
            {t('Components: {{summary}}', {
              summary: parts.length ? parts.join(' · ') : t('None'),
            })}
          </Text>
        </Box>
        <RadioButtonSelect
          items={[
            { key: 'uninstall', label: t('Uninstall'), value: 'uninstall' },
            { key: 'back', label: t('Back'), value: 'back' },
          ]}
          isFocused={isActive}
          showNumbers={false}
          onSelect={handleExtensionDetailAction}
        />
      </Box>
    );
  }

  if (view === 'detail' && detailSource) {
    const plugins = detailConfig?.plugins ?? [];
    const availableCount = plugins.length;
    const installedNames = new Set(extensions.map((ext) => ext.name));
    const installedHere = plugins.filter((p) => installedNames.has(p.name));
    const lastUpdated = formatDate(
      detailSource.lastUpdatedAt ?? detailSource.addedAt,
    );

    const actions: Array<{
      key: string;
      label: string;
      value: MarketplaceDetailAction;
    }> = [
      {
        key: 'browse',
        label: t('Browse extensions ({{count}})', {
          count: String(availableCount),
        }),
        value: 'browse',
      },
      {
        key: 'update',
        label: lastUpdated
          ? t('Update marketplace (last updated {{date}})', {
              date: lastUpdated,
            })
          : t('Update marketplace'),
        value: 'update',
      },
      { key: 'remove', label: t('Remove marketplace'), value: 'remove' },
    ];

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>
            {detailSource.name}
          </Text>
          <Text color={theme.text.secondary}>
            {redactUrlCredentials(detailSource.source)}
          </Text>
        </Box>

        {detailLoading ? (
          <Text color={theme.text.secondary}>{t('Loading...')}</Text>
        ) : detailConfig ? (
          <Box flexDirection="column" gap={1}>
            <Text color={theme.text.primary}>
              {t('{{count}} available extensions', {
                count: String(availableCount),
              })}
            </Text>

            {installedHere.length > 0 ? (
              <Box flexDirection="column">
                <Text color={theme.text.primary} bold>
                  {t('Installed extensions ({{count}}):', {
                    count: String(installedHere.length),
                  })}
                </Text>
                {installedHere.map((p) => (
                  <Box key={p.name} flexDirection="column">
                    <Box>
                      <Box minWidth={2} flexShrink={0}>
                        <Text color={theme.status.success}>{'●'}</Text>
                      </Box>
                      <Text color={theme.text.primary}>{p.name}</Text>
                    </Box>
                    {p.description ? (
                      <Box paddingLeft={2}>
                        <Text color={theme.text.secondary}>
                          {p.description}
                        </Text>
                      </Box>
                    ) : null}
                  </Box>
                ))}
              </Box>
            ) : null}

            <RadioButtonSelect
              items={actions}
              isFocused={isActive}
              showNumbers={false}
              onSelect={handleMarketplaceDetailAction}
            />
          </Box>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Text color={theme.status.error}>
              {t('Could not load this marketplace.')}
            </Text>
            <RadioButtonSelect
              items={[
                {
                  key: 'remove',
                  label: t('Remove marketplace'),
                  value: 'remove' as MarketplaceDetailAction,
                },
              ]}
              isFocused={isActive}
              showNumbers={false}
              onSelect={handleMarketplaceDetailAction}
            />
          </Box>
        )}
      </Box>
    );
  }

  if (view === 'remove-confirm') {
    const isExtension = !!detailExtension;
    const name = isExtension ? detailExtension!.name : detailSource?.name;
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.status.warning}>
          {isExtension
            ? t('Uninstall extension "{{name}}"?', { name: name ?? '' })
            : t('Remove marketplace "{{name}}"?', { name: name ?? '' })}
        </Text>
        <Text color={theme.text.secondary}>
          {t('Y/Enter to confirm · N/Esc to cancel')}
        </Text>
      </Box>
    );
  }

  // List view.
  const renderRow = (
    index: number,
    label: string,
    rightText?: string,
    isAction = false,
  ) => {
    const isSelected = index === selectedIndex;
    const labelColor = isSelected
      ? theme.text.accent
      : isAction
        ? theme.text.link
        : theme.text.primary;
    return (
      <Box key={`row-${index}`}>
        <Box minWidth={2} flexShrink={0}>
          <Text color={isSelected ? theme.text.accent : theme.text.primary}>
            {isSelected ? '●' : ' '}
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text color={labelColor}>{label}</Text>
        </Box>
        {rightText ? (
          <Text color={theme.text.secondary}>{rightText}</Text>
        ) : null}
      </Box>
    );
  };

  const extensionsStart = 2;
  const marketplacesStart = 2 + extensions.length;

  return (
    <Box flexDirection="column">
      {renderRow(0, t('+ Install new extension'), undefined, true)}
      {renderRow(
        1,
        t('+ Add new marketplace'),
        t('Claude plugin marketplace'),
        true,
      )}

      {extensions.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text.accent} bold>
            {t('Extensions')} ({extensions.length})
          </Text>
          {extensions.map((ext, i) =>
            renderRow(extensionsStart + i, ext.name, extensionSourceLabel(ext)),
          )}
        </Box>
      ) : null}

      {sources.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text.accent} bold>
            {t('Marketplaces')} ({sources.length})
          </Text>
          {sources.map((source, j) =>
            renderRow(
              marketplacesStart + j,
              source.name,
              `${redactUrlCredentials(source.source)} (${source.type})`,
            ),
          )}
        </Box>
      ) : null}

      {extensions.length === 0 && sources.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('No extensions or marketplaces added yet.')}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};
