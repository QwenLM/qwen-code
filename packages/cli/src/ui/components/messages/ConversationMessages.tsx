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
import { sliceTextByVisualHeight } from '../../utils/textUtils.js';
import { MaxSizedBox } from '../shared/MaxSizedBox.js';
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
const PENDING_PREVIEW_MARKER_ROWS = 1;
const MAX_PENDING_PREVIEW_HEIGHT = 12;

function getPrefixWidth(prefix: string): number {
  // Reserve one extra column so text never touches the prefix glyph.
  return stringWidth(prefix) + 1;
}

function slicePendingTextForHeight(
  text: string,
  maxHeight: number | undefined,
  maxWidth: number,
): { text: string; hiddenLinesCount: number } {
  const uncappedOverflowCheck = sliceTextByVisualHeight(
    text,
    maxHeight,
    maxWidth,
    {
      minHeight: MIN_PENDING_PREVIEW_HEIGHT,
      reservedRows: 0,
      overflowDirection: 'top',
    },
  );

  if (uncappedOverflowCheck.hiddenLinesCount === 0) {
    return uncappedOverflowCheck;
  }

  return sliceTextByVisualHeight(text, maxHeight, maxWidth, {
    minHeight: MIN_PENDING_PREVIEW_HEIGHT,
    reservedRows: PENDING_PREVIEW_MARKER_ROWS,
    overflowDirection: 'top',
  });
}

function getPendingPreviewHeight(
  availableTerminalHeight: number | undefined,
): number | undefined {
  if (availableTerminalHeight === undefined) {
    return undefined;
  }

  if (availableTerminalHeight <= MAX_PENDING_PREVIEW_HEIGHT) {
    return availableTerminalHeight;
  }

  return MAX_PENDING_PREVIEW_HEIGHT;
}

// Streaming pending output is always rendered as plain text (not through
// MarkdownDisplay) so that the visual height we use for slicing matches the
// height that actually reaches Ink/Yoga. MarkdownDisplay's code blocks,
// tables, and list items can each render taller than their source text
// (line-number prefixes, table borders, paddingLeft narrowing the wrap
// width), and that gap was letting pending output exceed the viewport on
// narrow terminals — which made Ink leak the topmost row into scrollback
// every frame, producing the duplicate output in #3279. Once a stable
// prefix is promoted into <Static>, the committed message is rendered
// through MarkdownDisplay with full formatting; only the still-streaming
// tail stays plain. The pre-sliced tail is capped to a small live viewport and
// still wrapped in MaxSizedBox as a hard guard, so any remaining source-vs-Ink
// measurement mismatch cannot grow the dynamic region enough to scroll the
// terminal and leak previous frames into scrollback.
const PendingTextPreview: React.FC<{
  text: string;
  hiddenLinesCount: number;
  textColor: string;
  maxHeight: number | undefined;
  maxWidth: number;
}> = ({ text, hiddenLinesCount, textColor, maxHeight, maxWidth }) => (
  <MaxSizedBox
    maxHeight={maxHeight}
    maxWidth={maxWidth}
    additionalHiddenLinesCount={hiddenLinesCount}
  >
    {text.split('\n').map((line, index) => (
      <Box key={index}>
        <Text wrap="wrap" color={textColor}>
          {line}
        </Text>
      </Box>
    ))}
  </MaxSizedBox>
);

const PendingMarkdownContent: React.FC<{
  text: string;
  hiddenLinesCount: number;
  textColor: string;
  availableTerminalHeight: number | undefined;
  contentWidth: number;
}> = ({
  text,
  hiddenLinesCount,
  textColor,
  availableTerminalHeight,
  contentWidth,
}) => {
  const previewHeight = getPendingPreviewHeight(availableTerminalHeight);

  if (availableTerminalHeight === undefined) {
    return (
      <Text wrap="wrap" color={textColor}>
        {text}
      </Text>
    );
  }

  return (
    <PendingTextPreview
      text={text}
      hiddenLinesCount={hiddenLinesCount}
      textColor={textColor}
      maxHeight={previewHeight}
      maxWidth={contentWidth}
    />
  );
};

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
  const pendingPreviewHeight = getPendingPreviewHeight(availableTerminalHeight);
  const effectiveTextColor = textColor ?? theme.text.primary;
  const pendingSlice = isPending
    ? slicePendingTextForHeight(text, pendingPreviewHeight, markdownWidth)
    : { text, hiddenLinesCount: 0 };

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth}>
        <Text color={prefixColor} aria-label={ariaLabel}>
          {prefix}
        </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {isPending ? (
          <PendingMarkdownContent
            text={pendingSlice.text}
            hiddenLinesCount={pendingSlice.hiddenLinesCount}
            textColor={effectiveTextColor}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={markdownWidth}
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
  const pendingPreviewHeight = getPendingPreviewHeight(availableTerminalHeight);
  const effectiveTextColor = textColor ?? theme.text.primary;
  const pendingSlice = isPending
    ? slicePendingTextForHeight(text, pendingPreviewHeight, markdownWidth)
    : { text, hiddenLinesCount: 0 };

  return (
    <Box flexDirection="column" paddingLeft={prefixWidth}>
      {isPending ? (
        <PendingMarkdownContent
          text={pendingSlice.text}
          hiddenLinesCount={pendingSlice.hiddenLinesCount}
          textColor={effectiveTextColor}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={markdownWidth}
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
