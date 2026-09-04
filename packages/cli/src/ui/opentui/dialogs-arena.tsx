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
import { nextEnabledIndex } from './dialogs-misc.js';
import { C } from './theme.js';

export type ArenaDialogMode = 'start' | 'select' | 'stop' | 'status';

export interface OpenTuiArenaDialogProps {
  config?: Config;
  mode: ArenaDialogMode;
  onClose: () => void;
  /** Command-style chat messages (ink addItem parity). */
  notify: (text: string) => void;
  /** ink handleArenaModelsSelected: fill the composer, keep it unsubmitted. */
  onFillInput?: (text: string) => void;
}

const MODEL_PROVIDERS_DOCUMENTATION_URL =
  'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/#modelproviders';

const STATUS_REFRESH_INTERVAL_MS = 2000;
const IN_PROCESS_REFRESH_INTERVAL_MS = 1000;
const MAX_MODEL_NAME_LENGTH = 35;
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
      <box flexDirection="row">
        <text fg={C.text} attributes={1}>
          {typeof title === 'string' ? title : ''}
        </text>
        {typeof title !== 'string' ? title : null}
      </box>
      {children}
      <box marginTop={1}>
        <text fg={C.dim}>{hint}</text>
      </box>
    </box>
  );
}

/** `/arena start` — multi-select of configured models → fill the composer. */
function ArenaStart({ config, onClose, onFillInput }: OpenTuiArenaDialogProps) {
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
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const hasDisabledQwenOauth = modelItems.some((m) => m.disabled);
  const selectableCount = modelItems.filter((m) => !m.disabled).length;
  const needsMoreModels = selectableCount < 2;
  const showMoreModelsHint = selectableCount >= 2 && selectableCount < 3;

  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'escape') {
      onClose();
    } else if (o.name === 'up' || o.name === 'down') {
      const d = o.name === 'up' ? -1 : 1;
      setCursor((c) => nextEnabledIndex(modelItems, c, d));
    } else if (o.name === 'space') {
      const item = modelItems[cursor];
      if (!item || item.disabled) return;
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(item.key)) next.delete(item.key);
        else next.add(item.key);
        return next;
      });
    } else if (o.name === 'return') {
      if (checked.size < 2) {
        setError('Please select at least 2 models to start an Arena session.');
        return;
      }
      const values = modelItems
        .filter((m) => checked.has(m.key))
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
          <text fg={C.yellow}>
            {'No models available. Please configure models first.'}
          </text>
        </box>
      ) : (
        <box flexDirection="column" marginTop={1}>
          {modelItems.map((m, i) => (
            <box key={m.key} flexDirection="row">
              <text fg={m.disabled ? C.dim : i === cursor ? C.accent : C.dim}>
                {checked.has(m.key) ? '[x] ' : '[ ] '}
              </text>
              <text
                fg={m.disabled ? C.dim : i === cursor ? C.text : C.dim}
                attributes={!m.disabled && i === cursor ? 1 : 0}
              >
                {m.label}
              </text>
            </box>
          ))}
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
            <text fg={C.yellow}>
              {'Note: qwen-oauth models are not supported in Arena.'}
            </text>
          )}
          {needsMoreModels && (
            <>
              <text fg={C.yellow}>
                {'Arena requires at least 2 models. To add more:'}
              </text>
              <text fg={C.yellow}>
                {
                  '  - Run /auth to set up a Coding Plan (includes multiple models)'
                }
              </text>
              <text fg={C.yellow}>
                {'  - Or configure modelProviders in settings.json'}
              </text>
            </>
          )}
        </box>
      )}
      {showMoreModelsHint && (
        <box marginTop={1} flexDirection="column">
          <text fg={C.dim}>
            {'Configure more models with the modelProviders guide:'}
          </text>
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
      <text fg={C.dim}>{'─'.repeat(innerWidth)}</text>
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
  const [sel, setSel] = useState(preserveDefault ? 1 : 0);

  const runStop = async (action: StopAction) => {
    if (processing) return;
    setProcessing(true);
    onClose();
    const mgr = config?.getArenaManager?.();
    if (!mgr) {
      notify('✗ No running Arena session found.');
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
        `✗ Failed to stop Arena session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  useKeyboard((key) => {
    if (processing) return;
    const o = toOriginalKey(key);
    if (o.name === 'escape') {
      onClose();
    } else if (o.name === 'up' || o.name === 'down') {
      setSel((s) => (s === 0 ? 1 : 0));
    } else if (o.name === 'return') {
      void runStop(items[sel]?.key ?? 'cleanup');
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
          <box key={it.key} flexDirection="column">
            <box flexDirection="row">
              <text fg={i === sel ? C.accent : C.dim}>
                {i === sel ? '● ' : '○ '}
              </text>
              <text
                fg={i === sel ? C.text : C.dim}
                attributes={i === sel ? 1 : 0}
              >
                {it.label}
              </text>
            </box>
            <box paddingLeft={2}>
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

function AgentPreview({ result }: { result: ArenaAgentResult }) {
  const files = result.diffSummary?.files ?? [];
  return (
    <box marginTop={1} flexDirection="column">
      <text fg={C.text} attributes={1}>
        {`Quick Preview · ${result.model.modelId}`}
      </text>
      <box marginLeft={2} flexDirection="row">
        <text fg={C.dim}>{'Approach: '}</text>
        <text fg={C.text}>
          {result.approachSummary ?? 'No approach summary available.'}
        </text>
      </box>
      <box marginLeft={2} flexDirection="row">
        <text fg={C.dim}>{'Major files: '}</text>
        <text fg={C.text}>{formatFileList(files.map((f) => f.path))}</text>
      </box>
      <box marginLeft={2} flexDirection="row">
        <text fg={C.dim}>{'Metrics: '}</text>
        <text
          fg={C.text}
        >{`${result.stats.outputTokens.toLocaleString()} tokens · ${formatDuration(result.stats.durationMs)} · ${result.stats.toolCalls} tools`}</text>
      </box>
    </box>
  );
}

function AgentDetailedDiff({ result }: { result: ArenaAgentResult }) {
  const lines = visibleDiffLines(result.diff);
  return (
    <box marginTop={1} flexDirection="column">
      <text fg={C.text} attributes={1}>
        {`Detailed Diff · ${result.model.modelId}`}
      </text>
      {lines.length === 0 ? (
        <box marginLeft={2}>
          <text fg={C.dim}>{'No diff available.'}</text>
        </box>
      ) : (
        <box marginLeft={2} flexDirection="column">
          {lines.map((line, index) => (
            <text key={index} fg={diffLineColor(line)}>
              {line}
            </text>
          ))}
        </box>
      )}
    </box>
  );
}

/** `/arena select` — winner picker with preview panes and discard. */
function ArenaSelect({ config, onClose, notify }: OpenTuiArenaDialogProps) {
  const manager = config?.getArenaManager?.() ?? null;
  const agents = useMemo(() => manager?.getAgentStates() ?? [], [manager]);
  const result = manager?.getResult();
  const [sel, setSel] = useState(() =>
    Math.max(
      0,
      agents.findIndex((a) => isSuccessStatus(a.status)),
    ),
  );
  const [showPreview, setShowPreview] = useState(false);
  const [showDetailedDiff, setShowDetailedDiff] = useState(false);

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
      notify('✗ No arena session found. Start one with /arena start.');
      return;
    }
    const agent =
      mgr.getAgentState(agentId) ??
      mgr.getAgentStates().find((a) => a.agentId === agentId);
    const label = agent?.model.modelId || agentId;
    notify(`Applying changes from ${label}…`);
    const applyResult = await mgr.applyAgentResult(agentId);
    if (!applyResult.success) {
      notify(`✗ Failed to apply changes from ${label}: ${applyResult.error}`);
      return;
    }
    try {
      await config?.cleanupArenaRuntime?.(true);
    } catch (err) {
      notify(
        `✗ Warning: failed to clean up arena resources: ${err instanceof Error ? err.message : String(err)}`,
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
      notify('✗ No arena session found. Start one with /arena start.');
      return;
    }
    try {
      notify('Discarding Arena results and cleaning up…');
      await config?.cleanupArenaRuntime?.(true);
      notify('Arena results discarded. All worktrees cleaned up.');
    } catch (err) {
      notify(
        `✗ Failed to clean up arena worktrees: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'escape') {
      onClose();
    } else if (o.name === 'up' || o.name === 'down') {
      setSel((s) => nextEnabledIndex(rows, s, o.name === 'up' ? -1 : 1));
    } else if (o.name === 'return') {
      const row = rows[sel];
      if (row && !row.disabled) void applyWinner(row.key);
    } else if (!o.ctrl && !o.meta) {
      if (o.name === 'p') setShowPreview((v) => !v);
      else if (o.name === 'd') setShowDetailedDiff((v) => !v);
      else if (o.name === 'x') void discardAll();
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

  const task = truncate(result?.task ?? '', MAX_TASK_DISPLAY_LENGTH);

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
        <text fg={C.dim}>{'Select a winner to apply changes:'}</text>
      </box>
      <box marginTop={1} flexDirection="column">
        {rows.map((row, i) => (
          <box key={row.key} flexDirection="column">
            <box flexDirection="row">
              <text fg={row.disabled ? C.dim : i === sel ? C.accent : C.dim}>
                {i === sel ? '● ' : '○ '}
              </text>
              <text
                fg={row.disabled ? C.dim : i === sel ? C.text : C.dim}
                attributes={!row.disabled && i === sel ? 1 : 0}
              >
                {row.label}
              </text>
            </box>
            <box paddingLeft={2} flexDirection="row">
              <text fg={row.status.color}>{row.status.text}</text>
              <text
                fg={C.dim}
              >{` · ${row.duration} · ${row.tokens} tokens`}</text>
              {row.fileCount > 0 && (
                <text fg={C.dim}>{` · ${row.fileCount} files`}</text>
              )}
              {(row.additions > 0 || row.deletions > 0) && (
                <>
                  <text fg={C.dim}>{' · '}</text>
                  <text fg={C.green}>{`+${row.additions}`}</text>
                  <text fg={C.dim}>{'/'}</text>
                  <text fg={C.red}>{`-${row.deletions}`}</text>
                  <text fg={C.dim}>{' lines'}</text>
                </>
              )}
            </box>
          </box>
        ))}
      </box>
      {showPreview && selectedResult && (
        <AgentPreview result={selectedResult} />
      )}
      {showDetailedDiff && selectedResult && (
        <AgentDetailedDiff result={selectedResult} />
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
