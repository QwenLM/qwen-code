/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { extractXmlTagContent } from '@qwen-code/core';
import { figures } from '../../utils/figures.js';
import type { HistoryItemCustomContent } from '../../types.js';

const BULLET = figures.bullet;

function statusToColor(
  status: string | null,
): 'green' | 'red' | 'yellow' | undefined {
  switch (status) {
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    case 'killed':
    case 'stopped':
      return 'yellow';
    default:
      return undefined;
  }
}

function formatDurationMs(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export interface TaskNotificationMessageProps {
  value: string;
}

export const TaskNotificationMessage: React.FC<
  TaskNotificationMessageProps
> = ({ value }) => {
  const summary = extractXmlTagContent(value, 'summary');
  if (!summary) return null;

  const status = extractXmlTagContent(value, 'status');
  const durationStr = extractXmlTagContent(value, 'duration_ms');
  const durationMs = durationStr ? Number(durationStr) : NaN;
  const color = statusToColor(status);

  return (
    <Box marginTop={1}>
      <Text>
        <Text color={color}>{BULLET}</Text>
        {' '}
        {summary}
        {Number.isFinite(durationMs) && durationMs > 0 && (
          <Text dimColor>{' '}· {formatDurationMs(durationMs)}</Text>
        )}
      </Text>
    </Box>
  );
};

/**
 * Build a custom_content HistoryItem for a task-notification message.
 * Returns null when no `<summary>` is present (nothing to render).
 */
export function buildTaskNotificationHistoryItem(
  value: string,
): HistoryItemCustomContent | null {
  const summary = extractXmlTagContent(value, 'summary');
  if (!summary) return null;
  return {
    type: 'custom_content',
    content: <TaskNotificationMessage value={value} />,
  };
}
