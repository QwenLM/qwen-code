/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Monitor kind of `TaskState`. Tracks one long-running
 * monitor process whose stdout lines are pushed to the parent agent
 * as event notifications. `outputFile` is reserved on registration but
 * no writer is attached today — events stream into the parent's chat
 * record.
 *
 * Replaces the methods on `MonitorRegistry` with kind-local free
 * functions that operate on a passed `TaskRegistry`. Carries the
 * monitor-specific cap enforcement
 * (`MAX_RETAINED_TERMINAL_MONITORS = 128`) and idle timer here so the
 * registry stays kind-agnostic.
 */

import * as path from 'node:path';
import { sanitizeFilenameComponent } from '../agents/agent-transcript.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { escapeXml } from '../utils/xml.js';
import { stripTerminalControlSequences } from '../utils/terminalSafe.js';
import type { TaskBase, TaskRegistration } from './types.js';
import type { TaskRegistry } from './registry.js';
import type { Task } from './dispatcher.js';

const debugLogger = createDebugLogger('MONITOR_TASK');

const EVENT_LINE_TRUNCATE = 2000;
const MAX_DESCRIPTION_LENGTH = 80;
export const MAX_CONCURRENT_MONITORS = 16;
export const MAX_RETAINED_TERMINAL_MONITORS = 128;

export type MonitorStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Resolves a per-monitor reserved output path.
 *
 * Today no writer is attached at this path — monitors deliver their
 * events through the parent's chat record via the notification
 * callback. The path is reserved on every `MonitorTask` so the
 * `TaskBase` contract ("every task has a path it would write to if it
 * produces a primary stream") holds, and so a future per-monitor file
 * writer can land without changing the type signature.
 */
export function getMonitorOutputPath(
  projectDir: string,
  sessionId: string,
  monitorId: string,
): string {
  return path.join(
    projectDir,
    'monitors',
    sanitizeFilenameComponent(sessionId),
    `monitor-${sanitizeFilenameComponent(monitorId)}.log`,
  );
}

/**
 * Monitor kind of `TaskState`. Tracks one long-running monitor process
 * whose stdout lines are pushed to the parent agent as event
 * notifications. `outputFile` is reserved on registration but no writer
 * is attached today — events stream into the parent's chat record.
 */
export interface MonitorTask extends TaskBase {
  kind: 'monitor';
  /**
   * @deprecated Read `id` instead; kept as a synonym during the
   * back-compat window. Always equals `id`.
   */
  monitorId: string;
  command: string;
  status: MonitorStatus;
  pid?: number;
  toolUseId?: string;
  /**
   * When set, this monitor is owned by a background subagent rather than
   * the top-level session. Owner-scoped notifications route to the
   * owner's per-agent callback instead of the global one, and the
   * owner's register/lifecycle fan-out is gated on this field.
   */
  ownerAgentId?: string;
  eventCount: number;
  lastEventTime: number;
  maxEvents: number;
  idleTimeoutMs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  droppedLines: number;
  /** Exit code from the underlying process, when known. */
  exitCode?: number;
  /**
   * Reason for terminal status, when one exists. Mirrors
   * `ShellTask.error`. Populated for:
   *   - `failed` — spawn error (passed to `monitorFail(monitorId, error)`).
   *   - `completed` via auto-stop — `'Max events reached'` from
   *     `monitorEmitEvent` and `'Idle timeout'` from the idle timer; any
   *     future auto-stop reason should populate this field too so the
   *     detail view stays a complete record of why the monitor stopped.
   * Not populated for `cancelled` (no semantic reason — the user / agent
   * just asked to stop) or for `completed` via natural process exit
   * (the `exitCode` field carries that signal instead).
   * Surfaced in the dialog's `MonitorDetailBody`.
   */
  error?: string;
}

/**
 * @deprecated Renamed to `MonitorTask`. Kept as a one-release type
 * alias for external SDK consumers; will be removed in the release
 * after PR 2 lands.
 */
export type MonitorEntry = MonitorTask;

/**
 * Shape callers pass to {@link monitorRegister}; the helper derives the
 * shared `TaskBase` envelope (`id`, `kind`, `outputOffset`, `notified`)
 * from these. Callers are responsible for computing `outputFile` via
 * {@link getMonitorOutputPath} so the helper stays decoupled from the
 * project/session paths owned by `Config`.
 */
export type MonitorTaskRegistration = TaskRegistration<MonitorTask>;

export interface MonitorNotificationMeta {
  monitorId: string;
  status: MonitorStatus;
  eventCount: number;
  toolUseId?: string;
  ownerAgentId?: string;
}

export type MonitorNotificationCallback = (
  displayText: string,
  modelText: string,
  meta: MonitorNotificationMeta,
) => void;

/**
 * Fired when an owner-scoped monitor is silently cancelled (owner-agent
 * teardown) so the owner's reasoning loop can wake instead of waiting on
 * a notification that will never arrive.
 */
export type MonitorOwnerLifecycleCallback = () => void;

export type MonitorRegisterCallback = (entry: MonitorTask) => void;

export interface MonitorCancelOptions {
  notify?: boolean;
}

/**
 * Module-level singletons replacing the per-instance callback fields on
 * `MonitorRegistry`. Same rationale as `agent-task.ts`: the registry's
 * polymorphic `subscribe` covers UI re-renders; these two callbacks
 * carry the monitor kind's SDK-specific event signals (per-event
 * notification XML for the parent model, register fan-out for SDK
 * consumers).
 */
let notificationCallback: MonitorNotificationCallback | undefined;
let registerCallback: MonitorRegisterCallback | undefined;

/**
 * Per-owner-agent notification + lifecycle callbacks. Module-level
 * (keyed by ownerAgentId) replacing the per-instance `MonitorRegistry`
 * maps; same module-scope rationale as the singleton callbacks above —
 * one `TaskRegistry` per session.
 */
const agentNotificationCallbacks = new Map<
  string,
  MonitorNotificationCallback
>();
const agentLifecycleCallbacks = new Map<string, MonitorOwnerLifecycleCallback>();

export function setMonitorNotificationCallback(
  cb: MonitorNotificationCallback | undefined,
): void {
  notificationCallback = cb;
}

export function setMonitorRegisterCallback(
  cb: MonitorRegisterCallback | undefined,
): void {
  registerCallback = cb;
}

export function setMonitorAgentNotificationCallback(
  agentId: string,
  cb: MonitorNotificationCallback | undefined,
): void {
  if (cb) {
    agentNotificationCallbacks.set(agentId, cb);
  } else {
    agentNotificationCallbacks.delete(agentId);
  }
}

export function setMonitorAgentLifecycleCallback(
  agentId: string,
  cb: MonitorOwnerLifecycleCallback | undefined,
): void {
  if (cb) {
    agentLifecycleCallbacks.set(agentId, cb);
  } else {
    agentLifecycleCallbacks.delete(agentId);
  }
}

/**
 * Read a monitor entry from the registry with the kind narrowed.
 * Returns `undefined` for missing ids and for ids that resolve to a
 * non-monitor kind.
 */
export function getMonitorTask(
  registry: TaskRegistry,
  monitorId: string,
): MonitorTask | undefined {
  const entry = registry.get(monitorId);
  if (!entry || entry.kind !== 'monitor') return undefined;
  return entry;
}

/**
 * Snapshot of every monitor task. Convenience over
 * `registry.getByKind('monitor')` for call sites that need monitor-specific
 * fields.
 */
export function getAllMonitorTasks(registry: TaskRegistry): MonitorTask[] {
  return registry.getByKind('monitor');
}

/**
 * Snapshot of running monitors only. Convenience helper for the cap
 * pre-check the Monitor tool runs before {@link monitorRegister}.
 */
export function getRunningMonitorTasks(registry: TaskRegistry): MonitorTask[] {
  return registry.getByKind('monitor').filter((e) => e.status === 'running');
}

/**
 * Insert a new monitor task into the registry. Mutates `registration`
 * in place to graduate it to a full `MonitorTask` (populating the
 * `TaskBase` envelope) and then hands the reference to
 * `registry.register`. Returning the same reference lets callers
 * continue using the variable for post-register mutations (`status`,
 * `droppedLines`, …) the existing monitor.ts flow relies on.
 *
 * Throws if the per-session concurrency cap is reached
 * (`MAX_CONCURRENT_MONITORS`).
 */
export function monitorRegister(
  registry: TaskRegistry,
  registration: MonitorTaskRegistration,
): MonitorTask {
  const running = registry
    .getByKind('monitor')
    .filter((e) => e.status === 'running');
  if (running.length >= MAX_CONCURRENT_MONITORS) {
    throw new Error(
      `Cannot start monitor: maximum concurrent monitors (${MAX_CONCURRENT_MONITORS}) reached. Stop an existing monitor first.`,
    );
  }
  const entry = registration as MonitorTask;
  entry.id = registration.monitorId;
  entry.kind = 'monitor';
  entry.outputOffset = 0;
  entry.notified = false;
  registry.register(entry);
  debugLogger.info(`Registered monitor: ${entry.monitorId}`);
  resetIdleTimer(registry, entry);

  // Owner-scoped monitors don't fire the global register callback —
  // their lifecycle is surfaced to the owning subagent, not the
  // top-level SDK register fan-out.
  if (!entry.ownerAgentId && registerCallback) {
    try {
      registerCallback(entry);
    } catch (error) {
      debugLogger.error('Failed to emit register callback:', error);
    }
  }
  return entry;
}

/**
 * Push a stdout line as an event notification to the agent. Increments
 * eventCount, resets idle timer, auto-stops if `maxEvents` reached.
 * No-op if the monitor is no longer running.
 */
export function monitorEmitEvent(
  registry: TaskRegistry,
  monitorId: string,
  line: string,
): void {
  const entry = registry.get(monitorId) as MonitorTask | undefined;
  if (!entry || entry.kind !== 'monitor' || entry.status !== 'running') return;

  registry.update<MonitorTask>(monitorId, (current) => {
    current.eventCount += 1;
    current.lastEventTime = Date.now();
    return current;
  });
  resetIdleTimer(registry, entry);

  const truncatedLine =
    line.length > EVENT_LINE_TRUNCATE
      ? line.slice(0, EVENT_LINE_TRUNCATE) + '...[truncated]'
      : line;

  emitEventNotification(entry, truncatedLine);

  // Auto-stop if max events reached. Settle BEFORE aborting so that any
  // synchronous abort listener that flushes buffered output back through
  // monitorEmitEvent (see Monitor tool's flushPartialLineBuffers) finds
  // entry.status !== 'running' and short-circuits, instead of
  // incrementing eventCount past maxEvents and emitting a duplicate
  // terminal notification.
  if (entry.eventCount >= entry.maxEvents) {
    debugLogger.info(
      `Monitor ${monitorId} reached max events (${entry.maxEvents}), stopping`,
    );
    registry.update<MonitorTask>(monitorId, (current) => {
      current.error = 'Max events reached';
      current.status = 'completed';
      current.endTime = Date.now();
      return current;
    });
    clearIdleTimer(entry);
    pruneTerminalEntries(registry);
    entry.abortController.abort();
    emitTerminalNotification(entry, 'Max events reached');
  }
}

/** No-op if not 'running' — guards against race with concurrent cancellation. */
export function monitorComplete(
  registry: TaskRegistry,
  monitorId: string,
  exitCode: number | null,
): void {
  const entry = registry.get(monitorId) as MonitorTask | undefined;
  if (!entry || entry.kind !== 'monitor' || entry.status !== 'running') return;

  if (exitCode !== null) {
    registry.update<MonitorTask>(monitorId, (current) => {
      current.exitCode = exitCode;
      return current;
    });
  }
  settle(registry, entry, 'completed');
  debugLogger.info(
    `Monitor completed: ${monitorId} (exit ${exitCode}, ${entry.eventCount} events)`,
  );
  emitTerminalNotification(
    entry,
    exitCode !== null ? `Exited with code ${exitCode}` : undefined,
  );
}

/** No-op if not 'running' — guards against race with concurrent cancellation. */
export function monitorFail(
  registry: TaskRegistry,
  monitorId: string,
  error: string,
): void {
  const entry = registry.get(monitorId) as MonitorTask | undefined;
  if (!entry || entry.kind !== 'monitor' || entry.status !== 'running') return;

  registry.update<MonitorTask>(monitorId, (current) => {
    current.error = error;
    return current;
  });
  settle(registry, entry, 'failed');
  debugLogger.info(`Monitor failed: ${monitorId}: ${error}`);
  emitTerminalNotification(entry, error);
}

/**
 * Cancel a running monitor. No-op if not 'running' — guards against a
 * race with concurrent cancellation.
 *
 * The two branches order `settle()` and `abort()` differently on
 * purpose:
 *
 * - `notify: false` (silent cancel, e.g. owner-agent teardown): settle
 *   to `'cancelled'` *first*, then abort. The status transition is
 *   locked in before any abort-listener can run, so an abort-triggered
 *   `fail()`/`complete()` can't race in and overwrite the terminal
 *   status. The owner is woken via `dispatchOwnerLifecycleWake()`
 *   instead of the notification channel.
 *
 * - Default (user-visible cancel): abort *first*, then re-check
 *   `status`. This lets a naturally-completing operation settle itself
 *   through its own terminal path (so the user sees `completed`/`failed`
 *   rather than a forced `cancelled` when the abort arrives at the
 *   finish line). Only if `status` is still `'running'` after abort do
 *   we force `'cancelled'` and emit the terminal notification.
 */
export function monitorCancel(
  registry: TaskRegistry,
  monitorId: string,
  options: MonitorCancelOptions = {},
): void {
  const entry = registry.get(monitorId) as MonitorTask | undefined;
  if (!entry || entry.kind !== 'monitor' || entry.status !== 'running') return;

  if (options.notify === false) {
    settle(registry, entry, 'cancelled');
    debugLogger.info(`Monitor cancelled: ${monitorId}`);
    entry.abortController.abort();
    dispatchOwnerLifecycleWake(entry);
    return;
  }

  entry.abortController.abort();
  // Re-read status — a synchronous abort listener could have flipped it.
  if (entry.status !== 'running') return;
  settle(registry, entry, 'cancelled');
  debugLogger.info(`Monitor cancelled: ${monitorId}`);
  emitTerminalNotification(entry);
}

export function monitorAbortAll(
  registry: TaskRegistry,
  options: MonitorCancelOptions = {},
): void {
  for (const entry of registry.getByKind('monitor')) {
    monitorCancel(registry, entry.monitorId, options);
  }
  debugLogger.info('Aborted all monitors');
}

/**
 * True if the owner subagent has any still-running monitor. Used by the
 * owner's reasoning loop to decide whether to keep waiting on monitor
 * events before settling.
 */
export function monitorHasRunningForOwner(
  registry: TaskRegistry,
  ownerAgentId: string,
): boolean {
  for (const entry of registry.getByKind('monitor')) {
    if (entry.ownerAgentId === ownerAgentId && entry.status === 'running') {
      return true;
    }
  }
  return false;
}

/**
 * Cancel every still-running monitor owned by a given subagent. Called
 * on owner-agent teardown so the owner's monitors don't outlive it.
 */
export function monitorCancelRunningForOwner(
  registry: TaskRegistry,
  ownerAgentId: string,
  options: MonitorCancelOptions = {},
): void {
  const monitorIds: string[] = [];
  for (const entry of registry.getByKind('monitor')) {
    if (entry.ownerAgentId === ownerAgentId && entry.status === 'running') {
      monitorIds.push(entry.monitorId);
    }
  }
  for (const monitorId of monitorIds) {
    monitorCancel(registry, monitorId, options);
  }
}

export function monitorReset(registry: TaskRegistry): void {
  agentNotificationCallbacks.clear();
  agentLifecycleCallbacks.clear();
  const monitors = registry.getByKind('monitor');
  if (monitors.length === 0) return;
  for (const entry of monitors) {
    clearIdleTimer(entry);
    if (entry.status === 'running') {
      entry.abortController.abort();
    }
    registry.evict(entry.monitorId);
  }
}

// --- Internal helpers ---

function dispatchOwnerLifecycleWake(entry: MonitorTask): void {
  if (!entry.ownerAgentId) return;
  const callback = agentLifecycleCallbacks.get(entry.ownerAgentId);
  if (!callback) return;
  try {
    callback();
  } catch (error) {
    debugLogger.error('owner lifecycle callback failed:', error);
  }
}

/**
 * Route a notification to the owning subagent's per-agent callback when
 * the monitor is owner-scoped, otherwise to the global callback. An
 * owner-scoped monitor with no registered owner callback drops the
 * notification (with a warning) rather than leaking it to the top-level
 * session.
 */
function dispatchNotification(
  entry: MonitorTask,
  displayLine: string,
  modelText: string,
  meta: MonitorNotificationMeta,
): void {
  const callback = entry.ownerAgentId
    ? agentNotificationCallbacks.get(entry.ownerAgentId)
    : notificationCallback;
  if (!callback) {
    if (entry.ownerAgentId) {
      debugLogger.warn(
        `Dropping monitor notification for ${entry.monitorId}: owner agent ${entry.ownerAgentId} has no notification callback`,
      );
    }
    return;
  }

  try {
    callback(displayLine, modelText, meta);
  } catch (error) {
    debugLogger.error('Failed to emit monitor notification:', error);
  }
}

function settle(
  registry: TaskRegistry,
  entry: MonitorTask,
  status: 'completed' | 'failed' | 'cancelled',
): void {
  registry.update<MonitorTask>(entry.monitorId, (current) => {
    current.status = status;
    current.endTime = Date.now();
    return current;
  });
  clearIdleTimer(entry);
  pruneTerminalEntries(registry);
}

function pruneTerminalEntries(registry: TaskRegistry): void {
  const terminalEntries = registry
    .getByKind('monitor')
    .filter((entry) => entry.status !== 'running')
    .sort(
      (a, b) =>
        (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime) ||
        a.startTime - b.startTime,
    );

  while (terminalEntries.length > MAX_RETAINED_TERMINAL_MONITORS) {
    const oldest = terminalEntries.shift();
    if (oldest) {
      registry.evict(oldest.monitorId);
    }
  }
}

function resetIdleTimer(registry: TaskRegistry, entry: MonitorTask): void {
  clearIdleTimer(entry);
  entry.idleTimer = setTimeout(() => {
    if (entry.status === 'running') {
      debugLogger.info(
        `Monitor ${entry.monitorId} idle timeout (${entry.idleTimeoutMs}ms), stopping`,
      );
      entry.abortController.abort();
      if (entry.status !== 'running') return;
      // Persist the reason so the dialog detail view can show it after
      // settle. Same pattern as the max-events branch in
      // `monitorEmitEvent`.
      registry.update<MonitorTask>(entry.monitorId, (current) => {
        current.error = 'Idle timeout';
        return current;
      });
      settle(registry, entry, 'completed');
      emitTerminalNotification(entry, 'Idle timeout');
    }
  }, entry.idleTimeoutMs);
  entry.idleTimer.unref?.();
}

function clearIdleTimer(entry: MonitorTask): void {
  if (entry.idleTimer !== undefined) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
}

/** Emit a streaming event notification (status=running, includes stdout line). */
function emitEventNotification(entry: MonitorTask, eventLine: string): void {
  const desc = stripTerminalControlSequences(
    truncateDescription(entry.description),
  );
  const safeEventLine = stripTerminalControlSequences(eventLine);
  const displayLine = `Monitor "${desc}" event #${entry.eventCount}: ${safeEventLine}`;

  const xmlParts: string[] = [
    '<task-notification>',
    `<task-id>${escapeXml(entry.monitorId)}</task-id>`,
  ];
  if (entry.toolUseId) {
    xmlParts.push(`<tool-use-id>${escapeXml(entry.toolUseId)}</tool-use-id>`);
  }
  xmlParts.push(
    '<kind>monitor</kind>',
    '<status>running</status>',
    `<event-count>${entry.eventCount}</event-count>`,
    `<summary>Monitor "${escapeXml(desc)}" emitted event #${entry.eventCount}.</summary>`,
    `<result>${escapeXml(eventLine)}</result>`,
    '</task-notification>',
  );

  const meta: MonitorNotificationMeta = {
    monitorId: entry.monitorId,
    status: 'running',
    eventCount: entry.eventCount,
    toolUseId: entry.toolUseId,
    ownerAgentId: entry.ownerAgentId,
  };

  dispatchNotification(entry, displayLine, xmlParts.join('\n'), meta);
}

/** Emit a terminal notification (completed/failed/cancelled). */
function emitTerminalNotification(entry: MonitorTask, detail?: string): void {
  const statusText =
    entry.status === 'completed'
      ? 'completed'
      : entry.status === 'failed'
        ? 'failed'
        : 'was cancelled';

  const desc = stripTerminalControlSequences(
    truncateDescription(entry.description),
  );
  const droppedSuffix =
    entry.droppedLines > 0
      ? `, ${entry.droppedLines} lines dropped due to throttling`
      : '';
  const displayLine = `Monitor "${desc}" ${statusText}. (${entry.eventCount} events${droppedSuffix})`;

  const xmlParts: string[] = [
    '<task-notification>',
    `<task-id>${escapeXml(entry.monitorId)}</task-id>`,
  ];
  if (entry.toolUseId) {
    xmlParts.push(`<tool-use-id>${escapeXml(entry.toolUseId)}</tool-use-id>`);
  }
  xmlParts.push(
    '<kind>monitor</kind>',
    `<status>${escapeXml(entry.status)}</status>`,
    `<event-count>${entry.eventCount}</event-count>`,
    `<summary>Monitor "${escapeXml(desc)}" ${statusText}. Total events: ${entry.eventCount}.${entry.droppedLines > 0 ? ` ${entry.droppedLines} lines dropped due to throttling.` : ''}</summary>`,
  );
  if (detail) {
    xmlParts.push(
      `<result>${escapeXml(stripTerminalControlSequences(detail))}</result>`,
    );
  }
  xmlParts.push('</task-notification>');

  const meta: MonitorNotificationMeta = {
    monitorId: entry.monitorId,
    status: entry.status,
    eventCount: entry.eventCount,
    toolUseId: entry.toolUseId,
    ownerAgentId: entry.ownerAgentId,
  };

  dispatchNotification(entry, displayLine, xmlParts.join('\n'), meta);
}

function truncateDescription(desc: string): string {
  // Ellipsis counts against the configured cap so the returned string
  // is guaranteed to be <= MAX_DESCRIPTION_LENGTH characters, matching
  // the documented contract and the Monitor tool's display truncation.
  const ELLIPSIS = '...';
  if (desc.length <= MAX_DESCRIPTION_LENGTH) return desc;
  const keep = Math.max(0, MAX_DESCRIPTION_LENGTH - ELLIPSIS.length);
  return desc.slice(0, keep) + ELLIPSIS;
}

/**
 * `Task` implementation registered with the dispatcher.
 */
export const MonitorTaskKind: Task = {
  kind: 'monitor',
  name: 'Monitor',
  kill: (id, ctx) => {
    monitorCancel(ctx.registry, id);
  },
};
