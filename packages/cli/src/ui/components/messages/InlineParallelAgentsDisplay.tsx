/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * InlineParallelAgentsDisplay — dense inline panel for a tool group
 * that launched ≥2 `task_execution` subagents in one response (e.g.
 * `/review`'s 9-agent fan-out). Replaces the `Agent × 9 / <last name>`
 * one-liner from `CompactToolGroupDisplay`, which collapsed all useful
 * progress information into a count.
 *
 * Each row shows: status glyph · agent name · elapsed · tokens.
 * Rendered in the committed phase only; during the live phase
 * `LiveAgentPanel` below the composer owns the per-agent roster.
 * Elapsed and token data fall back to
 * `AgentResultDisplay.executionSummary` when the registry entry has
 * been unregistered.
 */

import type React from 'react';
import { useContext, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  type AgentResultDisplay,
  ToolDisplayNames,
  ToolNames,
} from '@qwen-code/qwen-code-core';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ConfigContext } from '../../contexts/ConfigContext.js';
import { theme } from '../../semantic-colors.js';
import { formatDuration, formatTokenCount } from '../../utils/formatters.js';
import { escapeAnsiCtrlCodes } from '../../utils/textUtils.js';
import { localizeToolDisplayName } from '../../../i18n/index.js';

interface InlineParallelAgentsDisplayProps {
  toolCalls: readonly IndividualToolCallDisplay[];
  contentWidth: number;
  /**
   * Total agent count for the header when `toolCalls` is a subset
   * (e.g. only terminal agents during the live phase). When omitted,
   * defaults to the number of agent entries in `toolCalls`.
   */
  totalAgentCount?: number;
  /**
   * Hard cap on the panel's rendered height (rows). The panel renders
   * inside the non-`<Static>` live frame; if that frame exceeds the
   * terminal height, ink clears the whole screen on every repaint
   * (scroll snap-back / flicker — see ink `shouldClearTerminalForFrame`).
   * When set, the agent list windows to the most recent rows that fit,
   * leaving a "+N more" indicator. Omitted → no cap (committed phase,
   * where the row already lives in `<Static>`).
   */
  availableTerminalHeight?: number;
}

/**
 * `agentId` in the registry is `${subagentName}-${parentToolCallId}` —
 * see `AgentTool.executeImpl` in core/src/tools/agent/agent.ts where the
 * id is constructed as `${subagentConfig.name}-${this.callId}`.
 * Reconstructing it here is the cheapest way to correlate a
 * `IndividualToolCallDisplay` with its live registry entry without
 * having to thread the id through the tool-result pipeline.
 */
function deriveAgentId(
  toolCall: IndividualToolCallDisplay,
  resultDisplay: AgentResultDisplay,
): string {
  return `${resultDisplay.subagentName}-${toolCall.callId}`;
}

function isAgentResult(
  rd: IndividualToolCallDisplay['resultDisplay'],
): rd is AgentResultDisplay {
  return (
    typeof rd === 'object' &&
    rd !== null &&
    'type' in rd &&
    (rd as AgentResultDisplay).type === 'task_execution'
  );
}

interface RowData {
  agentId: string;
  callId: string;
  name: string;
  status: AgentResultDisplay['status'];
  /** Set when registry has a live entry — drives activity + elapsed. */
  startTime?: number;
  endTime?: number;
  /**
   * Fallback total duration for terminal rows whose registry entry has
   * been unregistered (foreground subagents drop from the registry on
   * `unregisterForeground`, so `startTime`/`endTime` go undefined).
   * Sourced from `AgentResultDisplay.executionSummary.totalDurationMs`.
   */
  fallbackElapsedMs?: number;
  recentActivity?: { name: string; description?: string };
  tokenCount?: number;
}

// Internal tool name → display name lookup (mirrors LiveAgentPanel so
// rows surface `Shell` instead of raw `run_shell_command`).
const TOOL_DISPLAY_BY_NAME: Record<string, string> = Object.fromEntries(
  (Object.keys(ToolNames) as Array<keyof typeof ToolNames>).map((key) => [
    ToolNames[key],
    ToolDisplayNames[key],
  ]),
);

function activityLabel(row: RowData): string {
  // `row.recentActivity` was snapshotted in the rows useMemo by reading
  // `registry.get(agentId).recentActivities.at(-1)`. The registry
  // intentionally mutates that array in place via `appendActivity`,
  // not by replacing the reference — the rows memo's `now`-keyed
  // re-read is what surfaces the latest entry on each tick. Treat the
  // value here as a tick-snapshot only; do NOT close over the
  // registry's live array.
  const last = row.recentActivity;
  if (!last) return '';
  const display = localizeToolDisplayName(
    TOOL_DISPLAY_BY_NAME[last.name] ?? last.name,
  );
  const desc = last.description?.replace(/\s*\n\s*/g, ' ').trim();
  return desc ? `${display} ${desc}` : display;
}

function statusGlyph(status: AgentResultDisplay['status']): {
  glyph: string;
  color: string;
} {
  switch (status) {
    case 'running':
    case 'background':
      return { glyph: '○', color: theme.status.warning };
    case 'completed':
      return { glyph: '✔', color: theme.status.success };
    case 'failed':
      return { glyph: '✖', color: theme.status.error };
    case 'cancelled':
      return { glyph: '✖', color: theme.status.warning };
    default:
      return { glyph: '·', color: theme.text.secondary };
  }
}

function elapsedLabel(row: RowData, now: number): string {
  // Prefer live registry timing while the agent is still tracked, fall
  // back to the terminal `executionSummary.totalDurationMs` so the
  // elapsed column survives `unregisterForeground` (otherwise completed
  // rows lose their duration the moment they finish — visible as the
  // "✔ Agent 2: Security review  8.1k tok" gap in real runs).
  let ms: number | undefined;
  if (row.startTime !== undefined) {
    const end = row.endTime ?? now;
    ms = Math.max(0, end - row.startTime);
  } else if (row.fallbackElapsedMs !== undefined) {
    ms = Math.max(0, row.fallbackElapsedMs);
  }
  if (ms === undefined) return '';
  return formatDuration(Math.floor(ms / 1000) * 1000, {
    hideTrailingZeros: true,
  });
}

// Width budget for the agent-name column. Sized to fit /review's
// labels like `Agent 6c: Maintainer` and `Agent 7: Build & Test` at
// their full length while leaving room for the activity column on a
// typical 100-col content width. Names longer than this truncate in
// the middle (`Agent 1: Corr…tness review`) so both the agent number
// and the trailing suffix stay readable.
const NAME_COL_WIDTH = 26;

function truncateMiddle(input: string, max: number): string {
  if (input.length <= max) return input;
  if (max <= 1) return input.slice(0, max);
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${input.slice(0, head)}…${input.slice(input.length - tail)}`;
}

export const InlineParallelAgentsDisplay: React.FC<
  InlineParallelAgentsDisplayProps
> = ({
  toolCalls,
  contentWidth,
  totalAgentCount,
  availableTerminalHeight,
}) => {
  const config = useContext(ConfigContext);

  // Static slice of agent calls for this group. The caller already
  // determined this group qualifies, but we re-filter defensively so
  // the component is robust to mixed groups (e.g. a sibling Shell call
  // accidentally landing in the same toolCalls payload).
  const agentEntries = useMemo(() => {
    const out: Array<{
      toolCall: IndividualToolCallDisplay;
      result: AgentResultDisplay;
    }> = [];
    for (const tc of toolCalls) {
      if (isAgentResult(tc.resultDisplay)) {
        out.push({ toolCall: tc, result: tc.resultDisplay });
      }
    }
    return out;
  }, [toolCalls]);

  // 1s wall-clock tick to refresh elapsed / activity columns while
  // any agent in the batch is still live. Gating prevents the
  // interval from firing forever after the batch settles.
  const [now, setNow] = useState(() => Date.now());
  // `AgentResultDisplay.status` is exhaustively
  // `'running' | 'completed' | 'failed' | 'cancelled' | 'background'`
  // (see core/src/tools/tools.ts). The two arms below cover every
  // non-terminal value; the remaining three are terminal and don't
  // need a tick. If a new non-terminal status is ever added upstream,
  // the interval will stop early and elapsed/activity will freeze for
  // that row — add the new value here to keep the tick alive.
  const hasLiveAgent = useMemo(
    () =>
      agentEntries.some(
        (e) =>
          e.result.status === 'running' || e.result.status === 'background',
      ),
    [agentEntries],
  );
  useEffect(() => {
    if (!hasLiveAgent) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasLiveAgent]);

  // Reconcile static toolCall snapshot with live registry data so
  // activity / elapsed / tokens stay fresh. `now` participates in the
  // dependency so each tick re-reads the registry — `appendActivity`
  // mutates `recentActivities` in place, so without a tick the
  // component would freeze on the first row of activity.
  const rows: RowData[] = useMemo(() => {
    const registry = config?.getBackgroundTaskRegistry();
    // Touch `now` so a future "remove dead dep" cleanup can't silently
    // freeze the panel — the registry mutates in place and we need to
    // re-read on every tick to surface fresh activity.
    void now;
    return agentEntries.map(({ toolCall, result }) => {
      const agentId = deriveAgentId(toolCall, result);
      const live = registry?.get(agentId);
      const recent = live?.recentActivities?.at(-1);
      return {
        agentId,
        callId: toolCall.callId,
        name: result.taskDescription || result.subagentName,
        status: result.status,
        startTime: live?.startTime,
        endTime: live?.endTime,
        fallbackElapsedMs: result.executionSummary?.totalDurationMs,
        recentActivity: recent
          ? { name: recent.name, description: recent.description }
          : undefined,
        tokenCount:
          result.tokenCount ??
          live?.stats?.outputTokens ??
          result.executionSummary?.outputTokens,
      };
    });
  }, [agentEntries, config, now]);

  if (rows.length === 0) return null;

  const doneCount = rows.filter(
    (r) =>
      r.status === 'completed' ||
      r.status === 'failed' ||
      r.status === 'cancelled',
  ).length;
  const total = totalAgentCount ?? rows.length;
  const headerLabel = `Parallel agents · ${total} · ${doneCount}/${total} done`;

  // Height backstop: the panel lives in the non-`<Static>` live frame, so its
  // total height must stay within budget or ink clears the whole terminal on
  // every repaint (scroll snap-back). The header always costs 1 row; when rows
  // overflow, the "+N more" indicator costs another. Window to the most recent
  // rows that still fit AFTER reserving those lines, so the rendered height
  // (header + optional indicator + visibleRows) never exceeds the budget — even
  // at degenerate budgets ≤ 2, where we drop all rows (and at a budget of 1 the
  // indicator too, leaving just the header whose label still states the total).
  // A budget ≤ 0 / undefined means "no cap" (committed phase — already in
  // `<Static>`).
  const hasBudget =
    availableTerminalHeight != null && availableTerminalHeight > 0;
  let overflowCount = 0;
  let visibleRows = rows;
  if (hasBudget && rows.length + 1 > availableTerminalHeight) {
    // header (1) + all rows would exceed the budget → window.
    if (availableTerminalHeight >= 2) {
      // Reserve 1 row for the header and 1 for the "+N more" indicator; the
      // remainder is for rows.
      const rowsFit = availableTerminalHeight - 2;
      overflowCount = rows.length - rowsFit;
      visibleRows = rowsFit > 0 ? rows.slice(rows.length - rowsFit) : [];
    } else {
      // Budget of 1: only the header fits — drop every row and the indicator
      // too. The header label still states the total agent count.
      visibleRows = [];
    }
  }

  return (
    <Box flexDirection="column" width={contentWidth} paddingX={1}>
      <Box>
        <Text bold color={theme.text.accent}>
          {headerLabel}
        </Text>
      </Box>
      {overflowCount > 0 && (
        <Box>
          <Text color={theme.text.secondary}>
            … +{overflowCount} more {overflowCount === 1 ? 'agent' : 'agents'}
          </Text>
        </Box>
      )}
      {visibleRows.map((row) => (
        <AgentRow key={row.agentId} row={row} now={now} />
      ))}
    </Box>
  );
};

const AgentRow: React.FC<{ row: RowData; now: number }> = ({ row, now }) => {
  const { glyph, color } = statusGlyph(row.status);
  const safeName = escapeAnsiCtrlCodes(row.name);
  const displayName = truncateMiddle(safeName, NAME_COL_WIDTH);
  const activity = escapeAnsiCtrlCodes(activityLabel(row));
  const elapsed = elapsedLabel(row, now);
  const tokens =
    row.tokenCount && row.tokenCount > 0
      ? formatTokenCount(row.tokenCount)
      : '';
  const trailingParts: string[] = [];
  if (elapsed) trailingParts.push(elapsed);
  if (tokens) trailingParts.push(`${tokens} tok`);
  const trailing = trailingParts.join(' · ');

  // Right-align `trailing` (elapsed · tokens) by giving the activity
  // column flexGrow:1 — it consumes all remaining horizontal space,
  // pinning the trailing column to the right edge. Without flexGrow
  // the trailing column hugs the activity text, so each row's
  // trailing sits at a different x position and the panel reads as
  // visually noisy.
  return (
    <Box flexDirection="row">
      <Box flexShrink={0} marginRight={1}>
        <Text color={color}>{glyph}</Text>
      </Box>
      <Box flexShrink={0} marginRight={1} width={NAME_COL_WIDTH}>
        <Text wrap="truncate-end">{displayName}</Text>
      </Box>
      <Box flexShrink={1} flexGrow={1} marginRight={1}>
        <Text color={theme.text.secondary} wrap="truncate-end">
          {activity}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={theme.text.secondary}>{trailing}</Text>
      </Box>
    </Box>
  );
};
