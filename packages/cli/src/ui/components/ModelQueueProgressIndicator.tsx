/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { Box, ResizeObserver, Text, type DOMElement } from 'ink';
import type { ModelQueueProps } from '../types.js';
import { theme } from '../semantic-colors.js';
import { formatDuration } from '../utils/formatters.js';
import {
  formatEstimatedQueueWait,
  getModelQueueBarWidth,
} from '../utils/modelQueueDisplay.js';
import { CliSpinner } from './CliSpinner.js';
import { ProgressBar } from './ProgressBar.js';

interface ModelQueueProgressIndicatorProps {
  modelQueue: ModelQueueProps;
  terminalWidth: number;
  isNarrow: boolean;
  elapsedTime: number;
  onResize?: (width: number) => void;
}

const PREFIX_WIDTH = 2;
const PROGRESS_RESERVED_WIDTH = 10;

function formatElapsedTime(elapsedTime: number): string {
  return elapsedTime < 60
    ? `${elapsedTime}s`
    : formatDuration(elapsedTime * 1000);
}

export function ModelQueueProgressIndicator({
  modelQueue,
  terminalWidth,
  isNarrow,
  elapsedTime,
  onResize,
}: ModelQueueProgressIndicatorProps): React.JSX.Element {
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
    },
    [],
  );

  const onRefChange = useCallback(
    (node: DOMElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;

      if (node && onResize) {
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry) onResize(Math.round(entry.contentRect.width));
        });
        observer.observe(node);
        observerRef.current = observer;
      }
    },
    [onResize],
  );

  const isReady = modelQueue.status === 'ready';
  const title = isReady
    ? isNarrow
      ? 'Model available'
      : 'Model is available'
    : isNarrow
      ? 'Model queued'
      : 'Model request queued';
  const detail = isReady
    ? 'Continuing request...'
    : (formatEstimatedQueueWait(modelQueue.waitTimeMs) ??
      'Waiting for model availability...');
  const elapsed = formatElapsedTime(elapsedTime);
  const activityText = isNarrow
    ? `(${elapsed})`
    : `(esc to cancel, ${elapsed})`;
  const color = isReady ? theme.status.success : theme.text.accent;
  const barWidth = getModelQueueBarWidth(
    terminalWidth,
    PROGRESS_RESERVED_WIDTH,
  );

  return (
    <Box ref={onRefChange} flexDirection="column" flexShrink={1} overflow="hidden">
      <Box flexDirection="row" flexWrap="nowrap" overflow="hidden">
        <Box width={PREFIX_WIDTH} flexShrink={0}>
          {isReady ? <Text color={color}>✓</Text> : <CliSpinner type="dots" />}
        </Box>
        <Box flexShrink={1} overflow="hidden">
          <Text color={color} wrap="truncate-end">
            {title}
          </Text>
        </Box>
        <Box marginLeft={1} flexShrink={0}>
          <Text color={theme.text.secondary}>{activityText}</Text>
        </Box>
      </Box>
      <Box marginLeft={PREFIX_WIDTH} overflow="hidden">
        <ProgressBar
          value={modelQueue.progress}
          width={barWidth}
          label={isReady ? 'ready' : 'moving'}
          activeColor={color}
          inactiveColor={theme.ui.dark}
          activeChar="█"
          inactiveChar="░"
        />
      </Box>
      <Box marginLeft={PREFIX_WIDTH} overflow="hidden">
        <Text color={theme.text.secondary} wrap="truncate-end">
          {detail}
        </Text>
      </Box>
    </Box>
  );
}
