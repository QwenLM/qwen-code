/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TrajectoryExecutionRow } from '../../trajectory/project-trajectory-executions';
import type { TrajectoryLifecycleProjection } from '../../trajectory/project-trajectory-lifecycle';
import { useI18n } from '../../i18n';
import { getShadowAwareActiveElement, isFocusUnclaimed } from '../../utils/dom';
import { formatDuration } from '../messages/StatsMessage';
import styles from './TrajectoryExecutions.module.css';

const ROW_HEIGHT = 34;

interface ScrollAnchor {
  keys: string[];
  index: number;
  offset: number;
}

function anchoredOffset(anchor: ScrollAnchor, keys: string[]): number {
  const indices = new Map(keys.map((key, index) => [key, index]));
  for (let distance = 0; distance < anchor.keys.length; distance++) {
    for (const index of [anchor.index + distance, anchor.index - distance]) {
      const key = anchor.keys[index];
      const next = key === undefined ? undefined : indices.get(key);
      if (next !== undefined) return next * ROW_HEIGHT + anchor.offset;
    }
  }
  return anchor.index * ROW_HEIGHT + anchor.offset;
}

export function TrajectoryExecutions({
  rows,
  selectedKey,
  onSelect,
  following,
  liveStatus,
  historySnapshot,
  onPause,
  onUpdatedChange,
  onFocusLost,
}: {
  rows: readonly TrajectoryExecutionRow[];
  selectedKey?: string;
  onSelect: (key: string) => void;
  following: boolean;
  liveStatus: TrajectoryLifecycleProjection['status'];
  historySnapshot: object | undefined;
  onPause: () => void;
  /** New executions arrived while the reader was not following. */
  onUpdatedChange?: (updated: boolean) => void;
  /** The focused grid went away with nothing of the strip left to take it. */
  onFocusLost?: () => void;
}) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [compact, setCompact] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<ScrollAnchor | undefined>(undefined);
  const restoreScrollRef = useRef<() => void>(() => {});
  const followingRef = useRef(following);
  const pause = () => {
    followingRef.current = false;
    onPause();
  };
  const onFocusLostRef = useRef(onFocusLost);
  useLayoutEffect(() => {
    onFocusLostRef.current = onFocusLost;
  }, [onFocusLost]);
  const setScrollElement = useCallback((node: HTMLDivElement | null) => {
    const previous = scrollRef.current;
    if (!node && previous?.contains(getShadowAwareActiveElement(previous))) {
      // Resolve the fallback after siblings have finished updating.
      const root = previous.getRootNode();
      queueMicrotask(() => {
        if (!previous.isConnected && isFocusUnclaimed(root)) {
          const target = scrollRef.current ?? toggleRef.current;
          if (target?.isConnected) target.focus({ preventScroll: true });
          else onFocusLostRef.current?.();
        }
      });
    }
    scrollRef.current = node;
  }, []);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [now, setNow] = useState(Date.now);
  const [activeKey, setActiveKey] = useState<string>();
  const id = useId();
  const open = expanded && !compact;
  const running = rows.some((row) => row.status === 'running');
  const [updated, setUpdated] = useState(false);
  const previous = useRef({ rows, liveStatus, historySnapshot });
  useEffect(() => {
    const before = previous.current;
    previous.current = { rows, liveStatus, historySnapshot };
    if (
      following ||
      liveStatus !== 'live' ||
      before.liveStatus !== 'live' ||
      historySnapshot !== before.historySnapshot
    ) {
      setUpdated(false);
    } else {
      const keys = new Set(before.rows.map((row) => row.key));
      if (rows.some((row) => !keys.has(row.key))) setUpdated(true);
    }
  }, [rows, following, liveStatus, historySnapshot]);
  const onUpdatedChangeRef = useRef(onUpdatedChange);
  useLayoutEffect(() => {
    onUpdatedChangeRef.current = onUpdatedChange;
  }, [onUpdatedChange]);
  useEffect(() => {
    onUpdatedChangeRef.current?.(updated);
  }, [updated]);
  const rememberScroll = (element: HTMLElement) => {
    const index = Math.floor(element.scrollTop / ROW_HEIGHT);
    anchorRef.current = {
      keys: rows.map((row) => row.key),
      index,
      offset: element.scrollTop - index * ROW_HEIGHT,
    };
  };
  useLayoutEffect(() => {
    followingRef.current = following;
    if (following) {
      setActiveKey(undefined);
      // A successful return requests the top once, even without live delivery.
      anchorRef.current = undefined;
    }
  }, [following]);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  // The strip renders nothing until the first execution arrives, so the panel
  // can only be observed from then on.
  const present = rows.length > 0;
  useEffect(() => {
    const panel = rootRef.current?.parentElement;
    if (!present || !panel) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCompact(entry.contentRect.height < 480);
      restoreScrollRef.current();
      cancelAnimationFrame(frame);
      if (entry && entry.contentRect.height >= 480 && scrollRef.current)
        frame = requestAnimationFrame(() => restoreScrollRef.current());
    });
    observer.observe(panel);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [present]);
  useEffect(() => {
    if (!open || !visible || !running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [open, visible, running]);
  const virtualizer = useVirtualizer({
    count: open ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]!.key,
    overscan: 3,
  });
  useLayoutEffect(() => {
    const restore = () => {
      const element = scrollRef.current;
      if (!element || !open || !visible || element.clientHeight === 0) return;
      const keys = rows.map((row) => row.key);
      const target =
        followingRef.current && (liveStatus === 'live' || !anchorRef.current)
          ? 0
          : anchorRef.current
            ? anchoredOffset(anchorRef.current, keys)
            : element.scrollTop;
      const top = Math.max(
        0,
        Math.min(target, element.scrollHeight - element.clientHeight),
      );
      // Restore after the virtualizer attaches a replacement scroll element.
      virtualizer.scrollToOffset(top);
      element.scrollTop = top;
      const index = Math.floor(element.scrollTop / ROW_HEIGHT);
      anchorRef.current = {
        keys,
        index,
        offset: element.scrollTop - index * ROW_HEIGHT,
      };
    };
    restoreScrollRef.current = restore;
    restore();
  }, [rows, following, liveStatus, open, visible, virtualizer]);
  const points = rows.flatMap((row) => {
    const start = row.startedAt;
    return [
      start,
      start !== undefined && row.durationMs !== undefined
        ? start + row.durationMs
        : row.endedAt,
      row.status === 'running' && start !== undefined && now >= start
        ? now
        : undefined,
    ].filter((point): point is number => point !== undefined);
  });
  const from = points.length ? Math.min(...points) : undefined;
  const to = points.length ? Math.max(...points) : undefined;
  const span = from !== undefined && to !== undefined ? to - from : 0;
  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.key === (activeKey ?? selectedKey)),
  );
  const items = virtualizer.getVirtualItems();
  // Rendered as nothing rather than unmounted, so the first execution to arrive
  // is compared against an empty list and counts as new.
  if (rows.length === 0) return null;
  return (
    <section
      ref={rootRef}
      className={styles.section}
      data-testid="trajectory-executions"
    >
      <div className={styles.header}>
        <button
          ref={toggleRef}
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          onClick={() => {
            setExpanded(!open);
            if (!open) setCompact(false);
          }}
        >
          {open ? '▾' : '▸'} {t('trajectory.executions.title')} ({rows.length})
        </button>
      </div>
      {open && (
        <>
          {from !== undefined && to !== undefined && (
            <div
              className={styles.axis}
              data-testid="trajectory-execution-axis"
            >
              <span>{new Date(from).toLocaleTimeString(language)}</span>
              <span>{t('trajectory.executions.clock')}</span>
              <span>{new Date(to).toLocaleTimeString(language)}</span>
            </div>
          )}
          <div
            ref={setScrollElement}
            className={styles.scroll}
            role="grid"
            tabIndex={0}
            aria-label={t('trajectory.executions.title')}
            aria-rowcount={rows.length}
            aria-activedescendant={
              items.some((item) => item.index === activeIndex)
                ? `${id}-${activeIndex}`
                : undefined
            }
            onWheel={(event) => {
              if (event.deltaY !== 0) pause();
            }}
            onScroll={(event) => {
              if (event.currentTarget.clientHeight === 0) return;
              const anchor = anchorRef.current;
              const previousTop = anchor
                ? anchor.index * ROW_HEIGHT + anchor.offset
                : 0;
              if (event.currentTarget.scrollTop !== previousTop) pause();
              rememberScroll(event.currentTarget);
            }}
            onKeyDown={(event) => {
              let next = activeIndex;
              if (event.key === 'ArrowDown') next++;
              else if (event.key === 'ArrowUp') next--;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = rows.length - 1;
              else if (event.key === 'PageDown' || event.key === 'PageUp') {
                pause();
                return;
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                pause();
                if (rows[activeIndex]) onSelect(rows[activeIndex].key);
                return;
              } else return;
              event.preventDefault();
              pause();
              next = Math.max(0, Math.min(rows.length - 1, next));
              setActiveKey(rows[next]!.key);
              virtualizer.scrollToIndex(next, { align: 'auto' });
              if (scrollRef.current) rememberScroll(scrollRef.current);
            }}
          >
            <div
              className={styles.body}
              style={{ height: virtualizer.getTotalSize() }}
            >
              {items.map((item) => {
                const row = rows[item.index]!;
                const start = row.startedAt;
                const end =
                  row.durationMs !== undefined && start !== undefined
                    ? start + row.durationMs
                    : row.status === 'running' &&
                        start !== undefined &&
                        now >= start
                      ? now
                      : undefined;
                const point = start ?? row.endedAt;
                const elapsed =
                  row.status === 'running'
                    ? start !== undefined && now >= start
                      ? t('trajectory.executions.elapsed', {
                          duration: formatDuration(now - start),
                        })
                      : t('trajectory.executions.uncertain')
                    : row.durationMs !== undefined
                      ? formatDuration(row.durationMs)
                      : '—';
                return (
                  <div
                    key={row.key}
                    id={`${id}-${item.index}`}
                    role="row"
                    aria-rowindex={item.index + 1}
                    aria-selected={selectedKey === row.key}
                    data-active={activeIndex === item.index || undefined}
                    className={styles.row}
                    data-status={row.status}
                    data-execution-key={row.key}
                    data-testid="trajectory-execution-row"
                    style={{ transform: `translateY(${item.start}px)` }}
                    onClick={() => {
                      pause();
                      setActiveKey(row.key);
                      onSelect(row.key);
                    }}
                  >
                    <span
                      role="gridcell"
                      className={styles.name}
                      title={row.name}
                    >
                      {row.name}
                    </span>
                    <span role="gridcell" className={styles.status}>
                      {t(`trajectory.executions.status.${row.status}`)}
                    </span>
                    <span
                      role="gridcell"
                      className={styles.track}
                      aria-hidden="true"
                    >
                      {point !== undefined && from !== undefined && (
                        <span
                          className={styles.bar}
                          data-running={row.status === 'running' || undefined}
                          data-marker={
                            end === undefined ||
                            end === start ||
                            span === 0 ||
                            undefined
                          }
                          style={{
                            left: `${span > 0 ? ((point - from) / span) * 100 : 0}%`,
                            width: `${span > 0 && end !== undefined && start !== undefined ? (Math.max(0, end - start) / span) * 100 : 0}%`,
                          }}
                        />
                      )}
                    </span>
                    <span role="gridcell" className={styles.duration}>
                      {elapsed}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
