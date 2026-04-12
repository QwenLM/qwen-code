/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ToolCallStatus } from '../../types.js';
import { GeminiRespondingSpinner } from '../GeminiRespondingSpinner.js';
import {
  TOOL_STATUS,
  SHELL_COMMAND_NAME,
  SHELL_NAME,
} from '../../constants.js';
import { theme } from '../../semantic-colors.js';

export const STATUS_INDICATOR_WIDTH = 3;

/**
 * Formats elapsed seconds as compact human-readable text.
 * Under 60s: "3s", "45s" (integer seconds, matching Claude Code style).
 * 60s and above: "1m", "1m 30s", "2h 15m" (via formatDuration).
 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

type ToolStatusIndicatorProps = {
  status: ToolCallStatus;
  name: string;
  executionStartTime?: number;
};

export const ToolStatusIndicator: React.FC<ToolStatusIndicatorProps> = ({
  status,
  name,
  executionStartTime,
}) => {
  const isShell = name === SHELL_COMMAND_NAME || name === SHELL_NAME;
  const statusColor = isShell ? theme.ui.symbol : theme.status.warning;

  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (status !== ToolCallStatus.Executing || !executionStartTime) {
      setElapsedSeconds(0);
      return;
    }
    setElapsedSeconds(Math.floor((Date.now() - executionStartTime) / 1000));
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - executionStartTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [status, executionStartTime]);

  const showElapsed =
    status === ToolCallStatus.Executing && elapsedSeconds >= 3;

  return (
    <Box minWidth={STATUS_INDICATOR_WIDTH}>
      {status === ToolCallStatus.Pending && (
        <Text color={theme.status.success}>{TOOL_STATUS.PENDING}</Text>
      )}
      {status === ToolCallStatus.Executing && (
        <>
          <GeminiRespondingSpinner
            spinnerType="toggle"
            nonRespondingDisplay={TOOL_STATUS.EXECUTING}
          />
          {showElapsed && (
            <Text color={theme.text.secondary}>
              {' '}
              {formatElapsed(elapsedSeconds)}
            </Text>
          )}
        </>
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
