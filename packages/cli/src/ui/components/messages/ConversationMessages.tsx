/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
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
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { ErrorBoundary } from '../shared/ErrorBoundary.js';
import { ICON } from '../../constants.js';
import { sanitizeTerminalText } from '../../utils/textUtils.js';
import { formatDuration } from '../../utils/displayUtils.js';
import type { InlineImageData } from '../../types.js';
import { TerminalImage } from '../TerminalImage.js';
import { formatInlineImageOverflow } from '../../utils/inline-image-parts.js';

const debugLogger = createDebugLogger('THINK_RENDER');

export const THINKING_ICON = `${ICON.THEREFORE} `;
export const THINKING_ICON_PENDING = `${ICON.BECAUSE} `;

export const toggleKeyHint = 'ctrl+o';

interface UserMessageProps {
  text: string;
}

interface UserShellMessageProps {
  text: string;
}

interface AssistantMessageProps {
  text: string;
  images?: InlineImageData[];
  omittedImageCount?: number;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  sourceCopyIndexOffsets?: MarkdownSourceCopyIndexOffsets;
}

interface AssistantMessageContentProps {
  text: string;
  images?: InlineImageData[];
  omittedImageCount?: number;
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
  images?: InlineImageData[];
  omittedImageCount?: number;
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
  images?: InlineImageData[];
  omittedImageCount?: number;
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
      <Box width={prefixWidth} flexShrink={0}>
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
  images,
  omittedImageCount,
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
  const imageHeightBudget =
    availableTerminalHeight !== undefined && images?.length
      ? Math.max(1, Math.floor(availableTerminalHeight / (images.length + 1)))
      : availableTerminalHeight;

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth} flexShrink={0}>
        <Text color={prefixColor} aria-label={ariaLabel}>
          {prefix}
        </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {text.length > 0 && (
          <MarkdownDisplay
            text={text}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={contentWidth - prefixWidth}
            textColor={textColor}
            sourceCopyIndexOffsets={sourceCopyIndexOffsets}
          />
        )}
        {images?.map((image, index) => (
          <TerminalImage
            key={index}
            image={image}
            contentWidth={contentWidth - prefixWidth}
            availableTerminalHeight={imageHeightBudget}
          />
        ))}
        {omittedImageCount !== undefined && omittedImageCount > 0 && (
          <Text dimColor>{formatInlineImageOverflow(omittedImageCount)}</Text>
        )}
      </Box>
    </Box>
  );
};

const ContinuationMarkdownMessage: React.FC<
  ContinuationMarkdownMessageProps
> = ({
  text,
  images,
  omittedImageCount,
  isPending,
  availableTerminalHeight,
  contentWidth,
  basePrefix,
  textColor,
  sourceCopyIndexOffsets,
}) => {
  const prefixWidth = getPrefixWidth(basePrefix);
  const imageHeightBudget =
    availableTerminalHeight !== undefined && images?.length
      ? Math.max(1, Math.floor(availableTerminalHeight / (images.length + 1)))
      : availableTerminalHeight;

  return (
    <Box flexDirection="column" paddingLeft={prefixWidth}>
      {text.length > 0 && (
        <MarkdownDisplay
          text={text}
          isPending={isPending}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={contentWidth - prefixWidth}
          textColor={textColor}
          sourceCopyIndexOffsets={sourceCopyIndexOffsets}
        />
      )}
      {images?.map((image, index) => (
        <TerminalImage
          key={index}
          image={image}
          contentWidth={contentWidth - prefixWidth}
          availableTerminalHeight={imageHeightBudget}
        />
      ))}
      {omittedImageCount !== undefined && omittedImageCount > 0 && (
        <Text dimColor>{formatInlineImageOverflow(omittedImageCount)}</Text>
      )}
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
  images,
  omittedImageCount,
  isPending,
  availableTerminalHeight,
  contentWidth,
  sourceCopyIndexOffsets,
}) => (
  <PrefixedMarkdownMessage
    text={text}
    images={images}
    omittedImageCount={omittedImageCount}
    prefix={ICON.DIAMOND}
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
  images,
  omittedImageCount,
  isPending,
  availableTerminalHeight,
  contentWidth,
  sourceCopyIndexOffsets,
}) => (
  <ContinuationMarkdownMessage
    text={text}
    images={images}
    omittedImageCount={omittedImageCount}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
    basePrefix={ICON.DIAMOND}
    sourceCopyIndexOffsets={sourceCopyIndexOffsets}
  />
);

const BRIEF_THOUGHT_THRESHOLD_MS = 1_000;

const ThinkBody: React.FC<{
  text: string;
  isPending: boolean;
  expanded: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
}> = ({ text, isPending, expanded, availableTerminalHeight, contentWidth }) => {
  if (!expanded) return null;

  return (
    <Box paddingLeft={2} flexDirection="column">
      <ErrorBoundary
        fallback={(err) => (
          <Text color={theme.text.secondary} dimColor>
            {sanitizeTerminalText(err.message)}
          </Text>
        )}
        onError={(error, info) => {
          debugLogger.error(
            `[THINK_RENDER_ERROR] ${error.message}\n${info.componentStack ?? ''}\n${error.stack ?? ''}`,
          );
        }}
      >
        <MarkdownDisplay
          text={text}
          isPending={isPending}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={contentWidth - 2}
          textColor={theme.text.secondary}
        />
      </ErrorBoundary>
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
