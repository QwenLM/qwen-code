/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CSSProperties } from 'react';
import { useI18n } from '../../i18n';
import { formatDuration } from '../messages/StatsMessage';
import type {
  TimelineModel,
  TimelineSpan,
} from '../../trajectory/buildTimeline';
import styles from './TrajectoryOverview.module.css';

/**
 * The strip's height, which never changes. It sits above the table as a flex
 * sibling of the scrolled rows, so any change in its height would move every
 * row the reader is looking at. Loading, empty and drawn states all fill the
 * same box.
 */
export const OVERVIEW_HEIGHT = 64;

export interface TrajectoryOverviewProps {
  model: TimelineModel | undefined;
  /** Shown inside the box when there is no model to draw. */
  notice?: string;
  selectedKey?: string;
  onSelect: (rowKey: string) => void;
  /** Hover text for one span; the table owns how a row is named. */
  describe: (span: TimelineSpan) => string;
}

/** Percentages as CSS lengths, rounded so tests can name them exactly. */
export function percent(value: number): string {
  return `${Number(value.toFixed(3))}%`;
}

function spanStyle(span: TimelineSpan, total: number): CSSProperties {
  const length = span.end - span.start;
  const share = total > 0 ? length / total : 0;
  const style: Record<string, string> = {
    '--left': percent(total > 0 ? (span.start / total) * 100 : 0),
    '--width': percent(share * 100),
    // Calls running side by side share a lane, and a long one drawn after a
    // short one would cover it completely. Shorter spans stack higher, so
    // every one stays visible and clickable.
    '--stack': String(1 + Math.round((1 - share) * 1000)),
  };
  if (span.ttftEnd !== undefined && length > 0) {
    style['--ttft'] = percent(((span.ttftEnd - span.start) / length) * 100);
  }
  return style as CSSProperties;
}

export function TrajectoryOverview({
  model,
  notice,
  selectedKey,
  onSelect,
  describe,
}: TrajectoryOverviewProps) {
  const { t } = useI18n();
  const busy = model ? formatDuration(model.total) : undefined;
  return (
    <div
      className={styles.overview}
      data-testid="trajectory-overview"
      {...(model
        ? {
            role: 'img',
            'aria-label': t('trajectory.overview.label', {
              spans: model.spans.length,
              busy: busy ?? '',
            }),
          }
        : {})}
    >
      {model ? (
        <>
          <div className={styles.labels} aria-hidden="true">
            <span>{t('trajectory.overview.lane.requests')}</span>
            <span>{t('trajectory.overview.lane.tools')}</span>
            <span>{t('trajectory.overview.lane.subagents')}</span>
          </div>
          <div className={styles.plot} aria-hidden="true">
            {model.turnMarks.map((mark) => (
              <span
                key={mark.turnIndex}
                className={styles.turnMark}
                data-testid="trajectory-turn-mark"
                style={
                  {
                    '--left': percent(
                      model.total > 0 ? (mark.at / model.total) * 100 : 0,
                    ),
                  } as CSSProperties
                }
              />
            ))}
            {model.spans.map((span) => (
              <span
                key={span.rowKey}
                className={styles.span}
                data-testid="trajectory-span"
                data-row-key={span.rowKey}
                data-lane={span.lane}
                data-error={span.error ? 'true' : undefined}
                data-ttft={span.ttftEnd !== undefined ? 'true' : undefined}
                data-current={span.rowKey === selectedKey ? 'true' : undefined}
                title={describe(span)}
                style={spanStyle(span, model.total)}
                onClick={() => onSelect(span.rowKey)}
              />
            ))}
          </div>
          <div className={styles.axis} aria-hidden="true">
            <span>0</span>
            <span data-testid="trajectory-overview-busy">
              {t('trajectory.overview.busy', { duration: busy ?? '' })}
            </span>
          </div>
        </>
      ) : notice ? (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
