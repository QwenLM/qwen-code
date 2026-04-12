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
            <Text color={theme.text.secondary}> {elapsedSeconds}s</Text>
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
