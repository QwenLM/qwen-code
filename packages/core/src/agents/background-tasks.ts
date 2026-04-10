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

export type BackgroundAgentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BackgroundAgentEntry {
  agentId: string;
  description: string;
  status: BackgroundAgentStatus;
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
  abortController: AbortController;
  name?: string;
}

export type BackgroundNotificationCallback = (message: string) => void;

export class BackgroundTaskRegistry {
  private readonly agents = new Map<string, BackgroundAgentEntry>();
  private notificationCallback?: BackgroundNotificationCallback;

  /**
   * Register a new background agent.
   */
  register(entry: BackgroundAgentEntry): void {
    this.agents.set(entry.agentId, entry);
    debugLogger.info(`Registered background agent: ${entry.agentId}`);
  }

  /**
   * Mark a background agent as completed.
   * No-op if the agent is not in 'running' state (guards against race
   * with concurrent cancellation).
   */
  complete(agentId: string, result: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return;

    entry.status = 'completed';
    entry.endTime = Date.now();
    entry.result = result;
    debugLogger.info(`Background agent completed: ${agentId}`);

    this.emitNotification(entry);
  }

  /**
   * Mark a background agent as failed.
   * No-op if the agent is not in 'running' state (guards against race
   * with concurrent cancellation).
   */
  fail(agentId: string, error: string): void {
    const entry = this.agents.get(agentId);
    if (!entry || entry.status !== 'running') return;

    entry.status = 'failed';
    entry.endTime = Date.now();
    entry.error = error;
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
  setNotificationCallback(cb: BackgroundNotificationCallback): void {
    this.notificationCallback = cb;
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

  private emitNotification(entry: BackgroundAgentEntry): void {
    if (!this.notificationCallback) return;

    const statusText =
      entry.status === 'completed'
        ? `completed`
        : entry.status === 'failed'
          ? `failed: ${entry.error || 'Unknown error'}`
          : `was cancelled`;

    const summary = `Agent "${entry.description}" ${statusText}`;

    const resultSection = entry.result
      ? `\n  <result>${entry.result}</result>`
      : '';
    const errorSection = entry.error ? `\n  <error>${entry.error}</error>` : '';

    const xml = `<task-notification>
  <agent_id>${entry.agentId}</agent_id>
  <status>${entry.status}</status>
  <summary>${summary}</summary>${resultSection}${errorSection}
</task-notification>`;

    const message = `A background agent completed a task:\n${xml}`;

    try {
      this.notificationCallback(message);
    } catch (error) {
      debugLogger.error('Failed to emit background notification:', error);
    }
  }
}
