/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BackgroundTasksDialog — overlay with two modes (`list`, `detail`).
 * Key handling is scoped to this component; the composer is muted via
 * the `bgDialogOpen` branch in InputPrompt while the dialog is open.
 */

import type React from 'react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import {
  useBackgroundTaskViewState,
  useBackgroundTaskViewActions,
} from '../../contexts/BackgroundTaskViewContext.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { MaxSizedBox } from '../shared/MaxSizedBox.js';
import { theme } from '../../semantic-colors.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import {
  buildBackgroundEntryLabel,
  ToolDisplayNames,
  ToolNames,
  type BackgroundTaskEntry,
} from '@qwen-code/qwen-code-core';
import { formatDuration, formatTokenCount } from '../../utils/formatters.js';
import {
  type AgentDialogEntry,
  type DialogEntry,
  entryId,
} from '../../hooks/useBackgroundTaskView.js';

// `DialogEntry['status']` widens the shell status union with the agent-only
// `paused` state, so dialog handlers can switch on a single combined enum.
type EntryStatus = DialogEntry['status'];

// Tool-name → display-name lookup (`run_shell_command` → `Shell`).
const TOOL_DISPLAY_BY_NAME: Record<string, string> = Object.fromEntries(
  (Object.keys(ToolNames) as Array<keyof typeof ToolNames>).map((key) => [
    ToolNames[key],
    ToolDisplayNames[key],
  ]),
);

function formatActivityLabel(name: string, description: string | undefined) {
  const display = TOOL_DISPLAY_BY_NAME[name] ?? name;
  const singleLineDesc = description
    ? description.replace(/\s*\n\s*/g, ' ').trim()
    : '';
  return singleLineDesc ? `${display}(${singleLineDesc})` : display;
}

const STATUS_VERBS: Record<EntryStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
};

interface StatusPresentation {
  icon: string;
  color: string;
  labelColor: string;
}

function terminalStatusPresentation(
  status: EntryStatus,
): StatusPresentation | null {
  switch (status) {
    case 'paused':
      return {
        icon: '\u23F8',
        color: theme.status.warning,
        labelColor: theme.status.warningDim,
      };
    case 'completed':
      return {
        icon: '\u2714',
        color: theme.status.success,
        labelColor: theme.text.secondary,
      };
    case 'failed':
      return {
        icon: '\u2716',
        color: theme.status.error,
        labelColor: theme.status.errorDim,
      };
    case 'cancelled':
      return {
        icon: '\u2716',
        color: theme.status.warning,
        labelColor: theme.status.warningDim,
      };
    default:
      return null;
  }
}

function rowLabel(entry: DialogEntry): string {
  if (entry.kind === 'agent') {
    return buildBackgroundEntryLabel(entry, { includePrefix: false });
  }
  // Shell row: `[shell] <command>`. Prefix mirrors the dialog's "section"
  // visual hint without needing per-kind section headers (which would
  // complicate the windowing math). The command itself is plain text and
  // already truncated by the row renderer's MaxSizedBox.
  return `[shell] ${entry.command}`;
}

function elapsedFor(entry: { startTime: number; endTime?: number }): string {
  const elapsedMs = Math.max(
    0,
    (entry.endTime ?? Date.now()) - entry.startTime,
  );
  // Round down to whole seconds — the detail subtitle is a glanceable
  // indicator, not a stopwatch, and sub-second precision flickers distract
  // from the actual status change.
  const wholeSeconds = Math.floor(elapsedMs / 1000);
  return formatDuration(wholeSeconds * 1000, { hideTrailingZeros: true });
}

// Manually truncate to an exact cell width so each row lines up with the
// others regardless of content length. Relying on Ink's `wrap="truncate-end"`
// inside MaxSizedBox produced inconsistent row widths when some rows fit and
// others needed ellipsis, breaking the left-column alignment of the prefix.
function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;
  const ellipsis = '…';
  const ellipsisWidth = stringWidth(ellipsis);
  const target = Math.max(0, maxWidth - ellipsisWidth);
  let width = 0;
  let result = '';
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (width + charWidth > target) break;
    width += charWidth;
    result += char;
  }
  return result + ellipsis;
}

// ─── List mode ─────────────────────────────────────────────

const ListBody: React.FC<{
  entries: readonly DialogEntry[];
  selectedIndex: number;
  maxRows: number;
}> = ({ entries, selectedIndex, maxRows }) => {
  // Keep the "Background tasks (N)" section header rendered even when the
  // list is empty, so the overlay doesn't collapse into a single line of
  // empty-state text when the last task finishes while the dialog is open.
  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text bold>Background tasks</Text>
          <Text color={theme.text.secondary}> (0)</Text>
        </Box>
        <Box paddingX={1}>
          <Text color={theme.text.secondary}>No tasks currently running</Text>
        </Box>
      </Box>
    );
  }

  // Window entries around selectedIndex. When the list fits, show
  // everything; otherwise centre the selection and clamp to the ends.
  // "+N more above/below" lines consume one row each on the respective
  // side, so subtract them from the available row budget.
  const fits = entries.length <= maxRows;
  const effectiveRows = Math.max(1, fits ? maxRows : maxRows - 2);
  const windowStart = fits
    ? 0
    : Math.max(
        0,
        Math.min(
          selectedIndex - Math.floor(effectiveRows / 2),
          entries.length - effectiveRows,
        ),
      );
  const windowEnd = fits
    ? entries.length
    : Math.min(entries.length, windowStart + effectiveRows);
  const hiddenAbove = windowStart;
  const hiddenBelow = entries.length - windowEnd;
  const visible = entries.slice(windowStart, windowEnd);

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text bold>Background tasks</Text>
        <Text color={theme.text.secondary}> ({entries.length})</Text>
      </Box>
      <Box flexDirection="column">
        {hiddenAbove > 0 && (
          <Box paddingX={1}>
            <Text color={theme.text.secondary}>
              {`  ^ ${hiddenAbove} more above`}
            </Text>
          </Box>
        )}
        {visible.map((entry, visibleIdx) => {
          const idx = windowStart + visibleIdx;
          const isSelected = idx === selectedIndex;
          const terminal = terminalStatusPresentation(entry.status);
          const labelColor = isSelected
            ? theme.text.accent
            : terminal
              ? terminal.labelColor
              : theme.text.primary;
          return (
            <Box key={entryId(entry)} flexDirection="row" paddingX={1}>
              <Text color={isSelected ? theme.text.accent : undefined}>
                {isSelected ? '> ' : '  '}
              </Text>
              <Text color={labelColor}>{rowLabel(entry)}</Text>
            </Box>
          );
        })}
        {hiddenBelow > 0 && (
          <Box paddingX={1}>
            <Text color={theme.text.secondary}>
              {`  v ${hiddenBelow} more below`}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

// ─── Detail mode ───────────────────────────────────────────

const DetailBody: React.FC<{
  entry: DialogEntry;
  maxHeight: number;
  maxWidth: number;
}> = ({ entry, maxHeight, maxWidth }) =>
  entry.kind === 'agent' ? (
    <AgentDetailBody entry={entry} maxHeight={maxHeight} maxWidth={maxWidth} />
  ) : (
    <ShellDetailBody entry={entry} maxHeight={maxHeight} maxWidth={maxWidth} />
  );

const AgentDetailBody: React.FC<{
  entry: AgentDialogEntry;
  maxHeight: number;
  maxWidth: number;
}> = ({ entry, maxHeight, maxWidth }) => {
  const title = `${entry.subagentType ?? 'Agent'} \u203A ${buildBackgroundEntryLabel(entry, { includePrefix: false })}`;

  const terminal = terminalStatusPresentation(entry.status);
  const dimSubtitleParts: string[] = [elapsedFor(entry)];
  if (entry.stats?.totalTokens) {
    dimSubtitleParts.push(
      `${formatTokenCount(entry.stats.totalTokens)} tokens`,
    );
  }
  if (entry.stats?.toolUses !== undefined) {
    dimSubtitleParts.push(
      `${entry.stats.toolUses} tool${entry.stats.toolUses === 1 ? '' : 's'}`,
    );
  }

  // Registry stores activities newest-last; keep that order so the live
  // row sits at the bottom of the Progress block. Cap at 5 in case the
  // registry ever raises its buffer.
  const activities = (entry.recentActivities ?? []).slice(-5);
  const blockedReason = entry.resumeBlockedReason;
  const hasError = Boolean(entry.error);
  const hasBlockedReason = Boolean(blockedReason);

  // Prompt: show at most 5 newline-delimited segments, each row truncated
  // to one visual line. Append an ellipsis if the source had more.
  const promptLines = entry.prompt ? entry.prompt.split('\n') : [];
  const visiblePromptLines = promptLines.slice(0, 5);
  const promptTruncated = promptLines.length > visiblePromptLines.length;
  if (promptTruncated && visiblePromptLines.length > 0) {
    const lastIdx = visiblePromptLines.length - 1;
    visiblePromptLines[lastIdx] =
      `${visiblePromptLines[lastIdx].trimEnd()}\u2026`;
  }

  return (
    <MaxSizedBox
      maxHeight={maxHeight}
      maxWidth={maxWidth}
      overflowDirection="bottom"
    >
      <Box>
        <Text bold color={theme.text.accent}>
          {title}
        </Text>
      </Box>
      <Box>
        {terminal && (
          <Text color={terminal.color}>
            {`${terminal.icon} ${STATUS_VERBS[entry.status]} \u00B7 `}
          </Text>
        )}
        <Text color={theme.text.secondary}>
          {dimSubtitleParts.join(' \u00B7 ')}
        </Text>
      </Box>

      {activities.length > 0 && (
        <Fragment>
          <Box />
          <Box>
            <Text bold dimColor>
              Progress
            </Text>
          </Box>
          {activities.map((a, i) => {
            const isLast = i === activities.length - 1;
            // ASCII `>` is unambiguously one cell wide in every terminal
            // font, so `> ` (2 cells) aligns with a two-space indent on the
            // other rows. Unicode chevrons rendered with inconsistent width
            // broke alignment in some fonts.
            const prefix = isLast ? '> ' : '  ';
            const label = truncateToWidth(
              formatActivityLabel(a.name, a.description),
              Math.max(0, maxWidth - stringWidth(prefix)),
            );
            return (
              <Box key={`${a.at}-${i}`}>
                <Text
                  color={isLast ? theme.text.primary : theme.text.secondary}
                >
                  {prefix}
                  {label}
                </Text>
              </Box>
            );
          })}
        </Fragment>
      )}

      {visiblePromptLines.length > 0 && (
        <Fragment>
          <Box />
          <Box>
            <Text bold dimColor>
              Prompt
            </Text>
          </Box>
          {visiblePromptLines.map((line, i) => (
            <Box key={`prompt-${i}`}>
              <Text wrap="truncate-end">{line || ' '}</Text>
            </Box>
          ))}
        </Fragment>
      )}

      {hasBlockedReason && (
        <Fragment>
          <Box />
          <Box>
            <Text bold color={theme.status.error}>
              Resume blocked
            </Text>
          </Box>
          <Box>
            <Text color={theme.status.error} wrap="wrap">
              {blockedReason}
            </Text>
          </Box>
        </Fragment>
      )}

      {hasError && (
        <Fragment>
          <Box />
          <Box>
            <Text bold color={theme.status.error}>
              Error
            </Text>
          </Box>
          <Box>
            <Text color={theme.status.error} wrap="wrap">
              {entry.error}
            </Text>
          </Box>
        </Fragment>
      )}
    </MaxSizedBox>
  );
};

const ShellDetailBody: React.FC<{
  entry: import('@qwen-code/qwen-code-core').BackgroundShellEntry;
  maxHeight: number;
  maxWidth: number;
}> = ({ entry, maxHeight, maxWidth }) => {
  const title = `Shell \u203A ${entry.command}`;

  const terminal = terminalStatusPresentation(entry.status);
  const dimSubtitleParts: string[] = [elapsedFor(entry)];
  if (entry.pid !== undefined) {
    dimSubtitleParts.push(`pid ${entry.pid}`);
  }
  if (entry.status === 'completed' && entry.exitCode !== undefined) {
    dimSubtitleParts.push(`exit ${entry.exitCode}`);
  }

  const hasError = entry.status === 'failed' && Boolean(entry.error);

  return (
    <MaxSizedBox
      maxHeight={maxHeight}
      maxWidth={maxWidth}
      overflowDirection="bottom"
    >
      <Box>
        <Text bold color={theme.text.accent}>
          {title}
        </Text>
      </Box>
      <Box>
        {terminal && (
          <Text color={terminal.color}>
            {`${terminal.icon} ${STATUS_VERBS[entry.status]} \u00B7 `}
          </Text>
        )}
        <Text color={theme.text.secondary}>
          {dimSubtitleParts.join(' \u00B7 ')}
        </Text>
      </Box>

      <Box />
      <Box>
        <Text bold dimColor>
          Working dir
        </Text>
      </Box>
      <Box>
        <Text wrap="truncate-end">{entry.cwd}</Text>
      </Box>

      <Box />
      <Box>
        <Text bold dimColor>
          Output file
        </Text>
      </Box>
      <Box>
        <Text wrap="truncate-end">{entry.outputPath}</Text>
      </Box>

      {hasError && (
        <Fragment>
          <Box />
          <Box>
            <Text bold color={theme.status.error}>
              Error
            </Text>
          </Box>
          <Box>
            <Text color={theme.status.error} wrap="wrap">
              {entry.error}
            </Text>
          </Box>
        </Fragment>
      )}
    </MaxSizedBox>
  );
};

// ─── Dialog shell ──────────────────────────────────────────

interface BackgroundTasksDialogProps {
  availableTerminalHeight: number;
  terminalWidth: number;
}

export const BackgroundTasksDialog: React.FC<BackgroundTasksDialogProps> = ({
  availableTerminalHeight,
  terminalWidth,
}) => {
  const { entries, selectedIndex, dialogOpen, dialogMode } =
    useBackgroundTaskViewState();
  const {
    moveSelectionUp,
    moveSelectionDown,
    closeDialog,
    enterDetail,
    exitDetail,
    cancelSelected,
    resumeSelected,
  } = useBackgroundTaskViewActions();
  const config = useConfig();

  // Progress and Prompt are each self-capped at 5 rows inside DetailBody,
  // so the body never grows unbounded. Use all available height (minus the
  // dialog chrome) as the MaxSizedBox budget so nothing gets clipped just
  // because the terminal is short. Chrome = border(2) + title(1) + two
  // marginTops(2) + hint(1) = 6 rows.
  const detailContentHeight = Math.max(10, availableTerminalHeight - 6);
  // Rounded border + paddingX=1 on the outer Box ≈ 4 horizontal cells.
  const detailContentWidth = Math.max(10, terminalWidth - 4);

  // List mode row budget: terminal height minus chrome (border 2 + title 1
  // + two marginTops 2 + hint 1) and list header ("N active agents" 1 +
  // marginTop 1 + "Background tasks (N)" 1) = 10.
  const listMaxRows = Math.max(3, availableTerminalHeight - 10);

  // Activity tick — bumped whenever the watched agent emits an activity
  // update, *and* used as a useMemo dep below to refresh the live agent
  // entry from the registry. The snapshot in useBackgroundTaskView
  // intentionally only refreshes on `statusChange` (so the footer pill
  // and AppContainer stay quiet during heavy tool traffic), but the
  // detail body must see fresh `recentActivities` / `stats` between
  // those transitions — so we re-read from the registry here.
  const [activityTick, setActivityTick] = useState(0);

  const selectedEntry = useMemo(() => {
    const fromSnapshot = entries[selectedIndex] ?? null;
    if (!fromSnapshot || fromSnapshot.kind !== 'agent') return fromSnapshot;
    // Re-read the agent from the registry so detail-body fields the
    // registry mutates between status transitions (recentActivities,
    // stats) are fresh. The shallow spread inside useBackgroundTaskView
    // captures `recentActivities` at refresh time, and `appendActivity`
    // reassigns `entry.recentActivities = next` on the registry object —
    // so the snapshot's reference is detached after the first activity.
    const live = config.getBackgroundTaskRegistry().get(fromSnapshot.agentId);
    return live ? { ...live, kind: 'agent' as const } : fromSnapshot;
    // activityTick is a dep on purpose: the registry mutation is invisible
    // to useMemo otherwise and we need to recompute on each activity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, selectedIndex, config, activityTick]);

  const selectedEntryId = selectedEntry ? entryId(selectedEntry) : undefined;
  // Activity callback is agent-only — shells don't emit per-tool events.
  const selectedAgentIdForActivity =
    selectedEntry?.kind === 'agent' ? selectedEntry.agentId : undefined;
  useEffect(() => {
    if (!dialogOpen || dialogMode !== 'detail' || !selectedAgentIdForActivity)
      return;
    const registry = config.getBackgroundTaskRegistry();
    const onActivity = (entry: BackgroundTaskEntry) => {
      if (entry.agentId !== selectedAgentIdForActivity) return;
      setActivityTick((n) => n + 1);
    };
    registry.setActivityChangeCallback(onActivity);
    return () => registry.setActivityChangeCallback(undefined);
  }, [dialogOpen, dialogMode, config, selectedAgentIdForActivity]);

  // Wall-clock tick for the running agent's duration. Activity callbacks
  // fire when tools run, but duration needs to advance even when the agent
  // is quietly thinking — otherwise the "33s" line freezes between tool uses.
  const selectedStatus = selectedEntry?.status;
  useEffect(() => {
    if (
      !dialogOpen ||
      dialogMode !== 'detail' ||
      !selectedEntryId ||
      selectedStatus !== 'running'
    )
      return;
    const id = setInterval(() => setActivityTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [dialogOpen, dialogMode, selectedEntryId, selectedStatus]);

  // Auto-fallback to the list view when the selected agent reaches a
  // terminal state while the user is watching it live. We only exit on
  // the running → terminal *transition* — if the user deliberately
  // opened an already-completed entry, they stay on it. The detail
  // view itself renders terminal state fine, so this is a UX choice
  // (return focus to the running roster) rather than a correctness fix.
  const initialDetailStatusRef = useRef<{
    entryId: string;
    status: EntryStatus;
  } | null>(null);
  useEffect(() => {
    if (!dialogOpen || dialogMode !== 'detail') {
      initialDetailStatusRef.current = null;
      return;
    }
    // Defensive fallback: if the viewed entry has somehow gone missing,
    // drop back to the list so we don't sit on a "No entry to show" screen.
    // Hitting this path now is unlikely — terminal entries stay in the
    // registry — but the entry could disappear if the registry is reset.
    if (!selectedEntryId) {
      initialDetailStatusRef.current = null;
      exitDetail();
      return;
    }
    const seen = initialDetailStatusRef.current;
    if (!seen || seen.entryId !== selectedEntryId) {
      // First render in detail mode for this entry — remember the status we
      // opened with so we can detect a transition away from 'running' later.
      if (selectedStatus) {
        initialDetailStatusRef.current = {
          entryId: selectedEntryId,
          status: selectedStatus,
        };
      }
      return;
    }
    if (
      seen.status === 'running' &&
      selectedStatus &&
      selectedStatus !== 'running'
    ) {
      exitDetail();
    }
  }, [dialogOpen, dialogMode, selectedEntryId, selectedStatus, exitDetail]);

  useKeypress(
    (key) => {
      if (!dialogOpen) return;

      if (dialogMode === 'list') {
        if (key.name === 'up') {
          moveSelectionUp();
          return;
        }
        if (key.name === 'down') {
          moveSelectionDown();
          return;
        }
        if (key.name === 'return') {
          if (selectedEntry) enterDetail();
          return;
        }
        if (key.name === 'escape' || key.name === 'left') {
          closeDialog();
          return;
        }
        if (key.sequence === 'r' && !key.ctrl && !key.meta) {
          void resumeSelected();
          return;
        }
        if (key.sequence === 'x' && !key.ctrl && !key.meta) {
          cancelSelected();
          return;
        }
        // Note: the "stop all agents" chord (ctrl+x ctrl+k in claw-code)
        // is intentionally deferred. `useKeypress` fires per keystroke,
        // so collapsing the chord to plain ctrl+k makes a destructive
        // action too easy to trigger by mistake. Stop-all will land in
        // a follow-up PR once proper chord handling is in place.
        return;
      }

      // detail mode
      if (key.name === 'left') {
        exitDetail();
        return;
      }
      if (
        key.name === 'escape' ||
        key.name === 'return' ||
        key.name === 'space'
      ) {
        closeDialog();
        return;
      }
      if (key.sequence === 'r' && !key.ctrl && !key.meta) {
        void resumeSelected();
        return;
      }
      if (key.sequence === 'x' && !key.ctrl && !key.meta) {
        cancelSelected();
        return;
      }
    },
    { isActive: dialogOpen },
  );

  if (!dialogOpen) return null;

  const selectedEntryAllowsResume =
    selectedEntry?.kind === 'agent' &&
    selectedEntry.status === 'paused' &&
    !selectedEntry.resumeBlockedReason;

  // Hint footer — context-sensitive.
  const hints: string[] = [];
  if (dialogMode === 'list') {
    hints.push('\u2191/\u2193 select', 'Enter view');
    if (selectedEntry?.status === 'running') hints.push('x stop');
    if (selectedEntryAllowsResume) hints.push('r resume');
    if (selectedEntry?.kind === 'agent' && selectedEntry.status === 'paused') {
      hints.push('x abandon');
    }
    hints.push('\u2190/Esc close');
  } else {
    hints.push('\u2190 go back', 'Esc/Enter/Space close');
    if (selectedEntry?.status === 'running') hints.push('x stop');
    if (selectedEntryAllowsResume) hints.push('r resume');
    if (selectedEntry?.kind === 'agent' && selectedEntry.status === 'paused') {
      hints.push('x abandon');
    }
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      marginTop={1}
      paddingX={1}
    >
      {dialogMode === 'list' && (
        <Box paddingX={1}>
          <Text bold color={theme.text.accent}>
            Background tasks
          </Text>
        </Box>
      )}
      <Box marginTop={dialogMode === 'list' ? 1 : 0}>
        {dialogMode === 'list' ? (
          <ListBody
            entries={entries}
            selectedIndex={selectedIndex}
            maxRows={listMaxRows}
          />
        ) : selectedEntry ? (
          <DetailBody
            entry={selectedEntry}
            maxHeight={detailContentHeight}
            maxWidth={detailContentWidth}
          />
        ) : (
          <Box paddingX={1}>
            <Text color={theme.text.secondary}>No entry to show.</Text>
          </Box>
        )}
      </Box>
      <Box marginTop={1} paddingX={1}>
        <Text color={theme.text.secondary}>{hints.join(' \u00B7 ')}</Text>
      </Box>
    </Box>
  );
};
