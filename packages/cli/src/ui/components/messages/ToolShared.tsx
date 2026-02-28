/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ToolCallStatus } from '../../types.js';
import { GeminiRespondingSpinner } from '../GeminiRespondingSpinner.js';
import {
  SHELL_COMMAND_NAME,
  SHELL_NAME,
  TOOL_STATUS,
} from '../../constants.js';
import { theme } from '../../semantic-colors.js';
import type { Config } from '@qwen-code/qwen-code-core';

export const STATUS_INDICATOR_WIDTH = 3;

const SHELL_FOCUS_HINT_DELAY_MS = 5000;

export function isShellTool(name: string): boolean {
  return name === SHELL_COMMAND_NAME || name === SHELL_NAME;
}

export function isThisShellFocusable(
  name: string,
  status: ToolCallStatus,
  _config?: Config,
): boolean {
  return !!(isShellTool(name) && status === ToolCallStatus.Executing);
}

export function isThisShellFocused(
  name: string,
  status: ToolCallStatus,
  ptyId?: number,
  activeShellPtyId?: number | null,
  embeddedShellFocused?: boolean,
): boolean {
  return !!(
    isShellTool(name) &&
    status === ToolCallStatus.Executing &&
    ptyId === activeShellPtyId &&
    embeddedShellFocused
  );
}

export function useFocusHint(
  isThisShellFocusable: boolean,
  isThisShellFocused: boolean,
  resultDisplay: unknown,
) {
  const [showFocusHint, setShowFocusHint] = useState(false);
  const [userHasFocused, setUserHasFocused] = useState(false);

  useEffect(() => {
    if (!isThisShellFocusable) {
      return;
    }

    const timer = setTimeout(() => {
      setShowFocusHint(true);
    }, SHELL_FOCUS_HINT_DELAY_MS);

    return () => clearTimeout(timer);
  }, [isThisShellFocusable, resultDisplay]);

  useEffect(() => {
    if (isThisShellFocused) {
      setUserHasFocused(true);
    }
  }, [isThisShellFocused]);

  const shouldShowFocusHint =
    isThisShellFocusable && (showFocusHint || userHasFocused);

  return { shouldShowFocusHint };
}

export const FocusHint: React.FC<{
  shouldShowFocusHint: boolean;
  isThisShellFocused: boolean;
}> = ({ shouldShowFocusHint, isThisShellFocused }) => {
  if (!shouldShowFocusHint) {
    return null;
  }

  return (
    <Box marginLeft={1} flexShrink={0}>
      <Text color={theme.text.accent}>
        {isThisShellFocused ? '(ctrl+f to unfocus)' : '(ctrl+f to focus)'}
      </Text>
    </Box>
  );
};

export type TextEmphasis = 'high' | 'medium' | 'low';

type ToolStatusIndicatorProps = {
  status: ToolCallStatus;
  name: string;
};

export const ToolStatusIndicator: React.FC<ToolStatusIndicatorProps> = ({
  status,
  name,
}) => {
  const isShell = isShellTool(name);
  const statusColor = isShell ? theme.ui.symbol : theme.status.warning;

  return (
    <Box minWidth={STATUS_INDICATOR_WIDTH}>
      {status === ToolCallStatus.Pending && (
        <Text color={theme.status.success}>{TOOL_STATUS.PENDING}</Text>
      )}
      {status === ToolCallStatus.Executing && (
        <GeminiRespondingSpinner
          spinnerType="toggle"
          nonRespondingDisplay={TOOL_STATUS.EXECUTING}
        />
      )}
      {status === ToolCallStatus.Success && (
        <Text color={theme.status.success} aria-label={'Success:'}>
          {TOOL_STATUS.SUCCESS}
        </Text>
      )}
      {status === ToolCallStatus.Confirming && (
        <Text color={statusColor} aria-label={'Confirming:'}>
          {TOOL_STATUS.CONFIRMING}
        </Text>
      )}
      {status === ToolCallStatus.Canceled && (
        <Text color={statusColor} aria-label={'Canceled:'} bold>
          {TOOL_STATUS.CANCELED}
        </Text>
      )}
      {status === ToolCallStatus.Error && (
        <Text color={theme.status.error} aria-label={'Error:'} bold>
          {TOOL_STATUS.ERROR}
        </Text>
      )}
    </Box>
  );
};

type ToolInfoProps = {
  name: string;
  description: string;
  status: ToolCallStatus;
  emphasis: TextEmphasis;
};

export const ToolInfo: React.FC<ToolInfoProps> = ({
  name,
  description,
  status,
  emphasis,
}) => {
  const nameColor = React.useMemo<string>(() => {
    switch (emphasis) {
      case 'high':
        return theme.text.primary;
      case 'medium':
        return theme.text.primary;
      case 'low':
        return theme.text.secondary;
      default: {
        const exhaustiveCheck: never = emphasis;
        return exhaustiveCheck;
      }
    }
  }, [emphasis]);

  return (
    <Box overflow="hidden" height={1} flexGrow={1} flexShrink={1}>
      <Text strikethrough={status === ToolCallStatus.Canceled} wrap="truncate">
        <Text color={nameColor} bold>
          {name}
        </Text>{' '}
        <Text color={theme.text.secondary}>{description}</Text>
      </Text>
    </Box>
  );
};

export interface McpProgressIndicatorProps {
  progress: number;
  total?: number;
  message?: string;
  barWidth: number;
}

export const McpProgressIndicator: React.FC<McpProgressIndicatorProps> = ({
  progress,
  total,
  message,
  barWidth,
}) => {
  const percentage =
    total && total > 0
      ? Math.min(100, Math.round((progress / total) * 100))
      : null;

  let rawFilled: number;
  if (total && total > 0) {
    rawFilled = Math.round((progress / total) * barWidth);
  } else {
    rawFilled = Math.floor(progress) % (barWidth + 1);
  }

  const filled = Math.max(
    0,
    Math.min(Number.isFinite(rawFilled) ? rawFilled : 0, barWidth),
  );
  const empty = Math.max(0, barWidth - filled);
  const progressBar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.text.accent}>
          {progressBar} {percentage !== null ? `${percentage}%` : `${progress}`}
        </Text>
      </Box>
      {message && (
        <Text color={theme.text.secondary} wrap="truncate">
          {message}
        </Text>
      )}
    </Box>
  );
};

export const TrailingIndicator: React.FC = () => (
  <Text color={theme.text.primary} wrap="truncate">
    {' '}
    ←
  </Text>
);
