/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ThoughtSummary } from '@qwen-code/core';
import { theme } from '../../semantic-colors.js';
import { normalizeEscapedNewlines } from '../../utils/textUtils.js';
import { useFoldState } from '../../contexts/FoldStateContext.js';
import { formatCommand } from '../../key/keybindingUtils.js';
import { Command } from '../../key/keyBindings.js';
import { wrapAnsi } from '../../../ink/wrapAnsi.js';
import { FEED_MARKER } from '../../constants/feedGrammar.js';
import { INDENT } from '../../constants/messageLayout.js';

interface ThinkingMessageProps {
  thought: ThoughtSummary;
  terminalWidth: number;
  isFirstThinking?: boolean;
}

/** Aligns the thinking rail with tool/subagent container borders. */
const THINKING_LEFT_OFFSET = INDENT.FEED_LEFT_OFFSET;
/** Total horizontal chrome consumed before thinking text starts. */
const THINKING_CHROME_WIDTH =
  THINKING_LEFT_OFFSET + FEED_MARKER.thinkingRail.length;

/** Visual rows to show at the top when collapsed */
const THINKING_HEAD_ROWS = 2;
/** Visual rows to show at the bottom when collapsed */
const THINKING_TAIL_ROWS = 3;
const FOLD_THRESHOLD = THINKING_HEAD_ROWS + THINKING_TAIL_ROWS;
const EXPAND_KEY = formatCommand(Command.SHOW_MORE_LINES);

interface VisualWrapResult {
  /** All visual rows after wrapping */
  allRows: string[];
  /** Head rows to show when folded, or null if no fold needed */
  headRows: string[] | null;
  /** Tail rows to show when folded, or null if no fold needed */
  tailRows: string[] | null;
  /** Number of hidden visual rows, 0 if no fold */
  foldedRows: number;
}

/**
 * Pre-wrap text with wrapAnsi to get visual rows, then compute head/tail
 * slices for folding. The allRows field is used for both folded and unfolded
 * rendering to ensure consistent wrapping.
 */
function computeVisualWrap(
  lines: string[],
  contentWidth: number,
  shouldFold: boolean,
): VisualWrapResult {
  const joined = lines.join('\n');
  const wrapped = wrapAnsi(joined, contentWidth, {
    hard: true,
    trim: true,
  });
  const allRows = wrapped.split('\n');
  const total = allRows.length;

  if (!shouldFold || total <= FOLD_THRESHOLD) {
    return { allRows, headRows: null, tailRows: null, foldedRows: 0 };
  }

  return {
    allRows,
    headRows: allRows.slice(0, THINKING_HEAD_ROWS),
    tailRows: allRows.slice(-THINKING_TAIL_ROWS),
    foldedRows: total - THINKING_HEAD_ROWS - THINKING_TAIL_ROWS,
  };
}

export function normalizeThoughtLines(thought: ThoughtSummary): string[] {
  const subject = normalizeEscapedNewlines(thought.subject).trim();
  const description = normalizeEscapedNewlines(thought.description).trim();

  const isNoise = (text: string) => {
    const trimmed = text.trim();
    return !trimmed || /^\.+$/.test(trimmed);
  };

  const lines: string[] = [];

  if (subject && !isNoise(subject)) {
    lines.push(subject);
  }

  if (description) {
    const descriptionLines = description
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !isNoise(line));
    lines.push(...descriptionLines);
  }

  return lines;
}

export function hasRenderableThought(thought: ThoughtSummary): boolean {
  return normalizeThoughtLines(thought).length > 0;
}

/**
 * Renders a model's thought as a quiet side-channel rail.
 */
export const ThinkingMessage: React.FC<ThinkingMessageProps> = ({
  thought,
  terminalWidth,
  isFirstThinking,
}) => {
  const fullLines = useMemo(() => normalizeThoughtLines(thought), [thought]);
  const { constrainHeight } = useFoldState();

  const contentWidth = Math.max(1, terminalWidth - THINKING_CHROME_WIDTH);
  const wrap = useMemo(
    () => computeVisualWrap(fullLines, contentWidth, constrainHeight),
    [fullLines, contentWidth, constrainHeight],
  );
  const isFolded = wrap.headRows !== null;

  if (fullLines.length === 0) {
    return null;
  }

  return (
    <Box width={terminalWidth} flexDirection="column">
      {isFirstThinking && (
        <Box paddingLeft={THINKING_LEFT_OFFSET}>
          <Text color={theme.text.primary} italic>
            {FEED_MARKER.thinkingHeader}
          </Text>
        </Box>
      )}

      <Box flexDirection="column">
        {isFolded ? (
          <>
            {wrap.headRows!.map((row, index) => (
              <Box key={`row-${index}`} paddingLeft={THINKING_LEFT_OFFSET}>
                <Text color={theme.border.default}>
                  {FEED_MARKER.thinkingRail}
                </Text>
                <Text color={theme.text.secondary} italic>
                  {row}
                </Text>
              </Box>
            ))}
            <Box paddingLeft={THINKING_LEFT_OFFSET}>
              <Text color={theme.border.default}>
                {FEED_MARKER.thinkingRail}
              </Text>
              <Text color={theme.border.default}>
                {`… +${wrap.foldedRows} rows (${EXPAND_KEY})`}
              </Text>
            </Box>
            {wrap.tailRows!.map((row, index) => (
              <Box
                key={`row-${THINKING_HEAD_ROWS + 1 + index}`}
                paddingLeft={THINKING_LEFT_OFFSET}
              >
                <Text color={theme.border.default}>
                  {FEED_MARKER.thinkingRail}
                </Text>
                <Text color={theme.text.secondary} italic>
                  {row}
                </Text>
              </Box>
            ))}
          </>
        ) : (
          wrap.allRows.map((row, index) => (
            <Box key={`row-${index}`} paddingLeft={THINKING_LEFT_OFFSET}>
              <Text color={theme.border.default}>
                {FEED_MARKER.thinkingRail}
              </Text>
              <Text color={theme.text.secondary} italic>
                {row}
              </Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
};
