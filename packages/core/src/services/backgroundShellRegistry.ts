/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracks background shell processes spawned via the `shell` tool with
 * `is_background: true`. Each entry holds the metadata that the agent,
 * the `/tasks` slash command, and the interactive Background tasks
 * dialog use to query, observe, or terminate a running background
 * shell.
 *
 * State machine: register → running → { completed | failed | cancelled }.
 * Transitions out of running are one-shot: complete/fail/cancel become
 * no-ops once the entry has settled. This prevents late callbacks (e.g. a
 * process that exits during cancellation) from clobbering the terminal
 * status.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type { TaskBase, TaskRegistration } from '../agents/tasks/types.js';

const debugLogger = createDebugLogger('BACKGROUND_SHELLS');

/**
 * Cap on how many terminal (completed/failed/cancelled) entries the
 * registry retains. Without this cap, every short-lived background
 * shell leaves a row in the Background tasks dialog and pill forever,
 * crowding out the running entries the user actually opened the dialog
 * to find. Mirrors the rationale + retention pattern in
 * `MonitorRegistry.MAX_RETAINED_TERMINAL_MONITORS`.
 *
 * Sized lower than the monitor cap because shells are user-initiated
 * (a session typically has tens, not hundreds) and the dialog-side
 * cost of a stale shell row is higher — each one has a long `command`
 * label, so they push newer entries out of the visible window faster
 * than monitor rows would.
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
 * and whose lifecycle is observable through this registry.
 */
export interface ShellTask extends TaskBase {
  kind: 'shell';
  /**
   * @deprecated Read `id` instead; kept as a synonym during the back-compat
   * window. Always equals `id`.
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
   * @deprecated Use `outputFile`. Kept as a synonym during the back-compat
   * window; always equals `outputFile`.
   */
  outputPath: string;
}

/**
 * @deprecated Renamed to `ShellTask`. Kept as a one-release type alias for
 * external SDK consumers; will be removed in the release after PR 2 lands.
 */
export type BackgroundShellEntry = ShellTask;

/**
 * Shape callers pass to {@link BackgroundShellRegistry.register}; the
 * registry derives the shared `TaskBase` envelope (`id`, `kind`,
 * `outputOffset`, `notified`) from these and additionally:
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

/** Fires when a new entry is registered. */
export type BackgroundShellRegisterCallback = (entry: ShellTask) => void;

/**
 * Fires on every status transition (running → terminal). Symmetric with
 * `BackgroundTaskRegistry.setStatusChangeCallback` so the same UI hook can
 * subscribe to both registries.
 */
export type BackgroundShellStatusChangeCallback = (entry?: ShellTask) => void;

export class BackgroundShellRegistry {
  private readonly entries = new Map<string, ShellTask>();

  private registerCallback: BackgroundShellRegisterCallback | undefined;
  private statusChangeCallback: BackgroundShellStatusChangeCallback | undefined;

  /**
   * Subscribe to new-entry events. Called synchronously inside `register()`.
   * Setting `undefined` clears the existing subscriber. Single-subscriber on
   * purpose — the UI hook is the only consumer in the codebase, and a list
   * would invite drift in error-handling.
   */
  setRegisterCallback(cb: BackgroundShellRegisterCallback | undefined): void {
    this.registerCallback = cb;
  }

  /**
   * Subscribe to status transitions (running → terminal). Called
   * synchronously inside `complete()` / `fail()` / `cancel()` after the
   * entry has been mutated. Same single-subscriber rationale as
   * `setRegisterCallback`.
   */
  setStatusChangeCallback(
    cb: BackgroundShellStatusChangeCallback | undefined,
  ): void {
    this.statusChangeCallback = cb;
  }

  register(registration: ShellTaskRegistration): ShellTask {
    // Mutate the registration in place to graduate it to a `ShellTask`.
    // Returning the same reference keeps the existing call sites that
    // mutate the entry post-register (e.g. shell.ts's `entry.pid = pid`)
    // observable through `get()` / `getAll()` without an explicit
    // re-fetch.
    const entry = registration as ShellTask;
    entry.id = registration.shellId;
    entry.kind = 'shell';
    // Shells have no separate description field; the command serves as
    // the human label rendered in the dialog/pill.
    entry.description = registration.command;
    entry.outputFile = registration.outputPath;
    entry.outputOffset = 0;
    entry.notified = false;
    this.entries.set(entry.shellId, entry);
    this.fireRegister(entry);
    // Mirror BackgroundTaskRegistry: registration is a status transition
    // (nothing → running) so subscribers that only care about
    // "what's in the registry now" can subscribe to a single callback
    // and see new entries the same way they see status changes.
    this.fireStatusChange(entry);
    return entry;
  }

  get(shellId: string): ShellTask | undefined {
    return this.entries.get(shellId);
  }

  getAll(): readonly ShellTask[] {
    return [...this.entries.values()];
  }

  hasRunningEntries(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.status === 'running') return true;
    }
    return false;
  }

  complete(shellId: string, exitCode: number, endTime: number): void {
    const entry = this.entries.get(shellId);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'completed';
    entry.exitCode = exitCode;
    entry.endTime = endTime;
    this.pruneTerminalEntries();
    this.fireStatusChange(entry);
  }

  fail(shellId: string, error: string, endTime: number): void {
    const entry = this.entries.get(shellId);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'failed';
    entry.error = error;
    entry.endTime = endTime;
    this.pruneTerminalEntries();
    this.fireStatusChange(entry);
  }

  cancel(shellId: string, endTime: number): void {
    const entry = this.entries.get(shellId);
    if (!entry || entry.status !== 'running') return;
    this.settleAsCancelled(entry, endTime);
    this.pruneTerminalEntries();
    this.fireStatusChange(entry);
  }

  /**
   * Mutates a running entry to its `cancelled` terminal state without
   * touching the prune or status-change side channels. Internal helper
   * shared by `cancel()` (single-shot, fires both side channels) and
   * `abortAll()` (batch, fires both exactly once after the loop).
   *
   * Caller is responsible for verifying the entry is `running` before
   * invoking this. The split keeps the running-status guard at the
   * public-API boundary so a future caller can't accidentally settle
   * an already-terminal entry without that check.
   */
  private settleAsCancelled(
    entry: BackgroundShellEntry,
    endTime: number,
  ): void {
    entry.status = 'cancelled';
    entry.endTime = endTime;
    entry.abortController.abort();
  }

  /**
   * Evict the oldest terminal entries (by `endTime`, then `startTime`)
   * once the count exceeds `MAX_RETAINED_TERMINAL_SHELLS`. Running
   * entries are never evicted. Called after every running → terminal
   * transition; settle order ensures the newly-terminal entry has its
   * `endTime` stamped before the prune runs, so a fresh terminal
   * never out-ages the entries already retained.
   */
  private pruneTerminalEntries(): void {
    const terminalEntries = Array.from(this.entries.values())
      .filter((entry) => entry.status !== 'running')
      .sort(
        (a, b) =>
          (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime) ||
          a.startTime - b.startTime,
      );

    while (terminalEntries.length > MAX_RETAINED_TERMINAL_SHELLS) {
      const oldest = terminalEntries.shift();
      if (oldest) {
        this.entries.delete(oldest.shellId);
      }
    }
  }

  private fireRegister(entry: ShellTask): void {
    if (!this.registerCallback) return;
    try {
      this.registerCallback(entry);
    } catch (error) {
      // Subscriber failure must not poison the registry — the spawn path
      // has already happened. Swallow + continue so the entry remains
      // observable via `getAll()` / `get()`.
      debugLogger.error('register callback failed:', error);
    }
  }

  private fireStatusChange(entry?: ShellTask): void {
    if (!this.statusChangeCallback) return;
    try {
      this.statusChangeCallback(entry);
    } catch (error) {
      debugLogger.error('statusChange callback failed:', error);
    }
  }

  /**
   * Request cancellation without marking the entry terminal.
   *
   * Triggers the entry's AbortController so the spawn handler can tear the
   * process down, but leaves `status='running'` until the settle path
   * observes the abort and records the real exit moment + outcome via
   * `complete()` / `fail()` / `cancel()`. This keeps the registry honest:
   * a cancelled shell only shows its terminal `endTime` once the process
   * has actually drained, and a cancel-vs-exit race can't permanently hide
   * a real completed/failed result.
   *
   * Used by the `task_stop` tool path; the immediate-mark `cancel()` above
   * is reserved for `abortAll()` / shutdown, where the CLI process is
   * tearing down anyway and there is no settle handler to wait for.
   *
   * Idempotent: no-op on entries that aren't `running`.
   */
  requestCancel(shellId: string): void {
    const entry = this.entries.get(shellId);
    if (!entry || entry.status !== 'running') return;
    entry.abortController.abort();
  }

  /**
   * Drops every in-memory entry without touching spawned processes.
   *
   * Callers must only use this after verifying that no running managed shell
   * from the current session still exists.
   */
  reset(): void {
    const firstEntry = this.entries.values().next().value as
      | ShellTask
      | undefined;
    if (!firstEntry) return;
    this.entries.clear();
    this.fireStatusChange(firstEntry);
  }

  /**
   * Cancel every still-running entry. Called on session/Config shutdown so
   * background shells don't outlive the CLI process and leak orphaned
   * children. Symmetric with `BackgroundTaskRegistry.abortAll()` for the
   * subagent path.
   *
   * Settles each entry inline, then fires `pruneTerminalEntries` and the
   * statusChange callback exactly once after the loop. The per-entry
   * `cancel()` path would have triggered both side channels for every
   * running shell — wasteful on shutdown / `/clear` where the only
   * subscriber (`useBackgroundTaskView`) just re-pulls `getAll()`
   * regardless of the entry argument.
   */
  abortAll(): void {
    const endTime = Date.now();
    let lastCancelled: BackgroundShellEntry | undefined;
    for (const entry of Array.from(this.entries.values())) {
      if (entry.status !== 'running') continue;
      this.settleAsCancelled(entry, endTime);
      lastCancelled = entry;
    }
    if (!lastCancelled) return;
    this.pruneTerminalEntries();
    // The single subscriber (`useBackgroundTaskView`) ignores the entry
    // arg and re-pulls `getAll()`, so passing the last cancelled entry
    // here is informational only — any of the just-cancelled entries
    // would be equally valid as the "what changed" signal.
    this.fireStatusChange(lastCancelled);
  }
}
