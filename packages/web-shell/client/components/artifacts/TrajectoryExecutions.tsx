/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TrajectoryExecutionRow } from '../../trajectory/project-trajectory-executions';
import { useI18n } from '../../i18n';
import { formatDuration } from '../messages/StatsMessage';
import styles from './TrajectoryExecutions.module.css';

export function TrajectoryExecutions({
  rows,
  omitted,
  incomplete,
  outsideWindow,
  selectedKey,
  onSelect,
}: {
  rows: readonly TrajectoryExecutionRow[];
  omitted: number;
  incomplete: boolean;
  outsideWindow: number;
  selectedKey?: string;
  onSelect: (key: string) => void;
}) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [compact, setCompact] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [now, setNow] = useState(Date.now);
  const [activeKey, setActiveKey] = useState<string>();
  const id = useId();
  const open = expanded && !compact;
  const running = rows.some((row) => row.status === 'running');
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    const panel = rootRef.current?.parentElement;
    if (!panel) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCompact(entry.contentRect.height < 480);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open || !visible || !running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [open, visible, running]);
  const virtualizer = useVirtualizer({
    count: open ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    getItemKey: (index) => rows[index]!.key,
    overscan: 3,
  });
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
  return (
    <section
      ref={rootRef}
      className={styles.section}
      data-testid="trajectory-executions"
    >
      <button
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
      {open && (
        <>
          <div className={styles.notice}>
            {t('trajectory.executions.scope')}
            {outsideWindow > 0 && (
              <span>
                {' '}
                · {t('trajectory.executions.outside', { count: outsideWindow })}
              </span>
            )}
            {omitted > 0 && (
              <span>
                {' '}
                · {t('trajectory.executions.omitted', { count: omitted })}
              </span>
            )}
            {incomplete && (
              <span> · {t('trajectory.lifecycleIncomplete')}</span>
            )}
          </div>
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
          {rows.length === 0 ? (
            <p className={styles.notice}>{t('trajectory.executions.empty')}</p>
          ) : (
            <div
              ref={scrollRef}
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
              onKeyDown={(event) => {
                let next = activeIndex;
                if (event.key === 'ArrowDown') next++;
                else if (event.key === 'ArrowUp') next--;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = rows.length - 1;
                else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  if (rows[activeIndex]) onSelect(rows[activeIndex].key);
                  return;
                } else return;
                event.preventDefault();
                next = Math.max(0, Math.min(rows.length - 1, next));
                setActiveKey(rows[next]!.key);
                virtualizer.scrollToIndex(next, { align: 'auto' });
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
          )}
        </>
      )}
    </section>
  );
}
