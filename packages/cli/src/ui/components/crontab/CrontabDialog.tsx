/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * @fileoverview /crontab dialog — interactive TUI for managing scheduled
 * loops, cron jobs, and ScheduleWakeup timers. Renders directly without
 * LLM involvement, similar to /permissions.
 */

import type React from 'react';
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { BaseTabDialog, type TabItem } from '../shared/BaseTabDialog.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from '../shared/RadioButtonSelect.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { useRegisterKeyboardContext } from '../../contexts/KeyboardContextRegistry.js';
import type { ShortcutHint } from '../../hooks/useContainerKeyboard.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { theme } from '../../semantic-colors.js';
import {
  type CronTask,
  type CronManager,
  readCronTasks,
  nextCronRunMs,
  cronToHuman,
  CONFIG_DIR,
} from '@qwen-code/core';

// ── Types ────────────────────────────────────────────────────────────────────

type CrontabTab = 'session' | 'persistent' | 'wakeup';

interface CrontabDialogProps {
  onExit: (result?: string) => void;
}

/**
 * The cron manager of the session this dialog is open in.
 *
 * Every read and write in this file goes through it. The dialog used to call
 * module-level functions that named no session, which is fine while one process
 * shows one /crontab and wrong the moment a second session shares the process:
 * the panel would list, edit, claim and delete whichever session's in-memory
 * tasks and wakeup timer happened to be in the shared slot.
 */
function useCronManager(): CronManager {
  return useConfig().getCronManager();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SENTINEL_RE =
  /<<(?:loop\.md(?:-dynamic)?|autonomous-loop(?:-dynamic)?)>>[\n]?/g;

/** Strip sentinel markers for display/editing. */
function stripSentinels(str: string): string {
  return str.replace(SENTINEL_RE, '').trim();
}

/** Extract sentinel prefix from a prompt (if any). */
function extractSentinelPrefix(str: string): string {
  const match = str.match(
    /^(<<(?:loop\.md(?:-dynamic)?|autonomous-loop(?:-dynamic)?)>>[\n]?)/,
  );
  return match ? match[1] : '';
}

function truncate(str: string, max: number): string {
  const cleaned = stripSentinels(str);
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '\u2026' : cleaned;
}

/** Convert human interval (5m, 2h, 30s, 1d) to cron expression. */
function intervalToCron(interval: string): string | null {
  const match = interval.trim().match(/^(\d+)\s*([smhd])$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (n <= 0) return null;
  switch (unit) {
    case 's':
      return `*/${Math.max(1, Math.ceil(n / 60))} * * * *`;
    case 'm':
      return n <= 59 ? `*/${n} * * * *` : `0 */${Math.round(n / 60)} * * *`;
    case 'h':
      return `0 */${n} * * *`;
    case 'd':
      return `0 0 */${n} * *`;
    default:
      return null;
  }
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatRelative(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return 'now';
  const secs = Math.round(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h ${mins % 60}m`;
}

// ── Component ────────────────────────────────────────────────────────────────

export function CrontabDialog({
  onExit,
}: CrontabDialogProps): React.JSX.Element {
  useRegisterKeyboardContext('Dialog', true);
  const cronManager = useCronManager();

  const [activeTab, setActiveTab] = useState<CrontabTab>('session');
  const [sessionTasks, setSessionTasks] = useState<CronTask[]>([]);
  const [persistentTasks, setPersistentTasks] = useState<CronTask[]>([]);
  const [wakeupTime, setWakeupTime] = useState<number | null>(null);
  const [changes, setChanges] = useState<string[]>([]);
  const [selectedTask, setSelectedTask] = useState<CronTask | undefined>();
  const [viewingWakeup, setViewingWakeup] = useState(false);

  // Load tasks on mount and after mutations
  const refreshTasks = useCallback(async () => {
    const session = cronManager.getSessionTasks();
    const persistent = await readCronTasks();
    const wakeup = cronManager.getPendingWakeupTime();
    setSessionTasks(session);
    setPersistentTasks(persistent);
    setWakeupTime(wakeup);
  }, [cronManager]);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  // Delete a task
  const handleDeleteTask = useCallback(
    async (task: CronTask) => {
      await cronManager.removeTasks([task.id]);
      setChanges((prev) => [
        ...prev,
        `Deleted: ${task.id} (${truncate(task.prompt, 40)})`,
      ]);
      setSelectedTask(undefined);
      await refreshTasks();
    },
    [cronManager, refreshTasks],
  );

  // Cancel wakeup
  const handleCancelWakeup = useCallback(() => {
    const cancelled = cronManager.cancelWakeup();
    if (cancelled) {
      setChanges((prev) => [...prev, 'Cancelled pending ScheduleWakeup timer']);
    }
    setWakeupTime(null);
  }, [cronManager]);

  // Close handler
  const handleClose = useCallback(() => {
    const result =
      changes.length > 0
        ? `Crontab changes:\n${changes.map((c) => `  • ${c}`).join('\n')}`
        : undefined;
    onExit(result);
  }, [changes, onExit]);

  // Tab definitions
  const tabs: TabItem[] = useMemo(
    () => [
      { key: 'session', label: `Session (${sessionTasks.length})` },
      { key: 'persistent', label: `Persistent (${persistentTasks.length})` },
      { key: 'wakeup', label: wakeupTime ? 'Wakeup (1)' : 'Wakeup (0)' },
    ],
    [sessionTasks.length, persistentTasks.length, wakeupTime],
  );

  // Keyboard hints
  const extraHints: ShortcutHint[] = useMemo(
    () => [
      { label: '↑↓ navigate', order: 10 },
      { label: 'Enter view details', order: 20 },
    ],
    [],
  );

  // Task detail sub-screen
  if (selectedTask) {
    return (
      <TaskDetailView
        task={selectedTask}
        isSessionTask={sessionTasks.some((t) => t.id === selectedTask.id)}
        onDelete={() => void handleDeleteTask(selectedTask)}
        onBack={() => setSelectedTask(undefined)}
        onExpiryChanged={() => {
          setSelectedTask(undefined);
          void refreshTasks();
        }}
      />
    );
  }

  // Wakeup detail sub-screen
  if (viewingWakeup) {
    return (
      <WakeupDetailView
        onCancel={() => {
          handleCancelWakeup();
          setViewingWakeup(false);
        }}
        onBack={() => setViewingWakeup(false)}
      />
    );
  }

  return (
    <BaseTabDialog
      title="Crontab"
      tabs={tabs}
      activeKey={activeTab}
      onTabChange={(key) => setActiveTab(key as CrontabTab)}
      onClose={handleClose}
      isActive={true}
      showSeparator={true}
      showContent={true}
      extraHints={extraHints}
    >
      {activeTab === 'session' && (
        <CrontabTabContent
          tasks={sessionTasks}
          onSelect={setSelectedTask}
          onDelete={handleDeleteTask}
          isSessionTab={true}
          emptyMessage="No session-only tasks. Tasks created without durable:true live here."
        />
      )}
      {activeTab === 'persistent' && (
        <CrontabTabContent
          tasks={persistentTasks}
          onSelect={setSelectedTask}
          onDelete={handleDeleteTask}
          showExpiry={true}
          emptyMessage={`No persistent tasks. Tasks in ${CONFIG_DIR}/scheduled_tasks.json appear here.`}
        />
      )}
      {activeTab === 'wakeup' && (
        <WakeupTabContent
          wakeupTime={wakeupTime}
          onSelect={() => setViewingWakeup(true)}
        />
      )}
    </BaseTabDialog>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

interface CrontabTabContentProps {
  tasks: CronTask[];
  onSelect: (task: CronTask) => void;
  onDelete: (task: CronTask) => void;
  emptyMessage: string;
  showExpiry?: boolean;
  /** True for the Session tab — suppresses ownership tags and grouping. */
  isSessionTab?: boolean;
}

function getShortExpiry(task: CronTask): string {
  if (task.permanent) return '∞';
  if (task.expiresAt) {
    const diff = task.expiresAt - Date.now();
    if (diff <= 0) return 'expired';
    const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
    return `${days}d`;
  }
  // Default: 7 days from creation
  const remaining = Math.ceil(
    (task.createdAt + 7 * 24 * 60 * 60 * 1000 - Date.now()) /
      (24 * 60 * 60 * 1000),
  );
  return remaining > 0 ? `${remaining}d` : 'expired';
}

/**
 * Ownership group for display ordering. Lower sorts first.
 * 0 = this session (actionable), 1 = unclaimed (needs a decision),
 * 2 = another session (read-only, sinks to the bottom).
 *
 * Session-only tasks are exempt: they live in this session's own store, always
 * fire, and never carry createdBySessionId — classifying them would label
 * every one of them 'unclaimed', which is both wrong and unactionable.
 */
function ownershipRank(
  task: CronTask,
  isSessionTask: boolean,
  ownerSessionId: string,
): number {
  if (isSessionTask) return 0;
  if (task.createdBySessionId === ownerSessionId) return 0;
  if (!task.createdBySessionId) return 1;
  return 2;
}

/** Next fire time for sorting; tasks that never fire sort last within their group. */
function nextFireForSort(task: CronTask): number {
  const anchor = task.lastFiredAt ?? task.createdAt;
  return nextCronRunMs(task.cron, anchor) ?? Number.POSITIVE_INFINITY;
}

/**
 * Shorten a session UUID for list rows. 8 chars matches the width of the
 * task ids shown in the same column layout; the full id is on the detail page.
 */
function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Column widths for the task table, in terminal columns.
 *
 * Alignment is done with fixed-width ink Boxes rather than padEnd, because
 * padEnd counts JS characters while a terminal lays out by display width — CJK
 * and emoji are double-width, so a padded string of 24 characters can occupy
 * 48 columns and drag every later column out of line. ink measures display
 * width, so a Box of width N is genuinely N columns wide whatever it contains.
 */
const COL_SCHEDULE = 24;
const COL_EXPIRY = 8;
/**
 * Fits "3/10 turns · 12.5/50 credits" (28 columns), the shape this cell takes for
 * ordinary numbers. Three-digit ceilings run a little longer and truncate, which
 * is the right trade: widening for them would cost the prompt column on every row.
 */
const COL_USAGE = 30;
const COL_OWNER = 24;
/** Prompt never shrinks below this before wider columns start dropping. */
const COL_PROMPT_MIN = 20;

/**
 * Widest gutter BaseSelectionList can draw before our content. Used only for
 * the fit calculation below.
 */
const LEFT_GUTTER_MAX = 8;

/**
 * Which optional columns fit the current terminal. Dropped right-to-left so the
 * prompt, the only column carrying task-specific content, keeps its room.
 *
 * The owner column is suppressed on the Session tab regardless of width:
 * session tasks belong to this process by definition and never carry an owner,
 * so the column would be a permanently blank heading.
 *
 * Usage is shown on both tabs. A session task's counters live in memory and die
 * with the process, but so does the task, and while it is running its cost is as
 * worth knowing as any other's.
 */
function visibleColumns(
  terminalWidth: number,
  showExpiry: boolean,
  isSessionTab: boolean,
): { expiry: boolean; usage: boolean; owner: boolean } {
  const base = LEFT_GUTTER_MAX + COL_SCHEDULE + COL_PROMPT_MIN;
  let budget = terminalWidth - base;
  const expiry = showExpiry && budget >= COL_EXPIRY;
  if (expiry) budget -= COL_EXPIRY;
  const usage = budget >= COL_USAGE;
  if (usage) budget -= COL_USAGE;
  const owner = !isSessionTab && budget >= COL_OWNER;
  return { expiry, usage, owner };
}

/**
 * Spend against ceiling, or empty when there is nothing to say.
 *
 * A ceiling is shown even before the task has fired, because a limit the user set
 * should be visible from the list rather than only in the detail view. Cost is
 * omitted rather than zeroed when no turn was metered: "0 credits" reads as free,
 * which is a different claim from unmeasured.
 *
 * "credits" is spelled out. The column is wide enough for it, and an abbreviation
 * saves a few characters at the cost of making the reader decode the unit of the
 * one number here that is money.
 */
function usageCell(task: CronTask): string {
  const parts: string[] = [];
  const fires = task.fireCount ?? 0;
  if (task.maxTurns !== undefined) {
    parts.push(`${fires}/${task.maxTurns} turns`);
  } else if (fires > 0) {
    parts.push(`${fires} turn${fires === 1 ? '' : 's'}`);
  }
  if (task.maxCredits !== undefined) {
    // Em dash, not 0, and the same glyph the detail view uses. A task with a
    // ceiling it has not been metered against has an unknown spend; "0/50" would
    // report it as having cost nothing, which is a different claim.
    const spent =
      task.creditsUsed !== undefined ? formatCredits(task.creditsUsed) : '—';
    parts.push(`${spent}/${task.maxCredits} credits`);
  } else if (task.creditsUsed !== undefined) {
    // Compared on the number, not the formatted string: formatCredits(1) is
    // "1.00", which never equals "1", so a string comparison here would spell
    // "1.00 credits" and never reach the singular at all.
    const spent = formatCredits(task.creditsUsed);
    parts.push(`${spent} credit${task.creditsUsed === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

function CrontabTabContent({
  tasks,
  onSelect,
  emptyMessage,
  showExpiry = false,
  isSessionTab = false,
}: CrontabTabContentProps): React.JSX.Element {
  const { columns: terminalWidth } = useTerminalSize();
  const ownerSessionId = useCronManager().getSessionId();

  if (tasks.length === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>{emptyMessage}</Text>
      </Box>
    );
  }

  // Display order: ownership group, then soonest fire first. Purely a view
  // concern — the on-disk task order is left untouched.
  const ordered = [...tasks].sort((a, b) => {
    const rankDiff =
      ownershipRank(a, isSessionTab, ownerSessionId) -
      ownershipRank(b, isSessionTab, ownerSessionId);
    if (rankDiff !== 0) return rankDiff;
    return nextFireForSort(a) - nextFireForSort(b);
  });

  const items: Array<RadioSelectItem<CronTask>> = ordered.map((t) => ({
    key: t.id,
    // Kept as a plain-text digest for accessibility and for any consumer that
    // reads label rather than the rendered tree; the visible row comes from
    // renderTaskRow below.
    label: `${t.cron} ${cronToHuman(t.cron)} ${stripSentinels(t.prompt)}`,
    value: t,
  }));

  const cols = visibleColumns(terminalWidth, showExpiry, isSessionTab);
  const numberColWidth = String(ordered.length).length + 1;
  // Indent that puts the header above the values. BaseSelectionList draws
  // 1 padding space + a 2-column indicator + the item number + its 1 margin
  // before handing us a row, and numberColWidth already carries the number's
  // trailing dot, so that gutter is numberColWidth + 4. The enclosing panel
  // offsets the header line and the rows equally, so matching this one number
  // is enough. Pinned by the layout test.
  const gutter = numberColWidth + 4;
  // The task column gets an explicit width rather than flexGrow. The header and
  // the rows live in different flex parents (rows are nested inside
  // BaseSelectionList's own row Box), so a grow factor resolves to different
  // widths in each and the columns drift apart. One computed number used by
  // both keeps them locked together.
  const promptWidth = Math.max(
    COL_PROMPT_MIN,
    terminalWidth -
      gutter -
      COL_SCHEDULE -
      (cols.expiry ? COL_EXPIRY : 0) -
      (cols.usage ? COL_USAGE : 0) -
      (cols.owner ? COL_OWNER : 0) -
      1,
  );

  const renderTaskRow = (
    item: RadioSelectItem<CronTask>,
    { titleColor, isSelected }: { titleColor?: string; isSelected?: boolean },
  ): React.ReactNode => {
    const t = item.value;
    const rank = ownershipRank(t, isSessionTab, ownerSessionId);
    // No warning glyph here: U+26A0 has ambiguous width, so ink measures it as
    // one column while many terminals draw it as two. That shifts everything
    // after it and breaks the very column alignment this table exists for.
    const owner =
      rank === 0
        ? 'this session'
        : rank === 1
          ? 'unclaimed'
          : `other session: ${shortSessionId(t.createdBySessionId!)}`;
    const human = cronToHuman(t.cron);
    // Every expression is phraseable now, but stay defensive: never print the
    // expression twice if cronToHuman ever falls back again.
    const humanReads = human !== t.cron ? human : '';
    // The whole row takes the selection colour, the reading line included.
    // Leaving it dim made a selected row look half-highlighted.
    const secondary = isSelected ? titleColor : theme.text.secondary;

    return (
      <Box flexDirection="column">
        {/* First line: the aligned columns. Only the raw expression sits in the
            schedule column; the human reading gets its own line below. */}
        <Box flexDirection="row" overflow="hidden">
          <Box width={COL_SCHEDULE} flexShrink={0}>
            <Text color={titleColor} wrap="truncate">
              {t.cron}
            </Text>
          </Box>

          {/* Task prompt. An explicit width, shared with the header, is what
              keeps the columns to its right aligned across rows. ink truncates by
              display width, so a CJK prompt fills the column rather than being
              cut at a character count. */}
          <Box
            width={promptWidth}
            flexShrink={0}
            paddingRight={1}
            overflow="hidden"
          >
            <Text color={titleColor} wrap="truncate">
              {stripSentinels(t.prompt)}
              {t.permanent ? ' ●' : ''}
            </Text>
          </Box>

          {cols.expiry && (
            <Box width={COL_EXPIRY} flexShrink={0}>
              <Text color={secondary} wrap="truncate">
                {getShortExpiry(t)}
              </Text>
            </Box>
          )}

          {cols.usage && (
            <Box width={COL_USAGE} flexShrink={0}>
              <Text color={secondary} wrap="truncate">
                {usageCell(t)}
              </Text>
            </Box>
          )}

          {cols.owner && (
            <Box width={COL_OWNER} flexShrink={0}>
              <Text
                color={
                  isSelected
                    ? titleColor
                    : rank === 0
                      ? theme.status.success
                      : rank === 1
                        ? theme.status.warning
                        : theme.status.error
                }
                wrap="truncate"
              >
                {owner}
              </Text>
            </Box>
          )}
        </Box>

        {/* Second line: the human reading, on its own row. Nothing is to its
            right on this line, so it is free to run the full width instead of
            being clipped to the schedule column. */}
        {humanReads !== '' && (
          <Text color={secondary} wrap="truncate">
            {humanReads}
          </Text>
        )}
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      {/* Header rendered as one pre-padded line rather than a row of Boxes.
          padEnd is exact here because every title is ASCII — the double-width
          problem this feature fixes only arises in the data rows — and a single
          Text sidesteps the flex interactions that made a spacer sibling land
          a column off. Offsets mirror the Box widths used by renderTaskRow, so
          the titles sit above their values. */}
      <Text bold color={theme.text.secondary}>
        {' '.repeat(gutter) +
          'SCHEDULE'.padEnd(COL_SCHEDULE) +
          'TASK'.padEnd(promptWidth) +
          (cols.expiry ? 'EXPIRY'.padEnd(COL_EXPIRY) : '') +
          (cols.usage ? 'USAGE'.padEnd(COL_USAGE) : '') +
          (cols.owner ? 'OWNER' : '')}
      </Text>

      <RadioButtonSelect<CronTask>
        items={items}
        onSelect={onSelect}
        isFocused={true}
        maxItemsToShow={8}
        renderItem={renderTaskRow}
      />
    </Box>
  );
}

interface WakeupTabContentProps {
  onSelect: () => void;
  wakeupTime: number | null;
}

function WakeupTabContent({
  onSelect,
  wakeupTime,
}: WakeupTabContentProps): React.JSX.Element {
  const { columns: terminalWidth } = useTerminalSize();
  const cronManager = useCronManager();

  if (!wakeupTime) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>No pending ScheduleWakeup timer.</Text>
      </Box>
    );
  }

  // A wakeup has no cron expression, but it has the same two ideas: an exact
  // firing point and a reading of it. Rendering them the way the task tabs do
  // keeps all three tabs consistent.
  const details = cronManager.getWakeupDetails();
  const prompt = details?.prompt ? stripSentinels(details.prompt) : '';
  const gutter = 1 + 4;
  const promptWidth = Math.max(
    COL_PROMPT_MIN,
    terminalWidth - gutter - COL_SCHEDULE - 1,
  );

  const items: Array<RadioSelectItem<string>> = [
    {
      key: 'wakeup-timer',
      label: `${formatTime(wakeupTime)} in ${formatRelative(wakeupTime)} ${prompt}`,
      value: 'view',
    },
  ];

  const renderWakeupRow = (
    _item: RadioSelectItem<string>,
    { titleColor, isSelected }: { titleColor?: string; isSelected?: boolean },
  ): React.ReactNode => (
    <Box flexDirection="row" overflow="hidden">
      <Box width={COL_SCHEDULE} flexShrink={0} flexDirection="column">
        <Text color={titleColor} wrap="truncate">
          {formatTime(wakeupTime)}
        </Text>
        <Text
          color={isSelected ? titleColor : theme.text.secondary}
          wrap="truncate"
        >
          in {formatRelative(wakeupTime)}
        </Text>
      </Box>
      <Box
        width={promptWidth}
        flexShrink={0}
        paddingRight={1}
        overflow="hidden"
      >
        <Text color={titleColor} wrap="truncate">
          {prompt !== '' ? prompt : 'Loop wakeup'}
        </Text>
      </Box>
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Text bold color={theme.text.secondary}>
        {' '.repeat(gutter) +
          'NEXT FIRE'.padEnd(COL_SCHEDULE) +
          'TASK'.padEnd(promptWidth)}
      </Text>
      <RadioButtonSelect<string>
        items={items}
        onSelect={() => onSelect()}
        isFocused={true}
        renderItem={renderWakeupRow}
      />
    </Box>
  );
}

// ── Wakeup Detail View ─────────────────────────────────────────────────────

const WAKEUP_DELAY_OPTIONS = [
  { label: '30 seconds', seconds: 30 },
  { label: '1 minute', seconds: 60 },
  { label: '2 minutes', seconds: 120 },
  { label: '5 minutes', seconds: 300 },
  { label: '10 minutes', seconds: 600 },
  { label: '30 minutes', seconds: 1800 },
  { label: '1 hour', seconds: 3600 },
] as const;

interface WakeupDetailViewProps {
  onCancel: () => void;
  onBack: () => void;
}

function WakeupDetailView({
  onCancel,
  onBack,
}: WakeupDetailViewProps): React.JSX.Element {
  const cronManager = useCronManager();
  const details = cronManager.getWakeupDetails();
  const [editMode, setEditMode] = useState<'none' | 'delay' | 'prompt'>('none');
  const [selectionIdx, setSelectionIdx] = useState(0);
  const [editBuffer, setEditBuffer] = useState('');

  useInput((input, key) => {
    // Delay selection mode
    if (editMode === 'delay') {
      if (key.upArrow) setSelectionIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow)
        setSelectionIdx((i) =>
          Math.min(WAKEUP_DELAY_OPTIONS.length - 1, i + 1),
        );
      else if (key.return) {
        const choice = WAKEUP_DELAY_OPTIONS[selectionIdx];
        cronManager.updateWakeup({ delaySeconds: choice.seconds });
        setEditMode('none');
      } else if (key.escape) setEditMode('none');
      return;
    }

    // Prompt edit mode
    if (editMode === 'prompt') {
      if (key.return) {
        if (editBuffer.trim()) {
          cronManager.updateWakeup({ prompt: editBuffer.trim() });
        }
        setEditMode('none');
      } else if (key.escape) {
        setEditMode('none');
      } else if (key.backspace || key.delete) {
        setEditBuffer((b) => b.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setEditBuffer((b) => b + input);
      }
      return;
    }

    // Normal mode
    if (input === 'd' || input === 'D') {
      onCancel();
    } else if (input === 's' || input === 'S') {
      setSelectionIdx(0);
      setEditMode('delay');
    } else if (input === 'p' || input === 'P') {
      setEditBuffer(details?.prompt ?? '');
      setEditMode('prompt');
    } else if (key.escape) {
      onBack();
    }
  });

  if (!details) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>Wakeup timer already fired or was cancelled.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ┌─ ScheduleWakeup Timer
        </Text>
      </Box>
      <Text>
        <Text color="gray">│</Text> <Text bold>Next Fire</Text>{' '}
        {formatTime(details.scheduledAt)}{' '}
        <Text dimColor>(in {formatRelative(details.scheduledAt)})</Text>
      </Text>
      <Text>
        <Text color="gray">│</Text> <Text bold>Prompt</Text>{' '}
        {truncate(details.prompt, 100)}
      </Text>

      {editMode === 'delay' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            │ Reschedule wakeup:
          </Text>
          {WAKEUP_DELAY_OPTIONS.map((opt, i) => (
            <Text key={opt.seconds}>
              <Text color="gray">│</Text>{' '}
              {i === selectionIdx ? (
                <Text color="cyan" bold>
                  ▸ {opt.label}
                </Text>
              ) : (
                <Text dimColor> {opt.label}</Text>
              )}
            </Text>
          ))}
          <Text>
            <Text color="gray">│</Text>{' '}
            <Text dimColor>Enter confirm · Esc cancel</Text>
          </Text>
        </Box>
      ) : editMode === 'prompt' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            │ Edit prompt:
          </Text>
          <Text>
            <Text color="gray">│</Text> <Text color="cyan">{editBuffer}</Text>
            <Text color="gray">█</Text>
          </Text>
          <Text>
            <Text color="gray">│</Text>{' '}
            <Text dimColor>Enter save · Esc cancel · Backspace delete</Text>
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text>
            <Text color="gray">└─</Text>{' '}
            <Text color="red" bold>
              d
            </Text>
            <Text dimColor> cancel</Text>{' '}
            <Text color="blue" bold>
              s
            </Text>
            <Text dimColor> reschedule</Text>{' '}
            <Text color="magenta" bold>
              p
            </Text>
            <Text dimColor> prompt</Text>{' '}
            <Text color="yellow" bold>
              Esc
            </Text>
            <Text dimColor> back</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ── Task Detail View (with keyboard handling) ────────────────────────────────

interface TaskDetailViewProps {
  task: CronTask;
  /** True when the task lives in this process's session store (not on disk). */
  isSessionTask?: boolean;
  onDelete: () => void;
  onBack: () => void;
  onExpiryChanged: () => void;
}

function getExpiryLabel(task: CronTask): string {
  if (task.permanent) return 'Permanent (no expiry)';
  if (task.expiresAt)
    return `Expires ${formatTime(task.expiresAt)} (in ${formatRelative(task.expiresAt)})`;
  // Default: 7 days from creation
  const defaultExpiry = task.createdAt + 7 * 24 * 60 * 60 * 1000;
  return `Default 7d (${formatTime(defaultExpiry)})`;
}

const EXPIRY_OPTIONS = ['1d', '7d', '14d', '30d', '90d', 'permanent'] as const;

// Predefined schedule intervals (cron expressions)
const SCHEDULE_OPTIONS = [
  { label: 'Every 1 min', cron: '*/1 * * * *' },
  { label: 'Every 2 min', cron: '*/2 * * * *' },
  { label: 'Every 5 min', cron: '*/5 * * * *' },
  { label: 'Every 10 min', cron: '*/10 * * * *' },
  { label: 'Every 15 min', cron: '*/15 * * * *' },
  { label: 'Every 30 min', cron: '*/30 * * * *' },
  { label: 'Every 1 hour', cron: '0 */1 * * *' },
  { label: 'Every 2 hours', cron: '0 */2 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every 12 hours', cron: '0 */12 * * *' },
  { label: 'Every day', cron: '0 0 * * *' },
] as const;

/**
 * Credits at a precision that suits the magnitude.
 *
 * A fractional cost has to stay distinguishable from no cost, so small values
 * keep their decimals; large ones do not need them.
 */
function formatCredits(credits: number): string {
  if (credits === 0) return '0';
  if (credits < 0.01) return '<0.01';
  if (credits < 10) return credits.toFixed(2);
  if (credits < 100) return credits.toFixed(1);
  return String(Math.round(credits));
}

/**
 * What the task has spent, against whatever ceilings it carries.
 *
 * Rendered even with no ceilings set, because the spend is worth knowing on its
 * own; the row is dropped only when there is nothing at all to say, so a task
 * that has never fired adds no noise.
 *
 * Spend and ceiling are deliberately on the same line per dimension. Showing a
 * total without its limit invites the reader to guess how much room is left.
 */
function BudgetRows({ task }: { task: CronTask }): React.JSX.Element | null {
  const fires = task.fireCount ?? 0;
  const credits = task.creditsUsed;
  const hasTurnInfo = fires > 0 || task.maxTurns !== undefined;
  const hasCreditInfo = credits !== undefined || task.maxCredits !== undefined;
  if (!hasTurnInfo && !hasCreditInfo) return null;

  const turns =
    task.maxTurns !== undefined ? `${fires} / ${task.maxTurns}` : `${fires}`;
  // An unmetered task shows a dash rather than 0: nothing was measured, which is
  // a different claim from having cost nothing.
  const spend = credits !== undefined ? formatCredits(credits) : '—';
  const cost =
    task.maxCredits !== undefined ? `${spend} / ${task.maxCredits}` : spend;

  return (
    <Box flexDirection="column">
      {hasTurnInfo && (
        <Text>
          <Text color="gray">│</Text> <Text bold>Turns</Text> {turns}
          {task.maxTurns !== undefined ? (
            <Text dimColor> (stops at the limit)</Text>
          ) : (
            ''
          )}
        </Text>
      )}
      {hasCreditInfo && (
        <Text>
          <Text color="gray">│</Text> <Text bold>Credits</Text> {cost}
          {task.maxCredits !== undefined ? (
            <Text dimColor> (stops at the limit)</Text>
          ) : (
            ''
          )}
        </Text>
      )}
    </Box>
  );
}

function TaskDetailView({
  task,
  isSessionTask = false,
  onDelete,
  onBack,
  onExpiryChanged,
}: TaskDetailViewProps): React.JSX.Element {
  const cronManager = useCronManager();
  const ownerSessionId = cronManager.getSessionId();
  const [editMode, setEditMode] = useState<
    | 'none'
    | 'expiry'
    | 'schedule'
    | 'schedule-custom'
    | 'prompt'
    | 'max-turns'
    | 'max-credits'
  >('none');
  const [selectionIdx, setSelectionIdx] = useState(0);
  const [editBuffer, setEditBuffer] = useState('');
  // Preserve sentinel prefix for prompt editing
  const sentinelPrefix = extractSentinelPrefix(task.prompt);

  useInput((input, key) => {
    // Expiry selection mode
    if (editMode === 'expiry') {
      if (key.upArrow) setSelectionIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow)
        setSelectionIdx((i) => Math.min(EXPIRY_OPTIONS.length - 1, i + 1));
      else if (key.return) {
        const choice = EXPIRY_OPTIONS[selectionIdx];
        if (choice === 'permanent') {
          void cronManager
            .updateTask(task.id, { permanent: true, expiresAt: undefined })
            .then(onExpiryChanged);
        } else {
          const days = parseInt(choice, 10);
          const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
          void cronManager
            .updateTask(task.id, { permanent: false, expiresAt })
            .then(onExpiryChanged);
        }
        setEditMode('none');
      } else if (key.escape) setEditMode('none');
      return;
    }

    // Schedule selection mode (interactive picker)
    if (editMode === 'schedule') {
      if (key.upArrow) setSelectionIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow)
        setSelectionIdx((i) => Math.min(SCHEDULE_OPTIONS.length, i + 1)); // +1 for "Custom" option
      else if (key.return) {
        if (selectionIdx === SCHEDULE_OPTIONS.length) {
          // "Custom" selected → switch to text input
          setEditBuffer('');
          setEditMode('schedule-custom');
        } else {
          const choice = SCHEDULE_OPTIONS[selectionIdx];
          void cronManager
            .updateTask(task.id, { cron: choice.cron })
            .then(onExpiryChanged);
          setEditMode('none');
        }
      } else if (key.escape) setEditMode('none');
      return;
    }

    // Schedule custom input mode (e.g. "5m", "2h", "30s")
    if (editMode === 'schedule-custom') {
      if (key.return) {
        const cron = intervalToCron(editBuffer);
        if (cron) {
          void cronManager.updateTask(task.id, { cron }).then(onExpiryChanged);
          setEditMode('none');
        }
        // Invalid input — stay in edit mode (user can Esc to cancel)
      } else if (key.escape) {
        setEditMode('none');
      } else if (key.backspace || key.delete) {
        setEditBuffer((b) => b.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setEditBuffer((b) => b + input);
      }
      return;
    }

    // Ceiling entry. An empty value clears the ceiling rather than being rejected,
    // which is the only way to undo a limit from here.
    if (editMode === 'max-turns' || editMode === 'max-credits') {
      if (key.return) {
        const raw = editBuffer.trim();
        const field = editMode === 'max-turns' ? 'maxTurns' : 'maxCredits';
        if (raw === '') {
          void cronManager
            .updateTask(task.id, { [field]: undefined })
            .then(onExpiryChanged);
          setEditMode('none');
        } else {
          const value =
            editMode === 'max-turns' ? parseInt(raw, 10) : parseFloat(raw);
          if (Number.isFinite(value) && value > 0) {
            void cronManager
              .updateTask(task.id, { [field]: value })
              .then(onExpiryChanged);
            setEditMode('none');
          }
          // Anything else leaves the field open rather than silently accepting a
          // ceiling that would retire the task immediately. Esc cancels.
        }
      } else if (key.escape) {
        setEditMode('none');
      } else if (key.backspace || key.delete) {
        setEditBuffer((b) => b.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setEditBuffer((b) => b + input);
      }
      return;
    }

    // Prompt text edit mode (pre-filled with CLEAN content, sentinel preserved on save)
    if (editMode === 'prompt') {
      if (key.return) {
        if (editBuffer.trim()) {
          // Re-prepend sentinel prefix so loop.md injection keeps working
          const newPrompt = sentinelPrefix + editBuffer.trim();
          void cronManager
            .updateTask(task.id, { prompt: newPrompt })
            .then(onExpiryChanged);
        }
        setEditMode('none');
      } else if (key.escape) {
        setEditMode('none');
      } else if (key.backspace || key.delete) {
        setEditBuffer((b) => b.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setEditBuffer((b) => b + input);
      }
      return;
    }

    // Normal mode
    if (input === 'd' || input === 'D') onDelete();
    else if (input === 'e' || input === 'E') {
      setSelectionIdx(0);
      setEditMode('expiry');
    } else if (input === 's' || input === 'S') {
      // Find closest match to current cron
      const currentIdx = SCHEDULE_OPTIONS.findIndex(
        (o) => o.cron === task.cron,
      );
      setSelectionIdx(currentIdx >= 0 ? currentIdx : 0);
      setEditMode('schedule');
    } else if (input === 'p' || input === 'P') {
      // Strip sentinels for editing — user shouldn't see internal markers
      setEditBuffer(stripSentinels(task.prompt));
      setEditMode('prompt');
    } else if (input === 't' || input === 'T') {
      setEditBuffer(task.maxTurns !== undefined ? String(task.maxTurns) : '');
      setEditMode('max-turns');
    } else if (input === 'b' || input === 'B') {
      setEditBuffer(
        task.maxCredits !== undefined ? String(task.maxCredits) : '',
      );
      setEditMode('max-credits');
    } else if (input === 'c' || input === 'C') {
      // Claim this task for the current session. Session-only tasks are
      // already private to this session, so claiming them is meaningless.
      if (isSessionTask) return;
      if (task.createdBySessionId !== ownerSessionId) {
        void cronManager.claimTask(task.id).then(onExpiryChanged);
      }
    } else if (key.escape) onBack();
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ┌─ Task {task.id}
        </Text>
      </Box>

      {/* Schedule follows the same convention as the list: the expression
         first, its reading underneath. The reading is dropped when cronToHuman
         has nothing to add beyond the expression itself. */}
      <Text>
        <Text color="gray">│</Text> <Text bold>Schedule</Text> {task.cron}
      </Text>
      {cronToHuman(task.cron) !== task.cron && (
        <Text>
          <Text color="gray">│</Text>{' '}
          <Text dimColor>{cronToHuman(task.cron)}</Text>
        </Text>
      )}
      <Text>
        <Text color="gray">│</Text> <Text bold>Prompt</Text>{' '}
        {truncate(task.prompt, 100)}
      </Text>
      <Text>
        <Text color="gray">│</Text> <Text bold>Created</Text>{' '}
        {formatTime(task.createdAt)}
      </Text>
      {task.lastFiredAt && (
        <Text>
          <Text color="gray">│</Text> <Text bold>Last Fire</Text>{' '}
          {formatTime(task.lastFiredAt)}
        </Text>
      )}
      <Text>
        <Text color="gray">│</Text> <Text bold>Type</Text>{' '}
        {task.recurring ? 'Recurring' : 'One-shot'}
      </Text>
      <Text>
        <Text color="gray">│</Text> <Text bold>Expiry</Text>{' '}
        {getExpiryLabel(task)}
      </Text>
      <Text>
        <Text color="gray">│</Text> <Text bold>Owner</Text>{' '}
        {(() => {
          if (isSessionTask)
            return <Text color="green">This session (in-memory)</Text>;
          if (!task.createdBySessionId)
            return <Text color="yellow">⚠ Unclaimed (not auto-fired)</Text>;
          if (task.createdBySessionId === ownerSessionId)
            return <Text color="green">This session ✓</Text>;
          return (
            <Text color="red">
              other session: {task.createdBySessionId}
              {task.createdByPid !== undefined
                ? ` (pid ${task.createdByPid})`
                : ''}
            </Text>
          );
        })()}
      </Text>

      <BudgetRows task={task} />

      {editMode === 'expiry' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            │ Set expiry:
          </Text>
          {EXPIRY_OPTIONS.map((opt, i) => (
            <Text key={opt}>
              <Text color="gray">│</Text>{' '}
              {i === selectionIdx ? (
                <Text color="cyan" bold>
                  ▸ {opt}
                </Text>
              ) : (
                <Text dimColor> {opt}</Text>
              )}
            </Text>
          ))}
          <Text>
            <Text color="gray">│</Text>{' '}
            <Text dimColor>Enter confirm · Esc cancel</Text>
          </Text>
        </Box>
      ) : editMode === 'schedule' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            │ Set interval:
          </Text>
          {SCHEDULE_OPTIONS.map((opt, i) => (
            <Text key={opt.cron}>
              <Text color="gray">│</Text>{' '}
              {i === selectionIdx ? (
                <Text color="cyan" bold>
                  ▸ {opt.label}
                </Text>
              ) : (
                <Text dimColor> {opt.label}</Text>
              )}
            </Text>
          ))}
          <Text>
            <Text color="gray">│</Text>{' '}
            {selectionIdx === SCHEDULE_OPTIONS.length ? (
              <Text color="cyan" bold>
                ▸ Custom (type e.g. 5m, 2h, 30s)
              </Text>
            ) : (
              <Text dimColor> Custom (type e.g. 5m, 2h, 30s)</Text>
            )}
          </Text>
          <Text>
            <Text color="gray">│</Text>{' '}
            <Text dimColor>Enter confirm · Esc cancel</Text>
          </Text>
        </Box>
      ) : editMode === 'schedule-custom' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            │ Custom interval (e.g. 5m, 2h, 30s, 1d):
          </Text>
          <Text>
            <Text color="gray">│</Text> <Text color="cyan">{editBuffer}</Text>
            <Text color="gray">█</Text>
          </Text>
          <Text>
            <Text color="gray">│</Text>{' '}
            <Text dimColor>Enter confirm · Esc cancel</Text>
          </Text>
        </Box>
      ) : editMode === 'prompt' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            │ Edit prompt:
          </Text>
          <Text>
            <Text color="gray">│</Text> <Text color="cyan">{editBuffer}</Text>
            <Text color="gray">█</Text>
          </Text>
          <Text>
            <Text color="gray">│</Text>{' '}
            <Text dimColor>Enter save · Esc cancel · Backspace delete</Text>
          </Text>
        </Box>
      ) : editMode === 'max-turns' || editMode === 'max-credits' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            │ {editMode === 'max-turns' ? 'Max turns:' : 'Max credits:'}
          </Text>
          <Text>
            <Text color="gray">│</Text> <Text color="cyan">{editBuffer}</Text>
            <Text color="gray">█</Text>
          </Text>
          <Text>
            <Text color="gray">│</Text>{' '}
            <Text dimColor>
              Enter save · empty clears the limit · Esc cancel
            </Text>
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text>
            <Text color="gray">└─</Text>{' '}
            <Text color="red" bold>
              d
            </Text>
            <Text dimColor> del</Text>{' '}
            <Text color="green" bold>
              e
            </Text>
            <Text dimColor> expiry</Text>{' '}
            <Text color="blue" bold>
              s
            </Text>
            <Text dimColor> schedule</Text>{' '}
            <Text color="magenta" bold>
              p
            </Text>
            <Text dimColor> prompt</Text>{' '}
            <Text color="yellow" bold>
              t
            </Text>
            <Text dimColor> turns</Text>{' '}
            <Text color="yellow" bold>
              b
            </Text>
            <Text dimColor> credits</Text>
            {isSessionTask ? (
              ''
            ) : (
              <>
                <Text>{'  '}</Text>
                <Text color="cyan" bold>
                  c
                </Text>
                <Text dimColor> claim</Text>
              </>
            )}{' '}
            <Text color="yellow" bold>
              Esc
            </Text>
            <Text dimColor> back</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
