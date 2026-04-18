/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ToolCallStatus } from '../../types.js';
import { theme } from '../../semantic-colors.js';

/**
 * Formats elapsed seconds as compact text.
 * Under 60s: "3s", "45s".
 * 60s+: "1m", "1m 30s", "2h 15m".
 */
export function formatElapsed(seconds: number): string {
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

interface ToolElapsedTimeProps {
  status: ToolCallStatus;
  executionStartTime?: number;
}

/**
 * Right-aligned elapsed-time indicator for an executing tool. Renders
 * nothing until the tool has been running for at least 3 seconds, so quick
 * tools stay visually quiet.
 */
export const ToolElapsedTime: React.FC<ToolElapsedTimeProps> = ({
  status,
  executionStartTime,
}) => {
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

  if (status !== ToolCallStatus.Executing || elapsedSeconds < 3) return null;

  return (
    <Box flexShrink={0} marginLeft={1}>
      <Text color={theme.text.secondary}>{formatElapsed(elapsedSeconds)}</Text>
    </Box>
  );
};
