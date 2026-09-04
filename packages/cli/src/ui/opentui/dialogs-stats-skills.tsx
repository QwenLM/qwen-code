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

import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useRenderer, useKeyboard } from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core';
import { uiTelemetryService } from '@qwen-code/qwen-code-core';
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
import { C } from './theme.js';

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
}) {
  const { config, onClose, isFocused = true } = props;
  const [tab, setTab] = useState<StatsTabName>('session');
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
      const idx = order.indexOf(tab);
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

  return (
    <box
      flexDirection="column"
      border
      borderColor={C.dim}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      marginTop={1}
      flexShrink={0}
    >
      {/* Tab bar */}
      <box flexDirection="row">
        {TABS.map((t) => {
          const active = t.name === tab;
          return (
            <box key={t.name} marginLeft={t.name === 'session' ? 0 : 1}>
              <text
                fg={active ? '#1e1e2e' : C.text}
                bg={active ? C.accent : undefined}
              >
                {` ${t.label} `}
              </text>
            </box>
          );
        })}
      </box>
      <box height={1} />

      {tab !== 'session' ? (
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
            <text
              fg={successColor}
            >{`${computed.successRate.toFixed(1)}%`}</text>
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
              <SectionTitle>
                {`Generation Metrics (Latest Request)`}
              </SectionTitle>
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
                  {averageTtft === undefined
                    ? '—'
                    : formatDuration(averageTtft)}
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
      )}

      <box marginTop={1}>
        <text fg={C.dim}>{'tab · esc'}</text>
      </box>
    </box>
  );
}

interface SkillRow {
  name: string;
  description: string;
}

export function OpenTuiSkillsDialog(props: {
  config: Config | null | undefined;
  onClose: () => void;
}) {
  const { config, onClose } = props;
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEscToClose(onClose, true);
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
      flexDirection="column"
      border
      borderColor={C.dim}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      marginTop={1}
      flexShrink={0}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={C.accent} attributes={1}>
          {'Skills'}
        </text>
        <text fg={C.dim}>{'esc to close'}</text>
      </box>
      <scrollbox height={12} marginTop={1} stickyScroll={false}>
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
