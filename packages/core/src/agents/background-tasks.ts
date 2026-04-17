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
const MAX_RESULT_LENGTH = 2000;

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
  name?: string;
  stats?: AgentCompletionStats;
}

export interface NotificationMeta {
  agentId: string;
  status: BackgroundAgentStatus;
  stats?: AgentCompletionStats;
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

  /**
   * Register a new background agent.
   */
  register(entry: BackgroundAgentEntry): void {
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

  /**
   * Mark a background agent as completed.
   * No-op if the agent is not in 'running' state (guards against race
   * with concurrent cancellation).
   */
  complete(
    agentId: string,
    result: string,
    stats?: AgentCompletionStats,
  ): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return;

    entry.status = 'completed';
    entry.endTime = Date.now();
    entry.result = result;
    entry.stats = stats;
    debugLogger.info(`Background agent completed: ${agentId}`);

    this.emitNotification(entry);
  }

  /**
   * Mark a background agent as failed.
   * No-op if the agent is not in 'running' state (guards against race
   * with concurrent cancellation).
   */
  fail(agentId: string, error: string, stats?: AgentCompletionStats): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return;

    entry.status = 'failed';
    entry.endTime = Date.now();
    entry.error = error;
    entry.stats = stats;
    debugLogger.info(`Background agent failed: ${agentId}`);

    this.emitNotification(entry);
  }

  /**
   * Abort and mark a background agent as cancelled.
   */
  cancel(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return;

    entry.abortController.abort();
    entry.status = 'cancelled';
    entry.endTime = Date.now();
    debugLogger.info(`Background agent cancelled: ${agentId}`);
  }

  /**
   * Look up a background agent by ID.
   */
  get(agentId: string): BackgroundAgentEntry | undefined {
    return this.agents.get(agentId);
  }

  /**
   * List all currently running background agents.
   */
  getRunning(): BackgroundAgentEntry[] {
    return Array.from(this.agents.values()).filter(
      (e) => e.status === 'running',
    );
  }

  /**
   * Look up a background agent by name (for SendMessage routing).
   */
  findByName(name: string): BackgroundAgentEntry | undefined {
    for (const entry of this.agents.values()) {
      if (entry.name === name && entry.status === 'running') {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Set the callback that delivers completion notifications to the CLI.
   * Called by AppContainer during initialization.
   */
  setNotificationCallback(
    cb: BackgroundNotificationCallback | undefined,
  ): void {
    this.notificationCallback = cb;
  }

  /**
   * Set the callback fired when a new background agent is registered.
   * Used by the CLI to emit task_started SDK events.
   */
  setRegisterCallback(cb: BackgroundRegisterCallback | undefined): void {
    this.registerCallback = cb;
  }

  /**
   * Abort all running background agents. Called during session cleanup.
   */
  abortAll(): void {
    for (const entry of this.agents.values()) {
      if (entry.status === 'running') {
        entry.abortController.abort();
        entry.status = 'cancelled';
        entry.endTime = Date.now();
      }
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
      `<task-id>${entry.agentId}</task-id>`,
      `<status>${entry.status}</status>`,
      `<summary>Agent "${entry.description}" ${statusText}.</summary>`,
    ];
    if (entry.result) {
      const truncated =
        entry.result.length > MAX_RESULT_LENGTH
          ? entry.result.slice(0, MAX_RESULT_LENGTH) + '\n[truncated]'
          : entry.result;
      xmlParts.push(`<result>${truncated}</result>`);
    }
    if (entry.error) {
      xmlParts.push(`<result>Error: ${entry.error}</result>`);
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
    };

    try {
      this.notificationCallback(displayLine, xmlParts.join('\n'), meta);
    } catch (error) {
      debugLogger.error('Failed to emit background notification:', error);
    }
  }
}
