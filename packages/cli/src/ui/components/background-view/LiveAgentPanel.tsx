/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LiveAgentPanel — always-on bottom-of-screen roster of running subagents.
 *
 * Mirrors Claude Code's CoordinatorTaskPanel ("Renders below the prompt
 * input footer whenever local_agent tasks exist") — borderless rows of
 * `status · name · activity · elapsed` so the panel sits lightly above
 * the composer rather than competing with it for vertical space. The
 * heavier bordered look stays with `BackgroundTasksDialog`, the
 * Down-arrow detail view that handles selection, cancel, and resume.
 *
 * Replaces the inline `AgentExecutionDisplay` frame for live updates —
 * that frame mutated on every tool-call and caused scrollback repaint
 * flicker once the tool list grew past the terminal height. The panel
 * sits outside `<Static>` so updates never disturb committed history,
 * and the same per-agent registry already powers the footer pill and
 * the dialog, so the three views never drift.
 *
 * Scope: read-only display. Cancel / detail / approval routing all stay
 * with the existing pill+dialog (Down arrow → BackgroundTasksDialog) so
 * this panel never competes for keyboard input.
 */

import type React from 'react';
import { useContext, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { useBackgroundTaskViewState } from '../../contexts/BackgroundTaskViewContext.js';
import { ConfigContext } from '../../contexts/ConfigContext.js';
import { theme } from '../../semantic-colors.js';
import { formatDuration, formatTokenCount } from '../../utils/formatters.js';
import type {
  AgentDialogEntry,
  DialogEntry,
} from '../../hooks/useBackgroundTaskView.js';

interface LiveAgentPanelProps {
  /**
   * Maximum agent rows to render. The panel windows from the most recent
   * launches downward when the list outgrows the budget — matches the
   * BackgroundTasksDialog list-mode windowing convention.
   */
  maxRows?: number;
  /**
   * Outer width budget so the panel respects the layout's main-area
   * width when the terminal is narrow. Optional — caller defaults to
   * the layout width when omitted.
   */
  width?: number;
}

const DEFAULT_MAX_ROWS = 5;
// Keep terminal entries on the panel briefly so the user gets visual
// feedback ("✓ done · 12s") when a subagent finishes, then they fall off
// and the user goes to BackgroundTasksDialog for a deeper look. Mirrors
// Claude Code's `RECENT_COMPLETED_TTL_MS = 30_000` knob, scaled down
// because the panel is denser and we have the dialog as the long-term
// review surface.
const TERMINAL_VISIBLE_MS = 8000;
// `general-purpose` is the default builtin subagent; printing the type
// every row when it's the default just clutters the line — the
// description carries all the meaningful identity. Specialized
// subagents (named in `subagents/builtin-agents.ts` or user-authored)
// still get their type rendered as a bold anchor.
const DEFAULT_SUBAGENT_TYPE = 'general-purpose';

type LivePanelEntry = AgentDialogEntry & {
  /** True when the row is past its terminal-visibility window. */
  expired: boolean;
};

function isAgentEntry(entry: DialogEntry): entry is AgentDialogEntry {
  return entry.kind === 'agent';
}

function statusIcon(entry: AgentDialogEntry): { glyph: string; color: string } {
  switch (entry.status) {
    case 'running':
      return { glyph: '⊷', color: theme.status.warning };
    case 'paused':
      return { glyph: '⏸', color: theme.status.warning };
    case 'completed':
      return { glyph: '✔', color: theme.status.success };
    case 'failed':
      return { glyph: '✖', color: theme.status.error };
    case 'cancelled':
      return { glyph: '✖', color: theme.status.warning };
    default:
      return { glyph: '○', color: theme.text.secondary };
  }
}

function activityLabel(entry: AgentDialogEntry): string {
  const last = entry.recentActivities?.at(-1);
  if (!last) return '';
  const desc = last.description?.replace(/\s*\n\s*/g, ' ').trim();
  return desc ? `${last.name} ${desc}` : last.name;
}

/**
 * Strip the leading `subagentType:` prefix from `entry.description` if
 * present so the row doesn't render `editor · editor: tighten…`. We
 * intentionally do NOT call `buildBackgroundEntryLabel` here: the shared
 * helper also caps at 40 chars + appends `…`, which then collides with
 * the row-level `truncate-end` and produces a double-ellipsis on narrow
 * terminals (e.g. `… FIXME ……`). The row's own truncation has the full
 * width budget and is the right place to decide where to cut.
 */
function descriptionWithoutPrefix(entry: AgentDialogEntry): string {
  const raw = entry.description ?? '';
  if (!entry.subagentType) return raw;
  const lowerRaw = raw.toLowerCase();
  const prefix = entry.subagentType.toLowerCase() + ':';
  if (lowerRaw.startsWith(prefix)) {
    return raw.slice(prefix.length).trimStart();
  }
  return raw;
}

function elapsedLabel(entry: AgentDialogEntry, now: number): string {
  const startedAt = entry.startTime;
  const endedAt = entry.endTime ?? now;
  const ms = Math.max(0, endedAt - startedAt);
  // Whole-second precision keeps the row stable between paint frames —
  // a stopwatch ticking sub-seconds in a footer panel is a distraction.
  const wholeSeconds = Math.floor(ms / 1000);
  return formatDuration(wholeSeconds * 1000, { hideTrailingZeros: true });
}

export const LiveAgentPanel: React.FC<LiveAgentPanelProps> = ({
  maxRows = DEFAULT_MAX_ROWS,
  width,
}) => {
  const { entries, dialogOpen } = useBackgroundTaskViewState();
  // Reach for Config via the raw context (NOT useConfig) so the panel
  // can degrade to snapshot-only when no provider is mounted — e.g.
  // unit tests that render the component in isolation. useConfig
  // throws in that case, which would force every consumer to provide
  // a stub Config just to satisfy the panel's "live registry re-pull".
  const config = useContext(ConfigContext);

  // Wall-clock tick. Drives elapsed-time refresh, terminal-row eviction,
  // AND the live registry re-pull below. Only runs while the panel
  // actually has live work to display so we don't keep a useless
  // interval alive in the steady state.
  const [now, setNow] = useState(() => Date.now());
  const hasAgents = entries.some(isAgentEntry);
  useEffect(() => {
    if (!hasAgents) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasAgents]);

  // Re-pull each agent from the live registry on every tick so the row
  // shows the latest `recentActivities` — `useBackgroundTaskView`
  // intentionally only refreshes its snapshot on `statusChange` to keep
  // the footer pill / AppContainer quiet under heavy tool traffic, but
  // a glance roster MUST surface "what is this agent doing right now"
  // or it stops being a glance surface. Mirrors the pattern in
  // BackgroundTasksDialog's detail body, which re-reads the registry
  // on its own activity tick. Falls back to the snapshot when Config
  // isn't available (test fixtures) or the entry has unregistered
  // between snapshots.
  //
  // NOTE: this useMemo MUST come before the `if (dialogOpen) return null`
  // early-return below — React's rules of hooks require hook calls in
  // identical order each render, so a conditional early-return that
  // skips a subsequent hook is a violation.
  const liveAgentSnapshots: AgentDialogEntry[] = useMemo(() => {
    const snapshots = entries.filter(isAgentEntry);
    if (!config) return snapshots;
    const registry = config.getBackgroundTaskRegistry();
    return snapshots.map((snap) => {
      const live = registry.get(snap.agentId);
      return live ? { ...live, kind: 'agent' as const } : snap;
    });
    // `now` is a deliberate dep so the memo recomputes each tick and
    // captures the latest `recentActivities` mutated in place by the
    // registry's appendActivity path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, config, now]);

  // Defense in depth: don't compete with the dialog. Under
  // DefaultAppLayout this branch is unreachable because the layout
  // already gates the panel on `!uiState.dialogsVisible` (which folds
  // in `bgTasksDialogOpen`), but we keep the internal gate so callers
  // mounting the panel outside that layout still get the right
  // behavior.
  if (dialogOpen) return null;

  const visibleAgents: LivePanelEntry[] = liveAgentSnapshots
    .map((entry) => ({
      ...entry,
      expired:
        entry.status !== 'running' &&
        entry.status !== 'paused' &&
        entry.endTime !== undefined &&
        now - entry.endTime > TERMINAL_VISIBLE_MS,
    }))
    .filter((entry) => !entry.expired);

  if (visibleAgents.length === 0) return null;

  // Window from the tail (newest launches) when the list outgrows the
  // budget. Older live agents are still surfaced in the pill count and
  // the dialog — the panel is a glance surface, not a full roster.
  const overflow = Math.max(0, visibleAgents.length - maxRows);
  const visible = overflow > 0 ? visibleAgents.slice(-maxRows) : visibleAgents;

  const runningCount = visibleAgents.filter(
    (e) => e.status === 'running',
  ).length;

  // Borderless layout, mirroring Claude Code's CoordinatorTaskPanel
  // ("Renders below the prompt input footer whenever local_agent tasks
  // exist" — plain rows under a single marginTop). The bordered look
  // belongs to BackgroundTasksDialog (a real overlay); the always-on
  // roster is a glance surface that should sit lightly above the
  // composer rather than fight it for vertical space + border cells.
  return (
    <Box flexDirection="column" marginTop={1} width={width} paddingX={2}>
      <Box>
        <Text bold color={theme.text.accent}>
          Active agents
        </Text>
        <Text
          color={theme.text.secondary}
        >{` (${runningCount}/${visibleAgents.length})`}</Text>
      </Box>
      {overflow > 0 && (
        <Box>
          <Text
            color={theme.text.secondary}
          >{`  ^ ${overflow} more above`}</Text>
        </Box>
      )}
      {visible.map((entry) => (
        <AgentRow key={entry.agentId} entry={entry} now={now} />
      ))}
    </Box>
  );
};

const AgentRow: React.FC<{ entry: AgentDialogEntry; now: number }> = ({
  entry,
  now,
}) => {
  const { glyph, color } = statusIcon(entry);
  const label = descriptionWithoutPrefix(entry);
  const flavorPrefix = entry.flavor === 'foreground' ? '[in turn] ' : '';
  const activity = activityLabel(entry);
  const elapsed = elapsedLabel(entry, now);
  const showType =
    entry.subagentType !== undefined &&
    entry.subagentType !== DEFAULT_SUBAGENT_TYPE;
  const tokenSuffix =
    entry.stats?.totalTokens && entry.stats.totalTokens > 0
      ? ` · ${formatTokenCount(entry.stats.totalTokens)} tokens`
      : '';

  // Two-column row, layout order:
  //   [icon · type · description · activity]   ·   [elapsed · tokens]
  //         ^ flex-shrink:1, truncate-end          ^ flex-shrink:0
  //
  // Identity (type) and intent (description / activity) read in
  // natural left-to-right order. Elapsed + tokens live in a
  // flex-shrink:0 right column so they're never clipped — long
  // descriptions truncate inside the left column with `truncate-end`.
  // Crucially the left column does NOT have `flex-grow:1`, so when
  // the row content fits comfortably (wide terminal) the two columns
  // sit side by side with the empty space at the row tail rather
  // than between description and elapsed (which is what `flex-grow`
  // would have produced).
  const tail =
    tokenSuffix.length > 0 ? ` · ${elapsed}${tokenSuffix}` : ` · ${elapsed}`;
  return (
    <Box flexDirection="row">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          {/*
            Template literal preserves the two-space breathing room
            after the status glyph — prettier can collapse literal
            whitespace inside JSX text expressions.
          */}
          <Text color={color}>{`${glyph}  `}</Text>
          {showType && (
            <>
              <Text bold>{entry.subagentType}</Text>
              <Text color={theme.text.secondary}>{' · '}</Text>
            </>
          )}
          <Text color={theme.text.secondary}>{`${flavorPrefix}${label}`}</Text>
          {activity && (
            <Text color={theme.text.secondary}>{` · ${activity}`}</Text>
          )}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={theme.text.secondary}>{tail}</Text>
      </Box>
    </Box>
  );
};
