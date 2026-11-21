/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
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
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { uiTelemetryService } from '@qwen-code/qwen-code-core/telemetry/uiTelemetry.js';
import {
  computeGenerationRates,
  computeSessionStats,
} from '../utils/computeStats.js';
import { formatDuration } from '../utils/formatters.js';
import {
  getStatusColor,
  TOOL_SUCCESS_RATE_HIGH,
  TOOL_SUCCESS_RATE_MEDIUM,
} from '../utils/displayUtils.js';
import {
  fmtTokens,
  getSeriesColors,
  RANGE_CYCLE,
  getRangeLabel,
} from '../components/stats-formatters.js';
import type { TimeRange } from '@qwen-code/qwen-code-core/services/usageHistoryService.js';
import type { BoxRenderable, ScrollBoxRenderable } from '@opentui/core';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import { useStatsHistory } from './use-stats-history.js';
import { StatsHistory, statsMonths } from './StatsHistory.js';
import { t } from '../../i18n/index.js';
import { ICON } from '../constants.js';
import { toOriginalKey } from './key-map.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import { C } from './theme.js';
import { scrollDialogLayout, wrappedRows } from './dialogs-core.js';
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

const Row = ({
  label,
  children,
  compact,
}: {
  label: string;
  children?: ReactNode;
  compact: boolean;
}) => (
  <box flexDirection={compact ? 'column' : 'row'} width="100%">
    <box width={compact ? '100%' : LABEL_W} flexShrink={0}>
      <text fg={C.dim} wrapMode="word">
        {label}
      </text>
    </box>
    <box flexGrow={1} flexDirection="column" minWidth={0}>
      {children}
    </box>
  </box>
);

const SubRow = ({
  label,
  children,
  compact,
}: {
  label: string;
  children?: ReactNode;
  compact: boolean;
}) => (
  <box
    flexDirection={compact ? 'column' : 'row'}
    paddingLeft={compact ? 0 : 2}
    width="100%"
  >
    <box width={compact ? '100%' : 26} flexShrink={0}>
      <text fg={C.dim} wrapMode="word">{`» ${label}`}</text>
    </box>
    <box flexGrow={1} flexDirection="column" minWidth={0}>
      {children}
    </box>
  </box>
);

const SectionTitle = ({ children }: { children?: ReactNode }) => (
  <box marginTop={1}>
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

export function OpenTuiStatsDialog(props: {
  config: Config | null | undefined;
  onClose: () => void;
  /** Embedded hosts pass false while their own focus zone owns the keys. */
  isFocused?: boolean;
  sessionStats?: SessionStatsState;
  availableTerminalHeight?: number;
}) {
  const { config, onClose, isFocused = true } = props;
  const [tab, setTabState] = useState<StatsTabName>('session');
  const [range, setRange] = useState<TimeRange>('all');
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [monthOffset, setMonthOffset] = useState(0);
  const monthRef = useRef(0);
  monthRef.current = monthOffset;
  const history = useStatsHistory(config, props.sessionStats, range);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const frame = useRef<BoxRenderable | null>(null);
  const dimensions = useTerminalDimensions();
  const [frameWidth, setFrameWidth] = useState(
    dialogAreaWidth(dimensions.width),
  );
  const [bodyWidth, setBodyWidth] = useState(
    Math.max(1, dialogAreaWidth(dimensions.width) - 7),
  );
  useLayoutEffect(() => {
    setFrameWidth(frame.current?.width || dialogAreaWidth(dimensions.width));
  }, [dimensions.width]);
  const regionHeight = Math.max(
    1,
    props.availableTerminalHeight ?? dimensions.height,
  );
  const tabText = TABS.map((definition) => ` ${t(definition.label)} `).join(
    ' ',
  );
  const rangeText = RANGE_CYCLE.map(getRangeLabel).join(' · ');
  const normalHint =
    tab === 'session'
      ? 'tab · esc'
      : range === 'all' && tab === 'activity'
        ? 'tab · r dates · ←→ month · PgUp/PgDn · esc'
        : 'tab · r dates · PgUp/PgDn · esc';
  // The decision uses the outer width with normal padding, never a width
  // changed by compact padding itself.
  const compact =
    frameWidth - 6 <
      Math.max(
        getCachedStringWidth(tabText),
        getCachedStringWidth(rangeText),
        getCachedStringWidth('tab · r dates · ←→ month · PgUp/PgDn · esc'),
      ) || regionHeight < 11;
  const contentWidth = Math.max(1, frameWidth - (compact ? 4 : 6));
  const headerText = compact
    ? t(TABS.find((definition) => definition.name === tab)!.label)
    : tabText;
  const hint = !isFocused
    ? ''
    : compact
      ? tab === 'session'
        ? 'tab PgUp/PgDn esc'
        : range === 'all' && tab === 'activity'
          ? 'tab r ←→ PgUp/PgDn esc'
          : 'tab r PgUp/PgDn esc'
      : normalHint;
  const visibleRange = compact ? getRangeLabel(range) : rangeText;
  const headerRows = wrappedRows(headerText, contentWidth);
  const rangeRows =
    tab === 'session' ? 0 : wrappedRows(visibleRange, contentWidth);
  const hintRows = hint ? wrappedRows(hint, contentWidth) : 0;
  const chromeRows =
    2 +
    (compact ? 0 : 2) +
    headerRows +
    1 +
    hintRows +
    (hint && !compact ? 1 : 0) +
    rangeRows +
    (rangeRows && !compact ? 1 : 0);
  const bodyRows = Math.max(1, regionHeight - chromeRows);
  useLayoutEffect(() => {
    scroll.current?.scrollTo(0);
  }, [tab, range, monthOffset]);
  // A held Tab hands the whole burst to the handler from the last render, so
  // the cycle must read where the previous key of the burst landed.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const setTab = (next: StatsTabName) => {
    tabRef.current = next;
    setTabState(next);
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
    if (original.ctrl || original.meta) return;
    if (original.name === 'r') {
      const next =
        RANGE_CYCLE[
          (RANGE_CYCLE.indexOf(rangeRef.current) + 1) % RANGE_CYCLE.length
        ];
      rangeRef.current = next;
      monthRef.current = 0;
      setMonthOffset(0);
      setRange(next);
      return;
    }
    if (
      tabRef.current === 'activity' &&
      rangeRef.current === 'all' &&
      history.data
    ) {
      if (original.name === 'left' || original.name === 'h') {
        monthRef.current = Math.min(
          monthRef.current + 1,
          Math.max(0, statsMonths(history.data).length - 1),
        );
        setMonthOffset(monthRef.current);
      } else if (original.name === 'right' || original.name === 'l') {
        monthRef.current = Math.max(0, monthRef.current - 1);
        setMonthOffset(monthRef.current);
      }
    }
    if (original.name === 'pageup' || original.name === 'pagedown') {
      scroll.current?.scrollBy(
        (original.name === 'pageup' ? -1 : 1) * bodyRows,
      );
    }
    if (original.name === 'tab') {
      const order = TABS.map((t) => t.name);
      const idx = order.indexOf(tabRef.current);
      setTab(
        order[(idx + (original.shift ? -1 : 1) + order.length) % order.length],
      );
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
  const { lastTps, averageTtft, sessionTps } =
    computeGenerationRates(generation);

  const successColor = getStatusColor(computed.successRate, {
    green: TOOL_SUCCESS_RATE_HIGH,
    yellow: TOOL_SUCCESS_RATE_MEDIUM,
  });
  const SERIES_COLORS = getSeriesColors();

  return (
    <box
      ref={(node) => {
        frame.current = node;
      }}
      onSizeChange={() => {
        if (frame.current?.width) setFrameWidth(frame.current.width);
      }}
      flexDirection="column"
      border
      borderColor={C.dim}
      paddingLeft={compact ? 1 : 2}
      paddingRight={compact ? 1 : 2}
      paddingTop={compact ? 0 : 1}
      paddingBottom={compact ? 0 : 1}
      flexShrink={0}
    >
      {compact ? (
        <text
          id="screen-reader-selected-tab"
          width="100%"
          height={headerRows}
          wrapMode="word"
        >
          <span fg="#1e1e2e" bg={C.accent}>
            {headerText}
          </span>
        </text>
      ) : (
        <box flexDirection="row" height={headerRows} flexShrink={0}>
          {TABS.map((definition, index) => (
            <text
              key={definition.name}
              id={
                definition.name === tab
                  ? 'screen-reader-selected-tab'
                  : 'screen-reader-unselected-tab'
              }
              marginLeft={index ? 1 : 0}
              fg={definition.name === tab ? '#1e1e2e' : C.text}
              bg={definition.name === tab ? C.accent : undefined}
            >
              {` ${t(definition.label)} `}
            </text>
          ))}
        </box>
      )}
      <box height={1} flexShrink={0} />

      <scrollbox
        ref={(node) => {
          scroll.current = node;
        }}
        height={bodyRows}
        width="100%"
        contentOptions={{ width: '100%', paddingRight: compact ? 0 : 1 }}
        onSizeChange={() => {
          if (scroll.current)
            setBodyWidth(
              Math.max(1, scroll.current.viewport.width - (compact ? 0 : 1)),
            );
        }}
      >
        {tab !== 'session' ? (
          history.loading ? (
            <text fg={C.dim}>{t('Loading stats...')}</text>
          ) : history.error ? (
            <text fg={C.red}>{t(history.error)}</text>
          ) : history.data ? (
            <StatsHistory
              data={history.data}
              tab={tab}
              range={range}
              monthOffset={monthOffset}
              width={bodyWidth}
            />
          ) : null
        ) : (
          <box flexDirection="column">
            <Row compact={compact} label="Session ID:">
              <text fg={C.text}>{sessionId ?? 'n/a'}</text>
            </Row>

            <SectionTitle>Interaction Summary</SectionTitle>
            <Row compact={compact} label="Tool Calls:">
              <text fg={C.text} wrapMode="word">
                {`${metrics.tools.totalCalls} ( `}
                <span
                  fg={C.green}
                >{`✓ ${metrics.tools.totalSuccess}`}</span>{' '}
                <span fg={C.red}>{`✗ ${metrics.tools.totalFail}`}</span>
                {' )'}
              </text>
            </Row>
            <Row compact={compact} label="Success Rate:">
              <text
                fg={successColor}
              >{`${computed.successRate.toFixed(1)}%`}</text>
            </Row>
            {(metrics.files.totalLinesAdded > 0 ||
              metrics.files.totalLinesRemoved > 0) && (
              <Row compact={compact} label="Code Changes:">
                <text wrapMode="word">
                  <span
                    fg={C.green}
                  >{`+${metrics.files.totalLinesAdded}`}</span>{' '}
                  <span
                    fg={C.red}
                  >{`-${metrics.files.totalLinesRemoved}`}</span>
                </text>
              </Row>
            )}

            <SectionTitle>Performance</SectionTitle>
            <Row compact={compact} label="Wall Time:">
              <text fg={C.text}>{formatDuration(wallDuration)}</text>
            </Row>
            <Row compact={compact} label="Agent Active:">
              <text fg={C.text}>
                {formatDuration(computed.agentActiveTime)}
              </text>
            </Row>
            <SubRow compact={compact} label="API Time:">
              <text fg={C.text} wrapMode="word">
                {formatDuration(computed.totalApiTime)}
                <span
                  fg={C.dim}
                >{` (${computed.apiTimePercent.toFixed(1)}%)`}</span>
              </text>
            </SubRow>
            <SubRow compact={compact} label="Tool Time:">
              <text fg={C.text} wrapMode="word">
                {formatDuration(computed.totalToolTime)}
                <span
                  fg={C.dim}
                >{` (${computed.toolTimePercent.toFixed(1)}%)`}</span>
              </text>
            </SubRow>

            {lastGeneration && (
              <box flexDirection="column">
                <SectionTitle>
                  {`Generation Metrics (Latest Request)`}
                </SectionTitle>
                <Row compact={compact} label="Model:">
                  <text fg={C.text}>{lastGeneration.model}</text>
                </Row>
                <Row compact={compact} label="TTFT:">
                  <text fg={C.text}>
                    {formatDuration(lastGeneration.ttftMs)}
                  </text>
                </Row>
                <Row compact={compact} label="Generation Time:">
                  <text fg={C.text}>
                    {formatDuration(lastGeneration.generationDurationMs)}
                  </text>
                </Row>
                <Row compact={compact} label="Output (incl. Reasoning):">
                  <text fg={C.text}>
                    {lastGeneration.outputTokens.toLocaleString()}
                  </text>
                </Row>
                <Row compact={compact} label="TPS:">
                  <text fg={C.text}>
                    {lastTps === undefined
                      ? '—'
                      : `${lastTps.toFixed(1)} tok/s`}
                  </text>
                </Row>
                <SubRow compact={compact} label="Requests:">
                  <text fg={C.text}>{generation?.timedRequests}</text>
                </SubRow>
                <SubRow compact={compact} label="Average TTFT:">
                  <text fg={C.text}>
                    {averageTtft === undefined
                      ? '—'
                      : formatDuration(averageTtft)}
                  </text>
                </SubRow>
                <SubRow compact={compact} label="Session TPS:">
                  <text fg={C.text}>
                    {sessionTps === undefined
                      ? '—'
                      : `${sessionTps.toFixed(1)} tok/s`}
                  </text>
                </SubRow>
              </box>
            )}

            <SectionTitle>Tokens</SectionTitle>
            <Row compact={compact} label="Input:">
              <text fg={C.yellow}>{totalInput.toLocaleString()}</text>
            </Row>
            <Row compact={compact} label="Output:">
              <text fg={C.yellow}>{totalOutput.toLocaleString()}</text>
            </Row>
            {totalCached > 0 && (
              <Row compact={compact} label="Cached:">
                <text fg={C.green}>
                  {`${totalCached.toLocaleString()} (${cacheRate.toFixed(1)}%)`}
                </text>
              </Row>
            )}

            {Object.keys(metrics.models).length > 0 && (
              <box flexDirection="column">
                <SectionTitle>Models</SectionTitle>
                {Object.entries(metrics.models).map(([name, m], i) => (
                  <text key={name} wrapMode="word">
                    <span
                      fg={SERIES_COLORS[i % SERIES_COLORS.length]}
                    >{`${ICON.CIRCLE_FILLED} `}</span>
                    <span fg={C.text}>{`${name} `}</span>
                    <span
                      fg={C.dim}
                    >{`${m.api.totalRequests} reqs · in=${fmtTokens(m.tokens.prompt)} · out=${fmtTokens(m.tokens.candidates)}`}</span>
                  </text>
                ))}
              </box>
            )}
          </box>
        )}
      </scrollbox>
      {tab !== 'session' ? (
        <box marginTop={compact ? 0 : 1} height={rangeRows} flexShrink={0}>
          <text fg={C.dim} wrapMode="word" width="100%">
            {compact ? (
              <span attributes={1}>{visibleRange}</span>
            ) : (
              RANGE_CYCLE.map((value, index) => (
                <span key={value} attributes={value === range ? 1 : 0}>
                  {`${index ? ' · ' : ''}${getRangeLabel(value)}`}
                </span>
              ))
            )}
          </text>
        </box>
      ) : null}
      {hint ? (
        <box marginTop={compact ? 0 : 1} height={hintRows} flexShrink={0}>
          <text fg={C.dim} width="100%" wrapMode="word">
            {hint}
          </text>
        </box>
      ) : null}
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
