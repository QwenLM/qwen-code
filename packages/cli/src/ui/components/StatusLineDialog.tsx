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
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import type { UIState } from '../contexts/UIStateContext.js';
import { truncateToWidth } from '../utils/textUtils.js';
import { MultiSelect, type MultiSelectItem } from './shared/MultiSelect.js';
import {
  aggregateModelTokens,
  buildStatusLinePresetData,
  buildStatusLinePresetLines,
  DEFAULT_STATUS_LINE_PRESET_CONFIG,
  normalizeStatusLinePresetConfig,
  orderStatusLinePresetItems,
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
// Fixed non-list rows: border(2) + paddingY(2) + title(1) + subtitle(1)
// + search block(3) + list marginTop(1) + preview block(3) + footer(2).
// The preview block is exactly one content line: buildStatusLinePresetLines
// returns at most one line, and the empty state renders one fallback line.
// Every counted text renders with wrap="truncate", and option labels plus
// the separator are capped to the terminal width, so the count stays valid
// at any width.
const STATUS_LINE_DIALOG_FIXED_ROWS = 15;
// Terminal cells an option row spends outside its label: dialog
// border(2) + paddingX(2) + active marker(2) + checkbox(4).
const LABEL_ROW_OVERHEAD = 10;

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

  return {
    type: 'preset',
    useThemeColors: selected.has(THEME_COLORS_KEY),
    items: orderStatusLinePresetItems(keys),
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

// Search text is derived from the untruncated source data, never from
// option.label: labels are display-truncated to the render width (labelCap
// below), so filtering on them would make results width-dependent — words
// lost to truncation would silently stop matching.
const PRESET_ITEM_BY_ID = new Map(
  STATUS_LINE_PRESET_ITEMS.map((item) => [item.id, item]),
);

function getOptionSearchText(
  option: MultiSelectItem<StatusLineOption>,
): string {
  if (option.value.kind === 'theme-colors') {
    return 'use theme colors apply colors from the active /theme theme colors active theme';
  }
  if (option.value.kind === 'separator') {
    return '';
  }
  const item = PRESET_ITEM_BY_ID.get(option.value.id);
  return item
    ? `${item.label} ${item.description} ${item.id}`.toLowerCase()
    : option.value.id;
}

function getPreviewData(config: Config, uiState: UIState) {
  const stats = uiState.sessionStats;
  const metrics = stats.metrics;
  const { totalInputTokens, totalOutputTokens } = aggregateModelTokens(metrics);
  const contentGeneratorConfig = config.getContentGeneratorConfig();

  return buildStatusLinePresetData({
    sessionId: stats.sessionId,
    version: config.getCliVersion(),
    modelDisplayName: config.getModelDisplayName(),
    reasoning: contentGeneratorConfig?.reasoning,
    currentDir: config.getTargetDir(),
    branch: uiState.branchName,
    contextWindowSize: contentGeneratorConfig?.contextWindowSize || 0,
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

  // Cap labels to the render width so each option is exactly one terminal
  // row — an uncapped label (e.g. model-with-reasoning, ~86 cells with the
  // marker/checkbox columns) wraps to 2 rows at narrow widths and
  // overflows the height budget. The floor is 1 (not DESCRIPTION_COLUMN) so
  // the one-row invariant holds at any width; below ~34 columns labels
  // degrade to short truncated strings instead of wrapping.
  const labelCap = Math.max(
    1,
    (uiState.mainAreaWidth ?? 80) - LABEL_ROW_OVERHEAD,
  );

  const options = useMemo<Array<MultiSelectItem<StatusLineOption>>>(
    () => [
      {
        key: THEME_COLORS_KEY,
        value: { kind: 'theme-colors' },
        label: truncateToWidth(
          `${'Use theme colors'.padEnd(DESCRIPTION_COLUMN)} Apply colors from the active /theme`,
          labelCap,
        ),
      },
      {
        key: 'statusline-separator',
        value: { kind: 'separator' },
        // The decorative rule gets no truncateToWidth from MultiSelect; cap
        // it to the label budget so it stays one row at narrow widths.
        label: '─'.repeat(Math.min(23, labelCap)),
        disabled: true,
        separator: true,
      },
      ...STATUS_LINE_PRESET_ITEMS.map((item) => ({
        key: item.id,
        value: { kind: 'item' as const, id: item.id },
        label: truncateToWidth(
          `${item.label.padEnd(DESCRIPTION_COLUMN)} ${item.description}`,
          labelCap,
        ),
      })),
    ],
    [labelCap],
  );

  const terminalHeight = availableTerminalHeight ?? 18;
  const hasFullLayout = terminalHeight >= STATUS_LINE_DIALOG_FIXED_ROWS + 1;

  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!hasFullLayout || !normalizedQuery) {
      return options;
    }
    return options.filter((option) =>
      getOptionSearchText(option).includes(normalizedQuery),
    );
  }, [hasFullLayout, options, query]);

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
    const statusLine =
      settings.forScope(effectiveScope).settings.ui?.statusLine;
    const hideContextIndicator =
      statusLine && typeof statusLine === 'object'
        ? statusLine.hideContextIndicator
        : undefined;
    const savedConfig = {
      ...presetConfig,
      ...(typeof hideContextIndicator === 'boolean'
        ? { hideContextIndicator }
        : {}),
    };
    settings.setValue(effectiveScope, 'ui.statusLine', savedConfig);
    onSaved?.(savedConfig);
    const feedbackItem: HistoryItemWithoutId & Record<string, unknown> = {
      type: MessageType.INFO,
      text: `Status line preset saved to ${effectiveScope.toLowerCase()} settings.`,
    };
    addItem(feedbackItem, Date.now());
    config.getChatRecordingService?.()?.recordSlashCommand({
      phase: 'result',
      rawCommand: '/statusline',
      outputHistoryItems: [feedbackItem],
    });
    onClose();
  }, [addItem, config, onClose, onSaved, presetConfig, settings]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (hasFullLayout && query) {
          setQuery('');
          return;
        }
        onClose();
        return;
      }

      if (
        hasFullLayout &&
        (key.name === 'backspace' || key.name === 'delete')
      ) {
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
        hasFullLayout &&
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
    1,
    Math.min(
      10,
      hasFullLayout
        ? terminalHeight - STATUS_LINE_DIALOG_FIXED_ROWS
        : terminalHeight,
    ),
  );

  return (
    <Box
      borderStyle={hasFullLayout ? 'round' : undefined}
      borderColor={theme.border.default}
      flexDirection="column"
      paddingX={1}
      paddingY={hasFullLayout ? 1 : 0}
      width="100%"
    >
      {hasFullLayout && (
        <>
          <Text bold wrap="truncate">
            Configure Status Line
          </Text>
          <Text color={theme.text.secondary} wrap="truncate">
            Select which items to display in the status line.
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text color={theme.text.secondary} wrap="truncate">
              Type to search
            </Text>
            <Text wrap="truncate">{query ? `> ${query}` : '>'}</Text>
          </Box>
        </>
      )}

      <Box marginTop={hasFullLayout ? 1 : 0} flexDirection="column">
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
          <Text color={theme.text.secondary} wrap="truncate">
            No preset items match.
          </Text>
        )}
      </Box>

      {hasFullLayout && (
        <>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.text.secondary} wrap="truncate">
              Preview
            </Text>
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
              <Text color={theme.text.secondary} wrap="truncate">
                Select at least one item to show a status line.
              </Text>
            )}
          </Box>

          <Box marginTop={1}>
            <Text color={theme.text.secondary} wrap="truncate">
              Use up/down to navigate, space to select, enter to confirm, esc to
              cancel
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
