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
import { formatDuration } from '../../utils/formatters.js';

interface ToolElapsedTimeProps {
  status: ToolCallStatus;
  executionStartTime?: number;
  /**
   * When provided, the elapsed indicator becomes a combined budget display:
   * `(elapsed · timeout N)` visible from t=0 so the timeout is always on
   * screen. When absent, the indicator keeps the 3-second quiet threshold
   * and renders just the elapsed time.
   */
  timeoutMs?: number;
}

/**
 * Right-aligned elapsed-time indicator for an executing tool.
 *
 * Two modes:
 *   - no `timeoutMs`: suppressed for the first 3 seconds so fast tools stay
 *     visually quiet.
 *   - with `timeoutMs`: rendered as `(elapsed · timeout N)` from t=0 so the
 *     user can see both how long the tool has been running and how much
 *     budget remains.
 */
export const ToolElapsedTime: React.FC<ToolElapsedTimeProps> = ({
  status,
  executionStartTime,
  timeoutMs,
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

  if (status !== ToolCallStatus.Executing) return null;

  const hasTimeout = timeoutMs != null && timeoutMs > 0;
  if (!hasTimeout && elapsedSeconds < 3) return null;

  const elapsedStr = formatDuration(elapsedSeconds * 1000, {
    hideTrailingZeros: true,
  });
  const label = hasTimeout
    ? `(${elapsedStr} · timeout ${formatDuration(timeoutMs, { hideTrailingZeros: true })})`
    : elapsedStr;

  return (
    <Box flexShrink={0} marginLeft={1}>
      <Text color={theme.text.secondary}>{label}</Text>
    </Box>
  );
};
