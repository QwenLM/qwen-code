/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useCallback } from 'react';
import { Box, Text } from 'ink';
import type { HistoryItem } from '../types.js';
import { theme } from '../semantic-colors.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { truncateText } from '../utils/sessionPickerUtils.js';
import { t } from '../../i18n/index.js';

export interface RewindSelectorProps {
  history: HistoryItem[];
  onRewind: (userItem: HistoryItem) => void;
  onCancel: () => void;
}

const MAX_VISIBLE_ITEMS = 7;

/**
 * Extract user-type items from UI history for the rewind pick list.
 */
function getUserTurns(history: HistoryItem[]): HistoryItem[] {
  return history.filter((item) => item.type === 'user');
}

interface TurnItemViewProps {
  item: HistoryItem;
  isSelected: boolean;
  isFirst: boolean;
  isLast: boolean;
  showScrollUp: boolean;
  showScrollDown: boolean;
  maxPromptWidth: number;
  turnNumber: number;
}

function TurnItemView({
  item,
  isSelected,
  isFirst,
  isLast,
  showScrollUp,
  showScrollDown,
  maxPromptWidth,
  turnNumber,
}: TurnItemViewProps): React.JSX.Element {
  const showUpIndicator = isFirst && showScrollUp;
  const showDownIndicator = isLast && showScrollDown;

  const prefix = isSelected
    ? '› '
    : showUpIndicator
      ? '↑ '
      : showDownIndicator
        ? '↓ '
        : '  ';

  const promptText = item.text || '(empty prompt)';
  const truncatedPrompt = truncateText(promptText, maxPromptWidth);

  return (
    <Box flexDirection="column" marginBottom={isLast ? 0 : 1}>
      <Box>
        <Text
          color={
            isSelected
              ? theme.text.accent
              : showUpIndicator || showDownIndicator
                ? theme.text.secondary
                : undefined
          }
          bold={isSelected}
        >
          {prefix}
        </Text>
        <Text color={theme.text.secondary}>{`#${turnNumber} `}</Text>
        <Text
          color={isSelected ? theme.text.accent : theme.text.primary}
          bold={isSelected}
        >
          {truncatedPrompt}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Two-phase rewind selector:
 * 1. Pick list — choose which user turn to rewind to
 * 2. Confirm — confirm the rewind action
 */
export function RewindSelector({
  history,
  onRewind,
  onCancel,
}: RewindSelectorProps) {
  const { columns: width, rows: height } = useTerminalSize();
  const userTurns = useMemo(() => getUserTurns(history), [history]);

  const [selectedIndex, setSelectedIndex] = useState(userTurns.length - 1);
  const [confirmItem, setConfirmItem] = useState<HistoryItem | null>(null);

  const boxWidth = width - 4;
  const maxVisibleItems = Math.min(MAX_VISIBLE_ITEMS, userTurns.length);

  // Centered scroll offset
  const scrollOffset = useMemo(() => {
    if (userTurns.length <= maxVisibleItems) return 0;
    const halfVisible = Math.floor(maxVisibleItems / 2);
    let offset = selectedIndex - halfVisible;
    offset = Math.max(0, offset);
    offset = Math.min(userTurns.length - maxVisibleItems, offset);
    return offset;
  }, [userTurns.length, maxVisibleItems, selectedIndex]);

  const visibleTurns = useMemo(
    () => userTurns.slice(scrollOffset, scrollOffset + maxVisibleItems),
    [userTurns, scrollOffset, maxVisibleItems],
  );
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxVisibleItems < userTurns.length;

  const handleConfirmSelect = useCallback(
    (confirmed: boolean) => {
      if (confirmed && confirmItem) {
        onRewind(confirmItem);
      } else {
        setConfirmItem(null);
      }
    },
    [confirmItem, onRewind],
  );

  // Pick-list key handler
  useKeypress(
    (key) => {
      const { name, ctrl } = key;

      if (name === 'escape' || (ctrl && name === 'c')) {
        onCancel();
        return;
      }

      if (name === 'return') {
        const selected = userTurns[selectedIndex];
        if (selected) {
          setConfirmItem(selected);
        }
        return;
      }

      if (name === 'up' || name === 'k') {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }

      if (name === 'down' || name === 'j') {
        setSelectedIndex((prev) => Math.min(userTurns.length - 1, prev + 1));
        return;
      }
    },
    { isActive: confirmItem === null },
  );

  // Confirm key handler
  useKeypress(
    (key) => {
      const { name, ctrl, sequence } = key;

      if (name === 'escape' || (ctrl && name === 'c')) {
        setConfirmItem(null);
        return;
      }

      if (name === 'return' || sequence === 'y' || sequence === 'Y') {
        handleConfirmSelect(true);
        return;
      }

      if (sequence === 'n' || sequence === 'N') {
        handleConfirmSelect(false);
        return;
      }
    },
    { isActive: confirmItem !== null },
  );

  if (userTurns.length === 0) {
    return (
      <Box flexDirection="column" width={boxWidth}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.border.default}
          width={boxWidth}
        >
          <Box paddingX={1}>
            <Text color={theme.text.secondary}>
              {t('No user turns to rewind to.')}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // Confirm phase
  if (confirmItem) {
    const promptPreview = truncateText(
      confirmItem.text || '(empty)',
      boxWidth - 10,
    );
    return (
      <Box flexDirection="column" width={boxWidth}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.border.default}
          width={boxWidth}
        >
          <Box paddingX={1}>
            <Text bold color={theme.text.primary}>
              {t('Rewind Conversation')}
            </Text>
          </Box>
          <Box>
            <Text color={theme.border.default}>{'─'.repeat(boxWidth - 2)}</Text>
          </Box>
          <Box paddingX={1} flexDirection="column">
            <Box marginBottom={1}>
              <Text color={theme.text.primary}>{t('Rewind to: ')}</Text>
              <Text color={theme.text.accent} bold>
                {promptPreview}
              </Text>
            </Box>
            <Text color={theme.status.warning}>
              {t(
                'This will remove all conversation after this turn. The prompt will be pre-populated in the input for editing.',
              )}
            </Text>
          </Box>
          <Box>
            <Text color={theme.border.default}>{'─'.repeat(boxWidth - 2)}</Text>
          </Box>
          <Box paddingX={1}>
            <Text color={theme.text.secondary}>
              {t('Enter/Y to confirm · Esc/N to go back')}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // Pick-list phase
  return (
    <Box
      flexDirection="column"
      width={boxWidth}
      height={height - 1}
      overflow="hidden"
    >
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        width={boxWidth}
        height={height - 1}
        overflow="hidden"
      >
        {/* Header */}
        <Box paddingX={1}>
          <Text bold color={theme.text.primary}>
            {t('Rewind Conversation')}
          </Text>
          <Text color={theme.text.secondary}>
            {' '}
            {t('({{count}} turns)', { count: String(userTurns.length) })}
          </Text>
        </Box>

        {/* Separator */}
        <Box>
          <Text color={theme.border.default}>{'─'.repeat(boxWidth - 2)}</Text>
        </Box>

        {/* Turn list */}
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
          {visibleTurns.map((item, visibleIndex) => {
            const actualIndex = scrollOffset + visibleIndex;
            return (
              <TurnItemView
                key={item.id}
                item={item}
                isSelected={actualIndex === selectedIndex}
                isFirst={visibleIndex === 0}
                isLast={visibleIndex === visibleTurns.length - 1}
                showScrollUp={showScrollUp}
                showScrollDown={showScrollDown}
                maxPromptWidth={boxWidth - 10}
                turnNumber={actualIndex + 1}
              />
            );
          })}
        </Box>

        {/* Separator */}
        <Box>
          <Text color={theme.border.default}>{'─'.repeat(boxWidth - 2)}</Text>
        </Box>

        {/* Footer */}
        <Box paddingX={1}>
          <Text color={theme.text.secondary}>
            {t('↑↓ to navigate · Enter to select · Esc to cancel')}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
