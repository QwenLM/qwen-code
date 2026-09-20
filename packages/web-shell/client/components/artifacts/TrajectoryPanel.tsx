/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { DaemonTurnUsage } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { formatDuration } from '../messages/StatsMessage';
import {
  useTrajectoryWindow,
  type TrajectoryPageLoader,
} from '../../trajectory/useTrajectoryWindow';
import type {
  Trajectory,
  TrajectoryRequestRow,
  TrajectoryRow,
  TrajectoryToolRow,
  TrajectoryTurn,
} from '../../trajectory/types';
import styles from './TrajectoryPanel.module.css';

/**
 * Every row is one line and every row is this tall, turn headers included.
 * Uniform heights are what make the scroll adjustment after an older page
 * lands exact arithmetic rather than a measurement race.
 */
const ROW_HEIGHT = 34;

export interface TrajectoryPanelProps {
  /**
   * Fetches transcript pages for this tab's session. Absent while a restored
   * tab is waiting to be rewired, which renders as the loading state.
   */
  loadPage?: TrajectoryPageLoader;
  /** Test seam for the window sizes; production uses the hook's defaults. */
  windowOptions?: { pageSize?: number; maxPages?: number };
}

type VisualRow =
  | { kind: 'turn'; key: string; turnKey: string; turn: TrajectoryTurn }
  | { kind: 'row'; key: string; row: TrajectoryRow };

/** Stable across re-projection: turn numbers shift when an older page lands. */
function turnKeyOf(turn: TrajectoryTurn): string {
  return turn.userRowKey ?? turn.rowKeys[0] ?? `ordinal:${turn.index}`;
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function usageSummary(usage: DaemonTurnUsage): string {
  return `${compactTokens(usage.inputTokens)} → ${compactTokens(usage.outputTokens)}`;
}

/**
 * Tool call ids the model layer mints, used only to recognise the trailing
 * segment of a subagent id when the spawning call is outside the window.
 */
const TOOL_CALL_ID_SUFFIX = /-call_[A-Za-z0-9]+$/;

/**
 * A subagent id is `<agentType>-<parentCallId>`, and an agent type may itself
 * contain a dash, so the split point cannot be guessed from the id alone.
 *
 * With the spawning call known the type is whatever precedes it. Without it —
 * the call is outside the loaded window, or was never a top-level tool call —
 * a trailing `-call_…` segment is still recognisably an id rather than part of
 * a name, and dropping it beats showing forty characters of hex. Anything else
 * is shown whole.
 */
function subagentLabel(row: TrajectoryRequestRow): string | undefined {
  const { subagentId, parentToolCallId } = row;
  if (subagentId === undefined) return undefined;
  if (
    parentToolCallId !== undefined &&
    subagentId.endsWith(`-${parentToolCallId}`)
  ) {
    return subagentId.slice(0, -(parentToolCallId.length + 1));
  }
  return subagentId.replace(TOOL_CALL_ID_SUFFIX, '');
}

function firstLine(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.indexOf('\n');
  return end === -1 ? trimmed : trimmed.slice(0, end);
}

/** Right-hand metrics for one row; an empty list renders as an em dash. */
function metricsOf(
  row: TrajectoryRow,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string[] {
  if (row.kind === 'request') {
    const parts = [formatDuration(row.timing.durationMs)];
    if (row.timing.ttftMs !== undefined) {
      parts.push(
        t('trajectory.ttft', { duration: formatDuration(row.timing.ttftMs) }),
      );
    }
    if (row.usage) parts.push(usageSummary(row.usage));
    return parts;
  }
  if (row.kind === 'tool') {
    const parts: string[] = [];
    // A tool frame carries only a duration — the tool logger stamps a whole
    // batch at the batch's end, so there is no honest per-tool start time and
    // nothing to derive one from.
    if (row.timing) parts.push(formatDuration(row.timing.durationMs));
    if (row.subagentSummary) {
      const { requests, tools, requestMs } = row.subagentSummary;
      parts.push(
        t('trajectory.subagentRollup', {
          requests,
          tools,
          duration: formatDuration(requestMs),
        }),
      );
    }
    return parts;
  }
  return [];
}

function toolStatusTone(row: TrajectoryToolRow): string | undefined {
  const status = row.toolStatus ?? row.block.status;
  if (status === 'error' || status === 'failed') return styles.toneError;
  if (status === 'cancelled') return styles.toneMuted;
  return undefined;
}

interface RowLabel {
  /** Short type marker in the left gutter. */
  badge: string;
  badgeTone?: string;
  text: string;
  /** Rendered in the de-emphasised style used for thoughts. */
  faint?: boolean;
}

function labelOf(
  row: TrajectoryRow,
  t: (key: string, vars?: Record<string, string | number>) => string,
): RowLabel {
  switch (row.kind) {
    case 'user':
      return {
        badge: t('trajectory.badge.user'),
        text: firstLine(row.block.text),
      };
    case 'request': {
      const agent = subagentLabel(row);
      return {
        badge:
          agent !== undefined
            ? t('trajectory.badge.subagent')
            : `#${row.requestIndex ?? '?'}`,
        ...(row.status === 'error' ? { badgeTone: styles.toneError } : {}),
        text:
          agent !== undefined
            ? `${agent}${row.model ? ` · ${row.model}` : ''}`
            : (row.model ??
              t(
                row.status === 'error'
                  ? 'trajectory.requestFailed'
                  : 'trajectory.request',
              )),
      };
    }
    case 'message':
      return {
        badge: row.thought
          ? t('trajectory.badge.thought')
          : t('trajectory.badge.message'),
        text: firstLine(row.block.text),
        faint: row.thought,
      };
    case 'tool':
      return {
        badge: row.block.toolName ?? t('trajectory.badge.tool'),
        ...(toolStatusTone(row) ? { badgeTone: toolStatusTone(row)! } : {}),
        text: row.block.title || (row.block.toolName ?? ''),
      };
    default:
      return { badge: row.block.kind, text: '' };
  }
}

/**
 * Whether the fold found any recorded timing at all. A session written before
 * the daemon emitted timing frames folds into rows with no request rows and no
 * tool durations, which is worth saying out loud rather than showing as a
 * table of em dashes.
 */
function hasAnyTiming(trajectory: Trajectory): boolean {
  return trajectory.rows.some(
    (row) =>
      row.kind === 'request' ||
      (row.kind === 'tool' && row.timing !== undefined),
  );
}

export function TrajectoryPanel({
  loadPage,
  windowOptions,
}: TrajectoryPanelProps) {
  const { t } = useI18n();
  const {
    trajectory,
    status,
    error,
    hasOlder,
    loadingOlder,
    atCapacity,
    loadOlder,
    refresh,
  } = useTrajectoryWindow(loadPage, windowOptions ?? {});

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingPrependRef = useRef(false);
  const previousCountRef = useRef(0);
  const settledOnceRef = useRef(false);

  const visualRows = useMemo<VisualRow[]>(() => {
    if (!trajectory) return [];
    const byKey = new Map(trajectory.rows.map((row) => [row.key, row]));
    const out: VisualRow[] = [];
    for (const turn of trajectory.turns) {
      const turnKey = turnKeyOf(turn);
      out.push({ kind: 'turn', key: `turn:${turnKey}`, turnKey, turn });
      if (collapsed.has(turnKey)) continue;
      for (const rowKey of turn.rowKeys) {
        const row = byKey.get(rowKey);
        if (row) out.push({ kind: 'row', key: rowKey, row });
      }
    }
    return out;
  }, [trajectory, collapsed]);

  const virtualizer = useVirtualizer({
    count: visualRows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => visualRows[index]?.key ?? index,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Older pages prepend, so every row already on screen moves down by exactly
  // the number of rows added. With uniform heights that offset is arithmetic,
  // and applying it keeps the reader looking at the same row.
  useLayoutEffect(() => {
    const count = visualRows.length;
    const previous = previousCountRef.current;
    previousCountRef.current = count;
    if (!pendingPrependRef.current) return;
    pendingPrependRef.current = false;
    const delta = count - previous;
    const element = scrollRef.current;
    if (delta > 0 && element) element.scrollTop += delta * ROW_HEIGHT;
  }, [visualRows]);

  // The tail is what a reader wants first: the newest turn is the one they
  // just watched run.
  useEffect(() => {
    if (status !== 'ready' || settledOnceRef.current || visualRows.length === 0)
      return;
    settledOnceRef.current = true;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [status, visualRows.length]);

  const handleLoadOlder = useCallback(() => {
    pendingPrependRef.current = true;
    loadOlder();
  }, [loadOlder]);

  const toggleTurn = useCallback((turnKey: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(turnKey)) next.add(turnKey);
      return next;
    });
  }, []);

  const allCollapsed =
    trajectory !== undefined &&
    trajectory.turns.length > 0 &&
    trajectory.turns.every((turn) => collapsed.has(turnKeyOf(turn)));

  const toggleAll = useCallback(() => {
    if (!trajectory) return;
    setCollapsed(
      allCollapsed
        ? new Set()
        : new Set(trajectory.turns.map((turn) => turnKeyOf(turn))),
    );
  }, [allCollapsed, trajectory]);

  const selectedIndex = useMemo(
    () =>
      selectedKey === undefined
        ? -1
        : visualRows.findIndex((row) => row.key === selectedKey),
    [selectedKey, visualRows],
  );

  const moveSelection = useCallback(
    (nextIndex: number) => {
      if (visualRows.length === 0) return;
      const clamped = Math.min(Math.max(nextIndex, 0), visualRows.length - 1);
      setSelectedKey(visualRows[clamped]!.key);
      virtualizer.scrollToIndex(clamped, { align: 'auto' });
    },
    [virtualizer, visualRows],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (visualRows.length === 0) return;
      const current = selectedIndex < 0 ? -1 : selectedIndex;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSelection(current + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(current <= 0 ? 0 : current - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        moveSelection(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        moveSelection(visualRows.length - 1);
      } else if (event.key === ' ' || event.key === 'Enter') {
        const row = visualRows[current];
        if (row?.kind === 'turn') {
          event.preventDefault();
          toggleTurn(row.turnKey);
        }
      }
    },
    [moveSelection, selectedIndex, toggleTurn, visualRows],
  );

  const totals = useMemo(() => {
    if (!trajectory) return undefined;
    let requests = 0;
    let tools = 0;
    let durationMs = 0;
    for (const turn of trajectory.turns) {
      requests += turn.requestCount;
      tools += turn.toolCount;
      durationMs += turn.requestMs;
    }
    return { turns: trajectory.turns.length, requests, tools, durationMs };
  }, [trajectory]);

  const empty = status === 'ready' && visualRows.length === 0;
  const timingAbsent =
    trajectory !== undefined &&
    visualRows.length > 0 &&
    !hasAnyTiming(trajectory);

  return (
    <div className={styles.panel} data-testid="trajectory-panel">
      <div className={styles.header}>
        <div className={styles.summary}>
          {totals ? (
            <span data-testid="trajectory-totals">
              {t('trajectory.totals', {
                turns: totals.turns,
                requests: totals.requests,
                tools: totals.tools,
                duration:
                  totals.durationMs > 0
                    ? formatDuration(totals.durationMs)
                    : '—',
              })}
            </span>
          ) : (
            <span>{t('trajectory.title')}</span>
          )}
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.headerButton}
            onClick={toggleAll}
            disabled={!trajectory || trajectory.turns.length === 0}
          >
            {t(
              allCollapsed ? 'trajectory.expandAll' : 'trajectory.collapseAll',
            )}
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={refresh}
            disabled={!loadPage || status === 'loading'}
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
          >
            <RefreshCwIcon size={14} strokeWidth={1.6} />
          </button>
        </div>
      </div>

      {error !== undefined && (
        <div className={styles.error} role="alert">
          <span>{t('trajectory.loadFailed', { message: error })}</span>
          <button
            type="button"
            className={styles.headerButton}
            onClick={refresh}
          >
            {t('common.retry')}
          </button>
        </div>
      )}
      {timingAbsent && (
        <div className={styles.notice} role="status">
          {t('trajectory.noTiming')}
        </div>
      )}

      <div className={styles.tableWrap}>
        {visualRows.length === 0 ? (
          // An error with nothing folded is already stated by the alert above;
          // repeating it here as a placeholder would say it twice.
          status === 'error' ? null : (
            <div className={styles.placeholder} role="status">
              {t(empty ? 'trajectory.empty' : 'common.loading')}
            </div>
          )
        ) : (
          <div
            ref={scrollRef}
            className={styles.scroll}
            role="grid"
            tabIndex={0}
            aria-label={t('trajectory.title')}
            aria-rowcount={visualRows.length}
            onKeyDown={handleKeyDown}
            data-testid="trajectory-rows"
          >
            {(hasOlder || loadingOlder || atCapacity) && (
              <div className={styles.olderBar}>
                {atCapacity ? (
                  <span className={styles.olderNotice}>
                    {t('trajectory.atCapacity')}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.olderButton}
                    onClick={handleLoadOlder}
                    disabled={loadingOlder}
                    data-testid="trajectory-load-older"
                  >
                    {loadingOlder
                      ? t('common.loading')
                      : t('trajectory.loadOlder')}
                  </button>
                )}
              </div>
            )}
            <div
              className={styles.virtualBody}
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((item) => {
                const entry = visualRows[item.index]!;
                return (
                  <div
                    key={item.key}
                    className={styles.virtualRow}
                    style={{
                      height: `${ROW_HEIGHT}px`,
                      transform: `translateY(${item.start}px)`,
                    }}
                    role="row"
                    aria-rowindex={item.index + 1}
                  >
                    {entry.kind === 'turn' ? (
                      <TurnHeaderRow
                        turn={entry.turn}
                        collapsed={collapsed.has(entry.turnKey)}
                        selected={entry.key === selectedKey}
                        onToggle={() => {
                          setSelectedKey(entry.key);
                          toggleTurn(entry.turnKey);
                        }}
                      />
                    ) : (
                      <RecordRow
                        row={entry.row}
                        selected={entry.key === selectedKey}
                        onSelect={() => setSelectedKey(entry.key)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TurnHeaderRow({
  turn,
  collapsed,
  selected,
  onToggle,
}: {
  turn: TrajectoryTurn;
  collapsed: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const Chevron = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <button
      type="button"
      className={`${styles.turnHeader} ${selected ? styles.selected : ''}`}
      onClick={onToggle}
      aria-expanded={!collapsed}
      data-selected={selected ? 'true' : undefined}
      role="gridcell"
      data-testid="trajectory-turn"
    >
      <Chevron size={13} strokeWidth={1.8} className={styles.turnChevron} />
      <span className={styles.turnTitle}>
        {turn.partial
          ? t('trajectory.turnPartial', { index: turn.index })
          : t('trajectory.turn', { index: turn.index })}
      </span>
      <span className={styles.turnSummary}>
        {t('trajectory.turnSummary', {
          requests: turn.requestCount,
          tools: turn.toolCount,
          duration: turn.requestMs > 0 ? formatDuration(turn.requestMs) : '—',
        })}
      </span>
    </button>
  );
}

function RecordRow({
  row,
  selected,
  onSelect,
}: {
  row: TrajectoryRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const label = labelOf(row, t);
  const metrics = metricsOf(row, t);
  return (
    <div
      className={`${styles.record} ${selected ? styles.selected : ''}`}
      role="gridcell"
      aria-selected={selected}
      data-selected={selected ? 'true' : undefined}
      onClick={onSelect}
      data-testid={`trajectory-row-${row.kind}`}
      data-depth={row.depth}
    >
      {row.depth > 0 && (
        <CornerDownRightIcon
          size={12}
          strokeWidth={1.6}
          className={styles.nestMarker}
          aria-hidden="true"
        />
      )}
      <span className={`${styles.badge} ${label.badgeTone ?? ''}`}>
        {label.badge}
      </span>
      <span className={`${styles.text} ${label.faint ? styles.faint : ''}`}>
        {label.text}
      </span>
      <span className={styles.metrics} data-testid="trajectory-row-metrics">
        {metrics.length > 0 ? metrics.join(' · ') : '—'}
      </span>
    </div>
  );
}
