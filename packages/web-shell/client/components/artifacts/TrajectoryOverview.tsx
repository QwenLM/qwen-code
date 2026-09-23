/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Maximize2Icon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';
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

/** The narrowest stretch of time the strip will zoom to, in ms. */
export const MIN_VIEWPORT_MS = 20;

/**
 * Zoom per pixel of wheel travel: the visible length is multiplied by
 * `exp(deltaY × this)`, so equal wheel travel is an equal zoom ratio whatever
 * the current zoom. One notch of a common mouse wheel (120px) is about 1.2×.
 */
export const ZOOM_PER_WHEEL_PX = 0.0015;

/** One wheel notch, which is what the zoom buttons step by. */
const WHEEL_NOTCH_PX = 120;

/**
 * A viewport this close to the whole run is the whole run. Without it,
 * zooming back out would leave a viewport a rounding error short of the
 * domain, and the reset button and the axis would keep saying "zoomed".
 */
const WHOLE_RUN_FRACTION = 0.999;

/** A stretch of the domain shown across the strip's width, in ms. */
export interface Viewport {
  start: number;
  end: number;
}

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

/**
 * The viewport, and the model it was set on. A refresh or another session
 * brings a new model whose compressed axis is laid out afresh, so the same
 * numbers would frame a different stretch of the run; holding the model
 * alongside lets the viewport lapse in the render the model changes.
 */
interface ViewportState {
  viewport: Viewport;
  of: TimelineModel;
}

/** One press on the track, from pointerdown until it is released. */
interface Gesture {
  pointerId: number | undefined;
  anchorX: number;
  /** Where the press landed, in domain ms. */
  anchorMs: number;
  /** The span pressed on, if any — the one a click selects. */
  spanKey: string | undefined;
  dragging: boolean;
}

/** A right-button press that pans a zoomed strip, or clears when it did not move. */
interface Pan {
  pointerId: number | undefined;
  anchorX: number;
  /** The viewport when the press began; the pan is measured from it. */
  start: number;
  length: number;
  moved: boolean;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * A viewport of `length` placed so domain point `anchorMs` stays at
 * `fraction` of the strip's width, clamped to the domain. `undefined` means
 * the whole run: the length reached it, or there is no domain to zoom.
 *
 * The length is clamped before the start is placed, so a zoom that hits its
 * limit still keeps the anchor where it was rather than drifting.
 */
export function placeViewport(
  total: number,
  anchorMs: number,
  fraction: number,
  length: number,
): Viewport | undefined {
  if (!(total > 0)) return undefined;
  const len = Math.min(
    total,
    Math.max(Math.min(MIN_VIEWPORT_MS, total), length),
  );
  if (len >= total * WHOLE_RUN_FRACTION) return undefined;
  const start = Math.min(total - len, Math.max(0, anchorMs - fraction * len));
  return { start, end: start + len };
}

/**
 * Wheel travel in pixels. A mouse in Firefox reports lines, and a few
 * devices report pages; left as they come, one notch of those would be
 * treated as a pixel and barely zoom at all.
 */
function wheelPixels(delta: number, mode: number, pageWidth: number): number {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * pageWidth;
  return delta;
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
  const panRef = useRef<Pan | null>(null);
  const [draft, setDraft] = useState<TimelineRange | undefined>(undefined);
  const [panning, setPanning] = useState(false);
  const total = model?.total ?? 0;

  const [viewportState, setViewportState] = useState<ViewportState | undefined>(
    undefined,
  );
  const viewport =
    viewportState !== undefined && viewportState.of === model
      ? viewportState.viewport
      : undefined;
  const vStart = viewport?.start ?? 0;
  const vLength = viewport ? viewport.end - viewport.start : total;

  // The wheel listener is attached outside React and several wheel events can
  // land before the next render. Each has to build on the viewport the one
  // before it set, not on the one last rendered, or a fast spin of the wheel
  // would lose most of its travel. So the latest viewport is also kept here,
  // written in the same breath as the state.
  const modelRef = useRef(model);
  const viewportRef = useRef<ViewportState | undefined>(undefined);
  useLayoutEffect(() => {
    modelRef.current = model;
  }, [model]);

  /** The viewport as of the latest change, whether or not it has rendered. */
  const currentView = useCallback((): { start: number; length: number } => {
    const current = modelRef.current;
    const whole = current?.total ?? 0;
    const held = viewportRef.current;
    if (held === undefined || held.of !== current) {
      return { start: 0, length: whole };
    }
    return {
      start: held.viewport.start,
      length: held.viewport.end - held.viewport.start,
    };
  }, []);

  const applyViewport = useCallback((next: Viewport | undefined) => {
    const current = modelRef.current;
    const value =
      next !== undefined && current !== undefined
        ? { viewport: next, of: current }
        : undefined;
    viewportRef.current = value;
    setViewportState(value);
  }, []);

  /** Where along the track a pointer is, clamped to the track's ends. */
  const fractionAt = useCallback((clientX: number): number => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  }, []);

  /** The domain point under a pointer, through the current viewport. */
  const msAt = useCallback(
    (clientX: number): number => {
      const { start, length } = currentView();
      return start + fractionAt(clientX) * length;
    },
    [currentView, fractionAt],
  );

  const rangeBetween = (a: number, b: number): TimelineRange => ({
    start: Math.min(a, b),
    end: Math.max(a, b),
  });

  /**
   * Scale the visible length by `factor` around a domain point that stays at
   * `fraction` of the width. Reports whether anything changed, so a wheel that
   * could not zoom further is left to scroll the page.
   */
  const zoomBy = useCallback(
    (factor: number, anchorMs: number, fraction: number): boolean => {
      const whole = modelRef.current?.total ?? 0;
      const { start, length } = currentView();
      const next = placeViewport(whole, anchorMs, fraction, length * factor);
      const nextStart = next?.start ?? 0;
      const nextLength = next ? next.end - next.start : whole;
      if (nextStart === start && nextLength === length) return false;
      applyViewport(next);
      return true;
    },
    [applyViewport, currentView],
  );

  /** Slide a zoomed viewport by `deltaMs`; the whole run does not slide. */
  const panBy = useCallback(
    (fromStart: number, length: number, deltaMs: number): boolean => {
      const whole = modelRef.current?.total ?? 0;
      if (!(length < whole)) return false;
      const start = Math.min(whole - length, Math.max(0, fromStart + deltaMs));
      if (start === currentView().start) return false;
      applyViewport({ start, end: start + length });
      return true;
    },
    [applyViewport, currentView],
  );

  const hasModel = model !== undefined;
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    // Attached by hand: React's own wheel listener is passive, and a wheel
    // that zooms the strip must not also scroll the page under it.
    const onWheel = (event: WheelEvent) => {
      if (gestureRef.current || panRef.current) return;
      const width = plot.getBoundingClientRect().width;
      const dx = wheelPixels(event.deltaX, event.deltaMode, width);
      const dy = wheelPixels(event.deltaY, event.deltaMode, width);
      let changed = false;
      if (Math.abs(dx) > Math.abs(dy)) {
        // A sideways swipe on a trackpad pans, once there is anywhere to go.
        const { start, length } = currentView();
        changed = width > 0 && panBy(start, length, (dx / width) * length);
      } else if (dy !== 0) {
        const fraction = fractionAt(event.clientX);
        changed = zoomBy(
          Math.exp(dy * ZOOM_PER_WHEEL_PX),
          msAt(event.clientX),
          fraction,
        );
      }
      if (changed) event.preventDefault();
    };
    plot.addEventListener('wheel', onWheel, { passive: false });
    return () => plot.removeEventListener('wheel', onWheel);
  }, [hasModel, currentView, fractionAt, msAt, panBy, zoomBy]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // One press at a time: a right press during a left drag, or the other way
    // round, is ignored rather than allowed to steal the capture.
    if (gestureRef.current || panRef.current) return;
    if (event.button === 2) {
      const { start, length } = currentView();
      panRef.current = {
        pointerId: event.pointerId,
        anchorX: event.clientX,
        start,
        length,
        moved: false,
      };
      const element = event.currentTarget;
      if (typeof element.setPointerCapture === 'function') {
        element.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const spanKey =
      target?.closest<HTMLElement>('[data-row-key]')?.dataset['rowKey'];
    gestureRef.current = {
      pointerId: event.pointerId,
      anchorX: event.clientX,
      anchorMs: msAt(event.clientX),
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
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      const dx = event.clientX - pan.anchorX;
      if (!pan.moved && Math.abs(dx) >= DRAG_THRESHOLD_PX) {
        pan.moved = true;
        setPanning(true);
      }
      if (pan.moved) {
        const width = plotRef.current?.getBoundingClientRect().width ?? 0;
        // Dragging right brings earlier time into view.
        if (width > 0) panBy(pan.start, pan.length, (-dx / width) * pan.length);
      }
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (
      !gesture.dragging &&
      Math.abs(event.clientX - gesture.anchorX) >= DRAG_THRESHOLD_PX
    ) {
      gesture.dragging = true;
    }
    if (gesture.dragging) {
      setDraft(rangeBetween(gesture.anchorMs, msAt(event.clientX)));
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      panRef.current = null;
      setPanning(false);
      // A right click that went nowhere clears the selection, as it always
      // has. One that panned was a pan, and leaves the selection alone.
      if (!pan.moved) onRangeChange(undefined);
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    setDraft(undefined);
    if (gesture.dragging) {
      onRangeChange(rangeBetween(gesture.anchorMs, msAt(event.clientX)));
    } else if (gesture.spanKey !== undefined) {
      onSelect(gesture.spanKey);
    } else {
      onRangeChange(undefined);
    }
  };

  /** The press ended without a release of its own; commit nothing. */
  const abandon = () => {
    gestureRef.current = null;
    panRef.current = null;
    setDraft(undefined);
    setPanning(false);
  };

  // Only the browser's menu is kept away here. Clearing belongs to the right
  // button's release, which knows whether the press panned: on Linux and macOS
  // the menu event fires on the press, before anyone can tell.
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const zoomed = viewport !== undefined;
  const atNarrowest = vLength <= Math.min(MIN_VIEWPORT_MS, total);
  const centre = vStart + vLength / 2;
  const notch = Math.exp(WHEEL_NOTCH_PX * ZOOM_PER_WHEEL_PX);
  const domainStyle = {
    '--domain-left': percent(vLength > 0 ? -(vStart / vLength) * 100 : 0),
    '--domain-width': percent(vLength > 0 ? (total / vLength) * 100 : 100),
  } as CSSProperties;

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
            // A group rather than an image: the zoom buttons live inside it,
            // and an image's children are hidden from assistive technology.
            role: 'group',
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
                : '') +
              (viewport
                ? t('trajectory.zoom.aria', {
                    from: formatDuration(viewport.start),
                    to: formatDuration(viewport.end),
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
            data-panning={panning ? 'true' : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={abandon}
            onContextMenu={onContextMenu}
          >
            {/* Everything drawn sits in this layer, placed in percent of the
                whole run. Zooming and panning move and stretch the layer, so
                not one span has to be placed again. */}
            <div
              className={styles.domain}
              data-testid="trajectory-domain"
              data-zoomed={zoomed ? 'true' : undefined}
              style={domainStyle}
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
                        total > 0
                          ? ((shown.end - shown.start) / total) * 100
                          : 0,
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
                  data-current={
                    span.rowKey === selectedKey ? 'true' : undefined
                  }
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
          </div>
          <div className={styles.axis}>
            <span aria-hidden="true" data-testid="trajectory-overview-from">
              {vStart > 0 ? formatDuration(vStart) : '0'}
            </span>
            <span className={styles.axisEnd}>
              <span aria-hidden="true" data-testid="trajectory-overview-busy">
                {zoomed
                  ? t('trajectory.zoom.window', {
                      to: formatDuration(vStart + vLength),
                      busy: busy ?? '',
                    })
                  : t('trajectory.overview.busy', { duration: busy ?? '' })}
              </span>
              {/* Not `disabled` when there is nothing to do: a disabled button
                  drops the focus of the reader who just pressed it, and these
                  are pressed exactly when they are about to run out. */}
              <button
                type="button"
                className={styles.zoomButton}
                data-testid="trajectory-zoom-in"
                aria-label={t('trajectory.zoom.in')}
                title={t('trajectory.zoom.in')}
                aria-disabled={atNarrowest ? true : undefined}
                onClick={() => {
                  zoomBy(1 / notch, centre, 0.5);
                }}
              >
                <ZoomInIcon size={10} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={styles.zoomButton}
                data-testid="trajectory-zoom-out"
                aria-label={t('trajectory.zoom.out')}
                title={t('trajectory.zoom.out')}
                aria-disabled={zoomed ? undefined : true}
                onClick={() => {
                  zoomBy(notch, centre, 0.5);
                }}
              >
                <ZoomOutIcon size={10} strokeWidth={1.8} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={styles.zoomButton}
                data-testid="trajectory-zoom-reset"
                aria-label={t('trajectory.zoom.reset')}
                title={t('trajectory.zoom.reset')}
                aria-disabled={zoomed ? undefined : true}
                onClick={() => {
                  if (zoomed) applyViewport(undefined);
                }}
              >
                <Maximize2Icon size={10} strokeWidth={1.8} aria-hidden="true" />
              </button>
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
