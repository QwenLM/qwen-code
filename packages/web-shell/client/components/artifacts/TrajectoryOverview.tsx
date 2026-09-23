/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useI18n } from '../../i18n';
import { formatDuration } from '../messages/StatsMessage';
import type {
  TimelineModel,
  TimelineSpan,
} from '../../trajectory/buildTimeline';
import {
  rowKeysInRange,
  type TimelineRange,
} from '../../trajectory/timelineRange';
import styles from './TrajectoryOverview.module.css';

/**
 * The strip's height, which never changes. It sits above the table as a flex
 * sibling of the scrolled rows, so any change in its height would move every
 * row the reader is looking at. Loading, empty and drawn states all fill the
 * same box.
 */
export const OVERVIEW_HEIGHT = 64;

/**
 * How far the pointer has to travel before a press becomes a drag. Below it
 * the press is a click, which selects the span under it — a hand that wobbles
 * a pixel while clicking a 3px bar must not turn the click into a range.
 */
export const DRAG_THRESHOLD_PX = 4;

export interface TrajectoryOverviewProps {
  model: TimelineModel | undefined;
  /** Shown inside the box when there is no model to draw. */
  notice?: string;
  selectedKey?: string;
  onSelect: (rowKey: string) => void;
  /** Hover text for one span; the table owns how a row is named. */
  describe: (span: TimelineSpan) => string;
  /** The committed time selection, in the model's domain. */
  range?: TimelineRange;
  /**
   * A drag commits a range; a click on empty track, a right click, or any
   * other way of clearing it reports `undefined`.
   */
  onRangeChange: (range: TimelineRange | undefined) => void;
}

/** One press on the track, from pointerdown until it is released. */
interface Gesture {
  pointerId: number | undefined;
  anchorX: number;
  anchorFraction: number;
  /** The span pressed on, if any — the one a click selects. */
  spanKey: string | undefined;
  dragging: boolean;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
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
  range,
  onRangeChange,
}: TrajectoryOverviewProps) {
  const { t } = useI18n();
  const busy = model ? formatDuration(model.total) : undefined;
  const plotRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [draft, setDraft] = useState<TimelineRange | undefined>(undefined);
  const total = model?.total ?? 0;

  /** Where along the track a pointer is, clamped to the track's ends. */
  const fractionAt = useCallback((clientX: number): number => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  }, []);

  const rangeBetween = useCallback(
    (a: number, b: number): TimelineRange => ({
      start: Math.min(a, b) * total,
      end: Math.max(a, b) * total,
    }),
    [total],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const spanKey =
      target?.closest<HTMLElement>('[data-row-key]')?.dataset['rowKey'];
    gestureRef.current = {
      pointerId: event.pointerId,
      anchorX: event.clientX,
      anchorFraction: fractionAt(event.clientX),
      spanKey,
      dragging: false,
    };
    // Captured, so a drag that leaves the strip keeps reporting to it and its
    // release is not lost to whatever is under the pointer by then. A captured
    // release is aimed at the track, not the span it started on — which is why
    // the span is remembered here.
    const element = event.currentTarget;
    if (typeof element.setPointerCapture === 'function') {
      element.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (
      !gesture.dragging &&
      Math.abs(event.clientX - gesture.anchorX) >= DRAG_THRESHOLD_PX
    ) {
      gesture.dragging = true;
    }
    if (gesture.dragging) {
      setDraft(rangeBetween(gesture.anchorFraction, fractionAt(event.clientX)));
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    setDraft(undefined);
    if (gesture.dragging) {
      onRangeChange(
        rangeBetween(gesture.anchorFraction, fractionAt(event.clientX)),
      );
    } else if (gesture.spanKey !== undefined) {
      onSelect(gesture.spanKey);
    } else {
      onRangeChange(undefined);
    }
  };

  /** The press ended without a release of its own; commit nothing. */
  const abandon = () => {
    gestureRef.current = null;
    setDraft(undefined);
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    abandon();
    onRangeChange(undefined);
  };

  const shown = draft ?? range;
  const inside = useMemo(
    () => (model && shown ? rowKeysInRange(model, shown) : undefined),
    [model, shown],
  );

  return (
    <div
      className={styles.overview}
      data-testid="trajectory-overview"
      {...(model
        ? {
            role: 'img',
            'aria-label':
              t('trajectory.overview.label', {
                spans: model.spans.length,
                busy: busy ?? '',
              }) +
              (range
                ? t('trajectory.range.aria', {
                    from: formatDuration(range.start),
                    to: formatDuration(range.end),
                  })
                : ''),
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
          <div
            ref={plotRef}
            className={styles.plot}
            aria-hidden="true"
            data-testid="trajectory-plot"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={abandon}
            onContextMenu={onContextMenu}
          >
            {shown && (
              <div
                className={styles.selection}
                data-testid="trajectory-range"
                data-draft={draft ? 'true' : undefined}
                style={
                  {
                    '--left': percent(
                      total > 0 ? (shown.start / total) * 100 : 0,
                    ),
                    '--width': percent(
                      total > 0 ? ((shown.end - shown.start) / total) * 100 : 0,
                    ),
                  } as CSSProperties
                }
              />
            )}
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
                data-dimmed={
                  inside &&
                  !inside.has(span.rowKey) &&
                  span.rowKey !== selectedKey
                    ? 'true'
                    : undefined
                }
                title={describe(span)}
                style={spanStyle(span, model.total)}
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
