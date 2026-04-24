/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const formatMemoryUsage = (bytes: number): string => {
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
/**
 * Formats a timestamp into a human-readable relative time string.
 * @param timestamp The timestamp in milliseconds since epoch.
 * @returns A formatted string like "just now", "5 minutes ago", "2 days ago".
 */
export const formatRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diffMs = now - timestamp;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) {
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
  if (weeks > 0) {
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  if (days > 0) {
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }
  if (hours > 0) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  if (minutes > 0) {
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  }
  return 'just now';
};

export const formatTokenCount = (count: number): string => {
  if (count < 1000) {
    return `${count}`;
  }
  if (count < 10000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${Math.floor(count / 1000)}k`;
};

export interface FormatDurationOptions {
  /**
   * When true, drops a trailing `.0` in the sub-minute range so that whole
   * seconds render as `5s` rather than `5.0s`. Non-integer values keep their
   * decimal (e.g. `5.5s`). Matches Claude Code's `ShellTimeDisplay` style.
   */
  hideTrailingZeros?: boolean;
}

export const formatDuration = (
  milliseconds: number,
  options?: FormatDurationOptions,
): string => {
  if (milliseconds <= 0) {
    return '0s';
  }

  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`;
  }

  const totalSeconds = milliseconds / 1000;

  if (totalSeconds < 60) {
    const formatted = totalSeconds.toFixed(1);
    if (options?.hideTrailingZeros && formatted.endsWith('.0')) {
      return `${formatted.slice(0, -2)}s`;
    }
    return `${formatted}s`;
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
