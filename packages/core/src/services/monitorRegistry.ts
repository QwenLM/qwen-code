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

const debugLogger = createDebugLogger('MONITOR_REGISTRY');

const MAX_LINE_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 80;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
  eventCount: number;
  lastEventTime: number;
  maxEvents: number;
  idleTimeoutMs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface MonitorNotificationMeta {
  monitorId: string;
  status: MonitorStatus;
  eventCount: number;
  toolUseId?: string;
}

export type MonitorNotificationCallback = (
  displayText: string,
  modelText: string,
  meta: MonitorNotificationMeta,
) => void;

export class MonitorRegistry {
  private readonly monitors = new Map<string, MonitorEntry>();
  private notificationCallback?: MonitorNotificationCallback;

  register(entry: MonitorEntry): void {
    this.monitors.set(entry.monitorId, entry);
    debugLogger.info(`Registered monitor: ${entry.monitorId}`);
    this.resetIdleTimer(entry);
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
      line.length > MAX_LINE_LENGTH
        ? line.slice(0, MAX_LINE_LENGTH) + '...[truncated]'
        : line;

    this.emitNotification(entry, truncatedLine);

    // Auto-stop if max events reached
    if (entry.eventCount >= entry.maxEvents) {
      debugLogger.info(
        `Monitor ${monitorId} reached max events (${entry.maxEvents}), stopping`,
      );
      entry.abortController.abort();
      this.settle(entry, 'completed');
      this.emitTerminalNotification(entry, 'Max events reached');
    }
  }

  // No-op if not 'running' — guards against race with concurrent cancellation.
  complete(monitorId: string, exitCode: number | null): void {
    const entry = this.monitors.get(monitorId);
    if (!entry || entry.status !== 'running') return;

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

    this.settle(entry, 'failed');
    debugLogger.info(`Monitor failed: ${monitorId}: ${error}`);
    this.emitTerminalNotification(entry, error);
  }

  // No-op if not 'running' — guards against race with concurrent cancellation.
  cancel(monitorId: string): void {
    const entry = this.monitors.get(monitorId);
    if (!entry || entry.status !== 'running') return;

    entry.abortController.abort();
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

  setNotificationCallback(cb: MonitorNotificationCallback | undefined): void {
    this.notificationCallback = cb;
  }

  abortAll(): void {
    for (const entry of Array.from(this.monitors.values())) {
      this.cancel(entry.monitorId);
    }
    debugLogger.info('Aborted all monitors');
  }

  // --- Internal helpers ---

  private settle(
    entry: MonitorEntry,
    status: 'completed' | 'failed' | 'cancelled',
  ): void {
    entry.status = status;
    entry.endTime = Date.now();
    this.clearIdleTimer(entry);
  }

  private resetIdleTimer(entry: MonitorEntry): void {
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      if (entry.status === 'running') {
        debugLogger.info(
          `Monitor ${entry.monitorId} idle timeout (${entry.idleTimeoutMs}ms), stopping`,
        );
        entry.abortController.abort();
        this.settle(entry, 'completed');
        this.emitTerminalNotification(entry, 'Idle timeout');
      }
    }, entry.idleTimeoutMs);
  }

  private clearIdleTimer(entry: MonitorEntry): void {
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  /** Emit a streaming event notification (status=running, includes stdout line). */
  private emitNotification(entry: MonitorEntry, eventLine: string): void {
    if (!this.notificationCallback) return;

    const desc = this.truncateDescription(entry.description);
    const displayLine = `Monitor "${desc}" event #${entry.eventCount}: ${eventLine}`;

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
    };

    try {
      this.notificationCallback(displayLine, xmlParts.join('\n'), meta);
    } catch (error) {
      debugLogger.error('Failed to emit monitor event notification:', error);
    }
  }

  /** Emit a terminal notification (completed/failed/cancelled). */
  private emitTerminalNotification(entry: MonitorEntry, detail?: string): void {
    if (!this.notificationCallback) return;

    const statusText =
      entry.status === 'completed'
        ? 'completed'
        : entry.status === 'failed'
          ? 'failed'
          : 'was cancelled';

    const desc = this.truncateDescription(entry.description);
    const displayLine = `Monitor "${desc}" ${statusText}. (${entry.eventCount} events)`;

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
      `<summary>Monitor "${escapeXml(desc)}" ${statusText}. Total events: ${entry.eventCount}.</summary>`,
    );
    if (detail) {
      xmlParts.push(`<result>${escapeXml(detail)}</result>`);
    }
    xmlParts.push('</task-notification>');

    const meta: MonitorNotificationMeta = {
      monitorId: entry.monitorId,
      status: entry.status,
      eventCount: entry.eventCount,
      toolUseId: entry.toolUseId,
    };

    try {
      this.notificationCallback(displayLine, xmlParts.join('\n'), meta);
    } catch (error) {
      debugLogger.error('Failed to emit monitor terminal notification:', error);
    }
  }

  private truncateDescription(desc: string): string {
    return desc.length > MAX_DESCRIPTION_LENGTH
      ? desc.slice(0, MAX_DESCRIPTION_LENGTH) + '...'
      : desc;
  }
}
