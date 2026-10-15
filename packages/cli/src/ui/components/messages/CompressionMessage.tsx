/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type { CompressionProps } from '../../types.js';
import Spinner from 'ink-spinner';
import { theme } from '../../semantic-colors.js';
import { SCREEN_READER_MODEL_PREFIX } from '../../textConstants.js';
import { ICON } from '../../constants.js';
import { getCompressionStatusText } from '../../utils/compression-text.js';

export interface CompressionDisplayProps {
  compression: CompressionProps;
}

/*
 * Compression messages appear when the /compress command is run, and show a loading spinner
 * while compression is in progress, followed up by some compression stats.
 */
export function CompressionMessage({
  compression,
}: CompressionDisplayProps): React.JSX.Element {
  const {
    isPending,
    originalTokenCount,
    newTokenCount,
    compressionStatus,
    originalTokenCountIsEstimated,
    newTokenCountIsEstimated,
  } = compression;

  const text = getCompressionStatusText({
    isPending,
    originalTokenCount,
    newTokenCount,
    compressionStatus,
    originalTokenCountIsEstimated,
    newTokenCountIsEstimated,
  });

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        {isPending ? (
          <Spinner type="dots" />
        ) : (
          <Text color={theme.text.accent}>{ICON.DIAMOND}</Text>
        )}
      </Box>
      <Box flexGrow={1}>
        <Text
          color={
            compression.isPending ? theme.text.accent : theme.status.success
          }
          aria-label={SCREEN_READER_MODEL_PREFIX}
        >
          {text}
        </Text>
      </Box>
    </Box>
  );
}
