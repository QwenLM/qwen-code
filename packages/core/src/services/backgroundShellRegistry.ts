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

import * as fs from 'node:fs';

import type { TaskBase, TaskRegistration } from '../agents/tasks/types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { escapeXml } from '../utils/xml.js';

const debugLogger = createDebugLogger('BACKGROUND_SHELLS');
const MAX_NOTIFICATION_COMMAND_LENGTH = 80;
const MAX_NOTIFICATION_MODEL_COMMAND_LENGTH = 500;
export const MAX_NOTIFICATION_OUTPUT_TAIL_BYTES = 8192;

/**
 * Strip C0 control characters (except tab) and C1 control characters from
 * terminal/UI display strings. Shell commands and errors are usually
 * user-authored, but this keeps escape sequences out of the visible
 * notification surface if a caller passes unsanitized text.
 */
function stripDisplayControlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09) {
      out += text[i];
      continue;
    }
    if (code < 0x20) continue;
    if (code >= 0x80 && code <= 0x9f) continue;
    out += text[i];
  }
  return out;
}

function stripOutputControlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += text[i];
      continue;
    }
    if (code < 0x20) continue;
    if (code >= 0x80 && code <= 0x9f) continue;
    out += text[i];
  }
  return out;
}

type OutputTailResult =
  | { text: string; truncated: boolean }
  | { error: string }
  | undefined;

function readOutputTail(outputFile: string): OutputTailResult {
  let fd: number | undefined;
  try {
    fd = fs.openSync(outputFile, getReadOutputOpenFlags());
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0) return undefined;

    const length = Math.min(stat.size, MAX_NOTIFICATION_OUTPUT_TAIL_BYTES);
    const start = stat.size - length;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);

    // When the read offset lands mid-codepoint (truncated read), skip
    // leading UTF-8 continuation bytes to avoid U+FFFD replacement chars.
    let sliceOffset = 0;
    if (start > 0) {
      while (
        sliceOffset < bytesRead &&
        (buffer[sliceOffset]! & 0xc0) === 0x80
      ) {
        sliceOffset++;
      }
    }

    const text = stripOutputControlChars(
      buffer.subarray(sliceOffset, bytesRead).toString('utf8'),
    ).trimEnd();

    if (!text) return undefined;
    return {
      text,
      truncated: start > 0,
    };
  } catch (error) {
    debugLogger.warn(`Failed to read shell output tail:`, error);
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

function getReadOutputOpenFlags(): number {
  const constants = fs.constants;
  return (constants?.O_RDONLY ?? 0) | (constants?.O_NOFOLLOW ?? 0);
}

function truncateCommandForDisplay(command: string): string {
  const normalized = stripDisplayControlChars(command).replace(/\s+/g, ' ');
  if (normalized.length <= MAX_NOTIFICATION_COMMAND_LENGTH) {
    return normalized;
  }
  return normalized.slice(0, MAX_NOTIFICATION_COMMAND_LENGTH - 3) + '...';
}

function truncateCommandForModel(command: string): {
  text: string;
  truncated: boolean;
} {
  const sanitized = stripDisplayControlChars(command);
  if (sanitized.length <= MAX_NOTIFICATION_MODEL_COMMAND_LENGTH) {
    return {
      text: sanitized,
      truncated: false,
    };
  }

  return {
    text: sanitized.slice(0, MAX_NOTIFICATION_MODEL_COMMAND_LENGTH - 3) + '...',
    truncated: true,
  };
}

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

export interface ShellNotificationMeta {
  shellId: string;
  status: BackgroundShellStatus;
  exitCode?: number;
}

export type BackgroundShellNotificationCallback = (
  displayText: string,
  modelText: string,
  meta: ShellNotificationMeta,
) => void;

/**
 * Fires on every status transition (running → terminal). Symmetric with
 * `BackgroundTaskRegistry.setStatusChangeCallback` so the same UI hook can
 * subscribe to both registries.
 */
export type BackgroundShellStatusChangeCallback = (entry?: ShellTask) => void;

export class BackgroundShellRegistry {
  private readonly entries = new Map<string, ShellTask>();

  private registerCallback: BackgroundShellRegisterCallback | undefined;
  private notificationCallback: BackgroundShellNotificationCallback | undefined;
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

  setNotificationCallback(
    cb: BackgroundShellNotificationCallback | undefined,
  ): void {
    this.notificationCallback = cb;
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
    this.emitNotification(entry);
    this.pruneTerminalEntries();
    this.fireStatusChange(entry);
  }

  fail(shellId: string, error: string, endTime: number): void {
    const entry = this.entries.get(shellId);
    if (!entry || entry.status !== 'running') return;
    entry.status = 'failed';
    entry.error = error;
    entry.endTime = endTime;
    this.emitNotification(entry);
    this.pruneTerminalEntries();
    this.fireStatusChange(entry);
  }

  cancel(shellId: string, endTime: number): void {
    const entry = this.entries.get(shellId);
    if (!entry || entry.status !== 'running') return;
    this.settleAsCancelled(entry, endTime);
    this.emitNotification(entry);
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

  private emitNotification(entry: ShellTask): void {
    if (entry.notified) return;
    entry.notified = true;

    if (!this.notificationCallback) {
      debugLogger.debug(
        `Notification dropped for shell ${entry.shellId}: no callback registered`,
      );
      return;
    }

    const statusText =
      entry.status === 'completed'
        ? 'completed'
        : entry.status === 'failed'
          ? 'failed'
          : 'was cancelled';
    const commandLabel = truncateCommandForDisplay(entry.command);
    const commandForModel = truncateCommandForModel(entry.command);
    const displayText = `Background shell "${commandLabel}" ${statusText}.`;

    const xmlParts: string[] = [
      '<task-notification>',
      `<task-id>${escapeXml(entry.shellId)}</task-id>`,
      '<kind>shell</kind>',
      `<status>${escapeXml(entry.status)}</status>`,
      `<summary>Shell command "${escapeXml(commandLabel)}" ${statusText}.</summary>`,
      commandForModel.truncated
        ? `<command truncated="true">${escapeXml(commandForModel.text)}</command>`
        : `<command>${escapeXml(commandForModel.text)}</command>`,
      `<cwd>${escapeXml(stripDisplayControlChars(entry.cwd))}</cwd>`,
    ];
    if (entry.pid !== undefined) {
      xmlParts.push(`<pid>${entry.pid}</pid>`);
    }
    if (entry.exitCode !== undefined) {
      xmlParts.push(`<exit-code>${entry.exitCode}</exit-code>`);
    }
    if (entry.error) {
      xmlParts.push(
        `<result>${escapeXml(stripDisplayControlChars(entry.error))}</result>`,
      );
    }
    const outputTail = readOutputTail(entry.outputFile);
    if (outputTail) {
      if ('error' in outputTail) {
        xmlParts.push(`<output-tail error="unreadable" />`);
      } else {
        xmlParts.push(
          `<output-tail truncated="${outputTail.truncated ? 'true' : 'false'}">${escapeXml(outputTail.text)}</output-tail>`,
        );
      }
    }
    xmlParts.push(
      `<output-file>${escapeXml(stripDisplayControlChars(entry.outputFile))}</output-file>`,
      '</task-notification>',
    );

    const meta: ShellNotificationMeta = {
      shellId: entry.shellId,
      status: entry.status,
      exitCode: entry.exitCode,
    };

    try {
      this.notificationCallback(displayText, xmlParts.join('\n'), meta);
    } catch (error) {
      debugLogger.error('Failed to emit shell notification:', error);
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
