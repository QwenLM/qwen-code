/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../../keyMatchers.js';
import { TextInput } from '../../shared/TextInput.js';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { t } from '../../../../i18n/index.js';
import {
  type Config,
  type MarketplaceSource,
  type ClaudeMarketplaceConfig,
  redactUrlCredentials,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../../../utils/errors.js';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';

const debugLogger = createDebugLogger('MARKETPLACES_TAB');

type MarketplacesView = 'list' | 'add' | 'detail' | 'remove-confirm';
type MarketplaceDetailAction = 'browse' | 'update' | 'remove';

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
  // selectedIndex: 0 = "add" row, 1..n = sources.
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [view, setView] = useState<MarketplacesView>('list');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [detailConfig, setDetailConfig] =
    useState<ClaudeMarketplaceConfig | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const extensionManager = config.getExtensionManager();

  const load = useCallback(() => {
    if (!extensionManager) return;
    const list = extensionManager.getMarketplaces();
    setSources(list);
    setSelectedIndex((prev) => (prev <= list.length ? prev : 0));
  }, [extensionManager]);

  useEffect(() => {
    load();
  }, [load, reloadSignal]);

  const goToList = useCallback(() => {
    setView('list');
    setInput('');
    setDetailConfig(null);
    onLockChange(false);
  }, [onLockChange]);

  const selectedSource =
    selectedIndex >= 1 ? (sources[selectedIndex - 1] ?? null) : null;

  const submitAdd = useCallback(async () => {
    if (!extensionManager || !input.trim()) return;
    setBusy(true);
    try {
      const entry = await extensionManager.addMarketplace(input.trim());
      onStatus({
        type: 'success',
        text: t('Added marketplace "{{name}}".', { name: entry.name }),
      });
      load();
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

  const openDetail = useCallback(
    async (source: MarketplaceSource) => {
      onStatus(null);
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

  const removeSelected = useCallback(() => {
    if (!extensionManager || !selectedSource) return;
    const removed = extensionManager.removeMarketplace(selectedSource.name);
    if (removed) {
      onStatus({
        type: 'success',
        text: t('Removed marketplace "{{name}}".', {
          name: selectedSource.name,
        }),
      });
      load();
      onChanged();
    }
    goToList();
  }, [extensionManager, selectedSource, onStatus, load, onChanged, goToList]);

  const updateMarketplace = useCallback(async () => {
    if (!extensionManager || !selectedSource) return;
    setDetailLoading(true);
    try {
      // Re-fetch the marketplace config and stamp a fresh "last updated".
      const cfg = await extensionManager.loadMarketplace(selectedSource.source);
      setDetailConfig(cfg ?? null);
      extensionManager.markMarketplaceUpdated(selectedSource.name);
      load();
      onChanged();
      onStatus({
        type: 'success',
        text: t('Updated marketplace "{{name}}".', {
          name: selectedSource.name,
        }),
      });
    } catch (error) {
      onStatus({
        type: 'error',
        text: redactUrlCredentials(getErrorMessage(error)),
      });
    } finally {
      setDetailLoading(false);
    }
  }, [extensionManager, selectedSource, load, onChanged, onStatus]);

  const handleDetailAction = useCallback(
    (action: MarketplaceDetailAction) => {
      if (!selectedSource) return;
      if (action === 'browse') {
        onBrowse(selectedSource.name);
      } else if (action === 'update') {
        void updateMarketplace();
      } else if (action === 'remove') {
        setView('remove-confirm');
      }
    },
    [selectedSource, onBrowse, updateMarketplace],
  );

  // List keyboard.
  useKeypress(
    (key) => {
      const itemCount = sources.length + 1; // +1 for the add row
      if (keyMatchers[Command.SELECTION_UP](key)) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : itemCount - 1));
      } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
        setSelectedIndex((prev) => (prev < itemCount - 1 ? prev + 1 : 0));
      } else if (key.name === 'return') {
        if (selectedIndex === 0) {
          onStatus(null);
          setView('add');
          onLockChange(true);
        } else if (selectedSource) {
          void openDetail(selectedSource);
        }
      } else if (
        (key.sequence === 'd' || key.sequence === 'x') &&
        !key.ctrl &&
        !key.meta
      ) {
        if (selectedSource) {
          setView('remove-confirm');
          onLockChange(true);
        }
      }
    },
    { isActive: isActive && view === 'list' },
  );

  // Add input escape.
  useKeypress(
    (key) => {
      if (key.name === 'escape' && !busy) {
        goToList();
      }
    },
    { isActive: isActive && view === 'add' },
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

  // Remove confirm.
  useKeypress(
    (key) => {
      if (key.name === 'return' || key.sequence === 'y') {
        removeSelected();
      } else if (key.name === 'escape' || key.sequence === 'n') {
        goToList();
      }
    },
    { isActive: isActive && view === 'remove-confirm' },
  );

  if (view === 'add') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.text.primary} bold>
          {t('Add Marketplace')}
        </Text>

        <Box flexDirection="column">
          <Text color={theme.text.primary}>
            {t('Enter marketplace source:')}
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

  if (view === 'detail' && selectedSource) {
    const plugins = detailConfig?.plugins ?? [];
    const availableCount = plugins.length;
    const installedNames = new Set(
      (extensionManager?.getLoadedExtensions() ?? []).map((ext) => ext.name),
    );
    const installedPlugins = plugins.filter((p) => installedNames.has(p.name));
    const lastUpdated = formatDate(
      selectedSource.lastUpdatedAt ?? selectedSource.addedAt,
    );

    const actions: Array<{
      key: string;
      label: string;
      value: MarketplaceDetailAction;
    }> = [
      {
        key: 'browse',
        label: t('Browse plugins ({{count}})', {
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
            {selectedSource.name}
          </Text>
          <Text color={theme.text.secondary}>
            {redactUrlCredentials(selectedSource.source)}
          </Text>
        </Box>

        {detailLoading ? (
          <Text color={theme.text.secondary}>{t('Loading...')}</Text>
        ) : detailConfig ? (
          <Box flexDirection="column" gap={1}>
            <Text color={theme.text.primary}>
              {t('{{count}} available plugins', {
                count: String(availableCount),
              })}
            </Text>

            {installedPlugins.length > 0 ? (
              <Box flexDirection="column">
                <Text color={theme.text.primary} bold>
                  {t('Installed plugins ({{count}}):', {
                    count: String(installedPlugins.length),
                  })}
                </Text>
                {installedPlugins.map((p) => (
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
              onSelect={handleDetailAction}
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
              onSelect={handleDetailAction}
            />
          </Box>
        )}
      </Box>
    );
  }

  if (view === 'remove-confirm' && selectedSource) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={theme.status.warning}>
          {t('Remove marketplace "{{name}}"?', { name: selectedSource.name })}
        </Text>
        <Text color={theme.text.secondary}>
          {t('Y/Enter to confirm · N/Esc to cancel')}
        </Text>
      </Box>
    );
  }

  // List view.
  return (
    <Box flexDirection="column">
      <Box>
        <Box minWidth={2} flexShrink={0}>
          <Text
            color={selectedIndex === 0 ? theme.text.accent : theme.text.primary}
          >
            {selectedIndex === 0 ? '●' : ' '}
          </Text>
        </Box>
        <Text color={selectedIndex === 0 ? theme.text.accent : theme.text.link}>
          {t('+ Add new marketplace')}
        </Text>
      </Box>
      {sources.length === 0 ? (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('No marketplaces added yet.')}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {sources.map((source, index) => {
            const isSelected = selectedIndex === index + 1;
            return (
              <Box key={source.name}>
                <Box minWidth={2} flexShrink={0}>
                  <Text
                    color={isSelected ? theme.text.accent : theme.text.primary}
                  >
                    {isSelected ? '●' : ' '}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text
                    color={isSelected ? theme.text.accent : theme.text.primary}
                  >
                    {source.name}
                  </Text>
                </Box>
                <Text color={theme.text.secondary}>
                  {redactUrlCredentials(source.source)} ({source.type})
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
};
