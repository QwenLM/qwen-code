/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Format an epoch-seconds timestamp as a localized relative time
 * ("3 hours ago"). `now` is also epoch seconds.
 */
export function timeAgo(
  timestamp: number,
  now: number,
  language: string,
): string {
  const seconds = Math.max(0, Math.floor(now - timestamp));
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (seconds < 60) return formatter.format(0, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return formatter.format(-days, 'day');
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return formatter.format(-weeks, 'week');
  const months = Math.floor(days / 30);
  if (months < 12) return formatter.format(-months, 'month');
  return formatter.format(-Math.max(1, Math.floor(days / 365)), 'year');
}
