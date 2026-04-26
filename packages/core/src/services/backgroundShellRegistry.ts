/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracks background shell processes spawned via the `shell` tool with
 * `is_background: true`. Each entry holds the metadata the agent and the
 * `/bashes` slash command need to query, observe, or terminate a running
 * background shell.
 *
 * State machine: register → running → { completed | failed | cancelled }.
 * Transitions out of running are one-shot: complete/fail/cancel become
 * no-ops once the entry has settled. This prevents late callbacks (e.g. a
 * process that exits during cancellation) from clobbering the terminal
 * status.
 */

export type BackgroundShellStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BackgroundShellEntry {
  /** Stable id used by the model and the `/bashes` UI. */
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

export class BackgroundShellRegistry {
  // Entries persist for the session lifetime — no automatic eviction of
  // terminal entries. For typical interactive sessions (tens of background
  // shells over an hour) this is fine, but long-running sessions that spawn
  // many short-lived background commands will see the map and the on-disk
  // output files grow without bound. Eviction policy (LRU? age-based? cap?)
  // is left as a follow-up alongside output-file rotation.
  private readonly entries = new Map<string, BackgroundShellEntry>();

  register(entry: BackgroundShellEntry): void {
    this.entries.set(entry.shellId, entry);
  }

  get(shellId: string): BackgroundShellEntry | undefined {
    return this.entries.get(shellId);
  }

  getAll(): readonly BackgroundShellEntry[] {
    return [...this.entries.values()];
  }

  complete(shellId: string, exitCode: number, endTime: number): void {
    const entry = this.entries.get(shellId);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'completed';
    entry.exitCode = exitCode;
    entry.endTime = endTime;
  }

  fail(shellId: string, error: string, endTime: number): void {
    const entry = this.entries.get(shellId);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'failed';
    entry.error = error;
    entry.endTime = endTime;
  }

  cancel(shellId: string, endTime: number): void {
    const entry = this.entries.get(shellId);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'cancelled';
    entry.endTime = endTime;
    entry.abortController.abort();
  }
}
