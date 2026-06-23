/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text, useIsScreenReaderEnabled } from 'ink';
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
import {
  resolveColor,
  subtleBandColor,
  supportsTrueColor,
} from '../../themes/color-utils.js';
import { t } from '../../../i18n/index.js';
import { getCachedStringWidth } from '../../utils/textUtils.js';
import { formatDuration } from '../../utils/displayUtils.js';

const isUtf8 = /utf-?8/i.test(
  process.env['LANG'] || process.env['LC_ALL'] || '',
);
export const THINKING_ICON =
  !process.env['CI'] && isUtf8 ? '💡 ' : isUtf8 ? '⟡ ' : '';

interface UserMessageProps {
  text: string;
  width?: number;
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

export const UserMessage: React.FC<UserMessageProps> = ({ text, width }) => {
  const isScreenReaderEnabled = useIsScreenReaderEnabled();

  const useBand =
    width !== undefined &&
    width > 0 &&
    !isScreenReaderEnabled &&
    !!theme.background.primary &&
    supportsTrueColor();

  const fallback = (
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

  if (!useBand) {
    return fallback;
  }

  const bg = resolveColor(theme.background.primary) || theme.background.primary;
  const bandColor = subtleBandColor(bg);
  if (!bandColor) {
    return fallback;
  }

  const prefix = '> ';
  const lines = text.split('\n');

  return (
    <Box flexDirection="column" width={width}>
      <Text color={bandColor}>{'▄'.repeat(width)}</Text>
      {lines.map((line, i) => {
        const linePrefix = i === 0 ? prefix : '  ';
        const lineWidth = stringWidth(linePrefix + line);
        const pad = Math.max(0, width - lineWidth);
        return (
          <Text
            key={i}
            backgroundColor={bandColor}
            aria-label={i === 0 ? SCREEN_READER_USER_PREFIX : undefined}
          >
            <Text color={theme.text.accent}>
              {linePrefix}
              {line}
            </Text>
            {pad > 0 ? ' '.repeat(pad) : ''}
          </Text>
        );
      })}
      <Text color={bandColor}>{'▀'.repeat(width)}</Text>
    </Box>
  );
};

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
    prefix="✦"
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
    basePrefix="✦"
    sourceCopyIndexOffsets={sourceCopyIndexOffsets}
  />
);

const MAX_STREAMING_THINKING_VISUAL_LINES = 4;

function wrapToVisualLines(text: string, width: number): string[] {
  if (width <= 0) {
    return [''];
  }
  const visualLines: string[] = [];
  for (const logicalLine of text.split('\n')) {
    if (logicalLine === '') {
      visualLines.push('');
      continue;
    }
    let currentLine = '';
    let currentWidth = 0;
    for (const char of logicalLine) {
      const charWidth = getCachedStringWidth(char);
      if (currentWidth + charWidth > width && currentWidth > 0) {
        visualLines.push(currentLine);
        currentLine = '';
        currentWidth = 0;
      }
      currentLine += char;
      currentWidth += charWidth;
    }
    if (currentLine) {
      visualLines.push(currentLine);
    }
  }
  if (visualLines.length === 0) {
    visualLines.push('');
  }
  return visualLines;
}

function tailVisualLines(
  text: string,
  width: number,
  maxLines: number,
): string {
  const charBudget = maxLines * width * 2;
  let sliceStart = Math.max(0, text.length - charBudget);
  if (sliceStart > 0) {
    const nl = text.indexOf('\n', sliceStart);
    if (nl !== -1 && nl < text.length - 1) {
      sliceStart = nl + 1;
    }
  }
  const lines = wrapToVisualLines(text.slice(sliceStart), width);
  return lines.slice(-maxLines).join('\n');
}

export const ThinkMessage: React.FC<ThinkMessageProps> = ({
  text,
  isPending,
  expanded = false,
  availableTerminalHeight,
  contentWidth,
  durationMs,
}) => {
  const durationSuffix =
    durationMs != null ? ` ${formatDuration(durationMs)}` : '';

  if (!isPending && !expanded) {
    const label =
      durationMs != null
        ? `${t('Thought for')} ${formatDuration(durationMs)}`
        : t('Thinking');
    return (
      <Text dimColor italic>
        {THINKING_ICON}
        {label} {t('(alt+t to expand)')}
      </Text>
    );
  }

  if (isPending) {
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
    const display = tailVisualLines(text, innerWidth, maxLines);
    return (
      <Box flexDirection="column">
        <Text dimColor italic>
          {THINKING_ICON}
          {t('Thinking')}…{durationSuffix}
        </Text>
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate">
            {display}
          </Text>
        </Box>
      </Box>
    );
  }

  const expandedLabel =
    durationMs != null
      ? `${t('Thought for')} ${formatDuration(durationMs)}`
      : `${t('Thinking')}…`;
  return (
    <Box flexDirection="column">
      <Text dimColor italic>
        {THINKING_ICON}
        {expandedLabel} {t('(alt+t to collapse)')}
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        <MarkdownDisplay
          text={text}
          isPending={false}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={contentWidth - 2}
          textColor={theme.text.secondary}
        />
      </Box>
    </Box>
  );
};

export const ThinkMessageContent: React.FC<ThinkMessageContentProps> = ({
  text,
  isPending,
  expanded = false,
  availableTerminalHeight,
  contentWidth,
}) => {
  if (!isPending && !expanded) {
    return null;
  }

  if (isPending) {
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
    const display = tailVisualLines(text, innerWidth, maxLines);
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
        isPending={false}
        availableTerminalHeight={availableTerminalHeight}
        contentWidth={contentWidth - 2}
        textColor={theme.text.secondary}
      />
    </Box>
  );
};
