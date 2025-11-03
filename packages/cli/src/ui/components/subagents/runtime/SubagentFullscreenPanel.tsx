/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { theme } from '../../../semantic-colors.js';
import { useUIActions } from '../../../contexts/UIActionsContext.js';
import type { SubagentFullscreenPanelState } from '../../../types.js';
import { getStatusColor, getStatusText } from './status.js';
import { CTRL_ALT_E_SEQUENCE } from './fullscreenKeys.js';

const FULLSCREEN_INSTRUCTION_TEXT =
  '↑/↓ scroll   PgUp/PgDn page   Home/End jump   q quit   ctrl+alt+e close';

interface SubagentFullscreenPanelProps {
  panel: SubagentFullscreenPanelState;
}

export const SubagentFullscreenPanel: React.FC<
  SubagentFullscreenPanelProps
> = ({ panel }) => {
  const { closeSubagentFullscreenPanel } = useUIActions();
  const { rows, columns } = useTerminalSize();
  const viewportHeight = Math.max(1, rows - 10); // header/footer padding
  const panelWidth = Math.max(6, columns - 2); // keep space for borders + padding at minimum
  const content = React.useMemo(
    () => panel.content ?? panel.getSnapshot?.() ?? [],
    [panel],
  );
  const previousContentLengthRef = React.useRef(content.length);
  const [scrollOffset, setScrollOffset] = React.useState(() =>
    Math.max(0, content.length - viewportHeight),
  );
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState<Date | null>(
    new Date(),
  );

  const panelId = panel.panelId;

  const closePanel = React.useCallback(() => {
    closeSubagentFullscreenPanel(panelId);
  }, [closeSubagentFullscreenPanel, panelId]);

  React.useEffect(() => {
    const maxOffset = Math.max(0, content.length - viewportHeight);
    setScrollOffset((previous) => {
      const previousLength = previousContentLengthRef.current;
      const previousMaxOffset = Math.max(0, previousLength - viewportHeight);
      const wasPinnedToBottom = previous >= previousMaxOffset;
      previousContentLengthRef.current = content.length;
      return wasPinnedToBottom ? maxOffset : Math.min(previous, maxOffset);
    });
    setLastRefreshedAt(new Date());
  }, [content, viewportHeight]);

  useKeypress(
    (key) => {
      const sequence = key.sequence ?? '';
      const isCtrlAltE =
        (key.ctrl && key.meta && key.name === 'e') ||
        sequence === CTRL_ALT_E_SEQUENCE;

      if (isCtrlAltE) {
        closePanel();
        return;
      }

      if (key.ctrl || key.meta) {
        return;
      }

      const maxOffset = Math.max(0, content.length - viewportHeight);

      switch (key.name) {
        case 'q':
        case 'escape':
          closePanel();
          return;
        case 'up':
          setScrollOffset((previous) => Math.max(0, previous - 1));
          return;
        case 'down':
          setScrollOffset((previous) => Math.min(maxOffset, previous + 1));
          return;
        case 'pageup':
          setScrollOffset((previous) => Math.max(0, previous - viewportHeight));
          return;
        case 'pagedown':
          setScrollOffset((previous) =>
            Math.min(maxOffset, previous + viewportHeight),
          );
          return;
        case 'home':
          setScrollOffset(0);
          return;
        case 'end':
          setScrollOffset(maxOffset);
          return;
        default:
          break;
      }
    },
    { isActive: true },
  );

  const visibleLines = content.slice(
    scrollOffset,
    scrollOffset + viewportHeight,
  );
  const paddingLineCount = Math.max(0, viewportHeight - visibleLines.length);
  const rangeText =
    content.length > 0
      ? `Lines ${Math.min(scrollOffset + 1, content.length)}-${Math.min(
          scrollOffset + viewportHeight,
          content.length,
        )} / ${content.length}`
      : 'Waiting for execution data';
  const lastRefreshText = lastRefreshedAt
    ? `Last updated at ${lastRefreshedAt.toLocaleTimeString()}`
    : 'Waiting for execution data';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      width={panelWidth}
      paddingX={1}
    >
      <Box
        flexDirection="row"
        justifyContent="space-between"
        marginBottom={1}
        flexShrink={0}
      >
        <Text bold color={theme.text.primary} wrap="truncate-end">
          {panel.subagentName}
        </Text>
        <Text color={theme.text.secondary} wrap="truncate-end">
          {lastRefreshText}
        </Text>
      </Box>

      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text color={getStatusColor(panel.status)}>
          {getStatusText(panel.status)}
        </Text>
        <Text color={theme.text.secondary}>{rangeText}</Text>
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {visibleLines.map((line, index) => (
          <Text key={`line-${scrollOffset + index}`} wrap="truncate-end">
            {line}
          </Text>
        ))}
        {Array.from({ length: paddingLineCount }).map((_, index) => (
          <Text key={`pad-${index}`}> </Text>
        ))}
      </Box>

      <Box flexDirection="column" gap={0} flexShrink={0} marginTop={1}>
        <Text color={theme.text.secondary}>{FULLSCREEN_INSTRUCTION_TEXT}</Text>
      </Box>
    </Box>
  );
};
