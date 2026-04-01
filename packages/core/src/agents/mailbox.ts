/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview TeamMailbox — in-memory inter-agent messaging.
 *
 * Enables direct teammate-to-teammate messaging and broadcast.
 * Each agent has its own inbox. Messages are queued and drained
 * on demand. The mailbox is shared across all agents in a team.
 */

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('TEAM_MAILBOX');

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  read: boolean;
}

/**
 * TeamMailbox — in-memory message queue for inter-agent communication.
 *
 * Simple inbox-per-agent model:
 * - `send(from, to, message)` → enqueue in recipient's inbox
 * - `broadcast(from, message)` → enqueue in all inboxes except sender
 * - `receive(agentId)` → drain all unread messages from inbox
 * - `peek(agentId)` → read without draining
 */
export class TeamMailbox {
  private readonly inboxes = new Map<string, TeamMessage[]>();
  private messageCounter = 0;

  /**
   * Register an agent's inbox. Called when an agent joins the team.
   */
  register(agentId: string): void {
    if (!this.inboxes.has(agentId)) {
      this.inboxes.set(agentId, []);
      debugLogger.debug(`Registered inbox for agent: ${agentId}`);
    }
  }

  /**
   * Unregister an agent's inbox. Called when an agent leaves the team.
   */
  unregister(agentId: string): void {
    this.inboxes.delete(agentId);
    debugLogger.debug(`Unregistered inbox for agent: ${agentId}`);
  }

  /**
   * Send a message from one agent to another.
   * Creates the recipient's inbox if it doesn't exist.
   */
  send(from: string, to: string, content: string): TeamMessage {
    const message: TeamMessage = {
      id: `msg-${++this.messageCounter}`,
      from,
      to,
      content,
      timestamp: Date.now(),
      read: false,
    };

    if (!this.inboxes.has(to)) {
      this.inboxes.set(to, []);
    }
    this.inboxes.get(to)!.push(message);

    debugLogger.debug(
      `Message ${message.id}: ${from} → ${to} (${content.length} chars)`,
    );
    return message;
  }

  /**
   * Broadcast a message from one agent to all other agents.
   * Returns the list of messages sent (one per recipient).
   */
  broadcast(from: string, content: string): TeamMessage[] {
    const messages: TeamMessage[] = [];
    for (const agentId of this.inboxes.keys()) {
      if (agentId !== from) {
        messages.push(this.send(from, agentId, content));
      }
    }
    debugLogger.debug(`Broadcast from ${from} to ${messages.length} agents`);
    return messages;
  }

  /**
   * Drain all unread messages from an agent's inbox.
   * Marks them as read and returns them.
   */
  receive(agentId: string): TeamMessage[] {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) return [];

    const unread = inbox.filter((m) => !m.read);
    for (const m of unread) {
      m.read = true;
    }
    return unread;
  }

  /**
   * Peek at unread messages without marking them as read.
   */
  peek(agentId: string): readonly TeamMessage[] {
    const inbox = this.inboxes.get(agentId);
    if (!inbox) return [];
    return inbox.filter((m) => !m.read);
  }

  /**
   * Get the count of unread messages for an agent.
   */
  getUnreadCount(agentId: string): number {
    return this.peek(agentId).length;
  }

  /**
   * Get all registered agent IDs.
   */
  getRegisteredAgents(): string[] {
    return Array.from(this.inboxes.keys());
  }

  /**
   * Clear all inboxes and reset the mailbox.
   */
  clear(): void {
    this.inboxes.clear();
    this.messageCounter = 0;
    debugLogger.debug('Mailbox cleared');
  }
}
