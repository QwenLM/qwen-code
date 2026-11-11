/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import { ModelRespondingSpinner } from './ModelRespondingSpinner.js';
import { formatDuration } from '../utils/formatters.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';
import {
  isModelProgressLabel,
  getModelProgressLabel,
} from '../utils/modelProgress.js';
import { useI18nService } from '../i18n/index.js';

interface LoadingIndicatorProps {
  currentLoadingPhrase?: string;
  wittyPhrase?: string;
  showWit?: boolean;
  showTips?: boolean;
  errorVerbosity?: 'low' | 'full';
  elapsedTime: number;
  inline?: boolean;
  rightContent?: React.ReactNode;
  showCancelAndTimer?: boolean;
  forceRealStatusOnly?: boolean;
  spinnerIcon?: string;
  isHookActive?: boolean;
  forceSpinner?: boolean;
}

export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  currentLoadingPhrase,
  wittyPhrase,
  showWit = false,
  elapsedTime,
  inline = false,
  rightContent,
  showCancelAndTimer = true,
  forceRealStatusOnly = false,
  spinnerIcon,
  isHookActive = false,
  forceSpinner = false,
}) => {
  const i18n = useI18nService();
  const streamingState = useStreamingContext();
  const { columns: terminalWidth } = useTerminalSize();
  const isNarrow = isNarrowWidth(terminalWidth);

  if (streamingState === StreamingState.Idle && !currentLoadingPhrase) {
    return null;
  }

  const primaryText =
    currentLoadingPhrase ||
    (streamingState === StreamingState.Responding
      ? getModelProgressLabel(null, i18n.get)
      : undefined);

  const cancelAndTimerContent =
    showCancelAndTimer && streamingState === StreamingState.Responding
      ? i18n.get('status.loading.cancelAndTimer', {
          duration:
            elapsedTime < 60
              ? `${elapsedTime}s`
              : formatDuration(elapsedTime * 1000),
        })
      : null;

  const wittyPhraseNode =
    !forceRealStatusOnly &&
    showWit &&
    wittyPhrase &&
    isModelProgressLabel(primaryText, i18n.get) ? (
      <Box marginLeft={1}>
        <Text color={theme.text.secondary} dimColor italic>
          {wittyPhrase}
        </Text>
      </Box>
    ) : null;

  if (inline) {
    // Force a single-line row. Without overflow="hidden" + flexWrap="nowrap",
    // very long primaryText (e.g. a hook's long custom statusMessage) can
    // cause Ink's `truncate-end` to fail and silently wrap, pushing a phantom
    // multi-line block above the input box.
    return (
      <Box flexDirection="row" flexWrap="nowrap" overflow="hidden">
        <Box marginRight={1} flexShrink={0}>
          <ModelRespondingSpinner
            nonRespondingDisplay={
              spinnerIcon ??
              (streamingState === StreamingState.WaitingForConfirmation
                ? '⠏'
                : '')
            }
            isHookActive={isHookActive}
            forceSpinner={forceSpinner}
          />
        </Box>
        {primaryText && (
          <Box flexShrink={1} overflow="hidden">
            <Text color={theme.text.primary} italic wrap="truncate-end">
              {primaryText}
            </Text>
          </Box>
        )}
        {cancelAndTimerContent && (
          <>
            <Box flexShrink={0} width={1} />
            <Box flexShrink={0}>
              <Text color={theme.text.secondary}>{cancelAndTimerContent}</Text>
            </Box>
          </>
        )}
        {wittyPhraseNode}
      </Box>
    );
  }

  return (
    <Box paddingLeft={0} flexDirection="column">
      {/* Main loading line */}
      <Box
        width="100%"
        flexDirection={isNarrow ? 'column' : 'row'}
        alignItems={isNarrow ? 'flex-start' : 'center'}
      >
        <Box>
          <Box marginRight={1}>
            <ModelRespondingSpinner
              nonRespondingDisplay={
                spinnerIcon ??
                (streamingState === StreamingState.WaitingForConfirmation
                  ? '⠏'
                  : '')
              }
              isHookActive={isHookActive}
              forceSpinner={forceSpinner}
            />
          </Box>
          {primaryText && (
            <Box flexShrink={1}>
              <Text color={theme.text.primary} italic wrap="truncate-end">
                {primaryText}
              </Text>
            </Box>
          )}
          {!isNarrow && cancelAndTimerContent && (
            <>
              <Box flexShrink={0} width={1} />
              <Text color={theme.text.secondary}>{cancelAndTimerContent}</Text>
            </>
          )}
          {!isNarrow && wittyPhraseNode}
        </Box>
        {!isNarrow && <Box flexGrow={1}>{/* Spacer */}</Box>}
        {!isNarrow && rightContent && <Box>{rightContent}</Box>}
      </Box>
      {isNarrow && cancelAndTimerContent && (
        <Box>
          <Text color={theme.text.secondary}>{cancelAndTimerContent}</Text>
        </Box>
      )}
      {isNarrow && wittyPhraseNode}
      {isNarrow && rightContent && <Box>{rightContent}</Box>}
    </Box>
  );
};
