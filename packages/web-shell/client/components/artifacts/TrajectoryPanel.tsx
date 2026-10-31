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
  ArrowDownIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  CornerDownRightIcon,
} from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  DaemonTranscriptBlock,
  DaemonTurnUsage,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { isFocusUnclaimed } from '../../utils/dom';
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
import { formatTimelinePoint, TrajectoryOverview } from './TrajectoryOverview';
import { TrajectoryDetail } from './TrajectoryDetail';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../ui/resizable';
import { TrajectoryExecutions } from './TrajectoryExecutions';
import { projectTrajectoryExecutions } from '../../trajectory/project-trajectory-executions';
import { trajectoryLoaderIdentity } from '../../trajectory/transcriptPageLoader';
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
import { TrajectoryToolbar } from './TrajectoryToolbar';
import { TrajectorySummaryBar, compactTokens } from './TrajectorySummaryBar';
import {
  isRetryableFailure,
  trajectoryFailureText,
  trajectoryPillState,
  trajectoryTopBoundary,
  trajectoryWarnings,
} from '../../trajectory/trajectory-status';
import {
  buildTrajectorySearchIndex,
  filterTrajectory,
  type TrajectoryFilter,
} from '../../trajectory/filterTrajectory';

const EMPTY_FILTER: TrajectoryFilter = {
  query: '',
  type: 'all',
  status: 'all',
};
function filtering(filter: TrajectoryFilter) {
  return (
    filter.query.trim() !== '' ||
    filter.type !== 'all' ||
    filter.status !== 'all'
  );
}
function filterSignature(
  filter: TrajectoryFilter,
  range: TimelineRange | undefined,
  mode: TimelineMode,
) {
  return JSON.stringify([
    filter.query.trim().toLowerCase(),
    filter.type,
    filter.status,
    range?.start,
    range?.end,
    mode,
  ]);
}

/** Every row is one line and every row is this tall, turn headers included. */
const ROW_HEIGHT = 34;

/** From this panel width details sit beside the list instead of over it. */
const SIDE_DETAIL_MIN_WIDTH = 960;

export interface TrajectoryPanelProps {
  /**
   * Fetches transcript pages for this tab's session. Absent while a restored
   * tab is waiting to be rewired, which renders as the loading state.
   */
  loadPage?: TrajectoryPageLoader;
  historyGapRevision?: number;
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
  if (status === 'cancelled' || status === 'canceled') return styles.toneMuted;
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

export function TrajectoryPanel({
  loadPage,
  historyGapRevision = 0,
}: TrajectoryPanelProps) {
  const { t, language } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  // The same tier the container queries pick, for the code that has to choose
  // between covering the list and sitting beside it.
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const update = () => setWide(element.clientWidth >= SIDE_DETAIL_MIN_WIDTH);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const committedLoaderRef = useRef(loadPage);
  useLayoutEffect(() => {
    committedLoaderRef.current = loadPage;
  }, [loadPage]);
  const focusRecentExecutions = useCallback(() => {
    if (committedLoaderRef.current !== loadPage) return;
    const section = panelRef.current?.querySelector<HTMLElement>(
      '[data-testid="trajectory-executions"]',
    );
    // The strip is empty once its executions are gone; the records are the
    // nearest place left to land.
    (
      section?.querySelector<HTMLElement>('[role="grid"]') ??
      section?.querySelector<HTMLButtonElement>('button') ??
      scrollRef.current
    )?.focus({ preventScroll: true });
  }, [loadPage]);
  const {
    trajectory,
    lifecycle,
    status,
    error,
    loadedPages,
    windowPages,
    truncated,
    olderFailure,
    refresh: refreshWindow,
    retry,
    older,
    newer,
    mode: windowMode,
    navigationVersion,
    navigationError,
    loadingKind,
    canRefresh,
    canOlder,
    canNewer,
    historyReleased,
  } = useTrajectoryWindow(loadPage);
  const [followState, setFollowState] = useState<{
    loader: typeof loadPage;
    paused: boolean;
    pending?: { of: typeof trajectory };
  }>({ loader: loadPage, paused: false });
  if (followState.loader !== loadPage)
    setFollowState({ loader: loadPage, paused: false });
  const pauseFollowing = useCallback(() => {
    setFollowState((current) =>
      current.loader !== loadPage || (current.paused && !current.pending)
        ? current
        : { loader: loadPage, paused: true },
    );
  }, [loadPage]);
  const previousLive = useRef({ loader: loadPage, status: lifecycle.status });
  useLayoutEffect(() => {
    const previous = previousLive.current;
    previousLive.current = { loader: loadPage, status: lifecycle.status };
    if (
      previous.loader === loadPage &&
      previous.status === 'live' &&
      lifecycle.status !== 'live'
    )
      pauseFollowing();
  }, [loadPage, lifecycle.status, pauseFollowing]);
  const following =
    followState.loader === loadPage &&
    !followState.paused &&
    windowMode === 'latest';
  const returning = followState.loader === loadPage && !!followState.pending;
  const [refreshedGap, setRefreshedGap] = useState({
    loader: loadPage,
    revision: 0,
  });
  const pendingGapRefresh = useRef<
    { revision: number; trajectory: typeof trajectory } | undefined
  >(undefined);
  const refresh = useCallback(() => {
    pendingGapRefresh.current = { revision: historyGapRevision, trajectory };
    refreshWindow();
  }, [historyGapRevision, trajectory, refreshWindow]);
  const returnToLatest = useCallback(() => {
    if (!canRefresh) return;
    setFollowState({
      loader: loadPage,
      paused: true,
      pending: { of: trajectory },
    });
    refresh();
  }, [canRefresh, loadPage, trajectory, refresh]);
  useEffect(() => {
    pendingGapRefresh.current = undefined;
  }, [loadPage]);
  useEffect(() => {
    const pending = pendingGapRefresh.current;
    if (pending && status !== 'loading' && error) {
      pendingGapRefresh.current = undefined;
    } else if (
      pending &&
      status === 'ready' &&
      trajectory !== pending.trajectory
    ) {
      setRefreshedGap({ loader: loadPage, revision: pending.revision });
      pendingGapRefresh.current = undefined;
    }
  }, [status, trajectory, error, loadPage]);
  const historyStale =
    historyGapRevision >
    (refreshedGap.loader === loadPage ? refreshedGap.revision : 0);
  const pendingWindowScrollRef = useRef(false);
  const [windowScope, setWindowScope] = useState({
    loader: loadPage,
    version: navigationVersion,
    selectionLost: false,
  });
  const [executionsUpdated, setExecutionsUpdated] = useState(false);
  // Jump to latest floats over the rows, so it only appears once the reader
  // has moved away from the tail: shown at the tail, it would land under the
  // very click that paused following.
  const [awayFromTail, setAwayFromTail] = useState(false);

  const [filterState, setFilterState] = useState({
    loader: loadPage,
    value: EMPTY_FILTER,
    scope: 0,
  });
  if (filterState.loader !== loadPage) {
    setFilterState({
      loader: loadPage,
      value: EMPTY_FILTER,
      scope: filterState.scope + 1,
    });
  }
  const filter =
    filterState.loader === loadPage ? filterState.value : EMPTY_FILTER;
  const changeFilter = useCallback(
    (value: TrajectoryFilter) => {
      pauseFollowing();
      setFilterState((current) =>
        current.loader === loadPage &&
        current.value.query === value.query &&
        current.value.type === value.type &&
        current.value.status === value.status
          ? current
          : { loader: loadPage, value, scope: current.scope },
      );
    },
    [loadPage, pauseFollowing],
  );
  const clearFilter = useCallback(
    () => changeFilter(EMPTY_FILTER),
    [changeFilter],
  );
  const filterActive = filtering(filter);
  const searchIndex = useMemo(
    () => (trajectory ? buildTrajectorySearchIndex(trajectory) : undefined),
    [trajectory],
  );
  const matches = useMemo(
    () => (searchIndex ? filterTrajectory(searchIndex, filter) : []),
    [searchIndex, filter],
  );
  const matchKeys = useMemo(() => new Set(matches), [matches]);

  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [inspectorSelection, setInspectorSelection] = useState<
    | { of: Trajectory | undefined; loader: TrajectoryPageLoader; key: string }
    | undefined
  >();
  const executions = useMemo(
    () =>
      projectTrajectoryExecutions(
        lifecycle,
        trajectoryLoaderIdentity(loadPage),
      ),
    [lifecycle, loadPage],
  );
  const [executionSelection, setExecutionSelection] = useState<{
    loader: TrajectoryPageLoader | undefined;
    key: string;
  }>();
  const selectedExecution =
    executionSelection?.loader === loadPage
      ? executions.rows.find((row) => row.key === executionSelection?.key)
      : undefined;
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => {
    if (executionSelection && !selectedExecution)
      setExecutionSelection(undefined);
  }, [executionSelection, selectedExecution]);
  useEffect(() => {
    setInspectorOpen(false);
    setInspectorSelection(undefined);
    setExecutionSelection(undefined);
  }, [loadPage]);
  useEffect(() => {
    if (
      inspectorSelection?.of &&
      trajectory &&
      inspectorSelection.of !== trajectory
    )
      setInspectorSelection({ ...inspectorSelection, of: undefined });
  }, [inspectorSelection, trajectory]);
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
      pauseFollowing();
      setRangeState(
        next !== undefined && trajectory !== undefined
          ? { range: next, of: trajectory, mode }
          : undefined,
      );
    },
    [trajectory, mode, pauseFollowing],
  );

  useEffect(() => {
    if (
      rangeState &&
      (rangeState.of !== trajectory || rangeState.mode !== mode)
    )
      setRangeState(undefined);
  }, [rangeState, trajectory, mode]);

  /** Rows running in the selected time, or undefined when nothing is selected. */
  const inRange = useMemo(
    () => (range && timeline ? rowKeysInRange(timeline, range) : undefined),
    [range, timeline],
  );

  const layout = useMemo(
    () => (trajectory ? buildTrajectoryLayout(trajectory) : undefined),
    [trajectory],
  );
  const turnsByKey = useMemo(
    () =>
      new Map(
        (layout?.rows ?? []).flatMap((entry) =>
          entry.kind === 'turn' ? [[entry.key, entry.turn] as const] : [],
        ),
      ),
    [layout],
  );
  const [collapseState, setCollapseState] = useState<{
    of: TrajectoryLayout;
    loader: TrajectoryPageLoader | undefined;
    keys: Set<string>;
  }>();
  const baseCollapsed = useMemo(() => {
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
        layout
          ? { of: layout, loader: loadPage, keys: baseCollapsed }
          : undefined,
      );
  }, [collapseState, layout, loadPage, baseCollapsed]);
  const resultKeys = useMemo(
    () => matches.filter((key) => !inRange || inRange.has(key)),
    [matches, inRange],
  );
  const hits = useMemo(
    () => (filterActive ? new Set(resultKeys) : inRange),
    [filterActive, resultKeys, inRange],
  );
  const signature = filterSignature(filter, range, mode);
  const [temporaryFolds, setTemporaryFolds] = useState<{
    of: Trajectory;
    loader: TrajectoryPageLoader | undefined;
    signature: string;
    overrides: Map<string, boolean>;
  }>();
  const currentOverrides = useMemo(
    () =>
      temporaryFolds?.of === trajectory &&
      temporaryFolds?.loader === loadPage &&
      temporaryFolds?.signature === signature
        ? temporaryFolds.overrides
        : new Map<string, boolean>(),
    [temporaryFolds, trajectory, loadPage, signature],
  );
  useEffect(() => {
    if (
      temporaryFolds &&
      (!filterActive ||
        temporaryFolds.of !== trajectory ||
        temporaryFolds.loader !== loadPage ||
        temporaryFolds.signature !== signature)
    )
      setTemporaryFolds(undefined);
  }, [temporaryFolds, filterActive, trajectory, loadPage, signature]);
  const collapsed = useMemo(() => {
    if (!filterActive) return baseCollapsed;
    const keys = new Set(baseCollapsed);
    for (const key of resultKeys)
      for (const parent of layout?.ancestors.get(key) ?? [])
        keys.delete(parent);
    for (const [key, folded] of currentOverrides) {
      if (folded) keys.add(key);
      else keys.delete(key);
    }
    return keys;
  }, [filterActive, baseCollapsed, resultKeys, layout, currentOverrides]);
  const rangeRows = useMemo(
    () => (layout ? trajectoryRowsInRange(layout, hits) : []),
    [layout, hits],
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

  // The boundary rows sit in the virtualizer's padding rather than in its
  // items, so keyboard selection and the grid's row indices skip them. The top
  // one is always there while records are, so its height never moves a row.
  const bottomBoundary = windowMode === 'history';
  const virtualizer = useVirtualizer({
    count: visualRows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => visualRows[index]?.key ?? index,
    estimateSize: () => ROW_HEIGHT,
    paddingStart: ROW_HEIGHT,
    paddingEnd: bottomBoundary ? ROW_HEIGHT : 0,
    overscan: 12,
  });
  // The first row's start is below the top boundary, so aligning to it would
  // scroll that boundary, and the way to earlier records, out of view.
  const scrollRowIntoView = useCallback(
    (index: number) => {
      if (index === 0) virtualizer.scrollToOffset(0);
      else virtualizer.scrollToIndex(index, { align: 'auto' });
    },
    [virtualizer],
  );

  const toggleGroup = useCallback(
    (key: string) => {
      if (!trajectory || !layout?.groups.has(key)) return;
      pauseFollowing();
      const element = scrollRef.current;
      if (element) {
        // Negative while the top boundary is in view, so restoring the anchor
        // keeps that boundary where it was rather than scrolling past it.
        const top = element.scrollTop - ROW_HEIGHT;
        const index = Math.max(
          0,
          Math.min(visualRows.length - 1, Math.floor(top / ROW_HEIGHT)),
        );
        const entry = visualRows[index];
        if (entry)
          pendingAnchorRef.current = {
            key: entry.key,
            offset: top - index * ROW_HEIGHT,
          };
      }
      const keys = new Set(collapsed);
      if (keys.has(key)) keys.delete(key);
      else keys.add(key);
      if (filterActive) {
        const overrides = new Map(currentOverrides);
        overrides.set(key, keys.has(key));
        setTemporaryFolds({
          of: trajectory,
          loader: loadPage,
          signature,
          overrides,
        });
      } else setCollapseState({ of: layout, loader: loadPage, keys });
      scrollRef.current?.focus({ preventScroll: true });
    },
    [
      trajectory,
      layout,
      visualRows,
      collapsed,
      loadPage,
      filterActive,
      signature,
      currentOverrides,
      pauseFollowing,
    ],
  );

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor || !layout || !scrollRef.current) return;
    pendingAnchorRef.current = undefined;
    const key = visibleTrajectoryAncestor(layout, anchor.key, visibleKeys);
    const index = visualRows.findIndex((entry) => entry.key === key);
    if (index >= 0)
      scrollTo(scrollRef.current, (index + 1) * ROW_HEIGHT + anchor.offset);
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
      scrollRowIntoView(selectedIndex);
    });
    return () => cancelAnimationFrame(frame);
  }, [inspectorOpen, scrollRowIntoView]);

  const moveSelection = useCallback(
    (nextIndex: number) => {
      if (visualRows.length === 0) return;
      pauseFollowing();
      const clamped = Math.min(Math.max(nextIndex, 0), visualRows.length - 1);
      const key = visualRows[clamped]!.key;
      setExecutionSelection(undefined);
      setSelectedKey(key);
      if (inspectorOpen && trajectory && loadPage) {
        setInspectorSelection({ of: trajectory, loader: loadPage, key });
      }
      scrollRowIntoView(clamped);
    },
    [
      inspectorOpen,
      loadPage,
      trajectory,
      scrollRowIntoView,
      visualRows,
      pauseFollowing,
    ],
  );

  /**
   * Pointer selection. The scrolled box is the grid's only tab stop, so a
   * click has to hand focus back to it: the rows themselves are not focusable,
   * and leaving focus on the document would strand the arrow keys.
   */
  const selectRow = useCallback(
    (key: string, focus = true) => {
      pauseFollowing();
      setExecutionSelection(undefined);
      setSelectedKey(key);
      if (inspectorOpen && trajectory && loadPage) {
        setInspectorSelection({ of: trajectory, loader: loadPage, key });
      }
      if (focus) scrollRef.current?.focus({ preventScroll: true });
    },
    [inspectorOpen, trajectory, loadPage, pauseFollowing],
  );

  const openInspector = useCallback(
    (key = selectedKey) => {
      if (!trajectory || !loadPage || !key) return;
      if (!trajectory.rowIndexByKey.has(key) && !turnsByKey.has(key)) return;
      pauseFollowing();
      setExecutionSelection(undefined);
      setInspectorSelection({
        of: trajectory,
        loader: loadPage,
        key,
      });
      setSelectedKey(key);
      setInspectorOpen(true);
    },
    [trajectory, loadPage, selectedKey, pauseFollowing, turnsByKey],
  );

  /** A click selects the row and opens its details. */
  const openRow = useCallback(
    (key: string) => {
      selectRow(key);
      openInspector(key);
    },
    [selectRow, openInspector],
  );

  // Docked, details cover the records and the records are inert beneath them,
  // so focus can only go back once they are live again.
  const recordsRef = useRef<HTMLDivElement>(null);
  const pendingRecordsFocusRef = useRef<(() => void) | undefined>(undefined);
  const detailOpen = inspectorOpen || !!selectedExecution;
  const detailPresentation = wide ? 'side' : 'drill-in';
  const recordsInert = detailOpen && detailPresentation === 'drill-in';
  useLayoutEffect(() => {
    // An attribute rather than the prop: React 18 does not know `inert`.
    recordsRef.current?.toggleAttribute('inert', recordsInert);
    const focus = pendingRecordsFocusRef.current;
    if (recordsInert || !focus) return;
    pendingRecordsFocusRef.current = undefined;
    focus();
  }, [recordsInert, detailOpen]);
  const focusRecords = useCallback((focus: () => void) => {
    pendingRecordsFocusRef.current = focus;
  }, []);
  const focusGrid = useCallback(() => {
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    setInspectorSelection(undefined);
    focusRecords(focusGrid);
  }, [focusRecords, focusGrid]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Keys pressed on a control inside the grid, such as a boundary row's
      // button, belong to that control, except the ones that move through the
      // records: those hand focus back to the grid. A row's own buttons are out
      // of the tab order and only hold focus because they were clicked; the
      // grid keeps their keys.
      if (
        event.target !== event.currentTarget &&
        (event.target as HTMLElement).tabIndex >= 0
      ) {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
          return;
        event.currentTarget.focus({ preventScroll: true });
      }
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
        if (activeVisualKey) openRow(activeVisualKey);
        return;
      }
      if (
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        activeVisualKey &&
        layout?.groups.has(activeVisualKey) &&
        (hiddenCounts.get(activeVisualKey) ?? 0) > 0
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
      } else if (
        event.key === 'PageUp' ||
        event.key === 'PageDown' ||
        event.key === ' '
      ) {
        pauseFollowing();
      }
    },
    [
      moveSelection,
      openRow,
      range,
      selectedIndex,
      setRange,
      visualRows,
      activeVisualKey,
      layout,
      hiddenCounts,
      collapsed,
      toggleGroup,
      pauseFollowing,
    ],
  );

  const summary = useMemo(
    () => (trajectory ? summarizeTrajectory(trajectory) : undefined),
    [trajectory],
  );
  const inspectorCurrent =
    inspectorSelection !== undefined &&
    inspectorSelection.of === trajectory &&
    inspectorSelection.loader === loadPage;
  const inspectorIndex = inspectorCurrent
    ? trajectory?.rowIndexByKey.get(inspectorSelection.key)
    : undefined;
  const inspectorTurn = inspectorCurrent
    ? turnsByKey.get(inspectorSelection.key)
    : undefined;
  const inspectorRow = inspectorTurn
    ? inspectorTurn.userRowKey === undefined
      ? undefined
      : trajectory?.rows[
          trajectory.rowIndexByKey.get(inspectorTurn.userRowKey) ?? -1
        ]
    : inspectorIndex === undefined
      ? undefined
      : trajectory?.rows[inspectorIndex];
  // A refresh that failed keeps the window it replaced, so an empty one is
  // still empty rather than loading.
  const empty =
    (status === 'ready' || (status === 'error' && trajectory !== undefined)) &&
    visualRows.length === 0;
  const timingAbsent =
    trajectory !== undefined &&
    trajectory.rows.length > 0 &&
    !hasAnyTiming(trajectory);
  const allStartsMissing =
    summary !== undefined &&
    summary.plottedCount === 0 &&
    summary.missingStartCount > 0;
  const rangeCounts = useMemo(() => {
    if (!trajectory || (!range && !filterActive && collapsed.size === 0))
      return undefined;
    return {
      shown: visualRows.filter((row) => row.kind === 'row').length,
      total: trajectory.rows.length,
    };
  }, [range, trajectory, visualRows, collapsed, filterActive]);

  const olderFailureText =
    olderFailure === undefined
      ? undefined
      : olderFailure.kind === 'partial'
        ? t('trajectory.olderPartial')
        : olderFailure.kind === 'unreadable'
          ? t('trajectory.olderFailed', { message: olderFailure.message })
          : t(`trajectory.window.${olderFailure.kind}`);

  /**
   * A span pressed outside the selected time: the selection is dropped so its
   * row can be shown, and the reveal waits for the unfiltered table to render.
   */
  const pendingRevealRef = useRef<string | undefined>(undefined);

  if (
    windowScope.loader !== loadPage ||
    windowScope.version !== navigationVersion
  ) {
    const changedSession = windowScope.loader !== loadPage;
    pendingWindowScrollRef.current = !changedSession;
    setWindowScope({
      loader: loadPage,
      version: navigationVersion,
      selectionLost: !changedSession && selectedKey !== undefined,
    });
    setSelectedKey(undefined);
    setInspectorSelection(undefined);
    setInspectorOpen(false);
    setCollapseState(undefined);
    setTemporaryFolds(undefined);
    setRangeState(undefined);
    pendingAnchorRef.current = undefined;
    pendingRevealRef.current = undefined;
    scrollTopRef.current = 0;
    settledOnceRef.current = !changedSession;
  }

  useLayoutEffect(() => {
    if (pendingWindowScrollRef.current && scrollRef.current) {
      pendingWindowScrollRef.current = false;
      virtualizer.scrollToOffset(0);
      scrollTo(scrollRef.current, 0);
    }
  }, [navigationVersion, hasRows, virtualizer, scrollTo]);

  const pendingLatestScroll = useRef(false);
  useEffect(() => {
    const pending = followState.loader === loadPage && followState.pending;
    if (!pending || status === 'loading') return;
    if (error || olderFailure || navigationError) {
      pauseFollowing();
    } else if (
      status === 'ready' &&
      trajectory !== pending.of &&
      windowMode === 'latest'
    ) {
      pendingLatestScroll.current = true;
      setFollowState({ loader: loadPage, paused: false });
      setSelectedKey(undefined);
      setExecutionSelection(undefined);
      setInspectorOpen(false);
      setInspectorSelection(undefined);
      setFilterState((current) => ({ ...current, value: EMPTY_FILTER }));
      setRangeState(undefined);
    }
  }, [
    followState,
    loadPage,
    status,
    error,
    olderFailure,
    navigationError,
    trajectory,
    windowMode,
    pauseFollowing,
  ]);
  useLayoutEffect(() => {
    if (!pendingLatestScroll.current) return;
    pendingLatestScroll.current = false;
    const element = scrollRef.current;
    if (!element) return;
    scrollTo(element, element.scrollHeight);
    // The control that asked for the return may be gone with the state it
    // showed; the records are where the reader lands.
    if (isFocusUnclaimed(element.getRootNode()))
      element.focus({ preventScroll: true });
  }, [following, visualRows, scrollTo]);

  // Moving the window re-renders the boundary rows, and when a filter empties
  // the list they move out of the grid; focus follows the button pressed.
  const pendingBoundaryFocusRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const testId = pendingBoundaryFocusRef.current;
    const panel = panelRef.current;
    if (!testId || !panel || status === 'loading') return;
    pendingBoundaryFocusRef.current = undefined;
    if (!isFocusUnclaimed(panel.getRootNode())) return;
    // At the start of the session there is nothing earlier to load, and the
    // button is gone; the records take focus instead.
    (
      panel.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ??
      scrollRef.current
    )?.focus({ preventScroll: true });
  }, [navigationVersion, status, hasRows]);

  // Measured again whenever the rows grow or the grid comes and goes, since
  // neither fires a scroll event: rows added below a paused reader move the
  // tail away, and a grid replaced by a placeholder has no tail at all.
  const measureTail = useCallback(() => {
    const element = scrollRef.current;
    setAwayFromTail(
      !!element &&
        element.scrollHeight - element.clientHeight - element.scrollTop >
          ROW_HEIGHT,
    );
  }, []);
  const totalSize = virtualizer.getTotalSize();
  const gridShown = visualRows.length > 0;
  useLayoutEffect(() => {
    measureTail();
  }, [measureTail, totalSize, gridShown]);

  /** A span stands for one row: select it and bring it into view. */
  const selectSpan = useCallback(
    (rowKey: string) => {
      const index = visualRows.findIndex((row) => row.key === rowKey);
      if (index < 0 && trajectory && layout) {
        pendingRevealRef.current = rowKey;
        const dropFilter =
          filterActive && !rangeKeys.has(rowKey) && !matchKeys.has(rowKey);
        const dropRange =
          range !== undefined &&
          !rangeKeys.has(rowKey) &&
          !inRange?.has(rowKey);
        if (dropFilter) clearFilter();
        if (dropRange) setRange(undefined);
        const parents = layout.ancestors.get(rowKey) ?? [];
        if (filterActive && !dropFilter) {
          const overrides = new Map(dropRange ? [] : currentOverrides);
          for (const parent of parents) overrides.set(parent, false);
          setTemporaryFolds({
            of: trajectory,
            loader: loadPage,
            signature: filterSignature(
              filter,
              dropRange ? undefined : range,
              mode,
            ),
            overrides,
          });
        } else {
          const keys = new Set(baseCollapsed);
          for (const parent of parents) keys.delete(parent);
          setCollapseState({ of: layout, loader: loadPage, keys });
        }
        selectRow(rowKey);
        return;
      }
      selectRow(rowKey);
      if (index >= 0) scrollRowIntoView(index);
    },
    [
      trajectory,
      layout,
      matchKeys,
      rangeKeys,
      inRange,
      filterActive,
      clearFilter,
      currentOverrides,
      filter,
      range,
      mode,
      baseCollapsed,
      loadPage,
      selectRow,
      setRange,
      scrollRowIntoView,
      visualRows,
    ],
  );

  const navigateResult = useCallback(
    (direction: 1 | -1, nextFilter = filter) => {
      if (!filtering(nextFilter) || !searchIndex || !trajectory || !layout)
        return;
      changeFilter(nextFilter);
      const keys = filterTrajectory(searchIndex, nextFilter).filter(
        (key) => !inRange || inRange.has(key),
      );
      if (!keys.length) return;
      const current = selectedKey ? keys.indexOf(selectedKey) : -1;
      const next =
        current < 0
          ? direction === 1
            ? 0
            : keys.length - 1
          : (current + direction + keys.length) % keys.length;
      const key = keys[next]!;
      const parents = layout.ancestors.get(key) ?? [];
      const nextSignature = filterSignature(nextFilter, range, mode);
      const overrides = new Map(
        nextSignature === signature ? currentOverrides : [],
      );
      for (const parent of parents) overrides.set(parent, false);
      setTemporaryFolds({
        of: trajectory,
        loader: loadPage,
        signature: nextSignature,
        overrides,
      });
      pendingRevealRef.current = key;
      selectRow(key, false);
    },
    [
      searchIndex,
      trajectory,
      layout,
      changeFilter,
      filter,
      inRange,
      selectedKey,
      range,
      mode,
      signature,
      currentOverrides,
      loadPage,
      selectRow,
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
    if (index >= 0) scrollRowIntoView(index);
  }, [scrollRowIntoView, visualRows]);

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

  // The strip stays mounted while it has nothing to show, so the first
  // execution of a session still counts as news; a list that has since
  // emptied has no news left to jump to.
  const newExecutions = executionsUpdated && executions.rows.length > 0;
  const pill = trajectoryPillState({
    windowMode,
    following,
    returning,
    liveStatus: lifecycle.status,
  });
  const warnings = trajectoryWarnings({
    hasTrajectory: trajectory !== undefined,
    error,
    navigationError,
    historyStale,
    // Without a live stream there is no lifecycle to be incomplete: the
    // projection reports that case as incomplete, and saying so on every
    // finished session would be noise.
    lifecycleIncomplete:
      (lifecycle.incomplete && lifecycle.status !== 'unavailable') ||
      lifecycle.truncated,
  });
  const topBoundary = trajectoryTopBoundary({
    truncated,
    // A refresh of the latest window leaves the start of it where it is.
    loading: status === 'loading' && loadingKind !== 'latest',
    olderFailure,
  });
  const rangeLabel =
    range && timeline
      ? `${formatTimelinePoint(timeline, range.start, range.end - range.start, language)} – ${formatTimelinePoint(timeline, range.end, range.end - range.start, language)}`
      : undefined;
  const boundaryRow = (
    // A live region rather than role="status": inside the grid, a role other
    // than row would break the grid's ownership rules.
    <div
      className={styles.boundary}
      aria-live="polite"
      data-testid="trajectory-older-bar"
      data-state={topBoundary}
    >
      {topBoundary === 'failed' ? (
        <>
          <span
            className={`${styles.boundaryText} ${styles.toneError}`}
            data-testid="trajectory-older-failed"
            title={olderFailureText}
          >
            {olderFailureText}
          </span>
          <button
            type="button"
            className={styles.boundaryButton}
            onClick={() => {
              if (status !== 'loading') retry();
            }}
            // Not `disabled`: a disabled button drops the focus of a reader
            // who just pressed it, and this one goes busy as it is pressed.
            aria-disabled={
              status === 'loading' ||
              (olderFailure !== undefined && !isRetryableFailure(olderFailure))
            }
            data-testid="trajectory-older-retry"
          >
            {t('common.retry')}
          </button>
        </>
      ) : topBoundary === 'loading' || topBoundary === 'earlier' ? (
        <>
          <span
            className={styles.boundaryText}
            {...(topBoundary === 'earlier'
              ? { 'data-testid': 'trajectory-truncated' }
              : {})}
          >
            {topBoundary === 'loading'
              ? t('trajectory.loadingPages', { pages: loadedPages })
              : windowMode === 'history'
                ? t('trajectory.window.outside')
                : t('trajectory.boundary.earlier')}
          </span>
          {truncated && (
            <button
              type="button"
              className={styles.boundaryButton}
              aria-disabled={!canOlder}
              onClick={() => {
                if (!canOlder) return;
                pauseFollowing();
                pendingBoundaryFocusRef.current = 'trajectory-window-older';
                older();
              }}
              data-testid="trajectory-window-older"
            >
              {t('trajectory.boundary.loadEarlier')}
            </button>
          )}
        </>
      ) : (
        <span className={styles.boundaryText}>
          {t('trajectory.boundary.start')}
        </span>
      )}
    </div>
  );

  const newerRow = (
    <div className={styles.boundary}>
      <button
        type="button"
        className={styles.boundaryButton}
        aria-disabled={!canNewer}
        onClick={() => {
          if (!canNewer) return;
          pauseFollowing();
          pendingBoundaryFocusRef.current = 'trajectory-window-newer';
          newer();
        }}
        data-testid="trajectory-window-newer"
      >
        {t('trajectory.boundary.newer')}
      </button>
      {/* Newer stops a window short of the latest, at the first bookmark or
          once bookmarks are released, so the way back sits beside it. */}
      <button
        type="button"
        className={styles.boundaryButton}
        aria-disabled={!canRefresh}
        onClick={() => {
          if (!canRefresh) return;
          pendingBoundaryFocusRef.current = 'trajectory-window-latest';
          returnToLatest();
        }}
        data-testid="trajectory-window-latest"
      >
        {t('trajectory.window.return')}
      </button>
      {historyReleased &&
        !canNewer &&
        status !== 'loading' &&
        !navigationError &&
        !error &&
        !olderFailure && (
          <span className={styles.boundaryText}>
            {t('trajectory.window.released')}
          </span>
        )}
    </div>
  );

  const inspectorHidden = inspectorRow && !inspectorTurn;
  const detail = selectedExecution ? (
    <TrajectoryDetail
      key={selectedExecution.key}
      presentation={detailPresentation}
      execution={selectedExecution}
      title={selectedExecution.name}
      onClose={() => {
        setExecutionSelection(undefined);
        focusRecords(focusRecentExecutions);
      }}
      onFocusedUnmount={focusRecentExecutions}
      onLocateExecution={
        selectedExecution.historyRowKey
          ? () => {
              const key = selectedExecution.historyRowKey!;
              selectSpan(key);
              openInspector(key);
            }
          : undefined
      }
    />
  ) : inspectorOpen &&
    inspectorSelection !== undefined &&
    inspectorSelection.loader === loadPage ? (
    <TrajectoryDetail
      presentation={detailPresentation}
      row={inspectorRow}
      turn={inspectorTurn}
      lifecycle={
        inspectorCurrent && inspectorRow && !inspectorTurn
          ? lifecycle.byRowKey.get(inspectorRow.key)
          : undefined
      }
      stale={!inspectorCurrent}
      title={
        inspectorTurn
          ? t(
              inspectorTurn.partial
                ? 'trajectory.turnPartial'
                : 'trajectory.turn',
              {
                index: inspectorTurn.index,
              },
            )
          : inspectorRow
            ? labelOf(inspectorRow, t).text
            : undefined
      }
      hiddenByRange={
        !!(
          range &&
          inspectorHidden &&
          !rangeKeys.has(inspectorRow.key) &&
          !inRange?.has(inspectorRow.key)
        )
      }
      hiddenByFilter={
        !!(
          filterActive &&
          inspectorHidden &&
          !rangeKeys.has(inspectorRow.key) &&
          !matchKeys.has(inspectorRow.key)
        )
      }
      onClearFilter={clearFilter}
      hiddenByCollapse={
        !!(
          inspectorHidden &&
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
      onStep={(direction) => moveSelection(selectedIndex + direction)}
      onFocusedUnmount={focusGrid}
    />
  ) : undefined;

  return (
    <div ref={panelRef} className={styles.panel} data-testid="trajectory-panel">
      <TrajectorySummaryBar
        summary={summary}
        pill={pill}
        onPill={() => {
          if (pill === 'paused' || pill === 'history') returnToLatest();
          else pauseFollowing();
        }}
        warnings={warnings}
        onRetry={retry}
        onRefresh={() => {
          pauseFollowing();
          refresh();
        }}
        onReturnToLatest={returnToLatest}
        canRefresh={canRefresh}
        history={windowMode === 'history'}
        failuresOn={filter.status === 'error'}
        onToggleFailures={() =>
          changeFilter({
            ...filter,
            status: filter.status === 'error' ? 'all' : 'error',
          })
        }
        about={{
          pages: windowPages,
          searchExcluded: searchIndex?.truncatedCount ?? 0,
          executionsOmitted: executions.omitted,
          executionsOutside: lifecycle.outsideWindow.length,
        }}
      />

      {/* Mounted from the start at a fixed height, whatever it holds: it is a
          flex sibling of the scrolled rows, so a box that appeared or grew
          would move every row under the reader. The no-timing notice lives
          inside it for the same reason. */}
      <TrajectoryOverview
        model={timeline}
        viewportControl={{
          ...viewportControl,
          applyViewport: (next) => {
            pauseFollowing();
            viewportControl.applyViewport(next);
          },
        }}
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
        onModeChange={(next) => {
          pauseFollowing();
          setMode(next);
        }}
      />

      <ResizablePanelGroup
        className={styles.split}
        orientation="horizontal"
        data-testid="trajectory-split"
      >
        <ResizablePanel
          id="trajectory-records"
          className={styles.recordsPanel}
          minSize={320}
        >
          <div ref={recordsRef} className={styles.records}>
            {trajectory && trajectory.rows.length > 0 && (
              <TrajectoryToolbar
                key={filterState.scope}
                value={filter}
                onChange={changeFilter}
                onNavigate={navigateResult}
                onClear={clearFilter}
                count={filterActive ? resultKeys.length : 0}
                position={
                  filterActive && selectedKey
                    ? resultKeys.indexOf(selectedKey) + 1
                    : 0
                }
                truncatedCount={searchIndex?.truncatedCount ?? 0}
                {...(rangeLabel !== undefined ? { range: rangeLabel } : {})}
                onClearRange={() => setRange(undefined)}
                {...(rangeCounts
                  ? { status: t('trajectory.range.status', rangeCounts) }
                  : {})}
              />
            )}

            <TrajectoryExecutions
              key={`executions-${filterState.scope}`}
              rows={executions.rows}
              selectedKey={selectedExecution?.key}
              following={following}
              liveStatus={lifecycle.status}
              historySnapshot={trajectory}
              onPause={pauseFollowing}
              onUpdatedChange={setExecutionsUpdated}
              onFocusLost={() =>
                scrollRef.current?.focus({ preventScroll: true })
              }
              onSelect={(key) => {
                pauseFollowing();
                setSelectedKey(undefined);
                setInspectorOpen(false);
                setExecutionSelection({ loader: loadPage, key });
              }}
            />

            <div className={styles.tableWrap}>
              {/* Moving the window drops the selection and closes its
                  details; a reader who cannot see that happen is told here.
                  Outside the grid, which a filter can replace with a
                  placeholder. */}
              <span
                className={styles.srOnly}
                role="status"
                data-testid="trajectory-window-changed"
              >
                {windowScope.selectionLost && !selectedKey
                  ? t('trajectory.window.changed')
                  : ''}
              </span>
              {visualRows.length === 0 ? (
                <>
                  {trajectory && boundaryRow}
                  {status === 'error' && error && !trajectory ? (
                    <div className={styles.placeholder} role="alert">
                      <span>{trajectoryFailureText(error, t)}</span>{' '}
                      {isRetryableFailure(error) && (
                        <button
                          type="button"
                          className={styles.headerButton}
                          onClick={retry}
                        >
                          {t('common.retry')}
                        </button>
                      )}
                    </div>
                  ) : filterActive ? (
                    <div
                      className={styles.placeholder}
                      data-testid="trajectory-filter-empty"
                    >
                      <span>{t('trajectory.filter.empty')}</span>{' '}
                      <button
                        type="button"
                        className={styles.headerButton}
                        onClick={clearFilter}
                      >
                        {t('trajectory.filter.clear')}
                      </button>
                    </div>
                  ) : range !== undefined ? (
                    // Real time keeps the gaps between turns on the axis, and a
                    // stretch dragged inside one has nothing in it. Said here, with
                    // the way back beside it, rather than left as a blank table.
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
                  )}
                  {trajectory && bottomBoundary && newerRow}
                </>
              ) : (
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
                  onWheel={pauseFollowing}
                  onPointerDown={pauseFollowing}
                  onScroll={(event) => {
                    scrollTopRef.current = event.currentTarget.scrollTop;
                    measureTail();
                  }}
                  data-testid="trajectory-rows"
                >
                  <div
                    className={styles.virtualBody}
                    style={{ height: `${virtualizer.getTotalSize()}px` }}
                  >
                    <div className={styles.virtualBoundary}>{boundaryRow}</div>
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
                              onSelect={() => openRow(entry.key)}
                            />
                          ) : (
                            <RecordRow
                              row={entry.row}
                              grouped={
                                (layout?.ancestors.get(entry.key)?.length ??
                                  0) > 1
                              }
                              unresolvedParent={
                                layout?.unresolvedParents.has(entry.key) ??
                                false
                              }
                              fold={
                                layout?.groups.has(entry.key) &&
                                (hiddenCounts.get(entry.key) ?? 0) > 0
                                  ? {
                                      collapsed: collapsed.has(entry.key),
                                      hiddenCount:
                                        hiddenCounts.get(entry.key) ?? 0,
                                      onToggle: () => toggleGroup(entry.key),
                                    }
                                  : undefined
                              }
                              span={spansByKey.get(entry.key)}
                              total={timeline?.total ?? 0}
                              viewport={viewportControl.viewport}
                              range={range}
                              context={!!hits && !hits.has(entry.key)}
                              selected={entry.key === activeVisualKey}
                              onSelect={() => openRow(entry.key)}
                            />
                          )}
                        </div>
                      );
                    })}
                    {bottomBoundary && (
                      <div
                        className={styles.virtualBoundary}
                        style={{
                          transform: `translateY(${virtualizer.getTotalSize() - ROW_HEIGHT}px)`,
                        }}
                      >
                        {newerRow}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {pill === 'paused' && (awayFromTail || newExecutions) && (
                <button
                  type="button"
                  className={styles.jumpLatest}
                  aria-disabled={!canRefresh}
                  onClick={() => {
                    if (canRefresh) returnToLatest();
                  }}
                  data-testid="trajectory-jump-latest"
                >
                  <ArrowDownIcon size={13} aria-hidden="true" />
                  {t('trajectory.jumpLatest')}
                  {newExecutions && (
                    <span
                      className={styles.updatedDot}
                      role="img"
                      aria-label={t('trajectory.jumpLatest.updated')}
                    />
                  )}
                </button>
              )}
            </div>
          </div>
          {detailPresentation === 'drill-in' && detail}
        </ResizablePanel>
        {detailPresentation === 'side' && detailOpen && (
          <>
            <ResizableHandle
              className={styles.splitHandle}
              aria-label={t('trajectory.detail.resize')}
            />
            <ResizablePanel
              id="trajectory-detail-panel"
              className={styles.detailPanel}
              defaultSize="40%"
              minSize={320}
              maxSize="60%"
            >
              {detail}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
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
  // A click selects the turn and opens its details, as on every other row,
  // and is deliberately not a <button>: the grid keeps a single tab stop, and
  // a focusable header would let DOM focus and the selection drift apart.
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
      {collapsed && hiddenCount > 0 && (
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
