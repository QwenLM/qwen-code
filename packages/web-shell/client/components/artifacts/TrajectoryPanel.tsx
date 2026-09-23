/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CornerDownRightIcon, RefreshCwIcon, XIcon } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  DaemonTranscriptBlock,
  DaemonTurnUsage,
} from '@qwen-code/sdk/daemon';
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
import {
  buildTimeline,
  type TimelineSpan,
} from '../../trajectory/buildTimeline';
import {
  rowKeysInRange,
  type TimelineRange,
} from '../../trajectory/timelineRange';
import { TrajectoryOverview } from './TrajectoryOverview';
import styles from './TrajectoryPanel.module.css';

/** Every row is one line and every row is this tall, turn headers included. */
const ROW_HEIGHT = 34;

export interface TrajectoryPanelProps {
  /**
   * Fetches transcript pages for this tab's session. Absent while a restored
   * tab is waiting to be rewired, which renders as the loading state.
   */
  loadPage?: TrajectoryPageLoader;
}

type VisualRow =
  | { kind: 'turn'; key: string; turn: TrajectoryTurn }
  | { kind: 'row'; key: string; row: TrajectoryRow };

/**
 * Thresholds are the rounded boundary, not the raw one: 999,950 tokens is
 * `1.0M`, because `999.9k` is what the next unit down rounds away from.
 */
function compactTokens(value: number): string {
  if (value >= 999_950) return `${(value / 1_000_000).toFixed(1)}M`;
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
    // Only the duration: where a call started is what the overview above
    // the table shows, and a clock time per row would crowd the column.
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
      const failed = row.status === 'error';
      const name =
        agent !== undefined
          ? `${agent}${row.model ? ` · ${row.model}` : ''}`
          : (row.model ?? t('trajectory.request'));
      return {
        badge:
          agent !== undefined
            ? t('trajectory.badge.subagent')
            : `#${row.requestIndex ?? '?'}`,
        ...(failed ? { badgeTone: styles.toneError } : {}),
        // Said in words, not only in the badge's colour. A failed request
        // almost always names its model, so putting the failure *instead of*
        // the name meant the sentence never rendered and the red `#N` was the
        // whole signal — which a reader who cannot see it never receives.
        text: failed ? `${name} · ${t('trajectory.requestFailed')}` : name,
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
      return otherLabel(row.block, t);
  }
}

/**
 * Rows the fold routes to `other`: shell output, a shell command the user ran,
 * a permission prompt, a status or error line, a cancelled turn. Each carries
 * text worth reading, and showing the block's discriminator instead would put
 * a lowercase English enum in front of the reader with an empty label beside
 * it.
 */
function otherLabel(
  block: DaemonTranscriptBlock,
  t: (key: string, vars?: Record<string, string | number>) => string,
): RowLabel {
  switch (block.kind) {
    case 'shell':
      return {
        badge: t('trajectory.badge.shell'),
        text: firstLine(block.text),
      };
    case 'user_shell':
      return {
        badge: t('trajectory.badge.shell'),
        text: firstLine(block.command || block.text),
      };
    case 'permission':
      return {
        badge: t('trajectory.badge.permission'),
        text: block.title || block.toolName || '',
      };
    case 'status':
    case 'error':
    case 'debug':
      return {
        badge: t('trajectory.badge.status'),
        ...(block.kind === 'error' ? { badgeTone: styles.toneError } : {}),
        text: firstLine(block.text),
        faint: block.kind !== 'error',
      };
    case 'prompt_cancelled':
      return {
        badge: t('trajectory.badge.cancelled'),
        badgeTone: styles.toneMuted,
        text: block.reason ?? t('trajectory.cancelled'),
        faint: true,
      };
    default:
      return { badge: t('trajectory.badge.other'), text: '' };
  }
}

/**
 * Whether the fold found any recorded timing at all. A window with no request
 * rows and no tool durations is worth saying out loud rather than showing as a
 * table of em dashes. The notice states only that: a session older than timing
 * frames and one whose first round is still in flight look the same from here,
 * so it does not name a cause.
 */
function hasAnyTiming(trajectory: Trajectory): boolean {
  return trajectory.rows.some(
    (row) =>
      row.kind === 'request' ||
      (row.kind === 'tool' && row.timing !== undefined),
  );
}

export function TrajectoryPanel({ loadPage }: TrajectoryPanelProps) {
  const { t } = useI18n();
  const {
    trajectory,
    status,
    error,
    loadedPages,
    truncated,
    olderFailure,
    refresh,
  } = useTrajectoryWindow(loadPage);

  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const settledOnceRef = useRef(false);
  /** Last offset this panel knows the reader at; see the resize effect. */
  const scrollTopRef = useRef(0);
  const gridId = useId();
  const rowDomId = useCallback(
    (index: number) => `${gridId}-row-${index}`,
    [gridId],
  );

  /**
   * Set the offset and remember it in the same breath. Every write goes
   * through here because the scroll event that would otherwise update the ref
   * arrives a frame later, and a resize can land in between.
   */
  const scrollTo = useCallback((element: HTMLElement, top: number) => {
    element.scrollTop = top;
    scrollTopRef.current = element.scrollTop;
  }, []);

  const timeline = useMemo(
    () => (trajectory ? buildTimeline(trajectory) : undefined),
    [trajectory],
  );

  // The selection belongs to the window it was drawn on. A refresh or another
  // session re-lays the compressed time axis, so the same numbers would name a
  // different stretch of the run; holding the window alongside the range lets
  // the range lapse in the same render the window changes, with no frame in
  // which the new table is filtered by the old one.
  const [rangeState, setRangeState] = useState<
    { range: TimelineRange; of: Trajectory } | undefined
  >(undefined);
  const range =
    rangeState !== undefined && rangeState.of === trajectory
      ? rangeState.range
      : undefined;
  const setRange = useCallback(
    (next: TimelineRange | undefined) => {
      setRangeState(
        next !== undefined && trajectory !== undefined
          ? { range: next, of: trajectory }
          : undefined,
      );
    },
    [trajectory],
  );

  /** Rows running in the selected time, or undefined when nothing is selected. */
  const inRange = useMemo(
    () => (range && timeline ? rowKeysInRange(timeline, range) : undefined),
    [range, timeline],
  );

  const visualRows = useMemo<VisualRow[]>(() => {
    if (!trajectory) return [];
    const byKey = new Map(trajectory.rows.map((row) => [row.key, row]));
    const out: VisualRow[] = [];
    for (const turn of trajectory.turns) {
      // Under a time selection a turn stays only if something in it ran in
      // that time, and then keeps its header and prompt so the rows that
      // survive still say which turn and which ask they answered.
      if (inRange && !turn.rowKeys.some((key) => inRange.has(key))) continue;
      // Named after the prompt that opened the turn, so a refresh that adds
      // newer turns leaves the selection on the turn it was on. Turn numbers
      // are window-relative and shift under exactly that. A turn the window
      // starts in the middle of has no prompt to name it and falls back to its
      // number, which is the case the fallback exists for.
      const turnKey = turn.userRowKey ?? `ordinal:${turn.index}`;
      out.push({ kind: 'turn', key: `turn:${turnKey}`, turn });
      for (const rowKey of turn.rowKeys) {
        if (inRange && !inRange.has(rowKey) && rowKey !== turn.userRowKey) {
          continue;
        }
        const row = byKey.get(rowKey);
        if (row) out.push({ kind: 'row', key: rowKey, row });
      }
    }
    return out;
  }, [trajectory, inRange]);

  const virtualizer = useVirtualizer({
    count: visualRows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => visualRows[index]?.key ?? index,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Hiding an element resets its scroll offset to zero without a scroll event,
  // and the right panel's fullscreen toggle does exactly that to the dock on
  // its way through. The virtualizer goes on rendering rows for the offset it
  // last saw, so every one of them lands below the viewport and the reader is
  // left with a blank table under a header still reporting the run's totals.
  //
  // Put the offset back when the box regains a size. The reset can land either
  // side of the resize callback, so restoring once is not enough — the second
  // attempt on the next frame is what makes it stick.
  const hasRows = visualRows.length > 0;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const restore = () => {
      if (element.scrollTop === 0 && scrollTopRef.current > 0) {
        element.scrollTop = scrollTopRef.current;
      }
    };
    const observer = new ResizeObserver(() => {
      restore();
      frame = requestAnimationFrame(restore);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [hasRows]);

  // The tail is what a reader wants first: the newest turn is the one they
  // just watched run.
  useEffect(() => {
    if (status !== 'ready' || settledOnceRef.current || visualRows.length === 0)
      return;
    settledOnceRef.current = true;
    const element = scrollRef.current;
    if (element) scrollTo(element, element.scrollHeight);
  }, [scrollTo, status, visualRows.length]);

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

  /**
   * Pointer selection. The scrolled box is the grid's only tab stop, so a
   * click has to hand focus back to it: the rows themselves are not focusable,
   * and leaving focus on the document would strand the arrow keys.
   */
  const selectRow = useCallback((key: string) => {
    setSelectedKey(key);
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        // Only claimed when there is a selection to drop; otherwise Escape is
        // left to whatever encloses the panel.
        if (range !== undefined) {
          event.preventDefault();
          setRange(undefined);
        }
        return;
      }
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
      }
    },
    [moveSelection, range, selectedIndex, setRange, visualRows],
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
    trajectory.rows.length > 0 &&
    !hasAnyTiming(trajectory);
  const rangeCounts = useMemo(() => {
    if (!range || !trajectory) return undefined;
    return {
      shown: visualRows.filter((row) => row.kind === 'row').length,
      total: trajectory.rows.length,
    };
  }, [range, trajectory, visualRows]);

  const olderFailureText =
    olderFailure === undefined
      ? undefined
      : olderFailure.kind === 'partial'
        ? t('trajectory.olderPartial')
        : t('trajectory.olderFailed', { message: olderFailure.message });

  /**
   * A span pressed outside the selected time: the selection is dropped so its
   * row can be shown, and the reveal waits for the unfiltered table to render.
   */
  const pendingRevealRef = useRef<string | undefined>(undefined);

  /** A span stands for one row: select it and bring it into view. */
  const selectSpan = useCallback(
    (rowKey: string) => {
      const index = visualRows.findIndex((row) => row.key === rowKey);
      if (index < 0) {
        if (range === undefined) return;
        pendingRevealRef.current = rowKey;
        setRange(undefined);
        selectRow(rowKey);
        return;
      }
      selectRow(rowKey);
      virtualizer.scrollToIndex(index, { align: 'auto' });
    },
    [range, selectRow, setRange, virtualizer, visualRows],
  );

  useLayoutEffect(() => {
    const key = pendingRevealRef.current;
    if (key === undefined) return;
    // One attempt, on the first render after the selection was dropped. A key
    // left waiting would scroll the table to it at some unrelated later
    // change, long after the press that asked for it.
    pendingRevealRef.current = undefined;
    const index = visualRows.findIndex((row) => row.key === key);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [virtualizer, visualRows]);

  // Named the way the row reads, which already says a failed request failed
  // in words — the red of the span is never the only signal.
  const describeSpan = useCallback(
    (span: TimelineSpan) => {
      const parts = [labelOf(span.row, t).text];
      parts.push(formatDuration(span.end - span.start));
      if (span.ttftEnd !== undefined) {
        parts.push(
          t('trajectory.ttft', {
            duration: formatDuration(span.ttftEnd - span.start),
          }),
        );
      }
      return parts.filter(Boolean).join(' · ');
    },
    [t],
  );

  return (
    <div className={styles.panel} data-testid="trajectory-panel">
      <div className={styles.header}>
        <div className={styles.summary}>
          {rangeCounts ? (
            <span data-testid="trajectory-range-status" role="status">
              {t('trajectory.range.status', rangeCounts)}
            </span>
          ) : totals ? (
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
          {range !== undefined && (
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setRange(undefined)}
              title={t('trajectory.range.clear')}
              aria-label={t('trajectory.range.clear')}
              data-testid="trajectory-range-clear"
            >
              <XIcon size={14} strokeWidth={1.6} />
            </button>
          )}
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

      {/* Mounted from the start at a fixed height, whatever it holds: it is a
          flex sibling of the scrolled rows, so a box that appeared or grew
          would move every row under the reader. The no-timing notice lives
          inside it for the same reason. */}
      <TrajectoryOverview
        model={timeline}
        {...(timingAbsent ? { notice: t('trajectory.noTiming') } : {})}
        selectedKey={selectedKey}
        onSelect={selectSpan}
        describe={describeSpan}
        {...(range !== undefined ? { range } : {})}
        onRangeChange={setRange}
      />

      {error !== undefined && (
        <div className={styles.error} role="alert">
          <span>
            {error.kind === 'partial'
              ? t('trajectory.partial')
              : t('trajectory.loadFailed', { message: error.message })}
          </span>
          <button
            type="button"
            className={styles.headerButton}
            onClick={refresh}
            disabled={status === 'loading'}
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      <div className={styles.tableWrap}>
        {visualRows.length === 0 ? (
          // An error with nothing folded is already stated by the alert above;
          // repeating it here as a placeholder would say it twice.
          status === 'error' ? null : (
            <div className={styles.placeholder} role="status">
              {empty
                ? t('trajectory.empty')
                : loadedPages > 0
                  ? t('trajectory.loadingPages', { pages: loadedPages })
                  : t('common.loading')}
            </div>
          )
        ) : (
          <>
            {/* Outside the scrolled box on purpose: inside it, its height
                would offset every virtual row from the coordinates the
                virtualizer computes. And always here, at one fixed height,
                whatever it says: it is a flex sibling of the scrolled box, so
                a bar that came and went with `truncated` would move every row
                the moment a refresh changed its answer. */}
            <div
              className={styles.olderBar}
              role="status"
              data-testid="trajectory-older-bar"
            >
              {olderFailure !== undefined ? (
                <>
                  <span
                    className={`${styles.olderNotice} ${styles.toneError}`}
                    data-testid="trajectory-older-failed"
                    title={olderFailureText}
                  >
                    {olderFailureText}
                  </span>
                  <button
                    type="button"
                    className={styles.headerButton}
                    onClick={() => {
                      if (status !== 'loading') refresh();
                    }}
                    // Not `disabled`: a disabled button drops the focus of a
                    // reader who just pressed it, and this one is pressed
                    // exactly when it is about to go busy.
                    aria-disabled={status === 'loading' ? true : undefined}
                    data-testid="trajectory-older-retry"
                  >
                    {t('common.retry')}
                  </button>
                </>
              ) : truncated ? (
                <span
                  className={styles.olderNotice}
                  data-testid="trajectory-truncated"
                >
                  {t('trajectory.truncated')}
                </span>
              ) : null}
            </div>
            <div
              ref={scrollRef}
              className={styles.scroll}
              role="grid"
              tabIndex={0}
              aria-label={t('trajectory.title')}
              aria-rowcount={visualRows.length}
              aria-activedescendant={
                selectedIndex >= 0 ? rowDomId(selectedIndex) : undefined
              }
              onKeyDown={handleKeyDown}
              onScroll={(event) => {
                scrollTopRef.current = event.currentTarget.scrollTop;
              }}
              data-testid="trajectory-rows"
            >
              <div
                className={styles.virtualBody}
                style={{ height: `${virtualizer.getTotalSize()}px` }}
              >
                {virtualizer.getVirtualItems().map((item) => {
                  const entry = visualRows[item.index]!;
                  return (
                    <div
                      key={item.key}
                      id={rowDomId(item.index)}
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
                          selected={entry.key === selectedKey}
                          onSelect={() => selectRow(entry.key)}
                        />
                      ) : (
                        <RecordRow
                          row={entry.row}
                          selected={entry.key === selectedKey}
                          onSelect={() => selectRow(entry.key)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TurnHeaderRow({
  turn,
  selected,
  onSelect,
}: {
  turn: TrajectoryTurn;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  // A header has no action of its own — it states what the turn cost. The
  // click only moves the selection, which is what every other row does, and
  // deliberately not a <button>: the grid keeps a single tab stop, and a
  // focusable header would let DOM focus and the selection drift apart.
  return (
    <div
      className={`${styles.turnHeader} ${selected ? styles.selected : ''}`}
      onClick={onSelect}
      aria-selected={selected}
      data-selected={selected ? 'true' : undefined}
      role="gridcell"
      data-testid="trajectory-turn"
    >
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
    </div>
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
