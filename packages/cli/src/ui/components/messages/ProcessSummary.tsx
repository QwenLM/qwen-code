/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRef } from 'react';
import { Box, Text, getFrameController, useStdout, type DOMElement } from 'ink';
import type { ProcessHistoryItem } from '../../utils/process-history.js';
import { buildToolSummary } from '../../utils/tool-group-summary.js';
import { theme } from '../../semantic-colors.js';
import { useMouseEvents } from '../../hooks/useMouseEvents.js';
import { useMouseTrackingEnabled } from '../../hooks/use-mouse-tracking-enabled.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useContextMenu } from '../../context-menu/ContextMenuContext.js';
import {
  layoutRowForEvent,
  measureElementPosition,
} from '../../utils/measure-element-position.js';
import { formatDuration } from '../../utils/formatters.js';
import { t } from '../../../i18n/index.js';

export function ProcessSummary({
  item,
  width,
  expanded,
  interactive,
  onExpand,
}: {
  item: ProcessHistoryItem;
  width: number;
  expanded: boolean;
  interactive: boolean;
  onExpand: () => void;
}) {
  const ref = useRef<DOMElement>(null);
  const press = useRef<{ col: number; row: number } | null>(null);
  const { rows } = useTerminalSize();
  const { stdout } = useStdout();
  const mouseEnabled = useMouseTrackingEnabled();
  const { menu } = useContextMenu();
  const clickable = interactive && mouseEnabled && menu === null && !expanded;
  useMouseEvents(
    (event) => {
      if (!ref.current) return;
      if (event.name !== 'left-press' && event.name !== 'left-release') {
        press.current = null;
        return;
      }
      const box = measureElementPosition(ref.current);
      const row = layoutRowForEvent(ref.current, event.row, rows);
      const inside =
        event.col - 1 >= box.x &&
        event.col - 1 < box.x + box.width &&
        row >= box.y &&
        row < box.y + box.height;
      if (event.name === 'left-press') {
        press.current = inside ? { col: event.col, row: event.row } : null;
      } else {
        if (
          inside &&
          press.current?.col === event.col &&
          press.current.row === event.row &&
          !getFrameController(stdout)?.getSelection()
        ) {
          onExpand();
        }
        press.current = null;
      }
    },
    { isActive: clickable },
  );
  const tools = item.members.flatMap((member) =>
    member.type === 'tool_group' ? member.tools : [],
  );
  const durationMs = item.members.reduce(
    (total, member) =>
      total + (member.type === 'gemini_thought' ? (member.durationMs ?? 0) : 0),
    0,
  );
  return (
    <Box ref={ref} marginX={2} marginTop={1} width={width} height={1}>
      <Text color={theme.text.secondary} wrap="truncate-end">
        {expanded ? '· ' : '› '}
        {buildToolSummary(tools, false)}
        {durationMs > 0 && (
          <Text dimColor>
            {' · '}
            {t('Thought for')}{' '}
            {formatDuration(durationMs, { hideTrailingZeros: true })}
          </Text>
        )}
        {!expanded && (
          <Text dimColor>
            {' · '}
            {t(clickable ? 'click to expand' : 'ctrl+o to expand')}
          </Text>
        )}
      </Text>
    </Box>
  );
}
