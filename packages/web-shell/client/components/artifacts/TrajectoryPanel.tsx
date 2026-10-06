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
import {
  ChevronRightIcon,
  ChevronDownIcon,
  CornerDownRightIcon,
  RefreshCwIcon,
  XIcon,
} from 'lucide-react';
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
  type TimelineMode,
  type TimelineSpan,
} from '../../trajectory/buildTimeline';
import {
  rowKeysInRange,
  type TimelineRange,
} from '../../trajectory/timelineRange';
import { summarizeTrajectory } from '../../trajectory/summarizeTrajectory';
import { TrajectoryOverview } from './TrajectoryOverview';
import { TrajectoryInspector } from './TrajectoryInspector';
import styles from './TrajectoryPanel.module.css';
import {
  buildTrajectoryLayout,
  type TrajectoryLayout,
  trajectoryRowsInRange,
  visibleTrajectoryRows,
  visibleTrajectoryAncestor,
} from '../../trajectory/buildTrajectoryLayout';
import { useTimelineViewport } from '../../trajectory/useTimelineViewport';
import { TrajectoryWaterfallCell } from './TrajectoryWaterfallCell';

/** Every row is one line and every row is this tall, turn headers included. */
const ROW_HEIGHT = 34;

export interface TrajectoryPanelProps {
  /**
   * Fetches transcript pages for this tab's session. Absent while a restored
   * tab is waiting to be rewired, which renders as the loading state.
   */
  loadPage?: TrajectoryPageLoader;
}

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
        text: `${row.block.title || (row.block.toolName ?? '')}${toolStatusTone(row) === styles.toneError ? ` · ${t('trajectory.toolFailed')}` : ''}`,
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
  const [inspectorSelection, setInspectorSelection] = useState<
    { of: Trajectory; loader: TrajectoryPageLoader; key: string } | undefined
  >();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => {
    setInspectorOpen(false);
    setInspectorSelection(undefined);
  }, [loadPage]);
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

  const pendingAnchorRef = useRef<{ key: string; offset: number } | undefined>(
    undefined,
  );
  const [mode, setMode] = useState<TimelineMode>('active');
  const timeline = useMemo(
    () => (trajectory ? buildTimeline(trajectory, { mode }) : undefined),
    [trajectory, mode],
  );

  const viewportControl = useTimelineViewport(timeline);
  const spansByKey = useMemo(
    () => new Map(timeline?.spans.map((span) => [span.row.key, span])),
    [timeline],
  );

  // The selection belongs to the axis it was drawn on. A refresh, another
  // session, or a switch between active and real time lays the axis out
  // afresh, so the same numbers would name a different stretch of the run;
  // holding what the axis was built from alongside the range lets the range
  // lapse in the same render the axis changes, with no frame in which the new
  // table is filtered by the old one. Keyed on the window and the mode — the
  // axis's inputs — rather than on the memoized axis itself, whose identity
  // React keeps as an optimisation, not a promise.
  const [rangeState, setRangeState] = useState<
    { range: TimelineRange; of: Trajectory; mode: TimelineMode } | undefined
  >(undefined);
  const range =
    rangeState !== undefined &&
    rangeState.of === trajectory &&
    rangeState.mode === mode
      ? rangeState.range
      : undefined;
  const setRange = useCallback(
    (next: TimelineRange | undefined) => {
      setRangeState(
        next !== undefined && trajectory !== undefined
          ? { range: next, of: trajectory, mode }
          : undefined,
      );
    },
    [trajectory, mode],
  );

  /** Rows running in the selected time, or undefined when nothing is selected. */
  const inRange = useMemo(
    () => (range && timeline ? rowKeysInRange(timeline, range) : undefined),
    [range, timeline],
  );

  const layout = useMemo(
    () => (trajectory ? buildTrajectoryLayout(trajectory) : undefined),
    [trajectory],
  );
  const [collapseState, setCollapseState] = useState<{
    of: TrajectoryLayout;
    loader: TrajectoryPageLoader | undefined;
    keys: Set<string>;
  }>();
  const collapsed = useMemo(() => {
    if (!layout || !collapseState || collapseState.loader !== loadPage)
      return new Set<string>();
    if (collapseState.of === layout) return collapseState.keys;
    return new Set(
      [...collapseState.keys].filter((key) => {
        const identity = layout.groupIdentities.get(key);
        return (
          identity !== undefined &&
          identity === collapseState.of.groupIdentities.get(key)
        );
      }),
    );
  }, [collapseState, layout, loadPage]);
  useEffect(() => {
    if (
      collapseState &&
      (collapseState.of !== layout || collapseState.loader !== loadPage)
    )
      setCollapseState(
        layout ? { of: layout, loader: loadPage, keys: collapsed } : undefined,
      );
  }, [collapseState, layout, loadPage, collapsed]);
  const rangeRows = useMemo(
    () => (layout ? trajectoryRowsInRange(layout, inRange) : []),
    [layout, inRange],
  );
  const rangeKeys = useMemo(
    () => new Set(rangeRows.map((entry) => entry.key)),
    [rangeRows],
  );
  const visualRows = useMemo(
    () => (layout ? visibleTrajectoryRows(layout, rangeRows, collapsed) : []),
    [layout, rangeRows, collapsed],
  );
  const visibleKeys = useMemo(
    () => new Set(visualRows.map((entry) => entry.key)),
    [visualRows],
  );
  const activeVisualKey =
    layout && selectedKey
      ? visibleTrajectoryAncestor(layout, selectedKey, visibleKeys)
      : undefined;
  const hiddenCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of rangeRows) {
      if (entry.kind !== 'row') continue;
      for (const parent of layout?.ancestors.get(entry.key) ?? [])
        counts.set(parent, (counts.get(parent) ?? 0) + 1);
    }
    return counts;
  }, [layout, rangeRows]);

  const virtualizer = useVirtualizer({
    count: visualRows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => visualRows[index]?.key ?? index,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const toggleGroup = useCallback(
    (key: string) => {
      if (!trajectory || !layout?.groups.has(key)) return;
      const element = scrollRef.current;
      if (element) {
        const index = Math.min(
          visualRows.length - 1,
          Math.floor(element.scrollTop / ROW_HEIGHT),
        );
        const entry = visualRows[index];
        if (entry)
          pendingAnchorRef.current = {
            key: entry.key,
            offset: element.scrollTop - index * ROW_HEIGHT,
          };
      }
      const keys = new Set(collapsed);
      if (keys.has(key)) keys.delete(key);
      else keys.add(key);
      setCollapseState({ of: layout, loader: loadPage, keys });
      scrollRef.current?.focus({ preventScroll: true });
    },
    [trajectory, layout, visualRows, collapsed, loadPage],
  );

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor || !layout || !scrollRef.current) return;
    pendingAnchorRef.current = undefined;
    const key = visibleTrajectoryAncestor(layout, anchor.key, visibleKeys);
    const index = visualRows.findIndex((entry) => entry.key === key);
    if (index >= 0)
      scrollTo(scrollRef.current, index * ROW_HEIGHT + anchor.offset);
  }, [layout, visualRows, visibleKeys, scrollTo]);

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
      activeVisualKey === undefined
        ? -1
        : visualRows.findIndex((row) => row.key === activeVisualKey),
    [activeVisualKey, visualRows],
  );

  const activeIndexRef = useRef(selectedIndex);
  activeIndexRef.current = selectedIndex;
  useLayoutEffect(() => {
    const selectedIndex = activeIndexRef.current;
    if (!inspectorOpen || selectedIndex < 0) return;
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [inspectorOpen, virtualizer]);

  const moveSelection = useCallback(
    (nextIndex: number) => {
      if (visualRows.length === 0) return;
      const clamped = Math.min(Math.max(nextIndex, 0), visualRows.length - 1);
      const key = visualRows[clamped]!.key;
      setSelectedKey(key);
      if (inspectorOpen && trajectory && loadPage) {
        setInspectorSelection({ of: trajectory, loader: loadPage, key });
      }
      virtualizer.scrollToIndex(clamped, { align: 'auto' });
    },
    [inspectorOpen, loadPage, trajectory, virtualizer, visualRows],
  );

  /**
   * Pointer selection. The scrolled box is the grid's only tab stop, so a
   * click has to hand focus back to it: the rows themselves are not focusable,
   * and leaving focus on the document would strand the arrow keys.
   */
  const selectRow = useCallback(
    (key: string) => {
      setSelectedKey(key);
      if (inspectorOpen && trajectory && loadPage) {
        setInspectorSelection({ of: trajectory, loader: loadPage, key });
      }
      scrollRef.current?.focus({ preventScroll: true });
    },
    [inspectorOpen, trajectory, loadPage],
  );

  const openInspector = useCallback(
    (key = selectedKey) => {
      if (!trajectory || !loadPage || !key) return;
      if (!trajectory.rowIndexByKey.has(key)) return;
      setInspectorSelection({
        of: trajectory,
        loader: loadPage,
        key,
      });
      setSelectedKey(key);
      setInspectorOpen(true);
    },
    [trajectory, loadPage, selectedKey],
  );

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    setInspectorSelection(undefined);
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
      if (event.key === 'Enter') {
        event.preventDefault();
        if (activeVisualKey) {
          selectRow(activeVisualKey);
          openInspector(activeVisualKey);
        }
        return;
      }
      if (
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        activeVisualKey &&
        layout?.groups.has(activeVisualKey)
      ) {
        const wantsCollapsed = event.key === 'ArrowLeft';
        if (collapsed.has(activeVisualKey) !== wantsCollapsed) {
          event.preventDefault();
          toggleGroup(activeVisualKey);
        }
        return;
      }
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
    [
      moveSelection,
      openInspector,
      selectRow,
      range,
      selectedIndex,
      setRange,
      visualRows,
      activeVisualKey,
      layout,
      collapsed,
      toggleGroup,
    ],
  );

  const summary = useMemo(
    () => (trajectory ? summarizeTrajectory(trajectory) : undefined),
    [trajectory],
  );
  const selectedEntry = layout?.rows.find((entry) => entry.key === selectedKey);
  const inspectorCurrent =
    inspectorSelection !== undefined &&
    inspectorSelection.of === trajectory &&
    inspectorSelection.loader === loadPage;
  const inspectorIndex = inspectorCurrent
    ? trajectory?.rowIndexByKey.get(inspectorSelection.key)
    : undefined;
  const inspectorRow =
    inspectorIndex === undefined ? undefined : trajectory?.rows[inspectorIndex];
  const selectedTitle = selectedEntry
    ? selectedEntry.kind === 'turn'
      ? t('trajectory.turn', { index: selectedEntry.turn.index })
      : labelOf(selectedEntry.row, t).text
    : t('trajectory.selected.none');
  const selectedTiming =
    selectedEntry?.kind === 'row' &&
    (selectedEntry.row.kind === 'request' || selectedEntry.row.kind === 'tool')
      ? selectedEntry.row.timing
      : undefined;
  const selectedTtft =
    selectedEntry?.kind === 'row' && selectedEntry.row.kind === 'request'
      ? selectedTiming?.ttftMs
      : undefined;
  const selectedMeta = selectedEntry
    ? selectedEntry.kind === 'turn'
      ? t('trajectory.turnSummary', {
          requests: selectedEntry.turn.requestCount,
          tools: selectedEntry.turn.toolCount,
          duration:
            selectedEntry.turn.requestCount > 0
              ? formatDuration(selectedEntry.turn.requestMs)
              : t('trajectory.unrecorded'),
        })
      : selectedEntry.row.kind === 'request' ||
          selectedEntry.row.kind === 'tool'
        ? `${selectedTiming === undefined ? t('trajectory.unrecorded') : formatDuration(selectedTiming.durationMs)}${selectedTtft === undefined ? '' : ` · ${t('trajectory.ttft', { duration: formatDuration(selectedTtft) })}`}`
        : t('trajectory.selected.noTiming')
    : undefined;

  const empty = status === 'ready' && visualRows.length === 0;
  const timingAbsent =
    trajectory !== undefined &&
    trajectory.rows.length > 0 &&
    !hasAnyTiming(trajectory);
  const allStartsMissing =
    summary !== undefined &&
    summary.plottedCount === 0 &&
    summary.missingStartCount > 0;
  const rangeCounts = useMemo(() => {
    if (!trajectory || (!range && collapsed.size === 0)) return undefined;
    return {
      shown: visualRows.filter((row) => row.kind === 'row').length,
      total: trajectory.rows.length,
    };
  }, [range, trajectory, visualRows, collapsed]);

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
      if (index < 0 && trajectory && layout) {
        pendingRevealRef.current = rowKey;
        if (!rangeKeys.has(rowKey)) setRange(undefined);
        const keys = new Set(collapsed);
        for (const parent of layout.ancestors.get(rowKey) ?? [])
          keys.delete(parent);
        setCollapseState({ of: layout, loader: loadPage, keys });
        selectRow(rowKey);
        return;
      }
      selectRow(rowKey);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
    },
    [
      trajectory,
      layout,
      rangeKeys,
      collapsed,
      loadPage,
      selectRow,
      setRange,
      virtualizer,
      visualRows,
    ],
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
      const startedAt =
        span.row.kind === 'request' || span.row.kind === 'tool'
          ? span.row.timing?.startedAt
          : undefined;
      if (startedAt !== undefined) {
        parts.push(
          `${new Date(startedAt).toLocaleString()}–${new Date(startedAt + span.end - span.start).toLocaleString()}`,
        );
      }
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
          {summary ? (
            <span data-testid="trajectory-totals">
              {t('trajectory.totals', {
                turns: summary.turnCount,
                requests: summary.requestCount,
                tools: summary.toolCount,
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

      <div className={styles.overviewMetrics} data-testid="trajectory-metrics">
        {(
          [
            ['elapsed', summary?.elapsedMs],
            ['active', summary?.activeMs],
            ['main', summary?.mainRequestMs],
          ] as const
        ).map(([key, value]) => (
          <div className={styles.metric} key={key}>
            <span>{t(`trajectory.metric.${key}`)}</span>
            <strong
              aria-label={
                value === undefined ? t('trajectory.unrecorded') : undefined
              }
              title={
                value === undefined ? t('trajectory.unrecorded') : undefined
              }
            >
              {value === undefined ? '—' : formatDuration(value)}
            </strong>
          </div>
        ))}
        <div
          className={styles.failureCounts}
          data-has-failures={
            summary && summary.requestFailures + summary.toolFailures > 0
              ? 'true'
              : undefined
          }
        >
          {summary
            ? t('trajectory.failures', {
                requests: summary.requestFailures,
                tools: summary.toolFailures,
              })
            : '—'}
        </div>
        <details className={styles.metricHelp}>
          <summary>{t('trajectory.metric.help')}</summary>
          <div className={styles.metricHelpContent}>
            <p>{t('trajectory.metric.scope')}</p>
            <p>{t('trajectory.metric.elapsed.help')}</p>
            <p>{t('trajectory.metric.active.help')}</p>
            <p>{t('trajectory.metric.main.help')}</p>
            <p>{t('trajectory.metric.missing.help')}</p>
          </div>
        </details>
      </div>

      {/* Mounted from the start at a fixed height, whatever it holds: it is a
          flex sibling of the scrolled rows, so a box that appeared or grew
          would move every row under the reader. The no-timing notice lives
          inside it for the same reason. */}
      <TrajectoryOverview
        model={timeline}
        viewportControl={viewportControl}
        {...(timingAbsent || allStartsMissing
          ? {
              notice: t(
                allStartsMissing ? 'trajectory.noStart' : 'trajectory.noTiming',
              ),
            }
          : {})}
        selectedKey={selectedKey}
        onSelect={selectSpan}
        describe={describeSpan}
        {...(range !== undefined ? { range } : {})}
        onRangeChange={setRange}
        onModeChange={setMode}
      />

      <div className={styles.context}>
        <div className={styles.selectedLine}>
          <div
            className={styles.selectedInfo}
            data-testid="trajectory-selected"
            aria-live="polite"
          >
            <span className={styles.selectedLabel}>
              {t('trajectory.selected.label')}
            </span>
            <span className={styles.selectedName} title={selectedTitle}>
              {selectedTitle}
            </span>
            {selectedMeta && (
              <span className={styles.selectedMeta} title={selectedMeta}>
                {selectedMeta}
              </span>
            )}
          </div>
          <button
            type="button"
            className={styles.detailsButton}
            onClick={() => openInspector()}
            disabled={
              !trajectory ||
              !loadPage ||
              !selectedKey ||
              !trajectory.rowIndexByKey.has(selectedKey)
            }
          >
            {t('trajectory.inspector.open')}
            <ChevronRightIcon size={13} aria-hidden="true" />
          </button>
        </div>
        <div
          className={styles.contextNotice}
          data-testid="trajectory-context-notice"
          title={[
            summary?.missingStartCount
              ? t('trajectory.missingStart', {
                  count: summary.missingStartCount,
                })
              : '',
            summary?.missingTimingCount
              ? t('trajectory.missingTiming', {
                  count: summary.missingTimingCount,
                })
              : '',
            truncated ? t('trajectory.truncated') : '',
            error && trajectory ? t('trajectory.refreshStale') : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          {rangeCounts && (
            <span data-testid="trajectory-range-status" role="status">
              {t('trajectory.range.status', rangeCounts)}
            </span>
          )}
          {rangeCounts ? ' · ' : ''}
          {[
            olderFailureText,
            error && trajectory ? t('trajectory.refreshStale') : '',
            truncated && !olderFailureText ? t('trajectory.truncated') : '',
            summary &&
            (summary.missingStartCount > 0 || summary.missingTimingCount > 0)
              ? t('trajectory.unplotted', {
                  starts: summary.missingStartCount,
                  timing: summary.missingTimingCount,
                })
              : '',
          ]
            .filter(Boolean)
            .join(' · ') || (rangeCounts ? '' : '\u00a0')}
        </div>
      </div>
      <div className={styles.errorSlot}>
        {error !== undefined && (
          <div className={styles.error} role="alert">
            <span>
              {trajectory ? `${t('trajectory.refreshStale')} · ` : ''}
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
      </div>

      <div
        className={`${styles.tableWrap} ${inspectorOpen ? styles.tableWrapWithInspector : ''}`}
      >
        {visualRows.length === 0 ? (
          // An error with nothing folded is already stated by the alert above;
          // repeating it here as a placeholder would say it twice.
          status === 'error' ? null : range !== undefined ? (
            // Real time keeps the gaps between turns on the axis, and a
            // stretch dragged inside one has nothing in it. Said here, with
            // the way back beside it, rather than left as a blank table. Not
            // a live region: the header's row count, which changes in the
            // same render, already says it, and two would say it twice.
            <div
              className={styles.placeholder}
              data-testid="trajectory-range-empty"
            >
              <span>{t('trajectory.range.empty')}</span>{' '}
              <button
                type="button"
                className={styles.headerButton}
                onClick={() => setRange(undefined)}
              >
                {t('trajectory.range.clear')}
              </button>
            </div>
          ) : (
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
                virtualizer
                  .getVirtualItems()
                  .some((item) => item.index === selectedIndex)
                  ? rowDomId(selectedIndex)
                  : undefined
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
                          prompt={
                            entry.turn.userRowKey
                              ? trajectory?.rows[
                                  trajectory.rowIndexByKey.get(
                                    entry.turn.userRowKey,
                                  ) ?? -1
                                ]
                              : undefined
                          }
                          collapsed={collapsed.has(entry.key)}
                          hiddenCount={hiddenCounts.get(entry.key) ?? 0}
                          onToggle={() => toggleGroup(entry.key)}
                          selected={entry.key === activeVisualKey}
                          onSelect={() => selectRow(entry.key)}
                        />
                      ) : (
                        <RecordRow
                          row={entry.row}
                          grouped={
                            (layout?.ancestors.get(entry.key)?.length ?? 0) > 1
                          }
                          unresolvedParent={
                            layout?.unresolvedParents.has(entry.key) ?? false
                          }
                          fold={
                            layout?.groups.has(entry.key)
                              ? {
                                  collapsed: collapsed.has(entry.key),
                                  hiddenCount: hiddenCounts.get(entry.key) ?? 0,
                                  onToggle: () => toggleGroup(entry.key),
                                }
                              : undefined
                          }
                          span={spansByKey.get(entry.key)}
                          total={timeline?.total ?? 0}
                          viewport={viewportControl.viewport}
                          range={range}
                          context={!!inRange && !inRange.has(entry.key)}
                          selected={entry.key === activeVisualKey}
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
      {inspectorOpen &&
        inspectorSelection !== undefined &&
        inspectorSelection.loader === loadPage && (
          <TrajectoryInspector
            row={inspectorRow}
            stale={!inspectorCurrent}
            turnSelected={selectedEntry?.kind === 'turn'}
            title={inspectorRow ? labelOf(inspectorRow, t).text : undefined}
            hiddenByRange={
              !!(range && inspectorRow && !rangeKeys.has(inspectorRow.key))
            }
            hiddenByCollapse={
              !!(
                inspectorRow &&
                layout?.ancestors
                  .get(inspectorRow.key)
                  ?.some((key) => collapsed.has(key))
              )
            }
            onReveal={() => {
              if (inspectorRow) selectSpan(inspectorRow.key);
            }}
            onClearRange={() => setRange(undefined)}
            onClose={closeInspector}
          />
        )}
    </div>
  );
}

function TurnHeaderRow({
  turn,
  prompt,
  collapsed,
  hiddenCount,
  onToggle,
  selected,
  onSelect,
}: {
  turn: TrajectoryTurn;
  prompt?: TrajectoryRow;
  collapsed: boolean;
  hiddenCount: number;
  onToggle: () => void;
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
      <FoldButton
        collapsed={collapsed}
        name={t('trajectory.turn', { index: turn.index })}
        onToggle={onToggle}
      />
      <span className={styles.turnTitle}>
        {turn.partial
          ? t('trajectory.turnPartial', { index: turn.index })
          : t('trajectory.turn', { index: turn.index })}
      </span>
      {prompt?.kind === 'user' && (
        <span
          className={styles.turnPrompt}
          title={firstLine(prompt.block.text)}
        >
          {firstLine(prompt.block.text).slice(0, 160)}
        </span>
      )}
      {collapsed && (
        <span className={styles.foldCount}>
          {t('trajectory.collapsed', { count: hiddenCount })}
        </span>
      )}
      <span className={styles.turnSummary}>
        {t('trajectory.turnSummary', {
          requests: turn.requestCount,
          tools: turn.toolCount,
          duration:
            turn.requestCount > 0 ? formatDuration(turn.requestMs) : '—',
        })}
      </span>
    </div>
  );
}

function RecordRow({
  row,
  grouped,
  unresolvedParent,
  fold,
  span,
  total,
  viewport,
  range,
  context,
  selected,
  onSelect,
}: {
  row: TrajectoryRow;
  grouped: boolean;
  unresolvedParent: boolean;
  fold?: { collapsed: boolean; hiddenCount: number; onToggle: () => void };
  span?: TimelineSpan;
  total: number;
  viewport?: { start: number; end: number };
  range?: TimelineRange;
  context: boolean;
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
      data-grouped={grouped || undefined}
      data-context={context || undefined}
      data-row-key={row.key}
    >
      {fold ? (
        <FoldButton
          collapsed={fold.collapsed}
          name={label.text}
          onToggle={fold.onToggle}
        />
      ) : (
        <span className={styles.foldSpacer} />
      )}
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
      {unresolvedParent && (
        <span
          className={styles.parentNotice}
          title={t('trajectory.parentUnresolved')}
        >
          {t('trajectory.parentUnresolved')}
        </span>
      )}
      {context && (
        <span className={styles.foldCount}>{t('trajectory.contextRow')}</span>
      )}
      {fold?.collapsed && (
        <span className={styles.foldCount}>
          {t('trajectory.collapsed', { count: fold.hiddenCount })}
        </span>
      )}
      <span className={styles.waterfallSlot}>
        <TrajectoryWaterfallCell
          span={span}
          total={total}
          viewport={viewport}
          range={range}
          title={metrics.join(' · ')}
        />
      </span>
      <span
        className={styles.rowMetrics}
        data-testid="trajectory-row-metrics"
        title={metrics.length > 0 ? metrics.join(' · ') : undefined}
      >
        {metrics.length > 0 ? metrics.join(' · ') : '—'}
      </span>
    </div>
  );
}

function FoldButton({
  collapsed,
  name,
  onToggle,
}: {
  collapsed: boolean;
  name: string;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      tabIndex={-1}
      className={styles.foldButton}
      aria-expanded={!collapsed}
      aria-label={t(collapsed ? 'trajectory.expand' : 'trajectory.collapse', {
        name,
      })}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {collapsed ? (
        <ChevronRightIcon size={13} aria-hidden="true" />
      ) : (
        <ChevronDownIcon size={13} aria-hidden="true" />
      )}
    </button>
  );
}
