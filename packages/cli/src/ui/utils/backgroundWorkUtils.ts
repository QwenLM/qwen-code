/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildBackgroundEntryLabel } from '@qwen-code/qwen-code-core';
import type {
  Config,
  TaskStatus,
  WorkflowStatus,
} from '@qwen-code/qwen-code-core';
import { formatDuration } from './formatters.js';
import { stripUnsafeCharacters, truncateToWidth } from './textUtils.js';

export function hasBlockingBackgroundWork(config: Config): boolean {
  return (
    // hasRunningTasks, not hasUnfinalizedTasks: a cancelled task whose
    // finalize callback hasn't fired yet must not block /clear or
    // session resume — both abort-and-reset the registry right after
    // this gate, suppressing the pending notification anyway. Gating on
    // the unfinalized set made /new silently no-op when typed in the
    // window between cancel and finalize (issue #5949).
    config.getBackgroundTaskRegistry().hasRunningTasks() ||
    config.getMonitorRegistry().getRunning().length > 0 ||
    config.getBackgroundShellRegistry().hasRunningEntries() ||
    // R7 (wenshao): the WorkflowRunRegistry is a 4th sibling that the
    // earlier P4b commit forgot to wire here. Without this OR clause,
    // /clear and session-resume happily ran while a workflow was
    // mid-run, orphaning the dispatch loop.
    config.getWorkflowRunRegistry().hasRunningEntries()
  );
}

export function resetBackgroundStateForSessionSwitch(config: Config): void {
  config.getBackgroundTaskRegistry().reset();
  config.getMonitorRegistry().reset();
  config.getBackgroundShellRegistry().reset();
  // R7 (wenshao): symmetric with hasBlockingBackgroundWork — without
  // this call, terminal workflow rows from the previous session
  // leaked into the next session's pill / dialog / /workflows list.
  // R12 (doudouOUC): abort BEFORE reset — paused runs no longer block
  // the switch (hasRunningEntries() excludes them), and reset() alone
  // would drop their entries without aborting the controllers, leaving
  // the gated script and its vm context alive indefinitely. The gate
  // still blocks running / pausing runs, so only paused entries are
  // cancelled here; the runner's finally still writes their snapshot
  // and telemetry as they settle.
  config.getWorkflowRunRegistry().abortAll();
  config.getWorkflowRunRegistry().reset();
}

/** Cap on enumerated lines so a pathological registry can't produce a wall of text. */
const MAX_LISTED_BLOCKING_ENTRIES = 10;
const MAX_BLOCKING_LABEL_WIDTH = 80;

export interface BlockingBackgroundWork {
  /**
   * One formatted line per blocking entry, sorted by start time, e.g.
   * `  [bg_ab12cd34] npm run dev (running 21h 4m)`. Capped at
   * `MAX_LISTED_BLOCKING_ENTRIES` plus a `…and N more` tail. Sanitized —
   * labels are user/process-supplied.
   */
  lines: string[];
  /** True when at least one blocking entry is an agent, shell, or monitor
   *  (the kinds `/tasks` lists). */
  hasTaskEntries: boolean;
  /** True when at least one blocking entry is a workflow run (listed via
   *  `/workflows`, not `/tasks`). */
  hasWorkflowRuns: boolean;
}

/**
 * Enumerates the entries that make `hasBlockingBackgroundWork()` true,
 * mirroring its per-registry predicate exactly (background agents:
 * `isBackgrounded` + `running`; monitors: `running`; shells: `running`;
 * workflow runs: `running` or `pausing`, plus the reserved-but-
 * unregistered runs `hasRunningEntries()` counts via `starting`). Returns `undefined`
 * when nothing is enumerated — e.g. an entry settled between the gate check
 * and this call — so callers fall back to their base message instead of
 * rendering an empty list.
 */
export function describeBlockingBackgroundWork(
  config: Config,
): BlockingBackgroundWork | undefined {
  const now = Date.now();
  const entries: Array<{
    startTime: number;
    id: string;
    label: string;
    status: TaskStatus | WorkflowStatus | 'starting';
    isWorkflowRun: boolean;
    isStarting?: boolean;
  }> = [];

  for (const entry of config.getBackgroundTaskRegistry().getAll()) {
    if (!entry.isBackgrounded || entry.status !== 'running') continue;
    entries.push({
      startTime: entry.startTime,
      id: entry.agentId,
      label: buildBackgroundEntryLabel(entry),
      status: entry.status,
      isWorkflowRun: false,
    });
  }
  for (const entry of config.getMonitorRegistry().getRunning()) {
    entries.push({
      startTime: entry.startTime,
      id: entry.monitorId,
      label: entry.description,
      status: entry.status,
      isWorkflowRun: false,
    });
  }
  for (const entry of config.getBackgroundShellRegistry().getAll()) {
    if (entry.status !== 'running') continue;
    entries.push({
      startTime: entry.startTime,
      id: entry.shellId,
      label: entry.command,
      status: entry.status,
      isWorkflowRun: false,
    });
  }
  for (const entry of config.getWorkflowRunRegistry().list()) {
    if (entry.status !== 'running' && entry.status !== 'pausing') continue;
    entries.push({
      startTime: entry.startTime,
      id: entry.runId,
      label: entry.meta?.name ?? entry.runId,
      status: entry.status,
      isWorkflowRun: true,
    });
  }
  // `hasRunningEntries()` also counts runs reserved by `reserveStart` and
  // not yet registered (journal replay on retry, saved-workflow background
  // start). `list()` never contains them, so the gate was true with nothing
  // to name: during the starting window /clear, /branch and /resume were
  // refused with the bare base message and no blocker. A reservation has
  // no registered startTime and no meta yet, so it sorts as the newest
  // entry and renders without a duration.
  for (const runId of config.getWorkflowRunRegistry().listStartingRunIds()) {
    entries.push({
      startTime: now,
      id: runId,
      label: runId,
      status: 'starting',
      isWorkflowRun: true,
      isStarting: true,
    });
  }

  if (entries.length === 0) return undefined;

  entries.sort((a, b) => a.startTime - b.startTime);
  const listed = entries.slice(0, MAX_LISTED_BLOCKING_ENTRIES);
  const lines = listed.map((entry) => {
    const label = truncateToWidth(
      stripUnsafeCharacters(entry.label).replace(/[\r\n]+/g, ' '),
      MAX_BLOCKING_LABEL_WIDTH,
    );
    // The label of a reservation is its run id, which the bracket already
    // carries; printing it twice reads as a duplicated row.
    if (entry.isStarting) return `  [${entry.id}] (starting)`;
    return `  [${entry.id}] ${label} (${entry.status} ${formatDuration(
      now - entry.startTime,
      { hideTrailingZeros: true },
    )})`;
  });
  const overflow = entries.length - listed.length;
  if (overflow > 0) {
    lines.push(`  …and ${overflow} more`);
  }
  return {
    lines,
    hasTaskEntries: entries.some((entry) => !entry.isWorkflowRun),
    hasWorkflowRuns: entries.some((entry) => entry.isWorkflowRun),
  };
}

/**
 * Builds the session-switch blocked error: the caller's base message plus
 * one line per blocking entry and a pointer to the command that lists
 * each kind (`/tasks` for agents/shells/monitors, `/workflows` for
 * workflow runs). Falls back to the bare base message when nothing is
 * enumerated (see `describeBlockingBackgroundWork`).
 */
export function buildBackgroundWorkBlockedMessage(
  config: Config,
  baseMessage: string,
): string {
  const blocking = describeBlockingBackgroundWork(config);
  if (!blocking) return baseMessage;
  const surfaces = [
    ...(blocking.hasTaskEntries ? ['/tasks'] : []),
    ...(blocking.hasWorkflowRuns ? ['/workflows'] : []),
  ].join(' and ');
  return [
    baseMessage,
    ...blocking.lines,
    `Use ${surfaces} to inspect them, then retry.`,
  ].join('\n');
}
