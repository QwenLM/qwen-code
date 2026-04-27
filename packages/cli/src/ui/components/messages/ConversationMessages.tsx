/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { theme } from '../../semantic-colors.js';
import { getCachedStringWidth, toCodePoints } from '../../utils/textUtils.js';
import {
  SCREEN_READER_MODEL_PREFIX,
  SCREEN_READER_USER_PREFIX,
} from '../../textConstants.js';

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
}

interface AssistantMessageContentProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
}

interface ThinkMessageProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
}

interface ThinkMessageContentProps {
  text: string;
  isPending: boolean;
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
}

interface ContinuationMarkdownMessageProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  basePrefix: string;
  textColor?: string;
}

const MIN_PENDING_PREVIEW_HEIGHT = 2;

function getPrefixWidth(prefix: string): number {
  // Reserve one extra column so text never touches the prefix glyph.
  return stringWidth(prefix) + 1;
}

function slicePendingTextForHeight(
  text: string,
  maxHeight: number | undefined,
  maxWidth: number,
): { text: string; hiddenLinesCount: number } {
  if (maxHeight === undefined) {
    return { text, hiddenLinesCount: 0 };
  }

  const targetMaxHeight = Math.max(
    Math.round(maxHeight),
    MIN_PENDING_PREVIEW_HEIGHT,
  );
  const visibleContentHeight = targetMaxHeight - 1;
  const visualWidth = Math.max(1, Math.floor(maxWidth));
  const visibleLines: string[] = [];
  let visualLineCount = 0;
  let currentLine = '';
  let currentLineWidth = 0;

  const appendVisibleLine = (line: string) => {
    visualLineCount += 1;
    visibleLines.push(line);
    if (visibleLines.length > visibleContentHeight) {
      visibleLines.shift();
    }
  };

  const flushCurrentLine = () => {
    appendVisibleLine(currentLine);
    currentLine = '';
    currentLineWidth = 0;
  };

  for (const char of toCodePoints(text)) {
    if (char === '\n') {
      flushCurrentLine();
      continue;
    }

    const charWidth = Math.max(getCachedStringWidth(char), 1);
    if (currentLineWidth > 0 && currentLineWidth + charWidth > visualWidth) {
      flushCurrentLine();
    }

    currentLine += char;
    currentLineWidth += charWidth;
  }

  flushCurrentLine();

  if (visualLineCount <= targetMaxHeight) {
    return { text, hiddenLinesCount: 0 };
  }

  return {
    text: visibleLines.join('\n'),
    hiddenLinesCount: visualLineCount - visibleContentHeight,
  };
}

const PendingTextPreview: React.FC<{
  text: string;
  hiddenLinesCount: number;
  textColor: string;
}> = ({ text, hiddenLinesCount, textColor }) => (
  <Box flexDirection="column">
    <Text color={theme.text.secondary} wrap="truncate">
      ... first {hiddenLinesCount} streaming line
      {hiddenLinesCount === 1 ? '' : 's'} hidden ...
    </Text>
    <Text wrap="wrap" color={textColor}>
      {text}
    </Text>
  </Box>
);

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
}) => {
  const prefixWidth = getPrefixWidth(prefix);
  const markdownWidth = Math.max(1, contentWidth - prefixWidth);
  const effectiveTextColor = textColor ?? theme.text.primary;
  const pendingSlice = isPending
    ? slicePendingTextForHeight(text, availableTerminalHeight, markdownWidth)
    : { text, hiddenLinesCount: 0 };

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth}>
        <Text color={prefixColor} aria-label={ariaLabel}>
          {prefix}
        </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {pendingSlice.hiddenLinesCount > 0 ? (
          <PendingTextPreview
            text={pendingSlice.text}
            hiddenLinesCount={pendingSlice.hiddenLinesCount}
            textColor={effectiveTextColor}
          />
        ) : (
          <MarkdownDisplay
            text={text}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={markdownWidth}
            textColor={textColor}
          />
        )}
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
}) => {
  const prefixWidth = getPrefixWidth(basePrefix);
  const markdownWidth = Math.max(1, contentWidth - prefixWidth);
  const effectiveTextColor = textColor ?? theme.text.primary;
  const pendingSlice = isPending
    ? slicePendingTextForHeight(text, availableTerminalHeight, markdownWidth)
    : { text, hiddenLinesCount: 0 };

  return (
    <Box flexDirection="column" paddingLeft={prefixWidth}>
      {pendingSlice.hiddenLinesCount > 0 ? (
        <PendingTextPreview
          text={pendingSlice.text}
          hiddenLinesCount={pendingSlice.hiddenLinesCount}
          textColor={effectiveTextColor}
        />
      ) : (
        <MarkdownDisplay
          text={text}
          isPending={isPending}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={markdownWidth}
          textColor={textColor}
        />
      )}
    </Box>
  );
};

export const UserMessage: React.FC<UserMessageProps> = ({ text }) => (
  <PrefixedTextMessage
    text={text}
    prefix=">"
    prefixColor={theme.text.accent}
    textColor={theme.text.accent}
    ariaLabel={SCREEN_READER_USER_PREFIX}
    alignSelf="flex-start"
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
}) => (
  <PrefixedMarkdownMessage
    text={text}
    prefix="✦"
    prefixColor={theme.text.accent}
    ariaLabel={SCREEN_READER_MODEL_PREFIX}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
  />
);

export const AssistantMessageContent: React.FC<
  AssistantMessageContentProps
> = ({ text, isPending, availableTerminalHeight, contentWidth }) => (
  <ContinuationMarkdownMessage
    text={text}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
    basePrefix="✦"
  />
);

export const ThinkMessage: React.FC<ThinkMessageProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
}) => (
  <PrefixedMarkdownMessage
    text={text}
    prefix="✦"
    prefixColor={theme.text.secondary}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
    textColor={theme.text.secondary}
  />
);

export const ThinkMessageContent: React.FC<ThinkMessageContentProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
}) => (
  <ContinuationMarkdownMessage
    text={text}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
    basePrefix="✦"
    textColor={theme.text.secondary}
  />
);
