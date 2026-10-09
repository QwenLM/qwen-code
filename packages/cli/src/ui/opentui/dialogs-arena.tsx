/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI arena dialogs (M4 deep-fidelity port of ink arena/*):
 *
 *  - start:  MultiSelect over config.getAllConfiguredModels() (runtime /
 *    image-only models filtered out, qwen-oauth disabled); confirming fills
 *    the composer with `/arena start --models …` — the dialog never launches
 *    the session itself, exactly like ink's handleArenaModelsSelected.
 *  - status: live agent table (status/time/tokens/rounds/tools) refreshed on
 *    an interval, reading AgentInteractive stats for in-process backends.
 *  - stop:   cleanup vs preserve radio, then cancel → settle → cleanup via
 *    the ArenaManager, reporting progress as chat messages.
 *  - select: winner picker with per-agent diff stats, p/d preview panes and
 *    x discard; applying runs applyAgentResult + cleanupArenaRuntime.
 */

import { useEffect, useMemo, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import {
  ArenaSessionStatus,
  AuthType,
  DISPLAY_MODE,
  isSettledStatus,
  isSuccessStatus,
  type AgentStatsSummary,
  type ArenaAgentResult,
  type ArenaAgentState,
  type Config,
  type InProcessBackend,
} from '@qwen-code/qwen-code-core';
import { formatDuration } from '../utils/formatters.js';
import { getArenaStatusLabel } from '../utils/displayUtils.js';
import { toOriginalKey } from './key-map.js';
import {
  clipToRows,
  findNextEnabledIndex,
  getSelectionScrollOffset,
  wrappedRows,
} from './dialogs-core.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import { dialogAreaWidth } from './dialogs-shared.js';
import {
  clipToWidth,
  getCachedStringWidth,
  sanitizeTerminalLine,
  truncateToWidth,
} from '../utils/textUtils.js';
import { C } from './theme.js';
import { useBatchSafeCursor, useBatchSafeState } from './batch-cursor.js';

export type ArenaDialogMode = 'start' | 'select' | 'stop' | 'status';

export interface OpenTuiArenaDialogProps {
  config?: Config;
  mode: ArenaDialogMode;
  onClose: () => void;
  /** Command-style chat messages (ink addItem parity). */
  notify: (text: string, level?: 'info' | 'error') => void;
  /** ink handleArenaModelsSelected: fill the composer, keep it unsubmitted. */
  onFillInput?: (text: string) => void;
  /** The popup region's row budget; the model and agent lists window from it. */
  availableTerminalHeight?: number;
}

const MODEL_PROVIDERS_DOCUMENTATION_URL =
  'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/#modelproviders';
const ARENA_NO_MODELS = 'No models available. Please configure models first.';
const ARENA_OAUTH_NOTE = 'Note: qwen-oauth models are not supported in Arena.';
const ARENA_NEED_MORE = 'Arena requires at least 2 models. To add more:';
const ARENA_ADD_VIA_AUTH =
  '  - Run /auth to set up a Coding Plan (includes multiple models)';
const ARENA_ADD_VIA_SETTINGS =
  '  - Or configure modelProviders in settings.json';
const ARENA_MORE_MODELS_GUIDE =
  'Configure more models with the modelProviders guide:';

const STATUS_REFRESH_INTERVAL_MS = 2000;
const IN_PROCESS_REFRESH_INTERVAL_MS = 1000;
const MAX_MODEL_NAME_LENGTH = 35;
const ARENA_SELECT_WINNER = 'Select a winner to apply changes:';
const MAX_TASK_DISPLAY_LENGTH = 60;
const DETAILED_DIFF_MAX_LINES = 180;

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function pad(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return ' '.repeat(len - str.length) + str;
}

function sessionStatusLabel(status: ArenaSessionStatus): {
  text: string;
  color: string;
} {
  switch (status) {
    case ArenaSessionStatus.RUNNING:
      return { text: 'Running', color: C.green };
    case ArenaSessionStatus.INITIALIZING:
      return { text: 'Initializing', color: C.yellow };
    case ArenaSessionStatus.IDLE:
      return { text: 'Idle', color: C.green };
    case ArenaSessionStatus.COMPLETED:
      return { text: 'Completed', color: C.green };
    case ArenaSessionStatus.CANCELLED:
      return { text: 'Cancelled', color: C.yellow };
    case ArenaSessionStatus.FAILED:
      return { text: 'Failed', color: C.red };
    default:
      return { text: String(status), color: C.dim };
  }
}

function ArenaFrame({
  title,
  hint,
  children,
}: {
  title: React.ReactNode;
  hint: string;
  children?: React.ReactNode;
}) {
  const { width } = useTerminalDimensions();
  return (
    <box
      flexDirection="column"
      border
      borderColor={C.dim}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      // A shrinkable frame lets a short region squeeze its text rows to zero
      // and paint them over each other; staying natural height keeps the rows
      // contiguous for the region's clip to cut at the tail, as ink does for
      // /stats. The clip cuts child text but not the frame's own border
      // strokes, so a frame taller than the region still paints its border
      // past it, and a body with an explicit height windows itself from the
      // region budget instead of relying on the clip (Decision 71).
      flexShrink={0}
    >
      <box flexDirection="row">
        <text fg={C.text} attributes={1}>
          {typeof title === 'string' ? title : ''}
        </text>
        {typeof title !== 'string' ? title : null}
      </box>
      {children}
      <box marginTop={1}>
        <text fg={C.dim}>
          {/* The hint is charged one row, so it clips to the frame's content
              columns (region width less border and padding) instead of
              wrapping onto a row the chrome count never paid for. */}
          {clipToWidth(hint, Math.max(1, dialogAreaWidth(width) - 6))}
        </text>
      </box>
    </box>
  );
}

/** `/arena start` — multi-select of configured models → fill the composer. */
function ArenaStart({
  config,
  onClose,
  onFillInput,
  availableTerminalHeight: propsRegionHeight,
}: OpenTuiArenaDialogProps) {
  const modelItems = useMemo(() => {
    const all = config?.getAllConfiguredModels?.() ?? [];
    return all
      .filter((m) => !m.isRuntimeModel && !m.imageOnly)
      .map((m) => {
        const token = `${m.authType}:${m.id}`;
        return {
          key: token,
          label: `[${m.authType}] ${m.label}`,
          disabled: m.authType === AuthType.QWEN_OAUTH,
        };
      });
  }, [config]);
  const { cursor, cursorRef, setCursor } = useBatchSafeCursor();
  // Keystrokes of one burst are handled against the render that registered the
  // handler, whose `checked` set is already stale by the second Space.
  const {
    value: checked,
    ref: checkedRef,
    setValue: setChecked,
  } = useBatchSafeState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const hasDisabledQwenOauth = modelItems.some((m) => m.disabled);
  const selectableCount = modelItems.filter((m) => !m.disabled).length;
  const needsMoreModels = selectableCount < 2;
  const showMoreModelsHint = selectableCount >= 2 && selectableCount < 3;

  // The frame (7) and the list's margin row come off the region first; the
  // error and guidance blocks pay their own rows, and the model list windows
  // from what is left. A zero-row window refuses the cursor keys and Space —
  // they address a row — while Enter stays live for the checks already made.
  const regionHeight = clampDialogHeight(propsRegionHeight);
  const { width } = useTerminalDimensions();
  // Every charged run is measured at the frame's content width — the same
  // width the ArenaFrame hint clips to: a run charged a flat row that wraps
  // (the modelProviders URL is 88 columns) under-pays, and the unshrinkable
  // frame grows past the region by the difference.
  const frameContentWidth = Math.max(1, dialogAreaWidth(width) - 6);
  // Each model row is charged one physical row, so the label — model labels
  // come from the config — is clipped to what the row owns: the frame's
  // content columns less the four columns of the `[x] ` checkbox.
  const modelLabelWidth = Math.max(1, frameContentWidth - 4);
  const errorRows = error ? 1 + wrappedRows(error, frameContentWidth) : 0;
  const guidanceRows =
    hasDisabledQwenOauth || needsMoreModels
      ? 1 +
        (hasDisabledQwenOauth
          ? wrappedRows(ARENA_OAUTH_NOTE, frameContentWidth)
          : 0) +
        (needsMoreModels
          ? wrappedRows(ARENA_NEED_MORE, frameContentWidth) +
            wrappedRows(ARENA_ADD_VIA_AUTH, frameContentWidth) +
            wrappedRows(ARENA_ADD_VIA_SETTINGS, frameContentWidth)
          : 0)
      : 0;
  const moreModelsRows = showMoreModelsHint
    ? 1 +
      wrappedRows(ARENA_MORE_MODELS_GUIDE, frameContentWidth) +
      wrappedRows(MODEL_PROVIDERS_DOCUMENTATION_URL, frameContentWidth)
    : 0;
  // The empty branch paints a text row where the list would paint its first
  // model row, so it pays the rows that text wraps into.
  const emptyRows =
    modelItems.length === 0
      ? wrappedRows(ARENA_NO_MODELS, frameContentWidth)
      : 0;
  const modelWindowRows =
    regionHeight === undefined
      ? modelItems.length
      : Math.max(
          0,
          regionHeight -
            8 -
            emptyRows -
            errorRows -
            guidanceRows -
            moreModelsRows,
        );
  const modelOffset = getSelectionScrollOffset(
    cursor,
    modelItems.length,
    modelWindowRows,
  );

  useKeyboard((key) => {
    const o = toOriginalKey(key);
    // The error's rows can take the window to zero, where the refusal keeps
    // Space off the only rows that could satisfy the message; the next key
    // clears it, so the window comes back. (The zero-row refusal itself
    // stays: this key's closure still saw no painted row.)
    if (error) setError(null);
    if (o.name === 'escape') {
      onClose();
    } else if (o.name === 'up' || o.name === 'down') {
      if (modelWindowRows < 1) return;
      setCursor(findNextEnabledIndex(modelItems, cursorRef.current, o.name));
    } else if (o.name === 'space') {
      if (modelWindowRows < 1) return;
      const item = modelItems[cursorRef.current];
      if (!item || item.disabled) return;
      const next = new Set(checkedRef.current);
      if (next.has(item.key)) next.delete(item.key);
      else next.add(item.key);
      setChecked(next);
    } else if (o.name === 'return') {
      if (checkedRef.current.size < 2) {
        setError('Please select at least 2 models to start an Arena session.');
        return;
      }
      const values = modelItems
        .filter((m) => checkedRef.current.has(m.key))
        .map((m) => m.key);
      onFillInput?.(`/arena start --models ${values.join(',')} `);
      onClose();
    }
  });

  return (
    <ArenaFrame
      title="Select Models"
      hint="Space to toggle, Enter to confirm, Esc to cancel"
    >
      {modelItems.length === 0 ? (
        <box marginTop={1}>
          <text fg={C.yellow}>{ARENA_NO_MODELS}</text>
        </box>
      ) : (
        <box flexDirection="column" marginTop={1}>
          {modelItems
            .slice(modelOffset, modelOffset + modelWindowRows)
            .map((m, i0) => {
              const i = modelOffset + i0;
              return (
                <box key={m.key} flexDirection="row">
                  <text
                    fg={m.disabled ? C.dim : i === cursor ? C.accent : C.dim}
                  >
                    {checked.has(m.key) ? '[x] ' : '[ ] '}
                  </text>
                  <text
                    fg={m.disabled ? C.dim : i === cursor ? C.text : C.dim}
                    attributes={!m.disabled && i === cursor ? 1 : 0}
                  >
                    {truncateToWidth(
                      sanitizeTerminalLine(m.label),
                      modelLabelWidth,
                    )}
                  </text>
                </box>
              );
            })}
        </box>
      )}
      {error && (
        <box marginTop={1}>
          <text fg={C.red}>{error}</text>
        </box>
      )}
      {(hasDisabledQwenOauth || needsMoreModels) && (
        <box marginTop={1} flexDirection="column">
          {hasDisabledQwenOauth && (
            <text fg={C.yellow}>{ARENA_OAUTH_NOTE}</text>
          )}
          {needsMoreModels && (
            <>
              <text fg={C.yellow}>{ARENA_NEED_MORE}</text>
              <text fg={C.yellow}>{ARENA_ADD_VIA_AUTH}</text>
              <text fg={C.yellow}>{ARENA_ADD_VIA_SETTINGS}</text>
            </>
          )}
        </box>
      )}
      {showMoreModelsHint && (
        <box marginTop={1} flexDirection="column">
          <text fg={C.dim}>{ARENA_MORE_MODELS_GUIDE}</text>
          <text fg={C.dim}>{MODEL_PROVIDERS_DOCUMENTATION_URL}</text>
        </box>
      )}
    </ArenaFrame>
  );
}

function agentElapsedMs(agent: ArenaAgentState): number {
  if (isSettledStatus(agent.status)) return agent.stats.durationMs;
  return Date.now() - agent.startedAt;
}

/** `/arena status` — live agent stats table. */
function ArenaStatus({ config, onClose }: OpenTuiArenaDialogProps) {
  const manager = config?.getArenaManager?.() ?? null;
  const { width } = useTerminalDimensions();
  const [, setTick] = useState(0);

  const backend = manager?.getBackend();
  const isInProcess = backend?.type === DISPLAY_MODE.IN_PROCESS;
  const inProcessBackend = isInProcess ? (backend as InProcessBackend) : null;

  useEffect(() => {
    const interval = isInProcess
      ? IN_PROCESS_REFRESH_INTERVAL_MS
      : STATUS_REFRESH_INTERVAL_MS;
    const timer = setInterval(() => setTick((t) => t + 1), interval);
    return () => clearInterval(timer);
  }, [isInProcess]);

  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'escape' || o.name === 'return' || o.name === 'q') {
      onClose();
    }
  });

  if (!manager) {
    return (
      <ArenaFrame title="Arena Status" hint="Esc to close">
        <box marginTop={1}>
          <text fg={C.dim}>{'No running Arena session found.'}</text>
        </box>
      </ArenaFrame>
    );
  }

  const sessionLabel = sessionStatusLabel(manager.getSessionStatus());
  const agents = manager.getAgentStates();
  const task = truncate(manager.getTask() ?? '', MAX_TASK_DISPLAY_LENGTH);

  const liveStats = new Map<string, AgentStatsSummary>();
  if (inProcessBackend) {
    for (const agent of agents) {
      const interactive = inProcessBackend.getAgent(agent.agentId);
      if (interactive) liveStats.set(agent.agentId, interactive.getStats());
    }
  }

  const colStatus = 14;
  const colTime = 8;
  const colTokens = 10;
  const colRounds = 8;
  const colTools = 8;
  const innerWidth = Math.max(10, (width ?? 80) - 6);

  return (
    <ArenaFrame
      title={
        <>
          <text fg={C.text} attributes={1}>
            {'Arena Status'}
          </text>
          <text fg={C.dim}>{' · '}</text>
          <text fg={sessionLabel.color}>{sessionLabel.text}</text>
        </>
      }
      hint="Esc to close"
    >
      <box marginTop={1} flexDirection="row">
        <text fg={C.dim}>{'Task: '}</text>
        <text fg={C.text}>{`"${task}"`}</text>
      </box>
      <box marginTop={1} flexDirection="row">
        <box flexGrow={1}>
          <text fg={C.dim} attributes={1}>
            {'Agent'}
          </text>
        </box>
        <box width={colStatus} justifyContent="flex-end">
          <text fg={C.dim} attributes={1}>
            {'Status'}
          </text>
        </box>
        <box width={colTime} justifyContent="flex-end">
          <text fg={C.dim} attributes={1}>
            {'Time'}
          </text>
        </box>
        <box width={colTokens} justifyContent="flex-end">
          <text fg={C.dim} attributes={1}>
            {'Tokens'}
          </text>
        </box>
        <box width={colRounds} justifyContent="flex-end">
          <text fg={C.dim} attributes={1}>
            {'Rounds'}
          </text>
        </box>
        <box width={colTools} justifyContent="flex-end">
          <text fg={C.dim} attributes={1}>
            {'Tools'}
          </text>
        </box>
      </box>
      <text fg={C.borderDefault}>{'─'.repeat(innerWidth)}</text>
      {agents.length === 0 ? (
        <text fg={C.dim}>{'No agents registered yet.'}</text>
      ) : (
        agents.map((agent) => {
          const label = truncate(agent.model.modelId, MAX_MODEL_NAME_LENGTH);
          const statusInfo = getArenaStatusLabel(agent.status);
          const live = liveStats.get(agent.agentId);
          const outputTokens = live?.outputTokens ?? agent.stats.outputTokens;
          const rounds = live?.rounds ?? agent.stats.rounds;
          const toolCalls = live?.totalToolCalls ?? agent.stats.toolCalls;
          const okCalls =
            live?.successfulToolCalls ?? agent.stats.successfulToolCalls;
          const failedCalls =
            live?.failedToolCalls ?? agent.stats.failedToolCalls;
          return (
            <box key={agent.agentId} flexDirection="row">
              <box flexGrow={1}>
                <text fg={C.text}>{label}</text>
              </box>
              <box width={colStatus} justifyContent="flex-end">
                <text fg={statusInfo.color}>{statusInfo.text}</text>
              </box>
              <box width={colTime} justifyContent="flex-end">
                <text fg={C.text}>
                  {pad(formatDuration(agentElapsedMs(agent)), colTime - 1)}
                </text>
              </box>
              <box width={colTokens} justifyContent="flex-end">
                <text fg={C.text}>
                  {pad(outputTokens.toLocaleString(), colTokens - 1)}
                </text>
              </box>
              <box width={colRounds} justifyContent="flex-end">
                <text fg={C.text}>{pad(String(rounds), colRounds - 1)}</text>
              </box>
              <box width={colTools} justifyContent="flex-end">
                {failedCalls > 0 ? (
                  <>
                    <text fg={C.green}>{String(okCalls)}</text>
                    <text fg={C.dim}>{'/'}</text>
                    <text fg={C.red}>{String(failedCalls)}</text>
                  </>
                ) : (
                  <text fg={toolCalls > 0 ? C.green : C.text}>
                    {pad(String(toolCalls), colTools - 1)}
                  </text>
                )}
              </box>
            </box>
          );
        })
      )}
    </ArenaFrame>
  );
}

type StopAction = 'cleanup' | 'preserve';

/** `/arena stop` — cleanup vs preserve radio + manager teardown. */
function ArenaStop({ config, onClose, notify }: OpenTuiArenaDialogProps) {
  const [processing, setProcessing] = useState(false);
  const preserveDefault =
    config?.getAgentsSettings?.().arena?.preserveArtifacts ?? false;
  const items: Array<{ key: StopAction; label: string; desc: string }> = [
    {
      key: 'cleanup',
      label: 'Stop and clean up',
      desc: 'Remove all worktrees and session files',
    },
    {
      key: 'preserve',
      label: 'Stop and preserve artifacts',
      desc: 'Keep worktrees and session files for later inspection',
    },
  ];
  const {
    cursor: sel,
    cursorRef: selRef,
    setCursor: setSel,
  } = useBatchSafeCursor(preserveDefault ? 1 : 0);

  const runStop = async (action: StopAction) => {
    if (processing) return;
    setProcessing(true);
    onClose();
    const mgr = config?.getArenaManager?.();
    if (!mgr) {
      notify('No running Arena session found.', 'error');
      return;
    }
    try {
      const status = mgr.getSessionStatus();
      if (
        status === ArenaSessionStatus.RUNNING ||
        status === ArenaSessionStatus.INITIALIZING
      ) {
        notify('Stopping Arena agents…');
        await mgr.cancel();
      }
      await mgr.waitForSettled();
      notify('Cleaning up Arena resources…');
      if (action === 'preserve') {
        await mgr.cleanupRuntime();
      } else {
        await mgr.cleanup();
      }
      config?.setArenaManager?.(null);
      notify(
        action === 'preserve'
          ? 'Arena session stopped. Worktrees and session files were preserved. Use /arena select --discard to manually clean up later.'
          : 'Arena session stopped. All Arena resources (including Git worktrees) were cleaned up.',
      );
    } catch (error) {
      notify(
        `Failed to stop Arena session: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  };

  useKeyboard((key) => {
    if (processing) return;
    const o = toOriginalKey(key);
    if (o.name === 'escape') {
      onClose();
    } else if (o.name === 'up' || o.name === 'down') {
      setSel(selRef.current === 0 ? 1 : 0);
    } else if (o.name === 'return') {
      void runStop(items[selRef.current]?.key ?? 'cleanup');
    }
  });

  return (
    <ArenaFrame
      title="Stop Arena Session"
      hint="Enter to confirm, Esc to cancel"
    >
      <box marginTop={1}>
        <text fg={C.dim}>{'Choose what to do with Arena artifacts:'}</text>
      </box>
      <box marginTop={1} flexDirection="column">
        {items.map((it, i) => (
          <box key={it.key} flexDirection="row" alignItems="flex-start">
            <box minWidth={2} flexShrink={0}>
              <text fg={i === sel ? C.green : C.text}>
                {i === sel ? '›' : ' '}
              </text>
            </box>
            <box flexDirection="column" flexGrow={1}>
              <text fg={i === sel ? C.green : C.text}>{it.label}</text>
              <text fg={C.dim}>{it.desc}</text>
            </box>
          </box>
        ))}
      </box>
      {preserveDefault && (
        <box marginTop={1}>
          <text fg={C.dim}>
            {'Default: preserve (agents.arena.preserveArtifacts is enabled)'}
          </text>
        </box>
      )}
    </ArenaFrame>
  );
}

function diffLineColor(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return C.green;
  if (line.startsWith('-') && !line.startsWith('---')) return C.red;
  if (
    line.startsWith('diff --git') ||
    line.startsWith('@@') ||
    line.startsWith('---') ||
    line.startsWith('+++')
  ) {
    return C.accent;
  }
  return C.dim;
}

function visibleDiffLines(diff: string | undefined): string[] {
  if (!diff) return [];
  const lines = diff.split('\n');
  if (lines.length <= DETAILED_DIFF_MAX_LINES) return lines;
  return [
    ...lines.slice(0, DETAILED_DIFF_MAX_LINES),
    `... truncated ${lines.length - DETAILED_DIFF_MAX_LINES} diff lines`,
  ];
}

function formatFileList(files: string[]): string {
  if (files.length === 0) return 'none';
  const visible = files.slice(0, 6);
  const suffix =
    files.length > visible.length
      ? `, +${files.length - visible.length} more`
      : '';
  return `${visible.join(', ')}${suffix}`;
}

interface AgentPreviewRun {
  label: string;
  value: string;
}

interface ClippedAgentPreview {
  title: string;
  runs: AgentPreviewRun[];
  /** The rows the clipped pane paints: its margin and title, then the runs. */
  rows: number;
}

/**
 * The preview pane's runs, clipped so the pane's row count never exceeds
 * `rowBudget`: the pane's rows come out of the list's window, and the
 * approach run — LLM-generated, with no length bound — can otherwise grow
 * the unshrinkable frame past the clipped region. Runs clip in paint order
 * (the unbounded approach first), and a run the budget can no longer pay
 * does not paint at all. Each run is clipped and re-measured at the width
 * its box actually gets — the pane is indented two columns and each value
 * starts after its label. Undefined when the budget cannot pay the pane's
 * own margin and title.
 */
function clipAgentPreview(
  result: ArenaAgentResult,
  frameContentWidth: number,
  rowBudget: number | undefined,
): ClippedAgentPreview | undefined {
  // Sanitize before measuring: the summary is LLM-generated and the paths
  // are git-derived, and a tab or newline measures zero columns for the clip
  // while the terminal advances it — the charge and the paint must read the
  // same bytes, like the sibling runs in this file.
  const title = sanitizeTerminalLine(`Quick Preview · ${result.model.modelId}`);
  const naturalRuns: AgentPreviewRun[] = [
    {
      label: 'Approach: ',
      value: sanitizeTerminalLine(
        result.approachSummary ?? 'No approach summary available.',
      ),
    },
    {
      label: 'Major files: ',
      value: sanitizeTerminalLine(
        formatFileList((result.diffSummary?.files ?? []).map((f) => f.path)),
      ),
    },
    {
      label: 'Metrics: ',
      value: `${result.stats.outputTokens.toLocaleString()} tokens · ${formatDuration(result.stats.durationMs)} · ${result.stats.toolCalls} tools`,
    },
  ];
  const runWidth = (label: string) =>
    Math.max(1, frameContentWidth - 2 - getCachedStringWidth(label));
  // The pane's marginTop plus the row(s) its title wraps into.
  const chrome = 1 + wrappedRows(title, frameContentWidth);
  if (rowBudget !== undefined && rowBudget < chrome) return undefined;
  let remaining =
    rowBudget === undefined ? Number.MAX_SAFE_INTEGER : rowBudget - chrome;
  const runs: AgentPreviewRun[] = [];
  let rows = chrome;
  for (const run of naturalRuns) {
    if (remaining < 1) break;
    const width = runWidth(run.label);
    const value = clipToRows(run.value, width, remaining);
    const paid = wrappedRows(value, width);
    runs.push({ label: run.label, value });
    rows += paid;
    remaining -= paid;
  }
  return { title, runs, rows };
}

/**
 * The diff lines a region-capped pane paints: whole lines only, with the
 * last painted row yielded to a truncation marker when the cap cuts.
 */
function cappedDiffLines(
  lines: string[],
  maxLines: number | undefined,
): string[] {
  if (maxLines === undefined || lines.length <= maxLines) return lines;
  if (maxLines < 1) return [];
  return [
    ...lines.slice(0, maxLines - 1),
    `… ${lines.length - (maxLines - 1)} more rows than the region leaves`,
  ];
}

function AgentPreview({ preview }: { preview: ClippedAgentPreview }) {
  return (
    <box marginTop={1} flexDirection="column">
      <text fg={C.text} attributes={1}>
        {preview.title}
      </text>
      {preview.runs.map((run) => (
        <box key={run.label} marginLeft={2} flexDirection="row">
          <text fg={C.dim}>{run.label}</text>
          <text fg={C.text}>{run.value}</text>
        </box>
      ))}
    </box>
  );
}

function AgentDetailedDiff({
  result,
  maxLines,
  lineWidth,
}: {
  result: ArenaAgentResult;
  /** Region-paid cap on painted body rows; undefined when there is no region. */
  maxLines?: number;
  /** The pane's content columns: every painted line is charged one row. */
  lineWidth: number;
}) {
  const lines = cappedDiffLines(visibleDiffLines(result.diff), maxLines);
  return (
    <box marginTop={1} flexDirection="column">
      <text fg={C.text} attributes={1}>
        {sanitizeTerminalLine(`Detailed Diff · ${result.model.modelId}`)}
      </text>
      {lines.length === 0 ? (
        maxLines === 0 ? null : (
          <box marginLeft={2}>
            <text fg={C.dim}>{'No diff available.'}</text>
          </box>
        )
      ) : (
        <box marginLeft={2} flexDirection="column">
          {lines.map((line, index) => (
            <text key={index} fg={diffLineColor(line)}>
              {clipToWidth(sanitizeTerminalLine(line), lineWidth)}
            </text>
          ))}
        </box>
      )}
    </box>
  );
}

/** `/arena select` — winner picker with preview panes and discard. */
function ArenaSelect({
  config,
  onClose,
  notify,
  availableTerminalHeight,
}: OpenTuiArenaDialogProps) {
  const manager = config?.getArenaManager?.() ?? null;
  const agents = useMemo(() => manager?.getAgentStates() ?? [], [manager]);
  const result = manager?.getResult();
  const {
    cursor: sel,
    cursorRef: selRef,
    setCursor: setSel,
  } = useBatchSafeCursor(() =>
    Math.max(
      0,
      agents.findIndex((a) => isSuccessStatus(a.status)),
    ),
  );
  // The pane toggles decide direction from the flag the current key burst
  // sees: two `p` presses in one stdin read share one render closure, so a
  // useState read there toggles twice off the same stale value and ends with
  // the pane open at a zero-row window — the state the guard below exists to
  // prevent. The ref half of the mirror is written synchronously with the
  // state half, so the second press reads the first's write.
  const {
    value: showPreview,
    ref: showPreviewRef,
    setValue: setShowPreview,
  } = useBatchSafeState(false);
  const {
    value: showDetailedDiff,
    ref: showDetailedDiffRef,
    setValue: setShowDetailedDiff,
  } = useBatchSafeState(false);

  const rows = useMemo(
    () =>
      agents.map((agent) => {
        let additions = 0;
        let deletions = 0;
        let fileCount = 0;
        if (isSuccessStatus(agent.status) && result) {
          const agentResult = result.agents.find(
            (a) => a.agentId === agent.agentId,
          );
          if (agentResult?.diffSummary) {
            additions = agentResult.diffSummary.additions;
            deletions = agentResult.diffSummary.deletions;
            fileCount = agentResult.diffSummary.files.length;
          } else if (agentResult?.diff) {
            for (const line of agentResult.diff.split('\n')) {
              if (line.startsWith('+') && !line.startsWith('+++')) additions++;
              else if (line.startsWith('-') && !line.startsWith('---'))
                deletions++;
            }
          }
          fileCount = agentResult?.modifiedFiles?.length ?? fileCount;
        }
        return {
          key: agent.agentId,
          label: agent.model.modelId,
          status: getArenaStatusLabel(agent.status),
          duration: formatDuration(agent.stats.durationMs),
          tokens: agent.stats.outputTokens.toLocaleString(),
          additions,
          deletions,
          fileCount,
          disabled: !isSuccessStatus(agent.status),
        };
      }),
    [agents, result],
  );

  const selectedAgentId = rows[sel]?.key;
  const selectedResult = result?.agents.find(
    (a) => a.agentId === selectedAgentId,
  );

  const applyWinner = async (agentId: string) => {
    onClose();
    const mgr = config?.getArenaManager?.();
    if (!mgr) {
      notify('No arena session found. Start one with /arena start.', 'error');
      return;
    }
    const agent =
      mgr.getAgentState(agentId) ??
      mgr.getAgentStates().find((a) => a.agentId === agentId);
    const label = agent?.model.modelId || agentId;
    notify(`Applying changes from ${label}…`);
    const applyResult = await mgr.applyAgentResult(agentId);
    if (!applyResult.success) {
      notify(
        `Failed to apply changes from ${label}: ${applyResult.error}`,
        'error',
      );
      return;
    }
    try {
      await config?.cleanupArenaRuntime?.(true);
    } catch (err) {
      notify(
        `Warning: failed to clean up arena resources: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    }
    notify(
      `Applied changes from ${label} to workspace. Arena session complete.`,
    );
  };

  const discardAll = async () => {
    onClose();
    const mgr = config?.getArenaManager?.();
    if (!mgr) {
      notify('No arena session found. Start one with /arena start.', 'error');
      return;
    }
    try {
      notify('Discarding Arena results and cleaning up…');
      await config?.cleanupArenaRuntime?.(true);
      notify('Arena results discarded. All worktrees cleaned up.');
    } catch (err) {
      notify(
        `Failed to clean up arena worktrees: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
    }
  };

  // Each agent row paints two physical rows (label, then stats), and the
  // frame, the task line, the "Select a winner" line and the list's margin
  // come off the region first (7 + 2 + 2 + 1); the task and the prompt are
  // each charged one row, so each clips to frameContentWidth rather than
  // wrapping onto a row the count never paid for. The window follows the
  // cursor; at a zero-row window the cursor keys, Enter and the preview
  // panes — everything that addresses a row — refuse, while x and Esc stay
  // live (they address the session, not a row).
  const regionHeight = clampDialogHeight(availableTerminalHeight);
  const { width } = useTerminalDimensions();
  // The frame pays a border column and two padding columns per side.
  const frameContentWidth = Math.max(1, dialogAreaWidth(width) - 6);
  // An open pane's rows come out of the list's window: the frame is
  // unshrinkable inside the clipped region, so a pane added on top of a full
  // window grows the frame past the region and the clip takes the pane the
  // user opened it to read. Both panes cap to what the region leaves: the
  // preview clips its runs to the leftover rows (reserving the diff pane's
  // margin and title rows when both are open), and the detailed diff gets a
  // line cap from what the list's zero-row floor leaves, because its 181-line
  // ceiling can never fit a region. Neither paints at all when the region
  // cannot pay its own chrome.
  const diffOpen = Boolean(showDetailedDiff && selectedResult);
  const diffLines = diffOpen ? visibleDiffLines(selectedResult?.diff) : [];
  // The diff pane's margin and title, the title measured the way the
  // preview pane measures its own: a model id long enough to wrap it would
  // otherwise be paid one row for two.
  const diffPaneChrome = selectedResult
    ? 1 +
      wrappedRows(
        sanitizeTerminalLine(`Detailed Diff · ${selectedResult.model.modelId}`),
        frameContentWidth,
      )
    : 0;
  const diffChromeRows = diffOpen ? diffPaneChrome : 0;
  // What the region leaves once the frame's own 12 rows are paid.
  const paneRoom =
    regionHeight === undefined ? undefined : Math.max(0, regionHeight - 12);
  const clipPreview = (budget: number | undefined) =>
    showPreview && selectedResult
      ? clipAgentPreview(selectedResult, frameContentWidth, budget)
      : undefined;
  // Affordability is priced against the widest the preview can be, so a pane
  // that passes still fits once the preview is re-clipped to what the pane
  // leaves. A pane the region cannot pay does not paint and charges nothing —
  // the frame is unshrinkable inside the clipped region, so painting it grows
  // the frame past the region and the clip takes the list's rows instead.
  let preview = clipPreview(paneRoom);
  const diffVisible =
    diffOpen &&
    (paneRoom === undefined ||
      paneRoom - (preview?.rows ?? 0) >= diffChromeRows);
  if (diffVisible && paneRoom !== undefined) {
    preview = clipPreview(Math.max(0, paneRoom - diffChromeRows));
  }
  const previewRows = preview?.rows ?? 0;
  let agentWindowRows: number;
  let diffLineCap: number | undefined;
  if (regionHeight === undefined) {
    agentWindowRows = rows.length;
  } else if (diffVisible) {
    // The pane pays its margin and title rows, then as many diff lines as
    // fit (one row for the empty diff's notice — which a zero-line budget
    // does not paint); the list windows from the rest. diffVisible already
    // established the pane can pay its chrome, so neither budget clamps a
    // deficit away.
    const lineBudget = regionHeight - 12 - previewRows - diffChromeRows;
    diffLineCap = lineBudget;
    const painted =
      diffLines.length === 0
        ? lineBudget === 0
          ? 0
          : 1
        : Math.min(diffLines.length, lineBudget);
    agentWindowRows = Math.floor((lineBudget - painted) / 2);
  } else {
    agentWindowRows = Math.max(
      0,
      Math.floor((regionHeight - 12 - previewRows) / 2),
    );
  }
  const agentOffset = getSelectionScrollOffset(
    sel,
    rows.length,
    agentWindowRows,
  );

  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'escape') {
      onClose();
    } else if (o.name === 'up' || o.name === 'down') {
      if (agentWindowRows < 1) return;
      setSel(findNextEnabledIndex(rows, selRef.current, o.name));
    } else if (o.name === 'return') {
      if (agentWindowRows < 1) return;
      const row = rows[selRef.current];
      if (row && !row.disabled) void applyWinner(row.key);
    } else if (!o.ctrl && !o.meta) {
      if (o.name === 'p' || o.name === 'd') {
        // A zero-row window refuses to OPEN a pane — its rows come out of the
        // list — but never refuses to CLOSE one: the open pane is what eats
        // the rows the list needs. Direction is read from the burst-live ref,
        // not this render's closure.
        if (o.name === 'p') {
          if (agentWindowRows < 1 && !showPreviewRef.current) return;
          setShowPreview(!showPreviewRef.current);
        } else {
          if (agentWindowRows < 1 && !showDetailedDiffRef.current) return;
          setShowDetailedDiff(!showDetailedDiffRef.current);
        }
      } else if (o.name === 'x') void discardAll();
    }
  });

  if (!manager) {
    return (
      <ArenaFrame title="Arena Results" hint="Esc to close">
        <box marginTop={1}>
          <text fg={C.dim}>
            {'No arena session found. Start one with /arena start.'}
          </text>
        </box>
      </ArenaFrame>
    );
  }

  const task = truncateToWidth(
    sanitizeTerminalLine(result?.task ?? ''),
    // Charged one row: 'Task: ' plus the two quotes come off the frame's
    // content columns first.
    Math.max(1, Math.min(MAX_TASK_DISPLAY_LENGTH, frameContentWidth - 8)),
  );

  return (
    <ArenaFrame
      title="Arena Results"
      hint="p preview, d detailed diff, Enter select winner, x discard all, Esc cancel"
    >
      <box marginTop={1} flexDirection="row">
        <text fg={C.dim}>{'Task: '}</text>
        <text fg={C.text}>{`"${task}"`}</text>
      </box>
      <box marginTop={1}>
        <text fg={C.dim}>
          {/* Charged one row, so at thirty-three columns it clips to the
              frame's content width like the hint does, instead of wrapping
              onto a row the chrome count never paid for. */}
          {clipToWidth(ARENA_SELECT_WINNER, frameContentWidth)}
        </text>
      </box>
      <box marginTop={1} flexDirection="column">
        {rows
          .slice(agentOffset, agentOffset + agentWindowRows)
          .map((row, i0) => {
            const i = agentOffset + i0;
            const statsSegments: Array<{ text: string; color: string }> = [
              { text: row.status.text, color: row.status.color },
              {
                text: ` · ${row.duration} · ${row.tokens} tokens`,
                color: C.dim,
              },
            ];
            if (row.fileCount > 0) {
              statsSegments.push({
                text: ` · ${row.fileCount} files`,
                color: C.dim,
              });
            }
            if (row.additions > 0 || row.deletions > 0) {
              statsSegments.push(
                { text: ' · ', color: C.dim },
                { text: `+${row.additions}`, color: C.green },
                { text: '/', color: C.dim },
                { text: `-${row.deletions}`, color: C.red },
                { text: ' lines', color: C.dim },
              );
            }
            // The stats run is the one run in the row that is not
            // width-bounded, and the row is charged two physical rows
            // (label + stats); clip the segments to the columns the row
            // owns, trailing segments first, so the run cannot wrap.
            let statsBudget = Math.max(0, frameContentWidth - 2);
            const statsRuns: Array<{ text: string; color: string }> = [];
            for (const segment of statsSegments) {
              if (statsBudget <= 0) break;
              const clipped = clipToWidth(
                sanitizeTerminalLine(segment.text),
                statsBudget,
              );
              if (clipped === '') break;
              statsRuns.push({ text: clipped, color: segment.color });
              statsBudget -= getCachedStringWidth(clipped);
            }
            return (
              <box key={row.key} flexDirection="row" alignItems="flex-start">
                <box minWidth={2} flexShrink={0}>
                  <text fg={i === sel ? C.green : C.text}>
                    {i === sel ? '›' : ' '}
                  </text>
                </box>
                <box flexDirection="column" flexGrow={1}>
                  <text
                    fg={row.disabled ? C.dim : i === sel ? C.green : C.text}
                  >
                    {truncateToWidth(
                      sanitizeTerminalLine(row.label),
                      Math.max(1, frameContentWidth - 2),
                    )}
                  </text>
                  <box flexDirection="row">
                    {statsRuns.map((run, runIndex) => (
                      <text key={runIndex} fg={run.color}>
                        {run.text}
                      </text>
                    ))}
                  </box>
                </box>
              </box>
            );
          })}
      </box>
      {preview && <AgentPreview preview={preview} />}
      {diffVisible && selectedResult && (
        <AgentDetailedDiff
          result={selectedResult}
          maxLines={diffLineCap}
          lineWidth={Math.max(1, frameContentWidth - 2)}
        />
      )}
    </ArenaFrame>
  );
}

export function OpenTuiArenaDialog(props: OpenTuiArenaDialogProps) {
  switch (props.mode) {
    case 'start':
      return <ArenaStart {...props} />;
    case 'status':
      return <ArenaStatus {...props} />;
    case 'stop':
      return <ArenaStop {...props} />;
    case 'select':
      return <ArenaSelect {...props} />;
    default:
      return null;
  }
}
