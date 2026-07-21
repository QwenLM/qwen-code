/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useRef } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import {
  MarkdownDisplay,
  type MarkdownSourceCopyIndexOffsets,
} from '../../utils/MarkdownDisplay.js';
import { theme } from '../../semantic-colors.js';
import {
  SCREEN_READER_MODEL_PREFIX,
  SCREEN_READER_USER_PREFIX,
} from '../../textConstants.js';
import { t } from '../../../i18n/index.js';
import { wrapToVisualLines } from '../../utils/textUtils.js';
import { formatDuration } from '../../utils/displayUtils.js';

export const THINKING_ICON = '∴ ';
export const THINKING_ICON_PENDING = '∵ ';

export const toggleKeyHint =
  process.platform === 'darwin' ? 'option+t' : 'alt+t';

interface UserMessageProps {
  text: string;
}

interface UserShellMessageProps {
  text: string;
}

interface AssistantMessageProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  sourceCopyIndexOffsets?: MarkdownSourceCopyIndexOffsets;
}

interface AssistantMessageContentProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  sourceCopyIndexOffsets?: MarkdownSourceCopyIndexOffsets;
}

interface ThinkMessageProps {
  text: string;
  isPending: boolean;
  /** When committed (not pending), whether to show the full reasoning. */
  expanded?: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  durationMs?: number;
  /**
   * VP mode only: the collapsed line is mouse-clickable, so the hint advertises
   * "click" in addition to the keyboard toggle. Non-VP has no click handler.
   */
  clickable?: boolean;
}

interface ThinkMessageContentProps {
  text: string;
  isPending: boolean;
  expanded?: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
}

interface PrefixedTextMessageProps {
  text: string;
  prefix: string;
  prefixColor: string;
  textColor: string;
  ariaLabel?: string;
  marginTop?: number;
  alignSelf?: 'auto' | 'flex-start' | 'center' | 'flex-end';
}

interface PrefixedMarkdownMessageProps {
  text: string;
  prefix: string;
  prefixColor: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  ariaLabel?: string;
  textColor?: string;
  sourceCopyIndexOffsets?: MarkdownSourceCopyIndexOffsets;
}

interface ContinuationMarkdownMessageProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  basePrefix: string;
  textColor?: string;
  sourceCopyIndexOffsets?: MarkdownSourceCopyIndexOffsets;
}

function getPrefixWidth(prefix: string): number {
  // Reserve one extra column so text never touches the prefix glyph.
  return stringWidth(prefix) + 1;
}

const PrefixedTextMessage: React.FC<PrefixedTextMessageProps> = ({
  text,
  prefix,
  prefixColor,
  textColor,
  ariaLabel,
  marginTop = 0,
  alignSelf,
}) => {
  const prefixWidth = getPrefixWidth(prefix);

  return (
    <Box
      flexDirection="row"
      paddingY={0}
      marginTop={marginTop}
      alignSelf={alignSelf}
    >
      <Box width={prefixWidth}>
        <Text color={prefixColor} aria-label={ariaLabel}>
          {prefix}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap" color={textColor}>
          {text}
        </Text>
      </Box>
    </Box>
  );
};

const PrefixedMarkdownMessage: React.FC<PrefixedMarkdownMessageProps> = ({
  text,
  prefix,
  prefixColor,
  isPending,
  availableTerminalHeight,
  contentWidth,
  ariaLabel,
  textColor,
  sourceCopyIndexOffsets,
}) => {
  const prefixWidth = getPrefixWidth(prefix);

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth}>
        <Text color={prefixColor} aria-label={ariaLabel}>
          {prefix}
        </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <MarkdownDisplay
          text={text}
          isPending={isPending}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={contentWidth - prefixWidth}
          textColor={textColor}
          sourceCopyIndexOffsets={sourceCopyIndexOffsets}
        />
      </Box>
    </Box>
  );
};

const ContinuationMarkdownMessage: React.FC<
  ContinuationMarkdownMessageProps
> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
  basePrefix,
  textColor,
  sourceCopyIndexOffsets,
}) => {
  const prefixWidth = getPrefixWidth(basePrefix);

  return (
    <Box flexDirection="column" paddingLeft={prefixWidth}>
      <MarkdownDisplay
        text={text}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        contentWidth={contentWidth - prefixWidth}
        textColor={textColor}
        sourceCopyIndexOffsets={sourceCopyIndexOffsets}
      />
    </Box>
  );
};

export const UserMessage: React.FC<UserMessageProps> = ({ text }) => (
  // The TUI paints no background of its own; user messages render directly on
  // the terminal background so they blend in across terminals and themes.
  <PrefixedTextMessage
    text={text}
    prefix=">"
    prefixColor={theme.text.accent}
    textColor={theme.text.accent}
    ariaLabel={SCREEN_READER_USER_PREFIX}
    alignSelf="flex-start"
    marginTop={1}
  />
);

export const UserShellMessage: React.FC<UserShellMessageProps> = ({ text }) => {
  const commandToDisplay = text.startsWith('!') ? text.substring(1) : text;

  return (
    <PrefixedTextMessage
      text={commandToDisplay}
      prefix="$"
      prefixColor={theme.text.link}
      textColor={theme.text.primary}
    />
  );
};

export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
  sourceCopyIndexOffsets,
}) => (
  <PrefixedMarkdownMessage
    text={text}
    prefix="◆"
    prefixColor={theme.text.accent}
    ariaLabel={SCREEN_READER_MODEL_PREFIX}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
    sourceCopyIndexOffsets={sourceCopyIndexOffsets}
  />
);

export const AssistantMessageContent: React.FC<
  AssistantMessageContentProps
> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
  sourceCopyIndexOffsets,
}) => (
  <ContinuationMarkdownMessage
    text={text}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
    basePrefix="◆"
    sourceCopyIndexOffsets={sourceCopyIndexOffsets}
  />
);

const MAX_STREAMING_THINKING_VISUAL_LINES = 4;
const BRIEF_THOUGHT_THRESHOLD_MS = 1_000;

function tailVisualLines(
  text: string,
  width: number,
  maxLines: number,
): string[] {
  const charBudget = maxLines * width * 2;
  let sliceStart = Math.max(0, text.length - charBudget);
  if (sliceStart > 0) {
    const nl = text.indexOf('\n', sliceStart);
    if (nl !== -1 && nl < text.length - 1) {
      sliceStart = nl + 1;
    }
  }
  const lines = wrapToVisualLines(text.slice(sliceStart), width);
  return lines.slice(-maxLines);
}

const ThinkBody: React.FC<{
  text: string;
  isPending: boolean;
  expanded: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
}> = ({ text, isPending, expanded, availableTerminalHeight, contentWidth }) => {
  // Grow-only height tracker for the streaming window: the rendered block never
  // shrinks below the tallest it has already reached for this thought, so a
  // blank paragraph separator (`\n\n`) transiently entering/leaving the tail
  // window can't make the block jump 2→3→5 rows and flicker. Reset when the
  // block stops streaming or when the buffer shrinks (a new thought replaced it).
  const maxSeenLinesRef = useRef(0);
  const prevTextLenRef = useRef(0);
  if (!isPending || text.length < prevTextLenRef.current) {
    maxSeenLinesRef.current = 0;
  }
  prevTextLenRef.current = text.length;

  if (!isPending && !expanded) return null;

  if (isPending && !expanded) {
    const innerWidth = Math.max(contentWidth - 2, 20);
    const maxLines =
      availableTerminalHeight != null
        ? Math.max(
            1,
            Math.min(
              MAX_STREAMING_THINKING_VISUAL_LINES,
              Math.floor(availableTerminalHeight / 3),
            ),
          )
        : MAX_STREAMING_THINKING_VISUAL_LINES;
    const lines = tailVisualLines(text, innerWidth, maxLines);
    const target = Math.min(
      maxLines,
      Math.max(lines.length, maxSeenLinesRef.current),
    );
    maxSeenLinesRef.current = target;
    // Pad at the top so the newest line stays pinned to the bottom.
    const padded =
      lines.length < target
        ? [...new Array(target - lines.length).fill(''), ...lines]
        : lines;
    const display = padded.join('\n');
    return (
      <Box paddingLeft={2}>
        <Text dimColor wrap="truncate">
          {display}
        </Text>
      </Box>
    );
  }

  return (
    <Box paddingLeft={2} flexDirection="column">
      <MarkdownDisplay
        text={text}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        contentWidth={contentWidth - 2}
        textColor={theme.text.secondary}
      />
    </Box>
  );
};

export const ThinkMessage: React.FC<ThinkMessageProps> = ({
  text,
  isPending,
  expanded = false,
  availableTerminalHeight,
  contentWidth,
  durationMs,
  clickable = false,
}) => {
  const durationSuffix =
    durationMs != null ? ` ${formatDuration(durationMs)}` : '';
  const completedLabel =
    durationMs == null
      ? null
      : durationMs < BRIEF_THOUGHT_THRESHOLD_MS
        ? t('Thought briefly')
        : `${t('Thought for')} ${formatDuration(durationMs)}`;

  if (!isPending && !expanded) {
    const label = completedLabel ?? t('Thinking');
    const hint = clickable
      ? t('(click or {{keyHint}} to expand)', { keyHint: toggleKeyHint })
      : t('({{keyHint}} to expand)', { keyHint: toggleKeyHint });
    return (
      <Text dimColor italic>
        {THINKING_ICON}
        {label} {hint}
      </Text>
    );
  }

  const label = isPending
    ? `${t('Thinking')}…${durationSuffix}`
    : (completedLabel ?? `${t('Thinking')}…`);
  const collapseHint =
    !isPending && expanded
      ? ` ${t('({{keyHint}} to collapse)', { keyHint: toggleKeyHint })}`
      : '';

  return (
    <Box flexDirection="column">
      <Text dimColor italic>
        {isPending ? THINKING_ICON_PENDING : THINKING_ICON}
        {label}
        {collapseHint}
      </Text>
      <ThinkBody
        text={text}
        isPending={isPending}
        expanded={expanded}
        availableTerminalHeight={availableTerminalHeight}
        contentWidth={contentWidth}
      />
    </Box>
  );
};

export const ThinkMessageContent: React.FC<ThinkMessageContentProps> = ({
  text,
  isPending,
  expanded = false,
  availableTerminalHeight,
  contentWidth,
}) => (
  <ThinkBody
    text={text}
    isPending={isPending}
    expanded={expanded}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
  />
);
