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

const debugLogger = createDebugLogger('BACKGROUND_TASKS');

const MAX_DESCRIPTION_LENGTH = 40;

// Grace period after cancel() before emitting a fallback cancelled
// notification. The natural handler (bgBody) almost always settles and
// emits the terminal notification with the real partial result well
// within this window; the timeout only fires for pathological tools
// that ignore AbortSignal. Must be long enough that normal scheduler
// unwind wins the race, short enough that a stuck headless wait loop
// doesn't feel hung.
const CANCEL_GRACE_MS = 5000;

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

export type BackgroundAgentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentCompletionStats {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

export interface BackgroundAgentEntry {
  agentId: string;
  description: string;
  subagentType?: string;
  status: BackgroundAgentStatus;
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
  abortController: AbortController;
  stats?: AgentCompletionStats;
  toolUseId?: string;
  /** Absolute path to the agent's plain-text transcript file. */
  outputFile?: string;
  /** Messages queued by SendMessage, drained between tool rounds. */
  pendingMessages?: string[];
  /**
   * True once a terminal task-notification has been emitted for this entry.
   * Prevents duplicate notifications when cancel races with the natural
   * completion path (cancel aborts the signal; the agent's own handler then
   * fires the notification with the real partial/final result).
   */
  notified?: boolean;
}

export interface NotificationMeta {
  agentId: string;
  status: BackgroundAgentStatus;
  stats?: AgentCompletionStats;
  toolUseId?: string;
}

export type BackgroundNotificationCallback = (
  displayText: string,
  modelText: string,
  meta: NotificationMeta,
) => void;

export type BackgroundRegisterCallback = (entry: BackgroundAgentEntry) => void;

export class BackgroundTaskRegistry {
  private readonly agents = new Map<string, BackgroundAgentEntry>();
  private notificationCallback?: BackgroundNotificationCallback;
  private registerCallback?: BackgroundRegisterCallback;

  register(entry: BackgroundAgentEntry): void {
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
  }

  // Cancellation aborts the signal and marks the entry as cancelled, but
  // does *not* emit the terminal notification immediately. The natural
  // completion path (bgBody) fires complete()/fail()/finalizeCancelled()
  // with the real partial/final result, which carries far more information
  // than a bare "cancelled" message. A deferred fallback handles the rare
  // case where a tool ignores AbortSignal and bgBody never settles — the
  // timeout lands on finalizeCancellationIfPending(), which is a no-op
  // once the natural handler has already emitted.
  cancel(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return;

    entry.abortController.abort();
    entry.status = 'cancelled';
    entry.endTime = Date.now();
    debugLogger.info(`Background agent cancelled: ${agentId}`);

    const timer = setTimeout(() => {
      this.finalizeCancellationIfPending(agentId);
    }, CANCEL_GRACE_MS);
    timer.unref?.();
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
  }

  get(agentId: string): BackgroundAgentEntry | undefined {
    return this.agents.get(agentId);
  }

  getRunning(): BackgroundAgentEntry[] {
    return Array.from(this.agents.values()).filter(
      (e) => e.status === 'running',
    );
  }

  /**
   * True if any registered agent has not yet emitted its terminal
   * task-notification. Covers `running` (still executing) and
   * `cancelled`-but-not-finalized (cancel requested, but the natural
   * handler hasn't fired finalizeCancelled() yet). Headless callers
   * must keep their event loop alive while this returns true, so every
   * task_started is paired with a matching task_notification.
   */
  hasUnfinalizedAgents(): boolean {
    for (const entry of this.agents.values()) {
      if (!entry.notified) return true;
    }
    return false;
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

  abortAll(): void {
    for (const entry of Array.from(this.agents.values())) {
      this.cancel(entry.agentId);
      // Shutdown path: no natural handler will run, so emit the cancelled
      // notification here to honour the one-notification-per-agent contract.
      this.finalizeCancellationIfPending(entry.agentId);
    }
    debugLogger.info('Aborted all background agents');
  }

  private buildDisplayLabel(entry: BackgroundAgentEntry): string {
    // Strip the subagent type prefix if the description already starts with it
    // to avoid duplication like "Explore: Explore: list ts files".
    let rawDesc = entry.description;
    if (
      entry.subagentType &&
      rawDesc.toLowerCase().startsWith(entry.subagentType.toLowerCase() + ':')
    ) {
      rawDesc = rawDesc.slice(entry.subagentType.length + 1).trimStart();
    }
    const desc =
      rawDesc.length > MAX_DESCRIPTION_LENGTH
        ? rawDesc.slice(0, MAX_DESCRIPTION_LENGTH) + '...'
        : rawDesc;
    return entry.subagentType ? `${entry.subagentType}: ${desc}` : desc;
  }

  private emitNotification(entry: BackgroundAgentEntry): void {
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
}
