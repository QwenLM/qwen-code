/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CSSProperties } from 'react';
import type { TimelineSpan } from '../../trajectory/buildTimeline';
import type { TimelineRange } from '../../trajectory/timelineRange';
import type { TimelineViewport } from '../../trajectory/useTimelineViewport';
import styles from './TrajectoryWaterfallCell.module.css';

function position(start: number, end: number, from: number, length: number) {
  return {
    left: `${((start - from) / length) * 100}%`,
    width: `${((end - start) / length) * 100}%`,
  } satisfies CSSProperties;
}

export function TrajectoryWaterfallCell({
  span,
  total,
  viewport,
  range,
  title,
}: {
  span?: TimelineSpan;
  total: number;
  viewport?: TimelineViewport;
  range?: TimelineRange;
  title?: string;
}) {
  const from = viewport?.start ?? 0;
  const to = viewport?.end ?? total;
  const length = to - from;
  const start = span ? Math.max(from, span.start) : 0;
  const end = span ? Math.min(to, span.end) : 0;
  const visible =
    span &&
    (end > start ||
      (span.end === span.start && span.start >= from && span.start <= to));
  const zero = visible && (length <= 0 || span.end === span.start);
  const first =
    span?.ttftEnd === undefined ? start : Math.min(end, span.ttftEnd);
  const rangeStart = range ? Math.max(from, range.start) : 0;
  const rangeEnd = range ? Math.min(to, range.end) : 0;
  return (
    <div
      className={styles.cell}
      aria-hidden="true"
      data-testid="trajectory-waterfall-cell"
      data-from={from}
      data-to={to}
    >
      {range && length > 0 && rangeEnd > rangeStart && (
        <span
          className={styles.range}
          data-testid="trajectory-waterfall-range"
          style={position(rangeStart, rangeEnd, from, length)}
        />
      )}
      {!span ? (
        <span className={styles.missing}>—</span>
      ) : visible ? (
        <span
          className={styles.bar}
          data-testid="trajectory-waterfall-span"
          data-row-key={span.rowKey}
          data-lane={span.lane}
          data-error={span.error || undefined}
          data-zero={zero || undefined}
          data-at-end={(zero && length > 0 && start === to) || undefined}
          title={title}
          style={
            zero
              ? {
                  left:
                    length > 0 ? `${((start - from) / length) * 100}%` : '0%',
                }
              : position(start, end, from, length)
          }
        >
          {span.ttftEnd !== undefined && !zero && first > start && (
            <span
              className={styles.ttft}
              data-testid="trajectory-waterfall-ttft"
              style={{ width: `${((first - start) / (end - start)) * 100}%` }}
            />
          )}
        </span>
      ) : null}
    </div>
  );
}
