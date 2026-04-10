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

export type BackgroundAgentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
}

export type BackgroundNotificationCallback = (
  displayText: string,
  modelText: string,
) => void;

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
        ? 'completed'
        : entry.status === 'failed'
          ? `failed`
          : 'was cancelled';

    // Build the label: "Explore: list ts files..." (truncated)
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
    const label = entry.subagentType ? `${entry.subagentType}: ${desc}` : desc;

    // Short display line shown in the UI
    const displayLine = `Background agent "${label}" ${statusText}.`;

    // Full model-facing text (includes result/error for the LLM to act on)
    const modelLines: string[] = [
      `Background agent "${entry.description}" (${entry.agentId}) ${statusText}.`,
    ];
    if (entry.result) {
      modelLines.push('', entry.result);
    }
    if (entry.error) {
      modelLines.push('', `Error: ${entry.error}`);
    }

    try {
      this.notificationCallback(displayLine, modelLines.join('\n'));
    } catch (error) {
      debugLogger.error('Failed to emit background notification:', error);
    }
  }
}
