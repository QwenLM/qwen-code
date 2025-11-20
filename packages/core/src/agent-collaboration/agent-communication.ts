/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { AgentSharedMemory } from './shared-memory.js';

export interface AgentMessage {
  id: string;
  from: string;
  to: string | 'broadcast';
  type: 'request' | 'response' | 'notification' | 'data';
  content: string | Record<string, unknown>;
  timestamp: string;
  correlationId?: string; // For matching requests with responses
  priority?: 'low' | 'medium' | 'high';
}

/**
 * Communication system for agents to send messages to each other
 */
export class AgentCommunicationSystem {
  private readonly memory: AgentSharedMemory;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.memory = new AgentSharedMemory(config);

    // Use config to log initialization if needed
    void this.config;
  }

  /**
   * Send a message to another agent
   * @param from The sending agent
   * @param to The receiving agent, or 'broadcast' for all agents
   * @param type The type of message
   * @param content The content of the message
   * @param options Additional options like priority or correlation ID
   */
  async sendMessage(
    from: string,
    to: string | 'broadcast',
    type: 'request' | 'response' | 'notification' | 'data',
    content: string | Record<string, unknown>,
    options?: {
      correlationId?: string;
      priority?: 'low' | 'medium' | 'high';
    },
  ): Promise<string> {
    const message: AgentMessage = {
      id: `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      from,
      to,
      type,
      content,
      timestamp: new Date().toISOString(),
      correlationId: options?.correlationId,
      priority: options?.priority || 'medium',
    };

    // Store in shared memory
    await this.memory.set(`message:${message.id}`, message);

    // Also store in the recipient's inbox if not broadcasting
    if (to !== 'broadcast') {
      const inboxKey = `inbox:${to}`;
      const inbox: AgentMessage[] =
        (await this.memory.get<AgentMessage[]>(inboxKey)) || [];
      inbox.push(message);
      await this.memory.set(inboxKey, inbox);
    } else {
      // For broadcast, add to all agents' inboxes
      const agentKeys = await this.memory.keys();
      for (const key of agentKeys) {
        if (key.startsWith('inbox:')) {
          const inbox: AgentMessage[] =
            (await this.memory.get<AgentMessage[]>(key)) || [];
          inbox.push(message);
          await this.memory.set(key, inbox);
        }
      }
    }

    return message.id;
  }

  /**
   * Get messages from an agent's inbox
   * @param agentId The agent to get messages for
   * @param count The maximum number of messages to return
   * @param priority Optional priority filter
   */
  async getInbox(
    agentId: string,
    count?: number,
    priority?: 'low' | 'medium' | 'high',
  ): Promise<AgentMessage[]> {
    const inboxKey = `inbox:${agentId}`;
    const inbox: AgentMessage[] =
      (await this.memory.get<AgentMessage[]>(inboxKey)) || [];

    let filteredMessages = inbox;
    if (priority) {
      filteredMessages = inbox.filter((msg) => msg.priority === priority);
    }

    // Sort by timestamp (most recent first)
    filteredMessages.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return count ? filteredMessages.slice(0, count) : filteredMessages;
  }

  /**
   * Get all messages (for broadcast or admin purposes)
   */
  async getAllMessages(): Promise<AgentMessage[]> {
    const allKeys = await this.memory.keys();
    const messages: AgentMessage[] = [];

    for (const key of allKeys) {
      if (key.startsWith('message:')) {
        const message = await this.memory.get<AgentMessage>(key);
        if (message) {
          messages.push(message);
        }
      }
    }

    return messages;
  }

  /**
   * Clear an agent's inbox
   * @param agentId The agent whose inbox to clear
   */
  async clearInbox(agentId: string): Promise<void> {
    const inboxKey = `inbox:${agentId}`;
    await this.memory.delete(inboxKey);
  }

  /**
   * Send a request and wait for a response
   * @param from The requesting agent
   * @param to The responding agent
   * @param request The request content
   * @param timeoutMs How long to wait for a response (in ms)
   */
  async sendRequestAndWait(
    from: string,
    to: string,
    request: string | Record<string, unknown>,
    timeoutMs: number = 5000,
  ): Promise<AgentMessage | null> {
    const correlationId = `req-${Date.now()}`;

    // Send the request
    await this.sendMessage(from, to, 'request', request, {
      correlationId,
      priority: 'high',
    });

    // Wait for a response with the matching correlation ID
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const inbox = await this.getInbox(from);
      const response = inbox.find(
        (msg) => msg.correlationId === correlationId && msg.type === 'response',
      );

      if (response) {
        // Remove the response from inbox if it's a direct request-response
        const inboxKey = `inbox:${from}`;
        const inbox: AgentMessage[] =
          (await this.memory.get<AgentMessage[]>(inboxKey)) || [];
        const updatedInbox = inbox.filter((msg) => msg.id !== response.id);
        await this.memory.set(inboxKey, updatedInbox);

        return response;
      }

      await new Promise((resolve) => setTimeout(resolve, 100)); // Wait 100ms before checking again
    }

    return null; // Timeout
  }

  /**
   * Get the shared memory instance for direct access
   */
  getMemory(): AgentSharedMemory {
    return this.memory;
  }
}
