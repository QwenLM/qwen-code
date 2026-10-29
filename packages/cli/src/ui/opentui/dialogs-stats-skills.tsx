/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI-native Stats and Skills dialogs (parity follow-up to #8677).
 * The Stats dialog is a faithful port of the ink `StatsDialog` Session tab
 * (ui/components/StatsSessionTab.tsx) driven by the real
 * `uiTelemetryService` metrics + `computeSessionStats`, so `/stats` shows the
 * same numbers/sections as the original. Tab/shift+tab switch, Esc closes.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  useRenderer,
  useKeyboard,
  useTerminalDimensions,
} from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { uiTelemetryService } from '@qwen-code/qwen-code-core/telemetry/uiTelemetry.js';
import { computeSessionStats } from '../utils/computeStats.js';
import { formatDuration } from '../utils/formatters.js';
import {
  getStatusColor,
  TOOL_SUCCESS_RATE_HIGH,
  TOOL_SUCCESS_RATE_MEDIUM,
} from '../utils/displayUtils.js';
import { fmtTokens, getSeriesColors } from '../components/stats-helpers.js';
import { ICON } from '../constants.js';
import { toOriginalKey } from './key-map.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import { C } from './theme.js';
import { scrollDialogLayout } from './dialogs-core.js';
import { dialogAreaWidth } from './dialogs-shared.js';
import { getCachedStringWidth, truncateToWidth } from '../utils/textUtils.js';

/** Close the dialog on a raw Escape, like the other dialog hosts. */
function useEscToClose(onClose: () => void, enabled: boolean) {
  const renderer = useRenderer();
  useLayoutEffect(() => {
    if (!enabled) return;
    const onRawInput = (sequence: string): boolean => {
      if (sequence !== '\x1b') return false;
      onClose();
      return true;
    };
    renderer.addInputHandler(onRawInput);
    return () => renderer.removeInputHandler(onRawInput);
  }, [renderer, onClose, enabled]);
  // Fallback: also close via the parsed-key path in case the lone-ESC raw
  // sequence is swallowed by the input parser.
  useKeyboard((key) => {
    if (!enabled) return;
    if (toOriginalKey(key).name === 'escape') onClose();
  });
}

const LABEL_W = 28;

const Row = ({ label, children }: { label: string; children?: ReactNode }) => (
  <box flexDirection="row">
    <box width={LABEL_W}>
      <text fg={C.dim}>{label}</text>
    </box>
    <box flexGrow={1} flexDirection="row">
      {children}
    </box>
  </box>
);

const SubRow = ({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}) => (
  <box flexDirection="row" paddingLeft={2}>
    <box width={26}>
      <text fg={C.dim}>{`» ${label}`}</text>
    </box>
    <box flexGrow={1} flexDirection="row">
      {children}
    </box>
  </box>
);

// A title's blank row is a spacer box, not a marginTop: with a one-row
// scrollbox viewport the renderer leaves a child's margin out of the content
// height, so three margins made the scroll range three rows short and the
// Tokens section never painted at any scroll offset.
const SectionTitle = ({ children }: { children?: ReactNode }) => (
  <box flexDirection="column">
    <box height={1} />
    <text fg={C.text} attributes={1}>
      {children}
    </text>
  </box>
);

type StatsTabName = 'session' | 'activity' | 'efficiency';
const TABS: Array<{ name: StatsTabName; label: string }> = [
  { name: 'session', label: 'Session' },
  { name: 'activity', label: 'Activity' },
  { name: 'efficiency', label: 'Efficiency' },
];

/**
 * The Stats frame's rows outside the scrolled body: borders (2), vertical
 * padding (2), tab bar (1), spacer (1) and the footer hint with its margin (2),
 * the same eight rows ink's `SESSION_CHROME_ROWS` charges. The tab bar and
 * the hint are clipped to one row at every width (`statsTabRuns`, below), so
 * the flat count stays true where a wrapping run would have grown the frame.
 */
export const STATS_FIXED_ROWS = 8;

/**
 * The standalone frame's layout for a popup region of the given height, by
 * the read-only scroll dialogs' shared rule: normal chrome while the region
 * pays for it and at least one body row, compact chrome (no padding, tab bar
 * or hint; the border only from three rows) otherwise, so the unshrinkable
 * frame is never taller than the region. Without a region the body is
 * unbounded, as the Settings embed renders it with no scrollbox.
 */
function statsDialogLayout(regionHeight: number | undefined) {
  return scrollDialogLayout(
    regionHeight,
    STATS_FIXED_ROWS,
    Number.MAX_SAFE_INTEGER,
  );
}

/** Body rows the region leaves after the chrome its layout keeps. */
export function computeStatsBodyRows(regionHeight: number): number {
  return statsDialogLayout(regionHeight).bodyRows;
}

/**
 * The tab labels as the one-row tab bar paints them in `contentWidth`
 * columns: each run is clipped to what the row has left after the runs and
 * the one-column gaps before it, and a run with no column left is dropped
 * with its gap, so the bar never wraps at a narrow width.
 */
export function statsTabRuns(contentWidth: number): string[] {
  let left = contentWidth;
  return TABS.map((t, i) => {
    const gap = i === 0 ? 0 : 1;
    const run = truncateToWidth(` ${t.label} `, Math.max(0, left - gap));
    left -= run ? gap + getCachedStringWidth(run) : 0;
    return run;
  });
}

export function OpenTuiStatsDialog(props: {
  config: Config | null | undefined;
  onClose: () => void;
  /** Embedded hosts pass false while their own focus zone owns the keys. */
  isFocused?: boolean;
  /**
   * The popup region's row budget. When set, the tab body scrolls inside
   * what the region leaves after the frame, with up/down/pageup/pagedown;
   * embedded hosts leave it unset because they use the up key to return to
   * their own tab bar.
   */
  availableTerminalHeight?: number;
}) {
  const { config, onClose, isFocused = true } = props;
  const regionHeight = clampDialogHeight(props.availableTerminalHeight);
  const layout = statsDialogLayout(regionHeight);
  const bodyRows = regionHeight === undefined ? undefined : layout.bodyRows;
  // Columns inside the frame: the popup area minus its two border and four
  // padding columns, as the skills frame below computes its own. Embedded in
  // Settings (no budget) the frame sits inside that dialog's own border and
  // padding, four columns more.
  const { width } = useTerminalDimensions();
  const contentWidth = Math.max(
    1,
    dialogAreaWidth(width) - (regionHeight === undefined ? 10 : 6),
  );
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  // Rows the body wants, reported by layout; 0 until the first layout pass.
  const [contentRows, setContentRows] = useState(0);
  // Advertise scrolling only when the viewport can actually move.
  const canScroll = bodyRows !== undefined && contentRows > bodyRows;
  const [tab, setTabState] = useState<StatsTabName>('session');
  // A held Tab hands the whole burst to the handler from the last render, so
  // the cycle must read where the previous key of the burst landed.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const setTab = (next: StatsTabName) => {
    tabRef.current = next;
    setTabState(next);
    scrollRef.current?.scrollTo(0);
  };
  // Re-render on every telemetry update so stats stay live while the dialog
  // is open (ink re-renders via SessionStatsProvider's update event).
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const handler = () => forceUpdate((n) => n + 1);
    uiTelemetryService.on('update', handler);
    return () => {
      uiTelemetryService.off('update', handler);
    };
  }, []);
  useEscToClose(onClose, isFocused);
  useKeyboard((key) => {
    if (!isFocused) return;
    const original = toOriginalKey(key);
    if (original.name === 'tab') {
      const order = TABS.map((t) => t.name);
      const idx = order.indexOf(tabRef.current);
      setTab(
        order[(idx + (original.shift ? -1 : 1) + order.length) % order.length],
      );
      return;
    }
    if (bodyRows === undefined) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const page = Math.max(1, bodyRows - 1);
    switch (original.name) {
      case 'up':
        scroller.scrollBy(-1);
        break;
      case 'down':
        scroller.scrollBy(1);
        break;
      case 'pageup':
        scroller.scrollBy(-page);
        break;
      case 'pagedown':
        scroller.scrollBy(page);
        break;
      default:
        break;
    }
  });

  const sessionId = config?.getSessionId?.();
  const metrics = sessionId
    ? uiTelemetryService.getMetricsForSession(sessionId)
    : uiTelemetryService.getMetrics();
  const computed = computeSessionStats(metrics);
  const wallDuration =
    Date.now() - uiTelemetryService.getSessionStartTime().getTime();

  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  for (const m of Object.values(metrics.models)) {
    totalInput += m.tokens.prompt;
    totalOutput += m.tokens.candidates;
    totalCached += m.tokens.cached;
  }
  const cacheRate = totalInput > 0 ? (totalCached / totalInput) * 100 : 0;
  const generation = metrics.generation;
  const lastGeneration = generation?.last;
  const lastTps =
    lastGeneration && lastGeneration.generationDurationMs > 0
      ? lastGeneration.outputTokens /
        (lastGeneration.generationDurationMs / 1000)
      : undefined;
  const averageTtft =
    generation && generation.timedRequests > 0
      ? generation.totalTtftMs / generation.timedRequests
      : undefined;
  const sessionTps =
    generation && generation.totalGenerationDurationMs > 0
      ? generation.totalThroughputOutputTokens /
        (generation.totalGenerationDurationMs / 1000)
      : undefined;

  const successColor = getStatusColor(computed.successRate, {
    green: TOOL_SUCCESS_RATE_HIGH,
    yellow: TOOL_SUCCESS_RATE_MEDIUM,
  });
  const SERIES_COLORS = getSeriesColors();

  const body =
    tab !== 'session' ? (
      <box flexDirection="column">
        <SectionTitle>
          {tab === 'activity'
            ? 'Activity (this session)'
            : 'Efficiency (this session)'}
        </SectionTitle>
        <Row label="Requests:">
          <text fg={C.text}>
            {Object.values(metrics.models)
              .reduce((s, m) => s + m.api.totalRequests, 0)
              .toLocaleString()}
          </text>
        </Row>
        <Row label="Input:">
          <text fg={C.yellow}>{totalInput.toLocaleString()}</text>
        </Row>
        <Row label="Output:">
          <text fg={C.yellow}>{totalOutput.toLocaleString()}</text>
        </Row>
        {totalCached > 0 && (
          <Row label="Cached:">
            <text fg={C.green}>
              {`${totalCached.toLocaleString()} (${cacheRate.toFixed(1)}%)`}
            </text>
          </Row>
        )}
        <SectionTitle>Models</SectionTitle>
        {Object.entries(metrics.models).map(([name, m], i) => (
          <box key={name} flexDirection="row">
            <text fg={SERIES_COLORS[i % SERIES_COLORS.length]}>
              {`${ICON.CIRCLE_FILLED} `}
            </text>
            <text fg={C.text}>{`${name} `}</text>
            <text fg={C.dim}>
              {`${m.api.totalRequests} reqs · in=${fmtTokens(m.tokens.prompt)} · out=${fmtTokens(m.tokens.candidates)}`}
            </text>
          </box>
        ))}
      </box>
    ) : (
      <box flexDirection="column">
        <Row label="Session ID:">
          <text fg={C.text}>{sessionId ?? 'n/a'}</text>
        </Row>

        <SectionTitle>Interaction Summary</SectionTitle>
        <Row label="Tool Calls:">
          <box flexDirection="row">
            <text fg={C.text}>{`${metrics.tools.totalCalls} ( `}</text>
            <text fg={C.green}>{`✓ ${metrics.tools.totalSuccess}`}</text>
            <text fg={C.text}> </text>
            <text fg={C.red}>{`✗ ${metrics.tools.totalFail}`}</text>
            <text fg={C.text}>{' )'}</text>
          </box>
        </Row>
        <Row label="Success Rate:">
          <text fg={successColor}>{`${computed.successRate.toFixed(1)}%`}</text>
        </Row>
        {(metrics.files.totalLinesAdded > 0 ||
          metrics.files.totalLinesRemoved > 0) && (
          <Row label="Code Changes:">
            <box flexDirection="row">
              <text fg={C.green}>{`+${metrics.files.totalLinesAdded}`}</text>
              <text fg={C.text}> </text>
              <text fg={C.red}>{`-${metrics.files.totalLinesRemoved}`}</text>
            </box>
          </Row>
        )}

        <SectionTitle>Performance</SectionTitle>
        <Row label="Wall Time:">
          <text fg={C.text}>{formatDuration(wallDuration)}</text>
        </Row>
        <Row label="Agent Active:">
          <text fg={C.text}>{formatDuration(computed.agentActiveTime)}</text>
        </Row>
        <SubRow label="API Time:">
          <box flexDirection="row">
            <text fg={C.text}>{formatDuration(computed.totalApiTime)}</text>
            <text
              fg={C.dim}
            >{` (${computed.apiTimePercent.toFixed(1)}%)`}</text>
          </box>
        </SubRow>
        <SubRow label="Tool Time:">
          <box flexDirection="row">
            <text fg={C.text}>{formatDuration(computed.totalToolTime)}</text>
            <text
              fg={C.dim}
            >{` (${computed.toolTimePercent.toFixed(1)}%)`}</text>
          </box>
        </SubRow>

        {lastGeneration && (
          <box flexDirection="column">
            <SectionTitle>{`Generation Metrics (Latest Request)`}</SectionTitle>
            <Row label="Model:">
              <text fg={C.text}>{lastGeneration.model}</text>
            </Row>
            <Row label="TTFT:">
              <text fg={C.text}>{formatDuration(lastGeneration.ttftMs)}</text>
            </Row>
            <Row label="Generation Time:">
              <text fg={C.text}>
                {formatDuration(lastGeneration.generationDurationMs)}
              </text>
            </Row>
            <Row label="Output Tokens:">
              <text fg={C.text}>
                {lastGeneration.outputTokens.toLocaleString()}
              </text>
            </Row>
            <Row label="TPS:">
              <text fg={C.text}>
                {lastTps === undefined ? '—' : `${lastTps.toFixed(1)} tok/s`}
              </text>
            </Row>
            <SubRow label="Requests:">
              <text fg={C.text}>{generation?.timedRequests}</text>
            </SubRow>
            <SubRow label="Average TTFT:">
              <text fg={C.text}>
                {averageTtft === undefined ? '—' : formatDuration(averageTtft)}
              </text>
            </SubRow>
            <SubRow label="Session TPS:">
              <text fg={C.text}>
                {sessionTps === undefined
                  ? '—'
                  : `${sessionTps.toFixed(1)} tok/s`}
              </text>
            </SubRow>
          </box>
        )}

        <SectionTitle>Tokens</SectionTitle>
        <Row label="Input:">
          <text fg={C.yellow}>{totalInput.toLocaleString()}</text>
        </Row>
        <Row label="Output:">
          <text fg={C.yellow}>{totalOutput.toLocaleString()}</text>
        </Row>
        {totalCached > 0 && (
          <Row label="Cached:">
            <text fg={C.green}>
              {`${totalCached.toLocaleString()} (${cacheRate.toFixed(1)}%)`}
            </text>
          </Row>
        )}

        {Object.keys(metrics.models).length > 0 && (
          <box flexDirection="column">
            <SectionTitle>Models</SectionTitle>
            {Object.entries(metrics.models).map(([name, m], i) => (
              <box key={name} flexDirection="row">
                <text fg={SERIES_COLORS[i % SERIES_COLORS.length]}>
                  {`${ICON.CIRCLE_FILLED} `}
                </text>
                <text fg={C.text}>{`${name} `}</text>
                <text fg={C.dim}>
                  {`${m.api.totalRequests} reqs · in=${fmtTokens(m.tokens.prompt)} · out=${fmtTokens(m.tokens.candidates)}`}
                </text>
              </box>
            ))}
          </box>
        )}
      </box>
    );

  const tabRuns = statsTabRuns(contentWidth);
  // The long hint only where it fits the row; a narrower frame keeps the keys
  // that matter rather than clipping "esc" off the end.
  const scrollHint = 'tab · ↑↓ scroll · esc';
  const hint =
    canScroll && getCachedStringWidth(scrollHint) <= contentWidth
      ? scrollHint
      : 'tab · esc';
  return (
    <box
      // Remount on a frame style change: a removed layout property can
      // persist on a reused native node (2026-10-13 short-scroll dialogs).
      key={layout.compact ? `compact-${layout.border}` : 'normal'}
      flexDirection="column"
      border={layout.border ? true : []}
      borderColor={C.dim}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={layout.compact ? 0 : 1}
      paddingBottom={layout.compact ? 0 : 1}
      // A shrinkable frame lets a short region squeeze its text rows to zero
      // and paint them over each other; staying natural height keeps the rows
      // contiguous for the region's clip to cut at the tail, as ink does for
      // /stats. The clip cuts child text but not the frame's own border
      // strokes, so a frame taller than the region still paints its border
      // past it, and a body with an explicit height windows itself from the
      // region budget instead of relying on the clip (Decision 71).
      flexShrink={0}
    >
      {/* Tab bar, one row at every width: a clipped label still cycles on
          Tab, and a region too short for the chrome sheds the bar as the
          skills frame sheds its title. */}
      {layout.compact ? null : (
        <>
          <box flexDirection="row">
            {TABS.map((t, i) => {
              const run = tabRuns[i];
              if (!run) return null;
              const active = t.name === tab;
              return (
                <box key={t.name} marginLeft={i === 0 ? 0 : 1}>
                  <text
                    fg={active ? '#1e1e2e' : C.text}
                    bg={active ? C.accent : undefined}
                    wrapMode="none"
                  >
                    {run}
                  </text>
                </box>
              );
            })}
          </box>
          <box height={1} />
        </>
      )}

      {bodyRows === undefined ? (
        body
      ) : (
        <scrollbox
          ref={scrollRef}
          // Content-sized when the body fits the budget, so tall terminals
          // are not padded with blank rows; the budget caps it otherwise.
          height={contentRows > 0 ? Math.min(contentRows, bodyRows) : bodyRows}
          flexGrow={0}
          stickyScroll={false}
          focusable={false}
        >
          <box
            flexGrow={0}
            flexShrink={0}
            flexDirection="column"
            onSizeChange={function (this: { height: number }) {
              setContentRows(this.height);
            }}
          >
            {body}
          </box>
        </scrollbox>
      )}

      {layout.compact ? null : (
        <box marginTop={1}>
          <text fg={C.dim} wrapMode="none">
            {truncateToWidth(hint, contentWidth)}
          </text>
        </box>
      )}
    </box>
  );
}

/** The port's own body cap; ink windows its list at
 * Math.min(15, Math.max(1, residual)) (SkillsManagerDialog). */
const SKILLS_BODY_ROWS = 12;

/** The skills frame's rows outside the scrollbox: border 2, padding 2, title 1, body margin 1. */
const SKILLS_FRAME_CHROME_ROWS = 6;

interface SkillRow {
  name: string;
  description: string;
}

export function OpenTuiSkillsDialog(props: {
  config: Config | null | undefined;
  onClose: () => void;
  /** The popup region's row budget; the scrollbox windows its height from it. */
  availableTerminalHeight?: number;
}) {
  const { config, onClose } = props;
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEscToClose(onClose, true);
  // The frame is unshrinkable and the region's clip cannot cut the border,
  // so the body's explicit height windows itself from what the region leaves
  // after the frame's chrome: border and padding 4, the title row 1, the
  // body's margin row 1. Without a budget the body keeps its twelve rows.
  const regionHeight = clampDialogHeight(props.availableTerminalHeight);
  const { width } = useTerminalDimensions();
  const bodyLayout = scrollDialogLayout(
    regionHeight,
    SKILLS_FRAME_CHROME_ROWS,
    SKILLS_BODY_ROWS,
  );
  const contentWidth = Math.max(1, dialogAreaWidth(width) - 6);
  useEffect(() => {
    let alive = true;
    const mgr = config?.getSkillManager?.();
    if (!mgr) {
      setLoading(false);
      return;
    }
    mgr
      .listSkills()
      .then((skills) => {
        if (!alive) return;
        setRows(
          (skills as Array<{ name: string; description?: string }>).map(
            (s) => ({ name: s.name, description: s.description ?? '' }),
          ),
        );
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [config]);

  return (
    <box
      key={bodyLayout.compact ? `compact-${bodyLayout.border}` : 'normal'}
      flexDirection="column"
      border={bodyLayout.border ? true : []}
      borderColor={C.dim}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={bodyLayout.compact ? 0 : 1}
      paddingBottom={bodyLayout.compact ? 0 : 1}
      // A shrinkable frame lets a short region squeeze its text rows to zero
      // and paint them over each other; staying natural height keeps the rows
      // contiguous for the region's clip to cut at the tail, as ink does for
      // /stats. The clip cuts child text but not the frame's own border
      // strokes, so a frame taller than the region still paints its border
      // past it, and a body with an explicit height windows itself from the
      // region budget instead of relying on the clip (Decision 71).
      flexShrink={0}
    >
      {!bodyLayout.compact ? (
        <box flexDirection="row" justifyContent="space-between">
          <text fg={C.accent} attributes={1}>
            {truncateToWidth('Skills', contentWidth)}
          </text>
          {contentWidth >= 18 ? <text fg={C.dim}>{'esc to close'}</text> : null}
        </box>
      ) : null}
      <scrollbox
        key={`body-${width}-${bodyLayout.bodyRows}-${bodyLayout.compact}`}
        height={bodyLayout.bodyRows}
        marginTop={bodyLayout.compact ? 0 : 1}
        flexShrink={1}
        stickyScroll={false}
      >
        {loading ? (
          <text fg={C.dim}>{'loading skills…'}</text>
        ) : rows.length === 0 ? (
          <text fg={C.dim}>{'no skills available'}</text>
        ) : (
          rows.map((r) => (
            <box key={r.name} flexDirection="row">
              <text fg={C.green} attributes={1}>
                {r.name}
              </text>
              <text fg={C.dim}>{`  ${r.description}`}</text>
            </box>
          ))
        )}
      </scrollbox>
    </box>
  );
}
