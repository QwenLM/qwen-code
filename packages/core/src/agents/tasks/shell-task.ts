/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shell kind of `TaskState`. Tracks one managed
 * background shell — a spawned child process whose stdout/stderr is
 * captured to `outputFile` and whose lifecycle is observable through
 * the registry.
 *
 * Replaces the methods on `BackgroundShellRegistry` with kind-local
 * free functions that operate on a passed `TaskRegistry`. State
 * machine: register → running → { completed | failed | cancelled }.
 * Transitions out of running are one-shot: complete/fail/cancel become
 * no-ops once the entry has settled. This prevents late callbacks
 * (e.g. a process that exits during cancellation) from clobbering the
 * terminal status.
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import type { TaskBase, TaskRegistration } from './types.js';
import type { TaskRegistry } from './registry.js';
import type { Task } from './dispatcher.js';

const debugLogger = createDebugLogger('SHELL_TASK');

/**
 * Cap on how many terminal (completed/failed/cancelled) entries the
 * registry retains for the shell kind. Without this cap, every
 * short-lived background shell leaves a row in the Background tasks
 * dialog and pill forever, crowding out the running entries the user
 * actually opened the dialog to find. Mirrors the rationale + retention
 * pattern in `MAX_RETAINED_TERMINAL_MONITORS` /
 * `MAX_RETAINED_TERMINAL_AGENTS`.
 *
 * Sized lower than the monitor cap because shells are user-initiated (a
 * session typically has tens, not hundreds) and the dialog-side cost of
 * a stale shell row is higher — each one has a long `command` label, so
 * they push newer entries out of the visible window faster than monitor
 * rows would.
 */
export const MAX_RETAINED_TERMINAL_SHELLS = 32;

export type BackgroundShellStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Shell kind of `TaskState`. Tracks one managed background shell — a
 * spawned child process whose stdout/stderr is captured to `outputFile`
 * and whose lifecycle is observable through the registry.
 */
export interface ShellTask extends TaskBase {
  kind: 'shell';
  /**
   * @deprecated Read `id` instead; kept as a synonym during the
   * back-compat window. Always equals `id`.
   */
  shellId: string;
  /** The user-supplied command, after any pre-processing the tool applies. */
  command: string;
  /** Working directory the process was spawned in. */
  cwd: string;
  /** OS pid once spawned; absent if registration happens before spawn. */
  pid?: number;
  status: BackgroundShellStatus;
  /** Exit code on `completed`. */
  exitCode?: number;
  /** Error message on `failed`. */
  error?: string;
  /**
   * @deprecated Use `outputFile`. Kept as a synonym during the
   * back-compat window; always equals `outputFile`.
   */
  outputPath: string;
}

/**
 * @deprecated Renamed to `ShellTask`. Kept as a one-release type alias
 * for external SDK consumers; will be removed in the release after PR 2
 * lands.
 */
export type BackgroundShellEntry = ShellTask;

/**
 * Shape callers pass to {@link shellRegister}; the helper derives the
 * shared `TaskBase` envelope (`id`, `kind`, `outputOffset`, `notified`)
 * from these and additionally:
 *   - aliases the legacy `outputPath` to `outputFile` (asymmetric vs.
 *     `AgentTaskRegistration` / `MonitorTaskRegistration`, which require
 *     callers to pass `outputFile` directly — this is a one-release
 *     transitional concession until `outputPath` is removed)
 *   - synthesizes `description` from `command` (shells have no separate
 *     human label).
 */
export type ShellTaskRegistration = Omit<
  TaskRegistration<ShellTask>,
  'description' | 'outputFile'
>;

/**
 * Read a shell entry from the registry with the kind narrowed. Returns
 * `undefined` for missing ids and for ids that resolve to a non-shell
 * kind.
 */
export function getShellTask(
  registry: TaskRegistry,
  shellId: string,
): ShellTask | undefined {
  const entry = registry.get(shellId);
  if (!entry || entry.kind !== 'shell') return undefined;
  return entry;
}

/**
 * Snapshot of every shell task. Convenience over
 * `registry.getByKind('shell')` for call sites that already destructure
 * shell-specific fields.
 */
export function getAllShellTasks(registry: TaskRegistry): ShellTask[] {
  return registry.getByKind('shell');
}

/**
 * Insert a new shell task into the registry. Mutates `registration` in
 * place to graduate it to a full `ShellTask` (populating the `TaskBase`
 * envelope and synthesizing `description` from `command`) and then
 * hands the reference to `registry.register`. Returning the same
 * reference keeps existing call sites that mutate the entry
 * post-register (e.g. shell.ts's `entry.pid = pid`) observable through
 * `registry.get` / `getAll` without a re-fetch.
 */
export function shellRegister(
  registry: TaskRegistry,
  registration: ShellTaskRegistration,
): ShellTask {
  const entry = registration as ShellTask;
  entry.id = registration.shellId;
  entry.kind = 'shell';
  // Shells have no separate description field; the command serves as
  // the human label rendered in the dialog/pill.
  entry.description = registration.command;
  entry.outputFile = registration.outputPath;
  entry.outputOffset = 0;
  entry.notified = false;
  registry.register(entry);
  return entry;
}

/**
 * Transition a running shell to `completed`. No-op if the entry is no
 * longer running — guards against late settle callbacks racing
 * concurrent cancellation.
 */
export function shellComplete(
  registry: TaskRegistry,
  shellId: string,
  exitCode: number,
  endTime: number,
): void {
  const entry = registry.get(shellId) as ShellTask | undefined;
  if (!entry || entry.kind !== 'shell' || entry.status !== 'running') return;
  registry.update<ShellTask>(shellId, (current) => {
    current.status = 'completed';
    current.exitCode = exitCode;
    current.endTime = endTime;
    return current;
  });
  pruneTerminalEntries(registry);
}

/**
 * Transition a running shell to `failed`. No-op if the entry is no
 * longer running.
 */
export function shellFail(
  registry: TaskRegistry,
  shellId: string,
  error: string,
  endTime: number,
): void {
  const entry = registry.get(shellId) as ShellTask | undefined;
  if (!entry || entry.kind !== 'shell' || entry.status !== 'running') return;
  registry.update<ShellTask>(shellId, (current) => {
    current.status = 'failed';
    current.error = error;
    current.endTime = endTime;
    return current;
  });
  pruneTerminalEntries(registry);
}

/**
 * Transition a running shell to `cancelled` and abort its
 * AbortController. Used by `shellAbortAll` and the legacy direct cancel
 * path; the public-facing cancel for the dialog and `task_stop` tool is
 * {@link shellRequestCancel}, which only aborts and lets the spawn
 * settle path record the real terminal moment.
 */
export function shellCancel(
  registry: TaskRegistry,
  shellId: string,
  endTime: number,
): void {
  const entry = registry.get(shellId) as ShellTask | undefined;
  if (!entry || entry.kind !== 'shell' || entry.status !== 'running') return;
  entry.abortController.abort();
  registry.update<ShellTask>(shellId, (current) => {
    current.status = 'cancelled';
    current.endTime = endTime;
    return current;
  });
  pruneTerminalEntries(registry);
}

/**
 * Request cancellation without marking the entry terminal.
 *
 * Triggers the entry's AbortController so the spawn handler can tear
 * the process down, but leaves `status='running'` until the settle path
 * observes the abort and records the real exit moment + outcome via
 * {@link shellComplete} / {@link shellFail} / {@link shellCancel}. This
 * keeps the registry honest: a cancelled shell only shows its terminal
 * `endTime` once the process has actually drained, and a cancel-vs-exit
 * race can't permanently hide a real completed/failed result.
 *
 * Used by the `task_stop` tool path and the dialog cancel switch; the
 * immediate-mark `shellCancel` above is reserved for `shellAbortAll` /
 * shutdown, where the CLI process is tearing down anyway and there is
 * no settle handler to wait for.
 *
 * Idempotent: no-op on entries that aren't `running`.
 */
export function shellRequestCancel(
  registry: TaskRegistry,
  shellId: string,
): void {
  const entry = registry.get(shellId) as ShellTask | undefined;
  if (!entry || entry.kind !== 'shell' || entry.status !== 'running') return;
  entry.abortController.abort();
}

/**
 * True if any registered shell is still running. Headless shutdown uses
 * this to decide whether to block on shell drain before exiting.
 */
export function shellHasRunningEntries(registry: TaskRegistry): boolean {
  for (const entry of registry.getByKind('shell')) {
    if (entry.status === 'running') return true;
  }
  return false;
}

/**
 * Drops every in-memory shell entry without touching spawned processes.
 *
 * Callers must only use this after verifying that no running managed
 * shell from the current session still exists.
 */
export function shellReset(registry: TaskRegistry): void {
  let removed = 0;
  for (const entry of registry.getByKind('shell')) {
    registry.evict(entry.shellId);
    removed++;
  }
  if (removed > 0) {
    debugLogger.info(`Reset ${removed} shell entries`);
  }
}

/**
 * Cancel every still-running shell. Called on session/Config shutdown
 * so background shells don't outlive the CLI process and leak orphaned
 * children.
 */
export function shellAbortAll(registry: TaskRegistry): void {
  const endTime = Date.now();
  for (const entry of registry.getByKind('shell')) {
    if (entry.status === 'running') {
      shellCancel(registry, entry.shellId, endTime);
    }
  }
}

/**
 * Evict the oldest terminal entries (by `endTime`, then `startTime`)
 * once the count exceeds `MAX_RETAINED_TERMINAL_SHELLS`. Running
 * entries are never evicted. Called after every running → terminal
 * transition; the transition stamps `endTime` before the prune runs,
 * so a fresh terminal never out-ages the entries already retained.
 */
function pruneTerminalEntries(registry: TaskRegistry): void {
  const terminalEntries = registry
    .getByKind('shell')
    .filter((entry) => entry.status !== 'running')
    .sort(
      (a, b) =>
        (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime) ||
        a.startTime - b.startTime,
    );

  while (terminalEntries.length > MAX_RETAINED_TERMINAL_SHELLS) {
    const oldest = terminalEntries.shift();
    if (oldest) {
      registry.evict(oldest.shellId);
    }
  }
}

/**
 * `Task` implementation registered with the dispatcher. Dialog cancel
 * goes through `requestCancel` so the spawn settle path can record the
 * real terminal moment + outcome.
 */
export const ShellTaskKind: Task = {
  kind: 'shell',
  name: 'Background shell',
  kill: (id, ctx) => {
    shellRequestCancel(ctx.registry, id);
  },
};
