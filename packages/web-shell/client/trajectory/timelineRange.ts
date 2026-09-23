/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TimelineModel } from './buildTimeline';

/**
 * A stretch of the overview's domain, in the same compressed milliseconds as
 * the spans. Always ordered: `start <= end`.
 */
export interface TimelineRange {
  start: number;
  end: number;
}

/**
 * Rows whose span was running at any point in the range, ends included.
 *
 * With idle time cut out of the domain, spans cover it end to end, so any
 * range finds at least one row. That stops holding once a mode draws real
 * clock time with its gaps left in.
 *
 * Closed on both sides so a zero-length span sitting on an edge — a tool that
 * reported 0 ms, or a range made by a drag that stopped exactly on a bar's
 * end — still counts as inside rather than vanishing from both sides.
 */
export function rowKeysInRange(
  model: TimelineModel,
  range: TimelineRange,
): Set<string> {
  const keys = new Set<string>();
  for (const span of model.spans) {
    if (span.start <= range.end && span.end >= range.start) {
      keys.add(span.rowKey);
    }
  }
  return keys;
}
