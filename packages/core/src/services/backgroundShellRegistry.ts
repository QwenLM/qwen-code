/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracks background shell processes spawned via the `shell` tool with
 * `is_background: true`. Each entry holds the metadata the agent and the
 * `/tasks` slash command need to query, observe, or terminate a running
 * background shell.
 *
 * State machine: register → running → { completed | failed | cancelled }.
 * Transitions out of running are one-shot: complete/fail/cancel become
 * no-ops once the entry has settled. This prevents late callbacks (e.g. a
 * process that exits during cancellation) from clobbering the terminal
 * status.
 */

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('BACKGROUND_SHELLS');

export type BackgroundShellStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BackgroundShellEntry {
  /** Stable id used by the model and the `/tasks` UI. */
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
  /** ms epoch when the entry was registered. */
  startTime: number;
  /** ms epoch when the entry transitioned out of running. */
  endTime?: number;
  /** Absolute path of the captured stdout/stderr file. */
  outputPath: string;
  /** Aborted by `cancel()`; callers should wire it into the spawn. */
  abortController: AbortController;
}

/** Fires when a new entry is registered. */
export type BackgroundShellRegisterCallback = (
  entry: BackgroundShellEntry,
) => void;

/**
 * Fires on every status transition (running → terminal). Symmetric with
 * `BackgroundTaskRegistry.setStatusChangeCallback` so the same UI hook can
 * subscribe to both registries.
 */
export type BackgroundShellStatusChangeCallback = (
  entry?: BackgroundShellEntry,
) => void;

export class BackgroundShellRegistry {
  // Entries persist for the session lifetime — no automatic eviction of
  // terminal entries. For typical interactive sessions (tens of background
  // shells over an hour) this is fine, but long-running sessions that spawn
  // many short-lived background commands will see the map and the on-disk
  // output files grow without bound. Eviction policy (LRU? age-based? cap?)
  // is left as a follow-up alongside output-file rotation.
  private readonly entries = new Map<string, BackgroundShellEntry>();

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

  register(entry: BackgroundShellEntry): void {
    this.entries.set(entry.shellId, entry);
    this.fireRegister(entry);
    // Mirror BackgroundTaskRegistry: registration is a status transition
    // (nothing → running) so subscribers that only care about
    // "what's in the registry now" can subscribe to a single callback
    // and see new entries the same way they see status changes.
    this.fireStatusChange(entry);
  }

  get(shellId: string): BackgroundShellEntry | undefined {
    return this.entries.get(shellId);
  }

  getAll(): readonly BackgroundShellEntry[] {
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
    this.fireStatusChange(entry);
  }

  fail(shellId: string, error: string, endTime: number): void {
    const entry = this.entries.get(shellId);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'failed';
    entry.error = error;
    entry.endTime = endTime;
    this.fireStatusChange(entry);
  }

  cancel(shellId: string, endTime: number): void {
    const entry = this.entries.get(shellId);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'cancelled';
    entry.endTime = endTime;
    entry.abortController.abort();
    this.fireStatusChange(entry);
  }

  private fireRegister(entry: BackgroundShellEntry): void {
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

  private fireStatusChange(entry?: BackgroundShellEntry): void {
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
      | BackgroundShellEntry
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
   */
  abortAll(): void {
    const endTime = Date.now();
    for (const entry of Array.from(this.entries.values())) {
      if (entry.status === 'running') {
        this.cancel(entry.shellId, endTime);
      }
    }
  }
}
