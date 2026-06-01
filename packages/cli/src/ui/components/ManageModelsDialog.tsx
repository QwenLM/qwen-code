/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import process from 'node:process';
import {
  type Config,
  type ProviderModelConfig as ModelConfig,
} from '@qwen-code/qwen-code-core';
import { useSettings } from '../contexts/SettingsContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { TextInput } from './shared/TextInput.js';
import type { LoadedSettings } from '../../config/settings.js';
import {
  type ManageModelsCatalog,
  type ManageModelsCatalogEntry,
  type ManageModelsSource,
  fetchManageModelsCatalog,
  getEnabledModelIdsForSource,
  saveManageModelsSelection,
} from '../manageModels/manageModels.js';

interface ManageModelsDialogProps {
  config: Config;
  onClose: () => void;
}

type DialogStatus = 'loading' | 'ready' | 'saving' | 'error';
type FocusMode = 'tabs' | 'search' | 'list';
export type FilterMode = 'all' | 'enabled' | 'free' | 'vision';

const MAX_VISIBLE_MODELS = 12;
const MANAGE_MODELS_TABS = [
  { source: 'openrouter', label: 'OpenRouter', enabled: true },
  { source: 'modelstudio', label: 'ModelStudio', enabled: false },
] as const;

type ManageModelsTabSource = (typeof MANAGE_MODELS_TABS)[number]['source'];

export function buildModelLabel(entry: ManageModelsCatalogEntry): string {
  return entry.label;
}

export function applyCatalogFilters(params: {
  entries: ManageModelsCatalogEntry[];
  query: string;
  selectedIds: string[];
  filterMode: FilterMode;
}): ManageModelsCatalogEntry[] {
  const { entries, query, selectedIds, filterMode } = params;
  const normalized = query.trim().toLowerCase();
  const rawTokens = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
  const quickFilterEnabled = rawTokens.some(
    (token) => token === 'enabled' || token === 'is:enabled',
  );
  const tokens = rawTokens.filter(
    (token) => token !== 'enabled' && token !== 'is:enabled',
  );
  const selectedSet = new Set(selectedIds);

  return entries.filter((entry) => {
    if (
      (filterMode === 'enabled' || quickFilterEnabled) &&
      !selectedSet.has(entry.id)
    ) {
      return false;
    }
    if (filterMode === 'free' && !entry.badges.includes('free')) {
      return false;
    }
    if (filterMode === 'vision' && !entry.supportsVision) {
      return false;
    }

    if (tokens.length === 0) {
      return true;
    }

    const haystack = `${entry.searchText} ${entry.id}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function getFilterLabel(filterMode: FilterMode): string {
  switch (filterMode) {
    case 'enabled':
      return 'Enabled';
    case 'free':
      return 'Free';
    case 'vision':
      return 'Vision';
    case 'all':
    default:
      return 'All';
  }
}

function cycleFilter(
  current: FilterMode,
  direction: 'left' | 'right',
): FilterMode {
  const modes: FilterMode[] = ['all', 'enabled', 'free', 'vision'];
  const currentIndex = modes.indexOf(current);
  const nextIndex =
    direction === 'right'
      ? (currentIndex + 1) % modes.length
      : (currentIndex - 1 + modes.length) % modes.length;
  return modes[nextIndex] || 'all';
}

function formatContextWindowSize(value?: number): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : 'unknown';
}

export function getNextFocusMode(
  current: FocusMode,
  direction: 'forward' | 'backward',
  hasList: boolean,
): FocusMode {
  const order: FocusMode[] = hasList
    ? ['tabs', 'search', 'list']
    : ['tabs', 'search'];
  const currentIndex = order.indexOf(current);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex =
    direction === 'forward'
      ? (safeIndex + 1) % order.length
      : (safeIndex - 1 + order.length) % order.length;
  return order[nextIndex] || 'tabs';
}

export function getNextEnabledTabSource(
  current: ManageModelsTabSource,
  direction: 'left' | 'right',
): ManageModelsTabSource {
  const currentIndex = MANAGE_MODELS_TABS.findIndex(
    (tab) => tab.source === current,
  );
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;

  for (let offset = 1; offset <= MANAGE_MODELS_TABS.length; offset += 1) {
    const candidateIndex =
      direction === 'right'
        ? (safeIndex + offset) % MANAGE_MODELS_TABS.length
        : (safeIndex - offset + MANAGE_MODELS_TABS.length) %
          MANAGE_MODELS_TABS.length;
    const candidate = MANAGE_MODELS_TABS[candidateIndex];
    if (candidate?.enabled) {
      return candidate.source;
    }
  }

  return current;
}

export function ManageModelsDialog({
  config,
  onClose,
}: ManageModelsDialogProps): React.JSX.Element {
  const settings = useSettings();
  const [activeTabSource, setActiveTabSource] =
    useState<ManageModelsTabSource>('openrouter');
  const source: ManageModelsSource = 'openrouter';

  const [status, setStatus] = useState<DialogStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ManageModelsCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [focusMode, setFocusMode] = useState<FocusMode>('tabs');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setStatus('loading');
    setError(null);
    setStatusMessage(null);

    try {
      const nextCatalog = await fetchManageModelsCatalog(source);
      const enabledIds = getEnabledModelIdsForSource(source, settings);
      setCatalog(nextCatalog);
      setSelectedIds(enabledIds);
      setHighlightedId(nextCatalog.entries[0]?.id || null);
      setStatus('ready');
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
      setStatus('error');
    }
  }, [settings, source]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const filteredEntries = useMemo(
    () =>
      applyCatalogFilters({
        entries: catalog?.entries || [],
        query,
        selectedIds,
        filterMode,
      }),
    [catalog?.entries, query, selectedIds, filterMode],
  );

  useEffect(() => {
    if (filteredEntries.length === 0) {
      setHighlightedId(null);
      if (focusMode === 'list') {
        setFocusMode('search');
      }
      return;
    }

    if (
      highlightedId &&
      filteredEntries.some((entry) => entry.id === highlightedId)
    ) {
      return;
    }

    setHighlightedId(filteredEntries[0]?.id || null);
  }, [filteredEntries, focusMode, highlightedId]);

  const highlightedIndex = useMemo(() => {
    if (!highlightedId) {
      return 0;
    }
    const index = filteredEntries.findIndex(
      (entry) => entry.id === highlightedId,
    );
    return index >= 0 ? index : 0;
  }, [filteredEntries, highlightedId]);

  const highlightedEntry = useMemo(() => {
    if (!highlightedId) {
      return null;
    }
    return catalog?.entries.find((entry) => entry.id === highlightedId) || null;
  }, [catalog?.entries, highlightedId]);

  const visibleWindow = useMemo(() => {
    if (filteredEntries.length <= MAX_VISIBLE_MODELS) {
      return {
        start: 0,
        entries: filteredEntries,
      };
    }

    const centeredStart = Math.max(
      0,
      Math.min(
        highlightedIndex - Math.floor(MAX_VISIBLE_MODELS / 2),
        filteredEntries.length - MAX_VISIBLE_MODELS,
      ),
    );

    return {
      start: centeredStart,
      entries: filteredEntries.slice(
        centeredStart,
        centeredStart + MAX_VISIBLE_MODELS,
      ),
    };
  }, [filteredEntries, highlightedIndex]);

  const moveHighlight = useCallback(
    (direction: 'up' | 'down') => {
      if (filteredEntries.length === 0) {
        return;
      }

      if (direction === 'up') {
        if (highlightedIndex <= 0) {
          setFocusMode('search');
          return;
        }
        setHighlightedId(filteredEntries[highlightedIndex - 1]?.id || null);
        return;
      }

      const nextIndex = Math.min(
        highlightedIndex + 1,
        filteredEntries.length - 1,
      );
      setHighlightedId(filteredEntries[nextIndex]?.id || null);
    },
    [filteredEntries, highlightedIndex],
  );

  const toggleHighlightedSelection = useCallback(() => {
    const currentEntry = filteredEntries[highlightedIndex];
    if (!currentEntry) {
      return;
    }

    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(currentEntry.id)) {
        next.delete(currentEntry.id);
      } else {
        next.add(currentEntry.id);
      }
      return Array.from(next);
    });
  }, [filteredEntries, highlightedIndex]);

  const handleSave = useCallback(async () => {
    if (!catalog) {
      return;
    }

    const selectedEntries = catalog.entries.filter((entry) =>
      selectedIds.includes(entry.id),
    );

    if (selectedEntries.length === 0) {
      setError('Select at least one model to keep enabled.');
      return;
    }

    setStatus('saving');
    setError(null);
    setStatusMessage(null);

    try {
      const selectedModels: ModelConfig[] = selectedEntries.map(
        (entry) => entry.model,
      );
      const result = await saveManageModelsSelection({
        source,
        selectedModels,
        settings: settings as LoadedSettings,
        config,
      });
      setSelectedIds(result.selectedIds);
      setStatus('ready');
      setStatusMessage(
        result.activeModelId
          ? `Saved ${result.selectedIds.length} enabled models · active model: ${result.activeModelId} · use /model to switch models`
          : `Saved ${result.selectedIds.length} enabled models · use /model to switch models`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
      setStatus('error');
    }
  }, [catalog, config, selectedIds, settings, source]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
        return;
      }

      if (key.ctrl && key.name === 'r' && status !== 'saving') {
        void loadCatalog();
        return;
      }

      if (status === 'saving') {
        return;
      }

      if (key.name === 'tab') {
        setFocusMode((current) =>
          getNextFocusMode(
            current,
            key.shift ? 'backward' : 'forward',
            filteredEntries.length > 0,
          ),
        );
        return;
      }

      if (focusMode === 'tabs') {
        if (key.name === 'left') {
          setActiveTabSource((current) =>
            getNextEnabledTabSource(current, 'left'),
          );
          return;
        }
        if (key.name === 'right') {
          setActiveTabSource((current) =>
            getNextEnabledTabSource(current, 'right'),
          );
          return;
        }
        if (key.name === 'down') {
          setFocusMode('search');
        }
        return;
      }

      if (focusMode === 'search') {
        if (key.name === 'left') {
          setFilterMode((current) => cycleFilter(current, 'left'));
          return;
        }
        if (key.name === 'right') {
          setFilterMode((current) => cycleFilter(current, 'right'));
          return;
        }
        if (key.name === 'up') {
          setFocusMode('tabs');
          return;
        }
        if (key.name === 'down' && filteredEntries.length > 0) {
          setFocusMode('list');
        }
        return;
      }

      if (focusMode === 'list') {
        if (key.name === 'up') {
          moveHighlight('up');
          return;
        }
        if (key.name === 'down') {
          moveHighlight('down');
          return;
        }
        if (key.name === 'space' || key.sequence === ' ') {
          toggleHighlightedSelection();
          return;
        }
        if (key.name === 'return') {
          void handleSave();
        }
      }
    },
    { isActive: true },
  );

  const terminalWidth = process.stdout.columns || 120;
  const searchInputWidth = Math.max(40, Math.min(100, terminalWidth - 16));

  const enabledSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const hiddenAboveCount = visibleWindow.start;
  const hiddenBelowCount = Math.max(
    0,
    filteredEntries.length -
      (visibleWindow.start + visibleWindow.entries.length),
  );

  return (
    <Box flexDirection="column" width="100%">
      <Box width="100%">
        <Text color={theme.border.default} wrap="truncate">
          {'─'.repeat(200)}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text color={theme.text.accent} bold>
            Manage Models:{' '}
          </Text>
          {MANAGE_MODELS_TABS.map((tab) => {
            const isActive = activeTabSource === tab.source;
            const isFocused = focusMode === 'tabs' && isActive;

            return (
              <Box key={tab.source} marginRight={2}>
                {isActive ? (
                  <Text
                    bold
                    backgroundColor={
                      isFocused ? theme.text.accent : theme.border.default
                    }
                    color={theme.background.primary}
                  >
                    {` ${tab.label} `}
                  </Text>
                ) : (
                  <Text color={theme.text.secondary}>
                    {` ${tab.label}${tab.enabled ? '' : ' (soon)'} `}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>

      {(status === 'loading' || status === 'saving') && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {status === 'loading'
              ? 'Loading OpenRouter catalog…'
              : 'Saving enabled models…'}
          </Text>
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      )}

      {statusMessage && (
        <Box marginTop={1}>
          <Text color={theme.status.success}>{statusMessage}</Text>
        </Box>
      )}

      <Box
        borderStyle="round"
        borderColor={
          focusMode === 'search' ? theme.text.accent : theme.border.default
        }
        paddingLeft={1}
        paddingRight={1}
      >
        <TextInput
          value={query}
          onChange={setQuery}
          onTab={() => {
            if (filteredEntries.length > 0) {
              setFocusMode('list');
            }
          }}
          onDown={() => {
            if (filteredEntries.length > 0) {
              setFocusMode('list');
            }
          }}
          placeholder="Search models… (type enabled to filter)"
          height={1}
          isActive={status !== 'saving' && focusMode === 'search'}
          inputWidth={searchInputWidth}
        />
      </Box>

      <Box flexDirection="row" gap={2}>
        <Box
          borderStyle="round"
          borderColor={theme.border.default}
          flexDirection="column"
          paddingX={1}
          paddingY={0}
          width="56%"
        >
          <Text color={theme.text.secondary}>
            {getFilterLabel(filterMode)} · {catalog?.entries.length || 0} total
            · {filteredEntries.length} shown · {selectedIds.length} enabled
          </Text>

          {filteredEntries.length === 0 ? (
            <Text color={theme.text.secondary}>
              No models match the current search and filter.
            </Text>
          ) : (
            <Box flexDirection="column">
              {hiddenAboveCount > 0 && (
                <Text color={theme.text.secondary}>
                  ↑ {hiddenAboveCount} more above
                </Text>
              )}

              {visibleWindow.entries.map((entry, index) => {
                const absoluteIndex = visibleWindow.start + index;
                const isActive =
                  focusMode === 'list' && absoluteIndex === highlightedIndex;
                const isEnabled = enabledSet.has(entry.id);
                const prefix = isActive ? '›' : ' ';
                const checkbox = isEnabled ? '[✓]' : '[ ]';
                const rowColor = isActive
                  ? theme.status.success
                  : isEnabled
                    ? theme.text.accent
                    : theme.text.primary;

                return (
                  <Text key={entry.id} color={rowColor} wrap="truncate-end">
                    {prefix} {checkbox} {buildModelLabel(entry)}
                  </Text>
                );
              })}

              {hiddenBelowCount > 0 && (
                <Text color={theme.text.secondary}>
                  ↓ {hiddenBelowCount} more below
                </Text>
              )}
            </Box>
          )}
        </Box>

        <Box
          borderStyle="round"
          borderColor={theme.border.default}
          flexDirection="column"
          paddingX={1}
          paddingY={0}
          width="44%"
        >
          <Text bold>Details</Text>
          {highlightedEntry ? (
            <Box flexDirection="column">
              <Text>{highlightedEntry.label}</Text>
              <Text color={theme.text.secondary}>
                Model ID: {highlightedEntry.id}
              </Text>
              <Text color={theme.text.secondary}>
                Enabled: {enabledSet.has(highlightedEntry.id) ? 'yes' : 'no'}
              </Text>
              <Text color={theme.text.secondary}>
                Vision: {highlightedEntry.supportsVision ? 'yes' : 'no'}
              </Text>
              <Text color={theme.text.secondary}>
                Context:{' '}
                {formatContextWindowSize(highlightedEntry.contextWindowSize)}
              </Text>
              <Text color={theme.text.secondary}>
                Tags:{' '}
                {highlightedEntry.badges.length > 0
                  ? highlightedEntry.badges.join(', ')
                  : 'none'}
              </Text>
            </Box>
          ) : (
            <Text color={theme.text.secondary}>
              Move to the model list to inspect a model.
            </Text>
          )}
        </Box>
      </Box>

      <Box>
        <Text color={theme.text.secondary}>
          ←/→ tab switch · ↓ enter list · Space toggle · Enter save · Esc cancel
        </Text>
      </Box>
    </Box>
  );
}
