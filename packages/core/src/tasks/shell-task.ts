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

import * as fs from 'node:fs';

import { createDebugLogger } from '../utils/debugLogger.js';
import { escapeXml } from '../utils/xml.js';
import type { TaskBase, TaskRegistration } from './types.js';
import type { TaskRegistry } from './registry.js';
import type { Task } from './dispatcher.js';

const debugLogger = createDebugLogger('SHELL_TASK');

// ---------------------------------------------------------------------------
// Notification constants
// ---------------------------------------------------------------------------

const MAX_NOTIFICATION_COMMAND_LENGTH = 80;
const MAX_NOTIFICATION_MODEL_COMMAND_LENGTH = 500;
export const MAX_NOTIFICATION_OUTPUT_TAIL_BYTES = 8192;

// ---------------------------------------------------------------------------
// Notification types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Per-registry notification callback (mirrors monitor-task.ts pattern)
//
// Keyed by `TaskRegistry` rather than a bare module singleton so that
// concurrent ACP sessions — each with its own `Config`/`TaskRegistry` —
// don't overwrite each other's notification callback. See the equivalent
// note in `agent-task.ts`. `WeakMap` so a disposed session's entry is
// collected with its `Config`.
// ---------------------------------------------------------------------------

let notificationCallbacks = new WeakMap<
  TaskRegistry,
  BackgroundShellNotificationCallback
>();

export function setShellNotificationCallback(
  registry: TaskRegistry,
  cb: BackgroundShellNotificationCallback | undefined,
): void {
  if (cb) {
    notificationCallbacks.set(registry, cb);
  } else {
    notificationCallbacks.delete(registry);
  }
}

// ---------------------------------------------------------------------------
// Notification helper functions (ported from backgroundShellRegistry.ts)
// ---------------------------------------------------------------------------

/**
 * Strip C0 control characters (except tab) and C1 control characters from
 * terminal/UI display strings.
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

function getReadOutputOpenFlags(): number {
  const constants = fs.constants;
  return (constants?.O_RDONLY ?? 0) | (constants?.O_NOFOLLOW ?? 0);
}

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
 * Emit a terminal notification for a shell entry that just settled.
 * No-op if the entry was already notified or no callback is registered.
 */
function emitShellNotification(registry: TaskRegistry, entry: ShellTask): void {
  if (entry.notified) return;

  // Mark notified silently — no need to trigger change listeners.
  entry.notified = true;

  const notificationCallback = notificationCallbacks.get(registry);
  if (!notificationCallback) {
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
    notificationCallback(displayText, xmlParts.join('\n'), meta);
  } catch (error) {
    debugLogger.error('Failed to emit shell notification:', error);
  }
}

/**
 * Test-only: reset the module-level notification callback. Pair with
 * `_resetTaskKindModuleStateForTest` in `tasks/index.ts`.
 */
export function _resetShellTaskModuleStateForTest(): void {
  notificationCallbacks = new WeakMap();
}

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
  emitShellNotification(registry, entry);
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
  emitShellNotification(registry, entry);
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
  options: { notify?: boolean } = {},
): void {
  const entry = registry.get(shellId) as ShellTask | undefined;
  if (!entry || entry.kind !== 'shell' || entry.status !== 'running') return;
  entry.abortController.abort();
  registry.update<ShellTask>(shellId, (current) => {
    current.status = 'cancelled';
    current.endTime = endTime;
    return current;
  });
  if (options.notify !== false) {
    emitShellNotification(registry, entry);
  }
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
      shellCancel(registry, entry.shellId, endTime, { notify: false });
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
