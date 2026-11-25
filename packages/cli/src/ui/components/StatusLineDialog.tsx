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
import type { UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import type { UIState } from '../contexts/UIStateContext.js';
import { MultiSelect } from './shared/MultiSelect.js';
import {
  buildStatusLinePresetLines,
  type StatusLinePresetConfig,
} from '../statusLinePresets.js';
import {
  buildInitialSelectedKeys,
  buildConfigFromKeys,
  getEffectiveStatusLineScope,
  getPreviewData,
  STATUS_LINE_OPTIONS,
  STATUS_LINE_DIALOG_FIXED_ROWS,
} from '../status-line-model.js';

interface StatusLineDialogProps {
  settings: LoadedSettings;
  config: Config;
  uiState: UIState;
  addItem: UseHistoryManagerReturn['addItem'];
  onSaved?: (config: StatusLinePresetConfig) => void;
  onClose: () => void;
  availableTerminalHeight?: number;
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

  const terminalHeight = availableTerminalHeight ?? 18;
  const hasFullLayout = terminalHeight >= STATUS_LINE_DIALOG_FIXED_ROWS + 1;

  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!hasFullLayout || !normalizedQuery) {
      return STATUS_LINE_OPTIONS;
    }
    return STATUS_LINE_OPTIONS.filter(
      ({ key, label, separator }) =>
        !separator && `${label} ${key}`.toLowerCase().includes(normalizedQuery),
    );
  }, [hasFullLayout, query]);

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
            truncateLabels
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
