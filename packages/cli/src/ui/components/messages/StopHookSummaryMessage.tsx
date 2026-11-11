/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { HistoryItemCustomContent } from '../../types.js';

export interface StopHookSummaryProps {
  hookErrors: string[];
  preventedContinuation: boolean;
  stopReason?: string;
}

export const StopHookSummaryMessage: React.FC<StopHookSummaryProps> = ({
  hookErrors,
  preventedContinuation,
  stopReason,
}) => (
  <Box flexDirection="column">
    {preventedContinuation && stopReason && (
      <Text dimColor>{'⎿  '}{stopReason}</Text>
    )}
    {hookErrors.map((err, i) => (
      <Text key={i} dimColor>
        {'⎿  '}Stop hook error: {err}
      </Text>
    ))}
  </Box>
);

/**
 * Build a custom_content HistoryItem for the Stop hook summary.
 * Returns null when there is nothing to show (no errors, no stopped continuation).
 */
export function buildStopHookSummaryHistoryItem(
  props: StopHookSummaryProps,
): HistoryItemCustomContent | null {
  if (props.hookErrors.length === 0 && !props.preventedContinuation) return null;
  return {
    type: 'custom_content',
    content: <StopHookSummaryMessage {...props} />,
  };
}
