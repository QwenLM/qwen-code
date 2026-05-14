/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThoughtSummary } from '@qwen-code/qwen-code-core';
import type React from 'react';
import { useRef } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import { GeminiRespondingSpinner } from './GeminiRespondingSpinner.js';
import { formatDuration, formatTokenCount } from '../utils/formatters.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useAnimationFrame } from '../hooks/useAnimationFrame.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';
import { t } from '../../i18n/index.js';

interface LoadingIndicatorProps {
  currentLoadingPhrase?: string;
  elapsedTime: number;
  rightContent?: React.ReactNode;
  thought?: ThoughtSummary | null;
  candidatesTokens?: number;
  /**
   * Live-updating character counter for the streaming response. When provided
   * together with `isStreaming`, the indicator animates a token estimate
   * (chars / 4) internally, so the animation never re-renders `Composer` or
   * the input prompt.
   */
  streamingCharsRef?: React.RefObject<number>;
  /** Whether to poll `streamingCharsRef` (true during Responding/WaitingForConfirmation). */
  isStreaming?: boolean;
  /**
   * True when receiving content (shows ↓ arrow), false when waiting for API
   * response (shows ↑ arrow).
   * @default true
   */
  isReceivingContent?: boolean;
}

export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  currentLoadingPhrase,
  elapsedTime,
  rightContent,
  thought,
  candidatesTokens,
  streamingCharsRef,
  isStreaming,
  isReceivingContent = true,
}) => {
  const streamingState = useStreamingContext();
  const { columns: terminalWidth } = useTerminalSize();
  const isNarrow = isNarrowWidth(terminalWidth);

  // Animate the streaming-chars counter locally so only this component
  // re-renders on each animation frame (100ms ≈ spinner cadence). Siblings
  // like InputPrompt / Footer stay static, which eliminates terminal flicker
  // during streaming output.
  const fallbackRef = useRef(0);
  const animatedChars = useAnimationFrame(
    streamingCharsRef ?? fallbackRef,
    streamingCharsRef && isStreaming ? 100 : null,
  );

  if (streamingState === StreamingState.Idle) {
    return null;
  }

  const primaryText = thought?.subject || currentLoadingPhrase;

  const streamingTokens = streamingCharsRef ? Math.round(animatedChars / 4) : 0;
  const outputTokens = (candidatesTokens ?? 0) + streamingTokens;
  const showTokens = !isNarrow && outputTokens > 0;
  const tokenArrow = isReceivingContent ? '↓' : '↑';

  const timeStr =
    elapsedTime < 60 ? `${elapsedTime}s` : formatDuration(elapsedTime * 1000);

  const tokenStr = showTokens
    ? ` · ${tokenArrow} ${formatTokenCount(outputTokens)} tokens`
    : '';

  const cancelAndTimerContent =
    streamingState !== StreamingState.WaitingForConfirmation
      ? t('({{time}}{{tokens}} · esc to cancel)', {
          time: timeStr,
          tokens: tokenStr,
        })
      : null;

  return (
    <Box paddingLeft={2} flexDirection="column">
      {/* Main loading line */}
      <Box
        width="100%"
        flexDirection={isNarrow ? 'column' : 'row'}
        alignItems={isNarrow ? 'flex-start' : 'center'}
      >
        <Box>
          <Box marginRight={1}>
            <GeminiRespondingSpinner
              nonRespondingDisplay={
                streamingState === StreamingState.WaitingForConfirmation
                  ? '⠏'
                  : ''
              }
            />
          </Box>
          {primaryText && (
            <Text color={theme.text.accent} wrap="truncate-end">
              {primaryText}
            </Text>
          )}
          {!isNarrow && cancelAndTimerContent && (
            <Text color={theme.text.secondary}> {cancelAndTimerContent}</Text>
          )}
        </Box>
        {!isNarrow && <Box flexGrow={1}>{/* Spacer */}</Box>}
        {!isNarrow && rightContent && <Box>{rightContent}</Box>}
      </Box>
      {isNarrow && cancelAndTimerContent && (
        <Box>
          <Text color={theme.text.secondary}>{cancelAndTimerContent}</Text>
        </Box>
      )}
      {isNarrow && rightContent && <Box>{rightContent}</Box>}
    </Box>
  );
};
