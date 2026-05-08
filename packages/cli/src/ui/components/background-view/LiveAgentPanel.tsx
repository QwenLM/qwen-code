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
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import {
  DEFAULT_BUILTIN_SUBAGENT_TYPE as CORE_DEFAULT_SUBAGENT_TYPE,
  ToolDisplayNames,
  ToolNames,
} from '@qwen-code/qwen-code-core';
import { useBackgroundTaskViewState } from '../../contexts/BackgroundTaskViewContext.js';
import { ConfigContext } from '../../contexts/ConfigContext.js';
import { theme } from '../../semantic-colors.js';
import { formatDuration, formatTokenCount } from '../../utils/formatters.js';
import { escapeAnsiCtrlCodes } from '../../utils/textUtils.js';
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
// Re-export under a panel-local alias so the source of truth stays
// in `subagents/builtin-agents.ts` (a backend rename of the default
// type would otherwise silently re-introduce the redundant
// `general-purpose:` prefix on every row). Specialized subagents
// (other builtins or user-authored types) still get their type
// rendered as a bold anchor.
const DEFAULT_SUBAGENT_TYPE = CORE_DEFAULT_SUBAGENT_TYPE;

type LivePanelEntry = AgentDialogEntry & {
  /** True when the row is past its terminal-visibility window. */
  expired: boolean;
  /**
   * True when the row was synthesized because the registry forgot
   * the entry — we know the agent is no longer running but NOT
   * whether it succeeded, failed, or was cancelled (foreground
   * subagents don't transition through `complete`/`fail`/`cancel`
   * before `unregisterForeground`). Renders with a neutral glyph
   * and color so the panel never claims a green ✔ on a run that
   * the user just saw fail in the inline tool result.
   */
  synthesized?: boolean;
};

function isAgentEntry(entry: DialogEntry): entry is AgentDialogEntry {
  return entry.kind === 'agent';
}

// Bullet glyphs mirror Claude Code's CoordinatorTaskPanel — `○` for
// active slots (running / paused) so the row reads as a uniform list,
// terminal states keep distinct check / cross marks so they're easy
// to scan at a glance.
function statusIcon(entry: AgentDialogEntry & { synthesized?: boolean }): {
  glyph: string;
  color: string;
} {
  if (entry.synthesized) {
    // Outcome unknown — registry forgot the entry without going
    // through complete / fail / cancel. Use a neutral marker so
    // we don't lie about success.
    return { glyph: '·', color: theme.text.secondary };
  }
  switch (entry.status) {
    case 'running':
      return { glyph: '○', color: theme.status.warning };
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

// Internal-tool-name → user-facing display-name lookup
// (`run_shell_command` → `Shell`, `glob` → `Glob`, …). Mirrors the
// same map BackgroundTasksDialog uses so the two surfaces stay
// vocabulary-consistent — without it the panel would surface raw
// internal identifiers like `run_shell_command` while the dialog
// shows `Shell` for the same agent.
const TOOL_DISPLAY_BY_NAME: Record<string, string> = Object.fromEntries(
  (Object.keys(ToolNames) as Array<keyof typeof ToolNames>).map((key) => [
    ToolNames[key],
    ToolDisplayNames[key],
  ]),
);

function activityLabel(entry: AgentDialogEntry): string {
  const last = entry.recentActivities?.at(-1);
  if (!last) return '';
  const display = TOOL_DISPLAY_BY_NAME[last.name] ?? last.name;
  const desc = last.description?.replace(/\s*\n\s*/g, ' ').trim();
  return desc ? `${display} ${desc}` : display;
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
  // AND the live registry re-pull below. The gate must consider:
  //   - `dialogOpen` — when the bg-tasks dialog is up, the panel
  //     renders null (`if (dialogOpen) return null` below), so any
  //     ticks the interval fires are wasted re-renders.
  //   - live agents (running / paused) — always need elapsed updates.
  //   - terminal agents still inside the 8s visibility window — need
  //     ticks to drive their eviction.
  // `BackgroundTaskRegistry.getAll()` retains terminal entries
  // indefinitely, so a naive `entries.some(isAgentEntry)` gate would
  // keep ticking forever after the last entry's window closed; the
  // `dialogOpen` arm closes the corresponding gap on the dialog side.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (dialogOpen) return;
    const needsTick = (whenMs: number) =>
      entries.some((e) => {
        if (!isAgentEntry(e)) return false;
        if (e.status === 'running' || e.status === 'paused') return true;
        if (e.endTime === undefined) return false;
        return whenMs - e.endTime <= TERMINAL_VISIBLE_MS;
      });
    if (!needsTick(Date.now())) return;
    const id = setInterval(() => {
      const wallNow = Date.now();
      // Always advance `now` first so the final render reflects the
      // latest expiry state; THEN check if there's still work to do
      // and clear the interval if not. Without the up-front update
      // the row that just expired would linger one extra second.
      setNow(wallNow);
      if (!needsTick(wallNow)) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [entries, dialogOpen]);

  // Re-pull each agent from the live registry on every tick so the row
  // shows the latest `recentActivities` — `useBackgroundTaskView`
  // intentionally only refreshes its snapshot on `statusChange` to keep
  // the footer pill / AppContainer quiet under heavy tool traffic, but
  // a glance roster MUST surface "what is this agent doing right now"
  // or it stops being a glance surface. Mirrors the pattern in
  // BackgroundTasksDialog's detail body, which re-reads the registry
  // on its own activity tick.
  //
  // Four reconciliation paths between the snapshot and the registry:
  //   1. Both agree → use live (newest `recentActivities`).
  //   2. Snap says still-live (running / paused) but registry forgot
  //      → most commonly a foreground subagent that finished:
  //      `unregisterForeground` fires `emitStatusChange(entry)` BEFORE
  //      it deletes the entry, so the snapshot captures the old
  //      "still running" state and the next render's `registry.get`
  //      returns undefined. Synthesize a terminal version with
  //      `endTime = first-seen-missing` (pinned so subsequent ticks
  //      don't re-stamp it) and `synthesized: true` so the 8s
  //      visibility window gives the user a "the agent finished"
  //      beat without claiming a green ✔ on a run we can't
  //      actually verify (foreground subagents don't transition
  //      through complete / fail / cancel before unregister, so the
  //      true outcome is unknowable here).
  //   3. Snap is already terminal AND has `endTime` → keep the snap
  //      as-is. Canonical case: a foreground subagent that was
  //      cancelled / failed (which stamps `endTime` and emits
  //      statusChange) and then `unregisterForeground`'d. The snap
  //      carries the real terminal state and timestamp, so the row
  //      reads accurately; the visibleAgents filter evicts it once
  //      `now - endTime > TERMINAL_VISIBLE_MS` like any other
  //      terminal entry.
  //   4. Snap is terminal but has NO `endTime` → drop. This is an
  //      upstream invariant violation (`complete`/`fail`/`cancel`
  //      always stamp endTime); rendering would leave a row the
  //      visibility window has no way to evict.
  //
  // When `config` itself is undefined (test fixtures that render
  // without ConfigContext) the panel degrades to snapshot-only —
  // there's no live source of truth to reconcile against.
  //
  // NOTE: this useMemo MUST come before the `if (dialogOpen) return null`
  // early-return below — React's rules of hooks require hook calls in
  // identical order each render, so a conditional early-return that
  // skips a subsequent hook is a violation.
  // First-seen-missing timestamps for synthesized terminal entries.
  // We need this to survive across useMemo recomputes — without it,
  // each tick would re-synthesize the entry with a fresh `now` as
  // `endTime`, the visibility-window check (`now - endTime > 8000`)
  // would always evaluate to 0, and the row would never expire. The
  // ref outlives both the snapshot and the tick state.
  const missingSinceRef = useRef<Map<string, number>>(new Map());

  const liveAgentSnapshots: AgentDialogEntry[] = useMemo(() => {
    const snapshots = entries.filter(isAgentEntry);
    if (!config) return snapshots;
    const registry = config.getBackgroundTaskRegistry();
    // `now` participates in the dependency array so the memo recomputes
    // each tick and picks up `recentActivities` the registry mutated in
    // place via appendActivity. Reading it here makes the dependency
    // semantically honest — without this read a future "remove dead
    // dep" cleanup would silently freeze the panel on the first
    // tool-call after a snapshot refresh.
    const reconcileAt = now;
    const seenIds = new Set<string>();
    const next = snapshots
      .map((snap) => {
        seenIds.add(snap.agentId);
        const live = registry.get(snap.agentId);
        if (live) {
          // Recovered (or never went missing) — drop any stale
          // missing-since record so a future re-disappearance
          // gets a fresh timestamp.
          missingSinceRef.current.delete(snap.agentId);
          return { ...live, kind: 'agent' as const };
        }
        if (snap.status === 'running' || snap.status === 'paused') {
          // Pin the disappearance time on first observation so
          // subsequent ticks don't keep resetting endTime to `now`.
          let missingSince = missingSinceRef.current.get(snap.agentId);
          if (missingSince === undefined) {
            missingSince = reconcileAt;
            missingSinceRef.current.set(snap.agentId, missingSince);
          }
          // Mark synthesized so the row renders with a neutral glyph
          // — we know the agent is no longer running but cannot tell
          // whether it succeeded, failed, or was cancelled (foreground
          // subagents are unregistered without transitioning through
          // complete / fail / cancel on the registry). Status stays
          // `'completed'` purely so the visibility-window filter
          // treats the row as terminal; `synthesized` overrides the
          // glyph + color in `statusIcon`.
          return {
            ...snap,
            status: 'completed' as const,
            endTime: snap.endTime ?? missingSince,
            synthesized: true,
          } as AgentDialogEntry;
        }
        // Snap is already terminal but the registry forgot. Canonical
        // case: a foreground subagent that was cancelled / failed
        // (`cancel` / `fail` set `endTime` and emit statusChange) and
        // then `unregisterForeground`'d. The snap carries the real
        // `endTime`, so keep showing it — the visibleAgents filter
        // below evicts it once `now - endTime > TERMINAL_VISIBLE_MS`.
        // Without this branch cancelled / failed foreground tasks
        // would disappear instantly, contradicting the panel's "brief
        // terminal visibility" contract the synthesized-completion
        // path relies on.
        if (snap.endTime !== undefined) return snap;
        // Defensive fallback: terminal snap with no endTime is an
        // invariant violation upstream (complete / fail / cancel
        // always stamp endTime). Drop rather than render an entry
        // the visibility window has no way to evict.
        return null;
      })
      .filter((e): e is AgentDialogEntry => e !== null);
    // GC: drop missing-since records for agents that are no longer
    // even in the snapshot (e.g. statusChange refreshed and the
    // entry left useBackgroundTaskView's view entirely).
    for (const id of missingSinceRef.current.keys()) {
      if (!seenIds.has(id)) missingSinceRef.current.delete(id);
    }
    return next;
  }, [entries, config, now]);

  // Defense in depth: don't compete with the dialog. Under
  // DefaultAppLayout this branch is unreachable because the layout
  // already gates the panel on `!uiState.dialogsVisible` (which folds
  // in `bgTasksDialogOpen`), but we keep the internal gate so callers
  // mounting the panel outside that layout still get the right
  // behavior.
  //
  // The early-return is the LAST statement of this component on
  // purpose — pure rendering moves to LiveAgentPanelBody so that
  // future refactors which add a hook can't accidentally drop it
  // below the `dialogOpen` guard (`Rendered fewer hooks than
  // expected` is the canonical bug shape this guards against).
  if (dialogOpen) return null;
  return (
    <LiveAgentPanelBody
      snapshots={liveAgentSnapshots}
      now={now}
      maxRows={maxRows}
      width={width}
    />
  );
};

const LiveAgentPanelBody: React.FC<{
  snapshots: AgentDialogEntry[];
  now: number;
  maxRows: number;
  width: number | undefined;
}> = ({ snapshots, now, maxRows, width }) => {
  const visibleAgents: LivePanelEntry[] = snapshots
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

  // Include paused entries in the "active" tally — they appear in
  // the panel as active rows (same warning color, ⏸ glyph) and the
  // header read "Active agents (0/1)" with one paused agent visible
  // is misleading. The tally now matches what the user sees: the
  // numerator counts every row that's NOT in a terminal/synthesized
  // resting state.
  const activeCount = visibleAgents.filter(
    (e) => e.status === 'running' || e.status === 'paused',
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
        >{` (${activeCount}/${visibleAgents.length})`}</Text>
      </Box>
      {overflow > 0 && (
        <Box>
          {/*
            The panel is read-only (no keyboard focus — that would
            steal input from the composer), so when the roster
            overflows the row budget we point users at the dialog
            that DOES support selection / scroll / cancel / resume.
            Same keystroke the footer pill uses, kept in sync so
            users only have to learn one thing.
          */}
          <Text
            color={theme.text.secondary}
          >{`  ^ ${overflow} more above (↓ to view all)`}</Text>
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
  // ANSI sanitize every user-controlled string before it reaches Ink.
  // `subagentType` comes from subagent config (user-authored or model-
  // chosen) and `recentActivities[].description` is LLM-generated;
  // both can carry terminal control sequences that would otherwise
  // bleed through Ink's `<Text>` and corrupt the panel chrome.
  // HistoryItemDisplay applies the same `escapeAnsiCtrlCodes` to its
  // user-facing content for the same reason.
  const label = escapeAnsiCtrlCodes(descriptionWithoutPrefix(entry));
  // Note: foreground vs background is intentionally not surfaced here.
  // BackgroundTasksDialog tags foreground rows with `[blocking]`
  // (formerly `[in turn]`) to warn that cancelling will end the
  // current turn — useful in the dialog where `x` triggers a real
  // cancel. The glance panel has no cancel surface, so the marker
  // reads as ambient noise. Keep the dialog as the place that
  // surfaces the flavor distinction.
  const activity = escapeAnsiCtrlCodes(activityLabel(entry));
  const elapsed = elapsedLabel(entry, now);
  const showType =
    entry.subagentType !== undefined &&
    entry.subagentType !== DEFAULT_SUBAGENT_TYPE;
  const safeSubagentType = showType
    ? escapeAnsiCtrlCodes(entry.subagentType ?? '')
    : '';
  const tokenSuffix =
    entry.stats?.totalTokens && entry.stats.totalTokens > 0
      ? ` · ${formatTokenCount(entry.stats.totalTokens)} tokens`
      : '';

  // Layout (Claude Code's CoordinatorTaskPanel visual + our
  // right-pin to keep elapsed / tokens from being clipped):
  //
  //   [○ type: desc (activity)]   [▶ 13s · 2.4k tokens]
  //         ^ flex-shrink:1              ^ flex-shrink:0
  //         truncate-end                 always intact
  //
  // - Status glyph at the left (`○` for live slots, ✔/✖/⏸ for
  //   terminal — see `statusIcon`).
  // - `type:` prefix when not the default `general-purpose`.
  // - Activity wrapped in parentheses so it reads as an annotation
  //   on the description rather than a sibling field.
  // - `▶` separates the description from elapsed / tokens, mirroring
  //   the leaked CoordinatorTaskPanel pattern (`PLAY_ICON`).
  // - The left column has flex-shrink:1 (no flex-grow) so the two
  //   columns sit side by side at intrinsic widths; empty slack
  //   falls off the row tail rather than opening a visual gap
  //   between the description and the right-pinned elapsed.
  const tail = ` ▶ ${elapsed}${tokenSuffix}`;
  return (
    <Box flexDirection="row">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={color}>{`${glyph} `}</Text>
          {showType && (
            <>
              <Text bold>{safeSubagentType}</Text>
              <Text color={theme.text.secondary}>{': '}</Text>
            </>
          )}
          <Text color={theme.text.secondary}>{label}</Text>
          {activity && (
            <Text color={theme.text.secondary}>{` (${activity})`}</Text>
          )}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={theme.text.secondary}>{tail}</Text>
      </Box>
    </Box>
  );
};
