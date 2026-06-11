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
    supportsTrueColor();

  const fallback = (
    <PrefixedTextMessage
      text={text}
      prefix=">"
      prefixColor={theme.text.accent}
      textColor={theme.text.accent}
      ariaLabel={SCREEN_READER_USER_PREFIX}
      alignSelf="flex-start"
      marginTop={useBand ? 0 : 1}
    />
  );

  if (!useBand) {
    return fallback;
  }

  const bg = resolveColor(theme.background.primary || 'black') || 'black';
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
