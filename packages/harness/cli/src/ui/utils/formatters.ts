/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  REFERENCE_CONTENT_START,
  REFERENCE_CONTENT_END,
} from '@qwen-code/core';

export const formatBytes = (bytes: number): string => {
  const gb = bytes / (1024 * 1024 * 1024);
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${gb.toFixed(2)} GB`;
};

/**
 * Formats a duration in milliseconds into a concise, human-readable string (e.g., "1h 5s").
 * It omits any time units that are zero.
 * @param milliseconds The duration in milliseconds.
 * @returns A formatted string representing the duration.
 */
export const formatDuration = (milliseconds: number): string => {
  if (milliseconds <= 0) {
    return '0s';
  }

  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`;
  }

  const totalSeconds = milliseconds / 1000;

  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0) {
    parts.push(`${seconds}s`);
  }

  // If all parts are zero (e.g., exactly 1 hour), return the largest unit.
  if (parts.length === 0) {
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  return parts.join(' ');
};

export const formatQueueDuration = (
  milliseconds: number,
  round: 'ceil' | 'floor',
): string => {
  const seconds =
    round === 'ceil'
      ? Math.max(1, Math.ceil(milliseconds / 1000))
      : Math.floor(milliseconds / 1000);
  if (seconds <= 60) {
    return `${seconds}s`;
  }
  const minutes =
    round === 'ceil'
      ? Math.max(1, Math.round(seconds / 60))
      : Math.floor(seconds / 60);
  return `${minutes}min`;
};

export const formatTimeAgo = (date: string | number | Date): string => {
  const past = new Date(date);
  if (isNaN(past.getTime())) {
    return 'invalid date';
  }

  const now = new Date();
  const diffMs = now.getTime() - past.getTime();
  if (diffMs < 60000) {
    return 'just now';
  }
  return `${formatDuration(diffMs)} ago`;
};

/**
 * Removes content bounded by reference content markers from the given text.
 * The markers are "${REFERENCE_CONTENT_START}" and "${REFERENCE_CONTENT_END}".
 *
 * @param text The input text containing potential reference blocks.
 * @returns The text with reference blocks removed and trimmed.
 */
const REFERENCE_CONTENT_PATTERN = new RegExp(
  `\\n?${REFERENCE_CONTENT_START}[\\s\\S]*?${REFERENCE_CONTENT_END}`,
  'g',
);

export function stripReferenceContent(text: string): string {
  if (!text.includes(REFERENCE_CONTENT_START)) return text.trim();
  return text.replace(REFERENCE_CONTENT_PATTERN, '').trim();
}

export const formatResetTime = (
  resetTime: string | undefined,
  format: 'terse' | 'column' | 'full' = 'full',
): string => {
  if (!resetTime) return '';
  const resetDate = new Date(resetTime);
  if (isNaN(resetDate.getTime())) return '';

  const diff = resetDate.getTime() - Date.now();
  if (diff <= 0) return '';

  const totalMinutes = Math.ceil(diff / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const isTerse = format === 'terse';
  const isColumn = format === 'column';

  if (isTerse || isColumn) {
    const hoursStr = hours > 0 ? `${hours}h` : '';
    const minutesStr = minutes > 0 ? `${minutes}m` : '';
    const duration =
      hoursStr && minutesStr
        ? `${hoursStr} ${minutesStr}`
        : hoursStr || minutesStr;

    if (isColumn) {
      const timeStr = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: 'numeric',
      }).format(resetDate);
      return duration ? `${timeStr} (${duration})` : timeStr;
    }

    return duration;
  }

  let duration = '';
  if (hours > 0) {
    duration = `${hours} hour${hours > 1 ? 's' : ''}`;
    if (minutes > 0) {
      duration += ` ${minutes} minute${minutes > 1 ? 's' : ''}`;
    }
  } else {
    duration = `${minutes} minute${minutes > 1 ? 's' : ''}`;
  }

  const timeStr = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: 'numeric',
    timeZoneName: 'short',
  }).format(resetDate);

  return `${duration} at ${timeStr}`;
};
