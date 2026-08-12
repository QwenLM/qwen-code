/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI-native Stats and Skills dialogs (parity follow-up to #8677).
 * Stats mirrors the ink `StatsDisplay` Session view using the real
 * `uiTelemetryService` metrics + `computeSessionStats`, so `/stats` shows the
 * same numbers as the original. Esc closes via a raw-input handler.
 */

import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useRenderer } from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core';
import { uiTelemetryService } from '@qwen-code/qwen-code-core';
import { computeSessionStats } from '../utils/computeStats.js';
import { flattenModelsBySource } from '../utils/modelsBySource.js';
import { formatDuration ,
  TOOL_SUCCESS_RATE_HIGH,
  TOOL_SUCCESS_RATE_MEDIUM,
} from '../utils/displayUtils.js';
import { C } from './theme.js';

const SESSION_START = Date.now();

/** Close the dialog on a raw Escape, like the other dialog hosts. */
function useEscToClose(onClose: () => void) {
  const renderer = useRenderer();
  useLayoutEffect(() => {
    const onRawInput = (sequence: string): boolean => {
      if (sequence !== '\x1b') return false;
      onClose();
      return true;
    };
    renderer.addInputHandler(onRawInput);
    return () => renderer.removeInputHandler(onRawInput);
  }, [renderer, onClose]);
}

function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEscToClose(onClose);
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
          {title}
        </text>
        <text fg={C.dim}>{'tab/shift+tab · esc to close'}</text>
      </box>
      <box height={1} />
      {children}
    </box>
  );
}

const StatRow = ({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) => (
  <box flexDirection="row">
    <box width={28}>
      <text fg={C.accent}>{title}</text>
    </box>
    <box flexGrow={1} flexDirection="row">
      {children}
    </box>
  </box>
);

const SubStatRow = ({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) => (
  <box flexDirection="row" paddingLeft={2}>
    <box width={26}>
      <text fg={C.dim}>{`» ${title}`}</text>
    </box>
    <box flexGrow={1} flexDirection="row">
      {children}
    </box>
  </box>
);

const Section = ({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) => (
  <box flexDirection="column" marginBottom={1}>
    <text fg={C.text} attributes={1}>
      {title}
    </text>
    {children}
  </box>
);

export function OpenTuiStatsDialog(props: {
  config: Config | null | undefined;
  onClose: () => void;
}) {
  const { config, onClose } = props;
  const metrics = uiTelemetryService.getMetrics();
  const { models, tools, files } = metrics;
  const computed = computeSessionStats(metrics);
  const sessionId = config?.getSessionId?.() ?? 'n/a';
  const duration = formatDuration(Date.now() - SESSION_START);

  const successColor =
    computed.successRate >= TOOL_SUCCESS_RATE_HIGH
      ? C.green
      : computed.successRate >= TOOL_SUCCESS_RATE_MEDIUM
        ? C.yellow
        : C.red;

  const modelEntries = flattenModelsBySource(models);

  return (
    <DialogShell title="Session Stats" onClose={onClose}>
      <Section title="Interaction Summary">
        <StatRow title="Session ID:">
          <text fg={C.text}>{sessionId}</text>
        </StatRow>
        <StatRow title="Tool Calls:">
          <box flexDirection="row">
            <text fg={C.text}>{`${tools.totalCalls} ( `}</text>
            <text fg={C.green}>{`✓ ${tools.totalSuccess}`}</text>
            <text fg={C.text}> </text>
            <text fg={C.red}>{`✗ ${tools.totalFail}`}</text>
            <text fg={C.text}>{' )'}</text>
          </box>
        </StatRow>
        <StatRow title="Success Rate:">
          <text fg={successColor}>{`${computed.successRate.toFixed(1)}%`}</text>
        </StatRow>
        {files &&
          (files.totalLinesAdded > 0 || files.totalLinesRemoved > 0) && (
            <StatRow title="Code Changes:">
              <box flexDirection="row">
                <text fg={C.green}>{`+${files.totalLinesAdded}`}</text>
                <text fg={C.text}> </text>
                <text fg={C.red}>{`-${files.totalLinesRemoved}`}</text>
              </box>
            </StatRow>
          )}
      </Section>

      <Section title="Performance">
        <StatRow title="Wall Time:">
          <text fg={C.text}>{duration}</text>
        </StatRow>
        <StatRow title="Agent Active:">
          <text fg={C.text}>{formatDuration(computed.agentActiveTime)}</text>
        </StatRow>
        <SubStatRow title="API Time:">
          <box flexDirection="row">
            <text fg={C.text}>{formatDuration(computed.totalApiTime)}</text>
            <text
              fg={C.dim}
            >{` (${computed.apiTimePercent.toFixed(1)}%)`}</text>
          </box>
        </SubStatRow>
        <SubStatRow title="Tool Time:">
          <box flexDirection="row">
            <text fg={C.text}>{formatDuration(computed.totalToolTime)}</text>
            <text
              fg={C.dim}
            >{` (${computed.toolTimePercent.toFixed(1)}%)`}</text>
          </box>
        </SubStatRow>
      </Section>

      {modelEntries.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <box flexDirection="row">
            <box width={35}>
              <text fg={C.text} attributes={1}>
                {'Model Usage'}
              </text>
            </box>
            <box width={8}>
              <text fg={C.text} attributes={1}>
                {'Reqs'}
              </text>
            </box>
            <box width={15}>
              <text fg={C.text} attributes={1}>
                {'Input Tokens'}
              </text>
            </box>
            <box width={15}>
              <text fg={C.text} attributes={1}>
                {'Output Tokens'}
              </text>
            </box>
          </box>
          {modelEntries.map(({ key, label, metrics: m }) => (
            <box key={key} flexDirection="row">
              <box width={35}>
                <text fg={C.text}>{label}</text>
              </box>
              <box width={8}>
                <text fg={C.text}>{m.api.totalRequests}</text>
              </box>
              <box width={15}>
                <text fg={C.yellow}>{m.tokens.prompt.toLocaleString()}</text>
              </box>
              <box width={15}>
                <text fg={C.yellow}>
                  {m.tokens.candidates.toLocaleString()}
                </text>
              </box>
            </box>
          ))}
        </box>
      )}
    </DialogShell>
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
    <DialogShell title="Skills" onClose={onClose}>
      <scrollbox height={12} stickyScroll={false}>
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
    </DialogShell>
  );
}
