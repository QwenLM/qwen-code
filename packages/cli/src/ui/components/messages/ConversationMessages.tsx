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

function getPrefixWidth(prefix: string): number {
  // Reserve one extra column so text never touches the prefix glyph.
  return stringWidth(prefix) + 1;
}

function parseThinkingContent(text: string): {
  thinkingContent: string;
  mainContent: string;
  hasThinking: boolean;
} {
  const thinkPattern = /<think(ing)?>([\s\S]*?)<\/think(ing)?>/g;

  const matches = [...text.matchAll(thinkPattern)];

  if (matches.length === 0) {
    return { thinkingContent: '', mainContent: text, hasThinking: false };
  }

  const thinkingParts: string[] = [];
  for (const match of matches) {
    const content = match[2]?.trim();
    if (content) {
      thinkingParts.push(content);
    }
  }

  const hasThinking = thinkingParts.length > 0;
  if (!hasThinking) {
    return { thinkingContent: '', mainContent: text, hasThinking: false };
  }

  const lastMatch = matches[matches.length - 1];
  const lastIndex = lastMatch.index! + lastMatch[0].length;

  const thinkingContent = thinkingParts.join('\n') + '\n';
  const mainContent = text.slice(lastIndex).trim();

  return { thinkingContent, mainContent, hasThinking };
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
}) => {
  const prefixWidth = getPrefixWidth(prefix);

  const { thinkingContent, mainContent, hasThinking } =
    parseThinkingContent(text);

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth}>
        <Text color={prefixColor} aria-label={ariaLabel}>
          {prefix}
        </Text>
      </Box>

      <Box flexGrow={1} flexDirection="column">
        {hasThinking && (
          <MarkdownDisplay
            text={thinkingContent}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={contentWidth - prefixWidth}
            textColor="gray"
          />
        )}
        {mainContent && (
          <MarkdownDisplay
            text={mainContent}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={contentWidth - prefixWidth}
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

  const { thinkingContent, mainContent, hasThinking } =
    parseThinkingContent(text);

  return (
    <Box flexDirection="column" paddingLeft={prefixWidth}>
      {hasThinking && (
        <MarkdownDisplay
          text={thinkingContent}
          isPending={isPending}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={contentWidth - prefixWidth}
          textColor="gray"
        />
      )}
      {mainContent && (
        <MarkdownDisplay
          text={mainContent}
          isPending={isPending}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={contentWidth - prefixWidth}
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
