/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import type { UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { MessageType } from '../types.js';
import type { UIState } from '../contexts/UIStateContext.js';
import { MultiSelect, type MultiSelectItem } from './shared/MultiSelect.js';
import {
  aggregateModelTokens,
  buildStatusLinePresetData,
  buildStatusLinePresetLines,
  DEFAULT_STATUS_LINE_PRESET_CONFIG,
  normalizeStatusLinePresetConfig,
  STATUS_LINE_PRESET_ITEMS,
  type StatusLinePresetConfig,
  type StatusLinePresetItemId,
} from '../statusLinePresets.js';

type StatusLineOption =
  | { kind: 'theme-colors' }
  | { kind: 'separator' }
  | { kind: 'item'; id: StatusLinePresetItemId };

interface StatusLineDialogProps {
  settings: LoadedSettings;
  config: Config;
  uiState: UIState;
  addItem: UseHistoryManagerReturn['addItem'];
  onSaved?: (config: StatusLinePresetConfig) => void;
  onClose: () => void;
  availableTerminalHeight?: number;
}

const THEME_COLORS_KEY = 'theme-colors';
const DESCRIPTION_COLUMN = 24;

function buildInitialSelectedKeys(settings: LoadedSettings): string[] {
  const preset =
    normalizeStatusLinePresetConfig(settings.merged.ui?.statusLine) ??
    DEFAULT_STATUS_LINE_PRESET_CONFIG;
  return [
    ...(preset.useThemeColors ? [THEME_COLORS_KEY] : []),
    ...preset.items,
  ];
}

function buildConfigFromKeys(keys: readonly string[]): StatusLinePresetConfig {
  const selected = new Set(keys);
  const validItemIds = new Set(STATUS_LINE_PRESET_ITEMS.map((item) => item.id));
  const items = [
    ...new Set(
      keys.filter((key): key is StatusLinePresetItemId =>
        validItemIds.has(key as StatusLinePresetItemId),
      ),
    ),
  ];

  return {
    type: 'preset',
    useThemeColors: selected.has(THEME_COLORS_KEY),
    items,
  };
}

function getEffectiveStatusLineScope(settings: LoadedSettings): SettingScope {
  if (settings.forScope(SettingScope.System).settings.ui?.statusLine) {
    return SettingScope.System;
  }
  if (
    settings.isTrusted &&
    settings.forScope(SettingScope.Workspace).settings.ui?.statusLine
  ) {
    return SettingScope.Workspace;
  }
  return SettingScope.User;
}

function getOptionSearchText(
  option: MultiSelectItem<StatusLineOption>,
): string {
  const value =
    option.value.kind === 'theme-colors'
      ? 'theme colors active theme'
      : option.value.kind === 'separator'
        ? ''
        : option.value.id;
  return `${option.label} ${value}`.toLowerCase();
}

function getPreviewData(config: Config, uiState: UIState) {
  const stats = uiState.sessionStats;
  const metrics = stats.metrics;
  const { totalInputTokens, totalOutputTokens } = aggregateModelTokens(metrics);

  return buildStatusLinePresetData({
    sessionId: stats.sessionId,
    version: config.getCliVersion(),
    modelDisplayName: uiState.currentModel || config.getModel(),
    currentDir: config.getTargetDir(),
    branch: uiState.branchName,
    contextWindowSize:
      config.getContentGeneratorConfig()?.contextWindowSize || 0,
    currentUsage: stats.lastPromptTokenCount,
    totalInputTokens,
    totalOutputTokens,
    totalLinesAdded: metrics.files.totalLinesAdded,
    totalLinesRemoved: metrics.files.totalLinesRemoved,
    streamingState: uiState.streamingState,
  });
}

export function StatusLineDialog({
  settings,
  config,
  uiState,
  addItem,
  onSaved,
  onClose,
  availableTerminalHeight,
}: StatusLineDialogProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() =>
    buildInitialSelectedKeys(settings),
  );

  const options = useMemo<Array<MultiSelectItem<StatusLineOption>>>(
    () => [
      {
        key: THEME_COLORS_KEY,
        value: { kind: 'theme-colors' },
        label: `${'Use theme colors'.padEnd(DESCRIPTION_COLUMN)} Apply colors from the active /theme`,
      },
      {
        key: 'statusline-separator',
        value: { kind: 'separator' },
        label: '───────────────────────',
        disabled: true,
        separator: true,
      },
      ...STATUS_LINE_PRESET_ITEMS.map((item) => ({
        key: item.id,
        value: { kind: 'item' as const, id: item.id },
        label: `${item.label.padEnd(DESCRIPTION_COLUMN)} ${item.description}`,
      })),
    ],
    [],
  );

  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return options;
    }
    return options.filter((option) =>
      getOptionSearchText(option).includes(normalizedQuery),
    );
  }, [options, query]);

  const presetConfig = useMemo(
    () => buildConfigFromKeys(selectedKeys),
    [selectedKeys],
  );
  const previewData = useMemo(
    () => getPreviewData(config, uiState),
    [config, uiState],
  );
  const previewLines = useMemo(
    () => buildStatusLinePresetLines(presetConfig, previewData),
    [presetConfig, previewData],
  );

  const handleConfirm = useCallback(() => {
    const effectiveScope = getEffectiveStatusLineScope(settings);
    settings.setValue(effectiveScope, 'ui.statusLine', presetConfig);
    onSaved?.(presetConfig);
    addItem(
      {
        type: MessageType.INFO,
        text: `Status line preset saved to ${effectiveScope.toLowerCase()} settings.`,
      },
      Date.now(),
    );
    onClose();
  }, [addItem, onClose, onSaved, presetConfig, settings]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (query) {
          setQuery('');
          return;
        }
        onClose();
        return;
      }

      if (key.name === 'backspace' || key.name === 'delete') {
        setQuery((current) => current.slice(0, -1));
        return;
      }

      if (
        key.name === 'j' ||
        key.name === 'k' ||
        key.name === 'up' ||
        key.name === 'down' ||
        key.name === 'return'
      ) {
        return;
      }

      if (
        !key.ctrl &&
        !key.meta &&
        key.sequence.length === 1 &&
        key.sequence >= '!' &&
        key.sequence <= '~'
      ) {
        setQuery((current) => `${current}${key.sequence}`);
      }
    },
    { isActive: true },
  );

  const maxItemsToShow = Math.max(
    5,
    Math.min(10, (availableTerminalHeight ?? 18) - 8),
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      width="100%"
    >
      <Text bold>Configure Status Line</Text>
      <Text color={theme.text.secondary}>
        Select which items to display in the status line.
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>Type to search</Text>
        <Text>{query ? `> ${query}` : '>'}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {filteredOptions.length > 0 ? (
          <MultiSelect
            items={filteredOptions}
            selectedKeys={selectedKeys}
            onSelectedKeysChange={setSelectedKeys}
            onConfirm={handleConfirm}
            showNumbers={false}
            checkedText="[x]"
            showActiveMarker
            maxItemsToShow={maxItemsToShow}
          />
        ) : (
          <Text color={theme.text.secondary}>No preset items match.</Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>Preview</Text>
        {previewLines.length > 0 ? (
          previewLines.map((line, index) => (
            <Text
              key={`${line}-${index}`}
              color={
                presetConfig.useThemeColors ? theme.text.accent : undefined
              }
              dimColor={!presetConfig.useThemeColors}
              wrap="truncate"
            >
              {line}
            </Text>
          ))
        ) : (
          <Text color={theme.text.secondary}>
            Select at least one item to show a status line.
          </Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          Use up/down to navigate, space to select, enter to confirm, esc to
          cancel
        </Text>
      </Box>
    </Box>
  );
}
