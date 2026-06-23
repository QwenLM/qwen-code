/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';
import { useState, useCallback, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';
import { useMouseEvents } from '../hooks/useMouseEvents.js';
import type { MouseEvent } from '../utils/mouse.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';
import { AlternateScreen } from './AlternateScreen.js';
import type { ThinkingViewerData } from '../contexts/ThinkingViewerContext.js';
import { THINKING_ICON } from './messages/ConversationMessages.js';
import { formatDuration } from '../utils/displayUtils.js';

interface ThinkingViewerProps {
  data: ThinkingViewerData;
  onClose: () => void;
  /** When true, Ink already owns the alternate screen (VP mode) — skip escape writes. */
  useAlternateScreen?: boolean;
}

const WHEEL_LINES = 3;

export const ThinkingViewer: FC<ThinkingViewerProps> = ({
  data,
  onClose,
  useAlternateScreen = true,
}) => {
  const { rows } = useTerminalSize();
  const [scrollOffset, setScrollOffset] = useState(0);

  const headerHeight = 2;
  const footerHeight = 2;
  const contentHeight = Math.max(rows - headerHeight - footerHeight, 1);

  const lines = useMemo(() => data.text.split('\n'), [data.text]);
  const maxScroll = Math.max(0, lines.length - contentHeight);

  useEffect(() => {
    setScrollOffset((prev) => Math.min(prev, maxScroll));
  }, [maxScroll]);

  const scrollBy = useCallback(
    (delta: number) => {
      setScrollOffset((prev) => Math.max(0, Math.min(maxScroll, prev + delta)));
    },
    [maxScroll],
  );

  useKeypress(
    useCallback(
      (key: Key) => {
        if (keyMatchers[Command.ESCAPE](key)) {
          onClose();
        } else if (keyMatchers[Command.SCROLL_UP](key) || key.name === 'up') {
          scrollBy(-1);
        } else if (
          keyMatchers[Command.SCROLL_DOWN](key) ||
          key.name === 'down'
        ) {
          scrollBy(1);
        } else if (keyMatchers[Command.PAGE_UP](key)) {
          scrollBy(-contentHeight);
        } else if (keyMatchers[Command.PAGE_DOWN](key)) {
          scrollBy(contentHeight);
        } else if (keyMatchers[Command.SCROLL_HOME](key)) {
          setScrollOffset(0);
        } else if (keyMatchers[Command.SCROLL_END](key)) {
          setScrollOffset(maxScroll);
        }
      },
      [onClose, scrollBy, contentHeight, maxScroll],
    ),
    { isActive: true },
  );

  useMouseEvents(
    useCallback(
      (event: MouseEvent) => {
        if (event.name === 'scroll-up') {
          scrollBy(-WHEEL_LINES);
        } else if (event.name === 'scroll-down') {
          scrollBy(WHEEL_LINES);
        }
      },
      [scrollBy],
    ),
    { isActive: true },
  );

  const title =
    data.durationMs != null
      ? `${t('Thought for')} ${formatDuration(data.durationMs)}`
      : t('Thinking');

  const visibleLines = lines.slice(scrollOffset, scrollOffset + contentHeight);
  const scrollPercent =
    maxScroll > 0 ? Math.round((scrollOffset / maxScroll) * 100) : 0;
  const scrollIndicator = maxScroll > 0 ? ` (${scrollPercent}%)` : '';

  return (
    <AlternateScreen disabled={!useAlternateScreen}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.text.secondary}
        paddingX={1}
        height={rows}
      >
        <Box>
          <Text color={theme.text.accent} bold>
            {THINKING_ICON}
            {title}
          </Text>
          <Text dimColor>{scrollIndicator}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {visibleLines.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
        </Box>
        <Box justifyContent="center">
          <Text dimColor italic>
            ESC {t('to close')} {'  '}↑↓ {t('to scroll')} {'  '}PgUp/PgDn{' '}
            Ctrl+Home/End
          </Text>
        </Box>
      </Box>
    </AlternateScreen>
  );
};
