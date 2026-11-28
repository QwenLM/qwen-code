/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type { CompressionProgressView } from '../contexts/UIStateContext.js';
import { theme } from '../semantic-colors.js';
import { CliSpinner } from './CliSpinner.js';

interface CompressionProgressIndicatorProps {
  progress: CompressionProgressView;
  isNarrow: boolean;
}

export function CompressionProgressIndicator({
  progress,
  isNarrow,
}: CompressionProgressIndicatorProps): React.JSX.Element {
  const color =
    progress.tone === 'warning' ? theme.status.warning : theme.text.accent;
  const displayPercent = Math.floor(progress.percent);
  const isRunning = progress.stage !== 'done' && progress.stage !== 'failed';
  const activityIndicator = isRunning ? <CliSpinner type="dots" /> : '✣';

  if (isNarrow) {
    return (
      <Box width="100%" flexWrap="nowrap" overflow="hidden">
        <Text color={color}>{activityIndicator} </Text>
        <Text color={color} wrap="truncate-end">
          {progress.label}
        </Text>
        <Text color={theme.text.secondary}> {displayPercent}%</Text>
      </Box>
    );
  }

  return (
    <Box width="100%" flexDirection="column" overflow="hidden">
      <Box flexDirection="row">
        <Text color={color}>{activityIndicator} </Text>
        <Text color={color}>{progress.label}</Text>
      </Box>
      <Box marginLeft={2} width="65%" flexDirection="row" flexWrap="nowrap">
        <Box
          flexGrow={1}
          height={1}
          backgroundColor={theme.background.message}
          overflow="hidden"
        >
          <Box
            width={`${Math.max(2, progress.percent)}%`}
            height={1}
            backgroundColor={color}
          >
            <Text> </Text>
          </Box>
        </Box>
        <Box marginLeft={1} flexShrink={0}>
          <Text color={theme.text.secondary}>{displayPercent}%</Text>
        </Box>
      </Box>
    </Box>
  );
}
