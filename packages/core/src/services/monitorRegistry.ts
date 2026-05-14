/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview MonitorRegistry — tracks long-running monitor processes.
 *
 * When the Monitor tool is called, a background process is spawned whose stdout
 * lines are pushed back to the agent as event notifications. This registry
 * manages the lifecycle of each monitor entry: running → completed/failed/cancelled.
 *
 * Follows the same structural pattern as BackgroundTaskRegistry (background-tasks.ts)
 * so the two can be unified into a single registry when #3488 lands.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import { escapeXml } from '../utils/xml.js';

const debugLogger = createDebugLogger('MONITOR_REGISTRY');

const EVENT_LINE_TRUNCATE = 2000;
const MAX_DESCRIPTION_LENGTH = 80;
export const MAX_CONCURRENT_MONITORS = 16;
export const MAX_RETAINED_TERMINAL_MONITORS = 128;

/**
 * Strip C0 control characters (except tab) and C1 control characters from a
 * string destined for terminal/UI display. The Monitor tool pre-sanitizes
 * stdout lines before calling `emitEvent`, but we apply the same strip here
 * as defense-in-depth so that any direct caller of the registry cannot leak
 * terminal escape sequences or NUL bytes into the `displayText` surface.
 */
function stripDisplayControlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09) {
      out += text[i];
      continue;
    }
    if (code < 0x20) continue; // C0 (NUL, BEL, ESC, \n, \r, ...)
    if (code >= 0x80 && code <= 0x9f) continue; // C1
    out += text[i];
  }
  return out;
}

export type MonitorStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface MonitorEntry {
  monitorId: string;
  command: string;
  description: string;
  status: MonitorStatus;
  pid?: number;
  startTime: number;
  endTime?: number;
  abortController: AbortController;
  toolUseId?: string;
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
   * `BackgroundShellEntry.error`. Populated for:
   *   - `failed` — spawn error (passed to `fail(monitorId, error)`).
   *   - `completed` via auto-stop — currently `'Max events reached'`
   *     from `emitEvent` and `'Idle timeout'` from the idle timer; any
   *     future auto-stop reason should populate this field too so the
   *     detail view stays a complete record of why the monitor stopped.
   * Not populated for `cancelled` (no semantic reason — the user / agent
   * just asked to stop) or for `completed` via natural process exit
   * (the `exitCode` field carries that signal instead).
   * Surfaced in the dialog's `MonitorDetailBody`.
   */
  error?: string;
}

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

export type MonitorOwnerLifecycleCallback = () => void;

export type MonitorRegisterCallback = (entry: MonitorEntry) => void;

/**
 * Fires on any change to the registry's contents that a snapshot
 * subscriber needs to observe — concretely: `register()` (nothing →
 * running), `settle()` (running → terminal: complete / fail / cancel /
 * emitEvent's auto-stop at maxEvents / idle timeout), and `reset()`
 * (mass clear, fired with no entry).
 *
 * Does NOT fire on `emitEvent` per se — per-event registry mutations
 * (eventCount / droppedLines) are deliberately excluded so the footer
 * pill and AppContainer don't churn under heavy event traffic. The
 * dialog's detail view re-resolves selected monitor entries from the
 * registry directly when it needs live counters.
 *
 * Symmetric with `BackgroundTaskRegistry.setStatusChangeCallback` and
 * `BackgroundShellRegistry.setStatusChangeCallback` so the same UI hook
 * can subscribe to all three registries.
 */
export type MonitorStatusChangeCallback = (entry?: MonitorEntry) => void;

interface MonitorCancelOptions {
  notify?: boolean;
}

export class MonitorRegistry {
  private readonly monitors = new Map<string, MonitorEntry>();
  private readonly agentNotificationCallbacks = new Map<
    string,
    MonitorNotificationCallback
  >();
  private readonly agentLifecycleCallbacks = new Map<
    string,
    MonitorOwnerLifecycleCallback
  >();
  private notificationCallback?: MonitorNotificationCallback;
  private registerCallback?: MonitorRegisterCallback;
  private statusChangeCallback?: MonitorStatusChangeCallback;

  register(entry: MonitorEntry): void {
    if (this.getRunning().length >= MAX_CONCURRENT_MONITORS) {
      throw new Error(
        `Cannot start monitor: maximum concurrent monitors (${MAX_CONCURRENT_MONITORS}) reached. Stop an existing monitor first.`,
      );
    }
    this.monitors.set(entry.monitorId, entry);
    debugLogger.info(`Registered monitor: ${entry.monitorId}`);
    this.resetIdleTimer(entry);

    if (!entry.ownerAgentId && this.registerCallback) {
      try {
        this.registerCallback(entry);
      } catch (error) {
        debugLogger.error('Failed to emit register callback:', error);
      }
    }
    // Mirror BackgroundTaskRegistry / BackgroundShellRegistry: registration
    // is a status transition (nothing → running) so subscribers that only
    // care about "what's in the registry now" can subscribe to a single
    // callback and see new entries the same way they see status changes.
    this.fireStatusChange(entry);
  }

  /**
   * Push a stdout line as an event notification to the agent.
   * Increments eventCount, resets idle timer, auto-stops if maxEvents reached.
   * No-op if the monitor is no longer running.
   */
  emitEvent(monitorId: string, line: string): void {
    const entry = this.monitors.get(monitorId);
    if (!entry || entry.status !== 'running') return;

    entry.eventCount++;
    entry.lastEventTime = Date.now();
    this.resetIdleTimer(entry);

    const truncatedLine =
      line.length > EVENT_LINE_TRUNCATE
        ? line.slice(0, EVENT_LINE_TRUNCATE) + '...[truncated]'
        : line;

    this.emitNotification(entry, truncatedLine);

    // Auto-stop if max events reached. Settle BEFORE aborting so that any
    // synchronous abort listener that flushes buffered output back through
    // `registry.emitEvent()` (see Monitor tool's flushPartialLineBuffers)
    // finds `entry.status !== 'running'` and short-circuits, instead of
    // incrementing `eventCount` past `maxEvents` and emitting a duplicate
    // terminal notification.
    if (entry.eventCount >= entry.maxEvents) {
      debugLogger.info(
        `Monitor ${monitorId} reached max events (${entry.maxEvents}), stopping`,
      );
      // Persist the reason so the dialog's detail view can surface it
      // after the monitor terminates. The chat-history notification is
      // separate from the registry's persistent state, so reopening the
      // Background tasks dialog or running `/tasks` later won't surface
      // it on its own — the persisted `entry.error` is what those
      // surfaces actually read.
      entry.error = 'Max events reached';
      this.settle(entry, 'completed');
      entry.abortController.abort();
      this.emitTerminalNotification(entry, 'Max events reached');
    }
  }

  // No-op if not 'running' — guards against race with concurrent cancellation.
  complete(monitorId: string, exitCode: number | null): void {
    const entry = this.monitors.get(monitorId);
    if (!entry || entry.status !== 'running') return;

    if (exitCode !== null) entry.exitCode = exitCode;
    this.settle(entry, 'completed');
    debugLogger.info(
      `Monitor completed: ${monitorId} (exit ${exitCode}, ${entry.eventCount} events)`,
    );
    this.emitTerminalNotification(
      entry,
      exitCode !== null ? `Exited with code ${exitCode}` : undefined,
    );
  }

  // No-op if not 'running' — guards against race with concurrent cancellation.
  fail(monitorId: string, error: string): void {
    const entry = this.monitors.get(monitorId);
    if (!entry || entry.status !== 'running') return;

    entry.error = error;
    this.settle(entry, 'failed');
    debugLogger.info(`Monitor failed: ${monitorId}: ${error}`);
    this.emitTerminalNotification(entry, error);
  }

  // No-op if not 'running' — guards against race with concurrent cancellation.
  cancel(monitorId: string, options: MonitorCancelOptions = {}): void {
    const entry = this.monitors.get(monitorId);
    if (!entry || entry.status !== 'running') return;

    if (options.notify === false) {
      this.settle(entry, 'cancelled');
      debugLogger.info(`Monitor cancelled: ${monitorId}`);
      entry.abortController.abort();
      this.dispatchOwnerLifecycleWake(entry);
      return;
    }

    entry.abortController.abort();
    if (entry.status !== 'running') return;
    this.settle(entry, 'cancelled');
    debugLogger.info(`Monitor cancelled: ${monitorId}`);
    this.emitTerminalNotification(entry);
  }

  get(monitorId: string): MonitorEntry | undefined {
    return this.monitors.get(monitorId);
  }

  getAll(): MonitorEntry[] {
    return Array.from(this.monitors.values());
  }

  getRunning(): MonitorEntry[] {
    return Array.from(this.monitors.values()).filter(
      (e) => e.status === 'running',
    );
  }

  hasRunningForOwner(ownerAgentId: string): boolean {
    for (const entry of this.monitors.values()) {
      if (entry.ownerAgentId === ownerAgentId && entry.status === 'running') {
        return true;
      }
    }
    return false;
  }

  setNotificationCallback(cb: MonitorNotificationCallback | undefined): void {
    this.notificationCallback = cb;
  }

  setAgentNotificationCallback(
    agentId: string,
    cb: MonitorNotificationCallback | undefined,
  ): void {
    if (cb) {
      this.agentNotificationCallbacks.set(agentId, cb);
    } else {
      this.agentNotificationCallbacks.delete(agentId);
    }
  }

  setAgentLifecycleCallback(
    agentId: string,
    cb: MonitorOwnerLifecycleCallback | undefined,
  ): void {
    if (cb) {
      this.agentLifecycleCallbacks.set(agentId, cb);
    } else {
      this.agentLifecycleCallbacks.delete(agentId);
    }
  }

  setRegisterCallback(cb: MonitorRegisterCallback | undefined): void {
    this.registerCallback = cb;
  }

  /**
   * Subscribe to status transitions (register + every running → terminal
   * settle). Single-subscriber on purpose — the dialog hook is the only
   * consumer in the codebase, and a list would invite drift in
   * error-handling.
   */
  setStatusChangeCallback(cb: MonitorStatusChangeCallback | undefined): void {
    this.statusChangeCallback = cb;
  }

  abortAll(options: MonitorCancelOptions = {}): void {
    for (const entry of Array.from(this.monitors.values())) {
      this.cancel(entry.monitorId, options);
    }
    debugLogger.info('Aborted all monitors');
  }

  cancelRunningForOwner(
    ownerAgentId: string,
    options: MonitorCancelOptions = {},
  ): void {
    const monitorIds: string[] = [];
    for (const entry of this.monitors.values()) {
      if (entry.ownerAgentId === ownerAgentId && entry.status === 'running') {
        monitorIds.push(entry.monitorId);
      }
    }

    for (const monitorId of monitorIds) {
      this.cancel(monitorId, options);
    }
  }

  reset(): void {
    this.agentNotificationCallbacks.clear();
    this.agentLifecycleCallbacks.clear();
    if (this.monitors.size === 0) return;
    for (const entry of this.monitors.values()) {
      this.clearIdleTimer(entry);
      if (entry.status === 'running') {
        entry.abortController.abort();
      }
    }
    this.monitors.clear();
    // Notify subscribers that the registry's contents changed wholesale
    // — without this, the dialog snapshot in `useBackgroundTaskView`
    // would keep rendering the now-cleared rows until an unrelated
    // register/settle event happens. Mirrors BackgroundShellRegistry /
    // BackgroundTaskRegistry's reset paths.
    this.fireStatusChange();
  }

  // --- Internal helpers ---

  private settle(
    entry: MonitorEntry,
    status: 'completed' | 'failed' | 'cancelled',
  ): void {
    entry.status = status;
    entry.endTime = Date.now();
    this.clearIdleTimer(entry);
    this.pruneTerminalEntries();
    this.fireStatusChange(entry);
  }

  private fireStatusChange(entry?: MonitorEntry): void {
    if (!this.statusChangeCallback) return;
    try {
      this.statusChangeCallback(entry);
    } catch (error) {
      debugLogger.error('statusChange callback failed:', error);
    }
  }

  private dispatchOwnerLifecycleWake(entry: MonitorEntry): void {
    if (!entry.ownerAgentId) return;
    const callback = this.agentLifecycleCallbacks.get(entry.ownerAgentId);
    if (!callback) return;
    try {
      callback();
    } catch (error) {
      debugLogger.error('owner lifecycle callback failed:', error);
    }
  }

  private pruneTerminalEntries(): void {
    const terminalEntries = Array.from(this.monitors.values())
      .filter((entry) => entry.status !== 'running')
      .sort(
        (a, b) =>
          (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime) ||
          a.startTime - b.startTime,
      );

    while (terminalEntries.length > MAX_RETAINED_TERMINAL_MONITORS) {
      const oldest = terminalEntries.shift();
      if (oldest) {
        this.monitors.delete(oldest.monitorId);
      }
    }
  }

  private resetIdleTimer(entry: MonitorEntry): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      if (entry.status === 'running') {
        debugLogger.info(
          `Monitor ${entry.monitorId} idle timeout (${entry.idleTimeoutMs}ms), stopping`,
        );
        entry.abortController.abort();
        if (entry.status !== 'running') return;
        // Same rationale as the max-events branch in `emitEvent`: persist
        // the reason so the dialog detail view can show it after settle.
        entry.error = 'Idle timeout';
        this.settle(entry, 'completed');
        this.emitTerminalNotification(entry, 'Idle timeout');
      }
    }, entry.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private clearIdleTimer(entry: MonitorEntry): void {
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  /** Emit a streaming event notification (status=running, includes stdout line). */
  private emitNotification(entry: MonitorEntry, eventLine: string): void {
    const desc = stripDisplayControlChars(
      this.truncateDescription(entry.description),
    );
    const safeEventLine = stripDisplayControlChars(eventLine);
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

    this.dispatchNotification(entry, displayLine, xmlParts.join('\n'), meta);
  }

  /** Emit a terminal notification (completed/failed/cancelled). */
  private emitTerminalNotification(entry: MonitorEntry, detail?: string): void {
    const statusText =
      entry.status === 'completed'
        ? 'completed'
        : entry.status === 'failed'
          ? 'failed'
          : 'was cancelled';

    const desc = stripDisplayControlChars(
      this.truncateDescription(entry.description),
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
        `<result>${escapeXml(stripDisplayControlChars(detail))}</result>`,
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

    this.dispatchNotification(entry, displayLine, xmlParts.join('\n'), meta);
  }

  private dispatchNotification(
    entry: MonitorEntry,
    displayLine: string,
    modelText: string,
    meta: MonitorNotificationMeta,
  ): void {
    const callback = entry.ownerAgentId
      ? this.agentNotificationCallbacks.get(entry.ownerAgentId)
      : this.notificationCallback;
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

  private truncateDescription(desc: string): string {
    // Ellipsis counts against the configured cap so the returned string is
    // guaranteed to be <= MAX_DESCRIPTION_LENGTH characters, matching the
    // documented contract and the Monitor tool's display truncation.
    const ELLIPSIS = '...';
    if (desc.length <= MAX_DESCRIPTION_LENGTH) return desc;
    const keep = Math.max(0, MAX_DESCRIPTION_LENGTH - ELLIPSIS.length);
    return desc.slice(0, keep) + ELLIPSIS;
  }
}
