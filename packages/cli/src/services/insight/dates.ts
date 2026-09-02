/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The single definition point for the insight pipeline's date basis.
 *
 * Convention: **local time** (issue #6835 decision). A "day" and an "hour"
 * are the viewer's local calendar day and wall-clock hour — the correct
 * semantics for a personal activity tracker, and the basis the
 * active-hours histogram and the ASCII heatmap renderer already used.
 * Every producer and consumer of day keys must go through these helpers;
 * if the convention is ever revisited, this file is the only place that
 * changes.
 *
 * The web renderer (packages/web-templates/src/insight) cannot import
 * this module across the package boundary; it carries a same-shaped twin
 * in `src/insight/src/dates.ts` — keep the two in sync.
 */

/** Keys an instant by its local calendar day as `YYYY-MM-DD`. */
export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Parses a `YYYY-MM-DD` day key to local midnight of that day. Local
 * construction (`new Date(y, m-1, d)`) rather than `new Date(key)`: the
 * latter parses as UTC midnight, which a subsequent local normalization
 * shifts to the previous day in negative-offset timezones.
 */
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** The local day key of `now` (injectable for tests). */
export function todayKey(now: Date = new Date()): string {
  return dayKey(now);
}

/** Buckets an instant by its local wall-clock hour (0–23). */
export function hourOfDay(date: Date): number {
  return date.getHours();
}
