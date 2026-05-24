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
 * Each row shows: status glyph · agent name · current activity · elapsed
 * · tokens. Pulled from `BackgroundTaskRegistry` on a 1s tick so the
 * activity and elapsed columns stay live (same pattern LiveAgentPanel
 * uses for its glance roster). Agents claimed by this display are
 * hidden from `LiveAgentPanel` via `InlineAgentClaimContext`, so the
 * same row never appears twice on screen.
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
import { useClaimedAgentIds } from '../../contexts/InlineAgentClaimContext.js';
import { theme } from '../../semantic-colors.js';
import { formatDuration, formatTokenCount } from '../../utils/formatters.js';
import { escapeAnsiCtrlCodes } from '../../utils/textUtils.js';

interface InlineParallelAgentsDisplayProps {
  /**
   * The full tool group as passed to ToolGroupMessage. We filter to
   * task_execution entries internally so the caller's gating logic
   * (which is what triggers this path in the first place) doesn't
   * need to duplicate the filter.
   */
  toolCalls: readonly IndividualToolCallDisplay[];
  contentWidth: number;
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
  const last = row.recentActivity;
  if (!last) return '';
  const display = TOOL_DISPLAY_BY_NAME[last.name] ?? last.name;
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
> = ({ toolCalls, contentWidth }) => {
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

  const agentIds = useMemo(
    () => agentEntries.map((e) => deriveAgentId(e.toolCall, e.result)),
    [agentEntries],
  );

  // Claim these ids so LiveAgentPanel knows to suppress them — this
  // panel is now the authoritative live surface for the batch.
  useClaimedAgentIds(agentIds);

  // 1s wall-clock tick to refresh elapsed / activity columns while
  // any agent in the batch is still live. Gating prevents the
  // interval from firing forever after the batch settles.
  const [now, setNow] = useState(() => Date.now());
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
          live?.stats?.totalTokens ??
          result.executionSummary?.totalTokens,
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
  const headerLabel = `Parallel agents · ${rows.length} · ${doneCount}/${rows.length} done`;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      width={contentWidth}
      borderColor={hasLiveAgent ? theme.status.warning : theme.border.default}
      paddingX={1}
    >
      <Box>
        <Text bold color={theme.text.accent}>
          {headerLabel}
        </Text>
      </Box>
      {rows.map((row) => (
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
