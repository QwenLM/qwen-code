/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { t } from '../../i18n/index.js';

interface Shortcut {
  key: string;
  description: string;
}

// Platform-specific key mappings
const getNewlineKey = () =>
  process.platform === 'win32' ? 'ctrl+enter' : 'ctrl+j';
const getPasteKey = () => {
  if (process.platform === 'win32') return 'alt+v';
  return process.platform === 'darwin' ? 'cmd+v' : 'ctrl+v';
};
const getExternalEditorKey = () =>
  process.platform === 'darwin' ? 'ctrl+x' : 'ctrl+x';

// Generate shortcuts with translations (called at render time)
const getShortcuts = (showModelToggle: boolean): Shortcut[] => {
  const shortcuts: Shortcut[] = [
    { key: '!', description: t('for shell mode') },
    { key: '/', description: t('for commands') },
    { key: '@', description: t('for file paths') },
    { key: 'esc esc', description: t('to clear input') },
    {
      key: process.platform === 'win32' ? 'tab' : 'shift+tab',
      description: t('to cycle approvals'),
    },
    { key: 'ctrl+c', description: t('to quit') },
    { key: getNewlineKey(), description: t('for newline') + ' ⏎' },
    { key: 'ctrl+l', description: t('to clear screen') },
    { key: 'ctrl+o', description: t('to view transcript') },
    { key: 'ctrl+r', description: t('to search history') },
    { key: 'ctrl+y', description: t('to retry last request') },
    { key: 'ctrl+q', description: t('to queue for the next turn') },
    { key: getPasteKey(), description: t('to paste images') },
    { key: getExternalEditorKey(), description: t('for external editor') },
  ];

  if (showModelToggle) {
    // Insert after ctrl+o to keep logical grouping
    shortcuts.splice(9, 0, {
      key: 'ctrl+f',
      description: t('to toggle model'),
    });
  }

  return shortcuts;
};

const ShortcutItem: React.FC<{ shortcut: Shortcut }> = ({ shortcut }) => (
  <Text color={theme.text.secondary}>
    <Text color={theme.text.accent}>{shortcut.key}</Text> {shortcut.description}
  </Text>
);

// Layout constants
const COLUMN_GAP = 4;
const MARGIN_LEFT = 2;
const MARGIN_RIGHT = 2;

export const KeyboardShortcuts: React.FC = () => {
  const { columns: terminalWidth } = useTerminalSize();
  const settings = useSettings();
  const showModelToggle = !!settings.merged.model?.toggleModel;
  const shortcuts = getShortcuts(showModelToggle);

  // Column distribution sums must match shortcuts.length (14 with toggle, 13 without)
  const columnSplits: Record<number, number[]> = showModelToggle
    ? { 3: [5, 5, 4], 2: [7, 7], 1: [14] }
    : { 3: [5, 4, 4], 2: [7, 6], 1: [13] };

  // Helper to calculate width needed for a column layout
  const getShortcutWidth = (shortcut: Shortcut) =>
    shortcut.key.length + 1 + shortcut.description.length;

  const calculateLayoutWidth = (splits: number[]): number => {
    let startIndex = 0;
    let totalWidth = 0;
    splits.forEach((count, colIndex) => {
      const columnItems = shortcuts.slice(startIndex, startIndex + count);
      const columnWidth = Math.max(...columnItems.map(getShortcutWidth));
      totalWidth += columnWidth;
      if (colIndex < splits.length - 1) {
        totalWidth += COLUMN_GAP;
      }
      startIndex += count;
    });
    return totalWidth;
  };

  // Calculate number of columns based on terminal width and actual content
  const availableWidth = terminalWidth - MARGIN_LEFT - MARGIN_RIGHT;
  const width3Col = calculateLayoutWidth(columnSplits[3]);
  const width2Col = calculateLayoutWidth(columnSplits[2]);

  const numColumns =
    availableWidth >= width3Col ? 3 : availableWidth >= width2Col ? 2 : 1;

  // Split shortcuts into columns using predefined distribution
  const splits = columnSplits[numColumns];
  const columns: Shortcut[][] = [];
  let startIndex = 0;
  for (const count of splits) {
    columns.push(shortcuts.slice(startIndex, startIndex + count));
    startIndex += count;
  }

  return (
    <Box
      flexDirection="row"
      marginLeft={MARGIN_LEFT}
      marginRight={MARGIN_RIGHT}
    >
      {columns.map((column, colIndex) => (
        <Box
          key={colIndex}
          flexDirection="column"
          marginRight={colIndex < numColumns - 1 ? COLUMN_GAP : 0}
        >
          {column.map((shortcut) => (
            <ShortcutItem key={shortcut.key} shortcut={shortcut} />
          ))}
        </Box>
      ))}
    </Box>
  );
};
