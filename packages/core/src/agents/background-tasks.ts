/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview BackgroundTaskRegistry — tracks background (async) sub-agents.
 *
 * When the Agent tool is called with `run_in_background: true`, the sub-agent
 * runs asynchronously. This registry tracks the lifecycle of each background
 * agent so the parent can be notified on completion.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import { patchAgentMeta } from './agent-transcript.js';

const debugLogger = createDebugLogger('BACKGROUND_TASKS');

const MAX_DESCRIPTION_LENGTH = 40;
const MAX_RECENT_ACTIVITIES = 5;

// Grace period after cancel() before emitting a fallback cancelled
// notification. The natural handler (bgBody) almost always settles and
// emits the terminal notification with the real partial result well
// within this window; the timeout only fires for pathological tools
// that ignore AbortSignal. Must be long enough that normal scheduler
// unwind wins the race, short enough that a stuck headless wait loop
// doesn't feel hung.
const CANCEL_GRACE_MS = 5000;

/**
 * Single source of truth for the human-facing label of a background
 * entry. Shared by the notification payload (model-facing) and the TUI
 * dialog (user-facing) so the two surfaces never drift.
 *
 * When `includePrefix` is true (default), returns `subagentType: desc`;
 * when false, returns the bare truncated description — used where the
 * subagent type is already rendered separately (e.g. the dialog header).
 */
export function buildBackgroundEntryLabel(
  entry: { description: string; subagentType?: string },
  options: { includePrefix?: boolean } = {},
): string {
  const { includePrefix = true } = options;
  let raw = entry.description;
  if (
    entry.subagentType &&
    raw.toLowerCase().startsWith(entry.subagentType.toLowerCase() + ':')
  ) {
    raw = raw.slice(entry.subagentType.length + 1).trimStart();
  }
  const truncated =
    raw.length > MAX_DESCRIPTION_LENGTH
      ? raw.slice(0, MAX_DESCRIPTION_LENGTH - 1) + '\u2026'
      : raw;
  return includePrefix && entry.subagentType
    ? `${entry.subagentType}: ${truncated}`
    : truncated;
}

// Escape text so it is safe to interpolate into an XML element body.
// Subagent-produced strings (description, result, error) can contain `<`,
// `>`, or literal `</task-notification>` — without escaping, a subagent
// summarizing HTML or another agent's notification could close the
// envelope early and forge sibling tags (e.g. a faked <status>) that the
// parent model would treat as trusted metadata.
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export type BackgroundTaskStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentCompletionStats {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/**
 * A compact record of a recent tool invocation — drives the Progress
 * section of the detail dialog. The Agent tool maintains a rolling
 * buffer of these on each background entry by subscribing to the
 * subagent's event emitter.
 */
export interface BackgroundActivity {
  /** Tool name (e.g. `Bash`, `Read`). */
  name: string;
  /** Short one-line description — the tool's own render-friendly summary. */
  description: string;
  /** Emission timestamp (ms). */
  at: number;
}

export interface BackgroundTaskEntry {
  agentId: string;
  description: string;
  subagentType?: string;
  status: BackgroundTaskStatus;
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
  /**
   * Present only when the task is intentionally kept paused but cannot be
   * safely resumed under the current conditions.
   */
  resumeBlockedReason?: string;
  abortController: AbortController;
  stats?: AgentCompletionStats;
  toolUseId?: string;
  /**
   * The original user-supplied prompt for the background task. Surfaced
   * verbatim in the detail dialog's Prompt section. Optional because
   * resume-restored entries may not have it.
   */
  prompt?: string;
  /**
   * Rolling buffer (newest last, capped at MAX_RECENT_ACTIVITIES) of
   * recent tool invocations by this agent. Feeds the detail dialog's
   * Progress section. Replaced as a new array each time an activity is
   * appended so reference-based change detection works. Optional:
   * callers may register without providing it, and `appendActivity`
   * initializes the array lazily.
   */
  recentActivities?: readonly BackgroundActivity[];
  /** Absolute path to the agent's on-disk JSONL transcript file. */
  outputFile?: string;
  /** Absolute path to the agent's sidecar metadata file. */
  metaPath?: string;
  /** Messages queued by SendMessage, drained between tool rounds. */
  pendingMessages?: string[];
  /**
   * True once a terminal task-notification has been emitted for this entry.
   * Prevents duplicate notifications when cancel races with the natural
   * completion path (cancel aborts the signal; the agent's own handler then
   * fires the notification with the real partial/final result).
   */
  notified?: boolean;
  /**
   * Persisted sidecar status to write when the current cancellation settles.
   * Explicit user cancellation uses `cancelled`; shutdown interruption keeps
   * `running` so `/resume` can recover the work later.
   */
  persistedCancellationStatus?: Extract<
    BackgroundTaskStatus,
    'running' | 'cancelled'
  >;
}

interface CancelOptions {
  persistedStatus?: Extract<BackgroundTaskStatus, 'running' | 'cancelled'>;
}

export interface NotificationMeta {
  agentId: string;
  status: BackgroundTaskStatus;
  stats?: AgentCompletionStats;
  toolUseId?: string;
}

export type BackgroundNotificationCallback = (
  displayText: string,
  modelText: string,
  meta: NotificationMeta,
) => void;

export type BackgroundRegisterCallback = (entry: BackgroundTaskEntry) => void;

/**
 * Fires on entry status transitions — register, complete, fail, cancel.
 * Intentionally does NOT fire on `appendActivity` so consumers that only
 * care about the pill / roster (Footer, AppContainer) don't re-render
 * on every tool call a background agent makes.
 */
export type BackgroundStatusChangeCallback = (
  entry?: BackgroundTaskEntry,
) => void;

/** Fires on `appendActivity` — scoped to detail-view consumers. */
export type BackgroundActivityChangeCallback = (
  entry: BackgroundTaskEntry,
) => void;

export class BackgroundTaskRegistry {
  private readonly agents = new Map<string, BackgroundTaskEntry>();
  private notificationCallback?: BackgroundNotificationCallback;
  private registerCallback?: BackgroundRegisterCallback;
  private statusChangeCallback?: BackgroundStatusChangeCallback;
  private activityChangeCallback?: BackgroundActivityChangeCallback;

  register(entry: BackgroundTaskEntry): void {
    if (!entry.pendingMessages) entry.pendingMessages = [];
    this.agents.set(entry.agentId, entry);
    debugLogger.info(`Registered background agent: ${entry.agentId}`);

    if (this.registerCallback) {
      try {
        this.registerCallback(entry);
      } catch (error) {
        debugLogger.error('Failed to emit register callback:', error);
      }
    }
    this.emitStatusChange(entry);
  }

  // Transition a still-running entry to 'completed' and emit the terminal
  // notification. No-op if the entry is already terminal *and* has been
  // notified — protects against duplicate emission when cancel aborts the
  // signal and the natural handler also races to completion.
  complete(
    agentId: string,
    result: string,
    stats?: AgentCompletionStats,
  ): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    // Allow running → completed (normal path) and cancelled → completed
    // (cancel raced the natural handler: the reasoning loop finished with
    // a real result before the abort landed, and we prefer to surface that
    // real result over the bare cancel).
    if (entry.status !== 'running' && entry.status !== 'cancelled') return;
    if (entry.notified) return;

    entry.status = 'completed';
    entry.endTime = Date.now();
    entry.result = result;
    entry.stats = stats;
    debugLogger.info(`Background agent completed: ${agentId}`);

    this.emitNotification(entry);
    this.emitStatusChange(entry);
  }

  // See complete() for the cancelled → terminal path rationale.
  fail(agentId: string, error: string, stats?: AgentCompletionStats): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (entry.status !== 'running' && entry.status !== 'cancelled') return;
    if (entry.notified) return;

    entry.status = 'failed';
    entry.endTime = Date.now();
    entry.error = error;
    entry.stats = stats;
    debugLogger.info(`Background agent failed: ${agentId}`);

    this.emitNotification(entry);
    this.emitStatusChange(entry);
  }

  // Cancellation aborts the signal and marks the entry as cancelled, but
  // does *not* emit the terminal notification immediately. The natural
  // completion path (bgBody) fires complete()/fail()/finalizeCancelled()
  // with the real partial/final result, which carries far more information
  // than a bare "cancelled" message. A deferred fallback handles the rare
  // case where a tool ignores AbortSignal and bgBody never settles — the
  // timeout lands on finalizeCancellationIfPending(), which is a no-op
  // once the natural handler has already emitted.
  cancel(agentId: string, options: CancelOptions = {}): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return;
    const persistedStatus = options.persistedStatus ?? 'cancelled';

    entry.abortController.abort();
    entry.status = 'cancelled';
    entry.endTime = Date.now();
    entry.persistedCancellationStatus = persistedStatus;
    if (entry.metaPath) {
      patchAgentMeta(entry.metaPath, {
        status: persistedStatus,
        lastUpdatedAt: new Date().toISOString(),
        lastError: undefined,
      });
    }
    debugLogger.info(`Background agent cancelled: ${agentId}`);
    this.emitStatusChange(entry);

    const timer = setTimeout(() => {
      this.finalizeCancellationIfPending(agentId);
    }, CANCEL_GRACE_MS);
    timer.unref?.();
  }

  /**
   * Marks a paused interrupted task as intentionally discarded/cancelled
   * without emitting a task-notification. Used when the user explicitly
   * abandons a recovered task instead of resuming it.
   */
  abandon(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'paused') return;

    entry.status = 'cancelled';
    entry.endTime = Date.now();
    entry.notified = true;
    debugLogger.info(`Abandoned paused background agent: ${agentId}`);
    this.emitStatusChange(entry);
  }

  // Emit the terminal cancelled notification once the agent's natural
  // handler has confirmed that the reasoning loop ended because of the
  // abort (terminateMode === CANCELLED). Attaches the partial result and
  // stats so the parent model still sees whatever work the agent had
  // captured before the abort landed, instead of a bare "cancelled" line.
  finalizeCancelled(
    agentId: string,
    partialResult: string,
    stats?: AgentCompletionStats,
  ): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    if (entry.status !== 'running' && entry.status !== 'cancelled') return;
    if (entry.notified) return;

    entry.status = 'cancelled';
    entry.endTime ??= Date.now();
    if (partialResult) entry.result = partialResult;
    entry.stats = stats;
    this.emitNotification(entry);
    this.emitStatusChange(entry);
  }

  // Emit the terminal cancelled notification for entries that were cancelled
  // but for which no natural handler delivered a follow-up complete()/fail()/
  // finalizeCancelled(). Used by shutdown paths (abortAll) to guarantee the
  // SDK contract (every registered agent produces exactly one
  // task-notification).
  finalizeCancellationIfPending(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'cancelled' || entry.notified) return;
    this.emitNotification(entry);
    this.emitStatusChange(entry);
  }

  /**
   * Append a recent tool activity to a running entry's rolling buffer.
   * No-op if the entry is not running — late events after a cancellation
   * shouldn't leak into the Progress section.
   */
  appendActivity(agentId: string, activity: BackgroundActivity): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return;

    const prior = entry.recentActivities ?? [];
    const next = [...prior, activity];
    if (next.length > MAX_RECENT_ACTIVITIES) {
      next.splice(0, next.length - MAX_RECENT_ACTIVITIES);
    }
    entry.recentActivities = next;
    this.emitActivityChange(entry);
  }

  get(agentId: string): BackgroundTaskEntry | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Snapshot of every entry regardless of status. Used by the TUI
   * footer/dialog to render rows for still-running AND terminal-state
   * tasks; the headless holdback loop keys off `hasUnfinalizedTasks`
   * instead, so callers that only need the running slice can filter
   * this snapshot at the call site.
   */
  getAll(): BackgroundTaskEntry[] {
    return Array.from(this.agents.values());
  }

  /**
   * True if any registered task has not yet emitted its terminal
   * task-notification. Covers `running` (still executing) and
   * `cancelled`-but-not-finalized (cancel requested, but the natural
   * handler hasn't fired finalizeCancelled() yet). Headless callers
   * must keep their event loop alive while this returns true, so every
   * task_started is paired with a matching task_notification.
   */
  hasUnfinalizedTasks(): boolean {
    for (const entry of this.agents.values()) {
      if (entry.status === 'running') return true;
      if (entry.status === 'cancelled' && !entry.notified) return true;
    }
    return false;
  }

  /**
   * Drops every in-memory entry without touching sidecar state.
   *
   * Used only when switching to a different session after the caller has
   * already established that no live work from the current session is still
   * running. Paused/interrupted entries remain recoverable from disk because
   * their sidecars keep the persisted status.
   */
  reset(): void {
    const firstEntry = this.agents.values().next().value as
      | BackgroundTaskEntry
      | undefined;
    if (!firstEntry) return;
    this.agents.clear();
    this.emitStatusChange(firstEntry);
  }

  /**
   * Enqueue a message for delivery to a running background agent.
   * The agent drains this queue between tool rounds.
   */
  queueMessage(agentId: string, message: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return false;
    const queue = entry.pendingMessages!;
    queue.push(message);
    debugLogger.info(
      `Queued message for background agent ${agentId} (${queue.length} pending)`,
    );
    return true;
  }

  /**
   * Drain all pending messages for an agent. Returns the messages
   * and clears the queue. Called by the agent's reasoning loop.
   */
  drainMessages(agentId: string): string[] {
    const entry = this.agents.get(agentId);
    if (!entry || !entry.pendingMessages!.length) return [];
    const messages = entry.pendingMessages!.splice(0);
    debugLogger.info(
      `Drained ${messages.length} message(s) for background agent ${agentId}`,
    );
    return messages;
  }

  setNotificationCallback(
    cb: BackgroundNotificationCallback | undefined,
  ): void {
    this.notificationCallback = cb;
  }

  setRegisterCallback(cb: BackgroundRegisterCallback | undefined): void {
    this.registerCallback = cb;
  }

  setStatusChangeCallback(
    cb: BackgroundStatusChangeCallback | undefined,
  ): void {
    this.statusChangeCallback = cb;
  }

  setActivityChangeCallback(
    cb: BackgroundActivityChangeCallback | undefined,
  ): void {
    this.activityChangeCallback = cb;
  }

  abortAll(): void {
    for (const entry of Array.from(this.agents.values())) {
      this.cancel(entry.agentId, { persistedStatus: 'running' });
      // Shutdown path: no natural handler will run, so emit the cancelled
      // notification here to honour the one-notification-per-agent contract.
      this.finalizeCancellationIfPending(entry.agentId);
    }
    debugLogger.info('Aborted all background agents');
  }

  private buildDisplayLabel(entry: BackgroundTaskEntry): string {
    return buildBackgroundEntryLabel(entry);
  }

  private emitNotification(entry: BackgroundTaskEntry): void {
    // Mark notified *before* invoking the callback so that a re-entrant
    // terminal call inside the callback chain (cancel → complete race)
    // sees the flag and short-circuits, rather than firing twice.
    if (entry.notified) return;
    entry.notified = true;

    if (!this.notificationCallback) return;

    const statusText =
      entry.status === 'completed'
        ? 'completed'
        : entry.status === 'failed'
          ? 'failed'
          : 'was cancelled';

    const label = this.buildDisplayLabel(entry);
    const displayLine = `Background agent "${label}" ${statusText}.`;

    const xmlParts: string[] = [
      '<task-notification>',
      `<task-id>${escapeXml(entry.agentId)}</task-id>`,
    ];
    if (entry.toolUseId) {
      xmlParts.push(`<tool-use-id>${escapeXml(entry.toolUseId)}</tool-use-id>`);
    }
    xmlParts.push(
      `<status>${escapeXml(entry.status)}</status>`,
      `<summary>Agent "${escapeXml(entry.description)}" ${statusText}.</summary>`,
    );
    if (entry.result) {
      xmlParts.push(`<result>${escapeXml(entry.result)}</result>`);
    }
    if (entry.error) {
      xmlParts.push(`<result>Error: ${escapeXml(entry.error)}</result>`);
    }
    if (entry.outputFile) {
      xmlParts.push(
        `<output-file>${escapeXml(entry.outputFile)}</output-file>`,
      );
    }
    if (entry.stats) {
      xmlParts.push(
        '<usage>',
        `<total_tokens>${entry.stats.totalTokens}</total_tokens>`,
        `<tool_uses>${entry.stats.toolUses}</tool_uses>`,
        `<duration_ms>${entry.stats.durationMs}</duration_ms>`,
        '</usage>',
      );
    }
    xmlParts.push('</task-notification>');

    const meta: NotificationMeta = {
      agentId: entry.agentId,
      status: entry.status,
      stats: entry.stats,
      toolUseId: entry.toolUseId,
    };

    try {
      this.notificationCallback(displayLine, xmlParts.join('\n'), meta);
    } catch (error) {
      debugLogger.error('Failed to emit background notification:', error);
    }
  }

  private emitStatusChange(entry?: BackgroundTaskEntry): void {
    if (!this.statusChangeCallback) return;
    try {
      this.statusChangeCallback(entry);
    } catch (error) {
      debugLogger.error('Failed to emit background status change:', error);
    }
  }

  private emitActivityChange(entry: BackgroundTaskEntry): void {
    if (!this.activityChangeCallback) return;
    try {
      this.activityChangeCallback(entry);
    } catch (error) {
      debugLogger.error('Failed to emit background activity change:', error);
    }
  }
}
