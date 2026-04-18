/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type { Config } from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { formatRelativeTime } from '../utils/formatters.js';
import { truncateText } from '../utils/sessionPickerUtils.js';
import { t } from '../../i18n/index.js';
import type { RewindHistoryEntry } from '../types/rewind.js';
import { buildRewindEntries } from '../utils/rewindUtils.js';

interface ConversationHistoryPickerProps {
  config: Config;
  sessionId: string;
  onSelect: (entry: RewindHistoryEntry) => void;
  onCancel: () => void;
}

const PREFIX_CHARS = {
  selected: '› ',
  scrollUp: '↑ ',
  scrollDown: '↓ ',
  normal: '  ',
};

function renderCodeSummary(entry: RewindHistoryEntry): React.JSX.Element {
  if (!entry.codeSummary.hasChanges) {
    return (
      <Text color={theme.text.secondary}>{entry.codeSummary.summaryText}</Text>
    );
  }

  if (entry.codeSummary.changes.length === 1) {
    const [change] = entry.codeSummary.changes;
    return (
      <Text>
        <Text color={theme.text.secondary}>{change.path} </Text>
        <Text color={theme.status.success}>+{change.additions}</Text>
        <Text color={theme.text.secondary}> </Text>
        <Text color={theme.status.error}>-{change.deletions}</Text>
      </Text>
    );
  }

  const additions = entry.codeSummary.changes.reduce(
    (sum, change) => sum + change.additions,
    0,
  );
  const deletions = entry.codeSummary.changes.reduce(
    (sum, change) => sum + change.deletions,
    0,
  );

  return (
    <Text>
      <Text color={theme.text.secondary}>
        {entry.codeSummary.changes.length} files changed{' '}
      </Text>
      <Text color={theme.status.success}>+{additions}</Text>
      <Text color={theme.text.secondary}> </Text>
      <Text color={theme.status.error}>-{deletions}</Text>
    </Text>
  );
}

export function ConversationHistoryPicker({
  config,
  sessionId,
  onSelect,
  onCancel,
}: ConversationHistoryPickerProps): React.JSX.Element {
  const { columns: width, rows: height } = useTerminalSize();
  const [entries, setEntries] = useState<RewindHistoryEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const boxWidth = width - 4;
  const reservedLines = 8;
  const itemHeight = 4;
  const maxVisibleItems = Math.max(
    1,
    Math.floor((height - reservedLines) / itemHeight),
  );

  useEffect(() => {
    let isMounted = true;

    const loadEntries = async () => {
      setIsLoading(true);
      setLoadError(null);

      try {
        const result = await buildRewindEntries(config, sessionId);
        if (!isMounted) {
          return;
        }
        setEntries(result);
        setSelectedIndex(Math.max(0, result.length - 1));
        setScrollOffset(0);
      } catch (error) {
        if (!isMounted) {
          return;
        }
        setEntries([]);
        setSelectedIndex(0);
        setScrollOffset(0);
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void loadEntries();

    return () => {
      isMounted = false;
    };
  }, [config, sessionId]);

  useEffect(() => {
    if (selectedIndex >= entries.length && entries.length > 0) {
      setSelectedIndex(entries.length - 1);
    }
  }, [entries.length, selectedIndex]);

  useEffect(() => {
    setScrollOffset((currentOffset) => {
      const maxOffset = Math.max(0, entries.length - maxVisibleItems);
      const clampedOffset = Math.min(currentOffset, maxOffset);
      if (selectedIndex < clampedOffset) {
        return selectedIndex;
      }
      if (selectedIndex >= clampedOffset + maxVisibleItems) {
        return Math.min(maxOffset, selectedIndex - maxVisibleItems + 1);
      }
      return clampedOffset;
    });
  }, [entries.length, maxVisibleItems, selectedIndex]);

  const visibleEntries = useMemo(
    () => entries.slice(scrollOffset, scrollOffset + maxVisibleItems),
    [entries, maxVisibleItems, scrollOffset],
  );
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxVisibleItems < entries.length;

  useKeypress(
    (key) => {
      const { name, ctrl } = key;

      if (name === 'escape' || (ctrl && name === 'c')) {
        onCancel();
        return;
      }

      if (name === 'return') {
        const entry = entries[selectedIndex];
        if (entry) {
          onSelect(entry);
        }
        return;
      }

      if (name === 'up' || name === 'k') {
        setSelectedIndex((prev) => {
          const next = Math.max(0, prev - 1);
          if (next < scrollOffset) {
            setScrollOffset(next);
          }
          return next;
        });
        return;
      }

      if (name === 'down' || name === 'j') {
        setSelectedIndex((prev) => {
          const next = Math.min(entries.length - 1, prev + 1);
          if (next >= scrollOffset + maxVisibleItems) {
            setScrollOffset(next - maxVisibleItems + 1);
          }
          return next;
        });
      }
    },
    { isActive: true },
  );

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
        <Box flexDirection="column" paddingX={1}>
          <Text bold color={theme.text.primary}>
            {t('Rewind')}
          </Text>
          <Text color={theme.text.secondary}>
            {t('Restore the code and/or conversation to the point before…')}
          </Text>
        </Box>

        <Box>
          <Text color={theme.border.default}>{'─'.repeat(boxWidth - 2)}</Text>
        </Box>

        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
          {isLoading ? (
            <Box paddingY={1} justifyContent="center">
              <Text color={theme.text.secondary}>
                {t('Loading conversation history...')}
              </Text>
            </Box>
          ) : loadError ? (
            <Box paddingY={1} flexDirection="column">
              <Text color={theme.status.error}>
                {t('Failed to load conversation history.')}
              </Text>
              <Text color={theme.text.secondary}>{loadError}</Text>
            </Box>
          ) : (
            visibleEntries.map((entry, visibleIndex) => {
              const actualIndex = scrollOffset + visibleIndex;
              const isSelected = actualIndex === selectedIndex;
              const isFirst = visibleIndex === 0;
              const isLast = visibleIndex === visibleEntries.length - 1;
              const prefix = isSelected
                ? PREFIX_CHARS.selected
                : isFirst && showScrollUp
                  ? PREFIX_CHARS.scrollUp
                  : isLast && showScrollDown
                    ? PREFIX_CHARS.scrollDown
                    : PREFIX_CHARS.normal;
              const truncatedPrompt = truncateText(entry.label, boxWidth - 6);

              return (
                <Box
                  key={entry.key}
                  flexDirection="column"
                  marginBottom={isLast ? 0 : 1}
                >
                  <Box>
                    <Text
                      color={
                        isSelected ? theme.text.accent : theme.text.secondary
                      }
                    >
                      {prefix}
                    </Text>
                    <Text
                      color={
                        isSelected ? theme.text.accent : theme.text.primary
                      }
                      bold={isSelected}
                    >
                      {truncatedPrompt}
                    </Text>
                  </Box>
                  <Box paddingLeft={2}>
                    <Text color={theme.text.secondary}>
                      {entry.kind === 'current'
                        ? t('Current conversation')
                        : formatRelativeTime(Date.parse(entry.timestamp ?? ''))}
                    </Text>
                  </Box>
                  <Box paddingLeft={2}>{renderCodeSummary(entry)}</Box>
                </Box>
              );
            })
          )}
        </Box>

        <Box>
          <Text color={theme.border.default}>{'─'.repeat(boxWidth - 2)}</Text>
        </Box>

        <Box paddingX={1}>
          <Text color={theme.text.secondary}>
            {t('↑↓ to navigate · Enter to confirm · Esc to cancel')}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
