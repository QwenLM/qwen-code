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
  type:
    | 'request'
    | 'response'
    | 'notification'
    | 'data'
    | 'workflow'
    | 'health'
    | 'error';
  content: string | Record<string, unknown>;
  timestamp: string;
  correlationId?: string; // For matching requests with responses
  priority?: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[]; // Additional tags for message classification and routing
  expiry?: string; // Optional expiry timestamp
  source?: string; // Source of the message (for routing)
}

export type MessageFilter = (message: AgentMessage) => boolean;

/**
 * Communication system for agents to send messages to each other
 */
export class AgentCommunicationSystem {
  private readonly memory: AgentSharedMemory;
  private config: Config;
  private readonly messageFilters: Map<string, MessageFilter>;
  private readonly routingRules: Map<
    string,
    (message: AgentMessage, recipient: string) => boolean
  >;

  constructor(config: Config) {
    this.config = config;
    this.memory = new AgentSharedMemory(config);
    this.messageFilters = new Map();
    this.routingRules = new Map();

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
    type:
      | 'request'
      | 'response'
      | 'notification'
      | 'data'
      | 'workflow'
      | 'health'
      | 'error',
    content: string | Record<string, unknown>,
    options?: {
      correlationId?: string;
      priority?: 'low' | 'medium' | 'high' | 'critical';
      requireAck?: boolean; // Whether to require acknowledgment
      tags?: string[]; // Tags for message classification
      expiry?: string; // Optional expiry timestamp
      source?: string; // Source of the message
    },
  ): Promise<string> {
    const startTime = Date.now();
    const message: AgentMessage = {
      id: `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      from,
      to,
      type,
      content,
      timestamp: new Date().toISOString(),
      correlationId: options?.correlationId,
      priority: options?.priority || 'medium',
      tags: options?.tags,
      expiry: options?.expiry,
      source: options?.source,
    };

    // Check if message has expired
    if (message.expiry && new Date(message.expiry) < new Date()) {
      console.warn(`Message ${message.id} has expired and will not be sent`);
      return message.id;
    }

    // Store in shared memory
    await this.memory.set(`message:${message.id}`, message);

    // Also store in the recipient's inbox if not broadcasting
    if (to !== 'broadcast') {
      const inboxKey = `inbox:${to}`;
      const inbox: AgentMessage[] =
        (await this.memory.get<AgentMessage[]>(inboxKey)) || [];
      inbox.push(message);
      await this.memory.set(inboxKey, inbox);

      // If acknowledgment is required, set up message tracking
      if (options?.requireAck) {
        await this.memory.set(`ack:${message.id}`, {
          messageId: message.id,
          receiver: to,
          status: 'pending',
          timestamp: message.timestamp,
          attempts: 0,
        });
      }
    } else {
      // For broadcast, add to all agents' inboxes
      const agentKeys = await this.memory.keys();
      for (const key of agentKeys) {
        if (key.startsWith('inbox:')) {
          const agentName = key.substring(6); // Remove 'inbox:' prefix
          // Check routing rules to see if this agent should receive the broadcast
          if (this.shouldRouteMessage(message, agentName)) {
            const inbox: AgentMessage[] =
              (await this.memory.get<AgentMessage[]>(key)) || [];
            inbox.push(message);
            await this.memory.set(key, inbox);
          }
        }
      }
    }

    // Record collaboration metrics
    if (to !== 'broadcast') {
      const duration = Date.now() - startTime;
      await this.recordCollaborationMetrics(
        undefined,
        from,
        to,
        type,
        duration,
        true,
      );
    }

    return message.id;
  }

  /**
   * Route a message to appropriate recipients based on routing rules
   */
  async routeMessage(
    message: AgentMessage,
    recipients: string[],
  ): Promise<string[]> {
    const sentMessageIds: string[] = [];

    for (const recipient of recipients) {
      if (this.shouldRouteMessage(message, recipient)) {
        // Create a copy of the message with the appropriate recipient
        const routedMessage = { ...message, to: recipient };
        const messageId = await this.sendMessage(
          routedMessage.from,
          recipient,
          routedMessage.type,
          routedMessage.content,
          {
            correlationId: routedMessage.correlationId,
            priority: routedMessage.priority,
            tags: routedMessage.tags,
            expiry: routedMessage.expiry,
            source: routedMessage.source,
          },
        );
        sentMessageIds.push(messageId);
      }
    }

    return sentMessageIds;
  }

  /**
   * Determines if a message should be routed to the specified recipient
   */
  private shouldRouteMessage(
    message: AgentMessage,
    recipient: string,
  ): boolean {
    // Check routing rules
    for (const [_, rule] of this.routingRules) {
      if (!rule(message, recipient)) {
        return false; // If any rule fails, don't route
      }
    }

    // Default behavior: route message if recipient matches or it's a broadcast
    return message.to === 'broadcast' || message.to === recipient;
  }

  /**
   * Add a message filter to the system
   * @param id Unique ID for the filter
   * @param filter Function that determines if a message should be processed
   */
  addFilter(id: string, filter: MessageFilter): void {
    this.messageFilters.set(id, filter);
  }

  /**
   * Remove a message filter
   * @param id The ID of the filter to remove
   */
  removeFilter(id: string): boolean {
    return this.messageFilters.delete(id);
  }

  /**
   * Add a routing rule to determine which agents receive specific messages
   * @param id Unique ID for the rule
   * @param rule Function that determines if a message should be sent to a recipient
   */
  addRoutingRule(
    id: string,
    rule: (message: AgentMessage, recipient: string) => boolean,
  ): void {
    this.routingRules.set(id, rule);
  }

  /**
   * Remove a routing rule
   * @param id The ID of the rule to remove
   */
  removeRoutingRule(id: string): boolean {
    return this.routingRules.delete(id);
  }

  /**
   * Get messages from an agent's inbox that match the specified filter
   * @param agentId The agent to get messages for
   * @param filters Optional array of filter functions to apply
   * @param count The maximum number of messages to return
   * @param priority Optional priority filter
   * @param tag Optional tag filter
   */
  async getInbox(
    agentId: string,
    filters?: MessageFilter[],
    count?: number,
    priority?: 'low' | 'medium' | 'high' | 'critical',
    tag?: string,
  ): Promise<AgentMessage[]> {
    const inboxKey = `inbox:${agentId}`;
    let inbox: AgentMessage[] =
      (await this.memory.get<AgentMessage[]>(inboxKey)) || [];

    // Apply priority filter
    if (priority) {
      inbox = inbox.filter((msg) => msg.priority === priority);
    }

    // Apply tag filter
    if (tag) {
      inbox = inbox.filter((msg) => msg.tags && msg.tags.includes(tag));
    }

    // Apply custom filters
    if (filters && filters.length > 0) {
      for (const filter of filters) {
        inbox = inbox.filter(filter);
      }
    }

    // Apply system filters
    for (const [_, filter] of this.messageFilters) {
      inbox = inbox.filter(filter);
    }

    // Sort by priority and timestamp
    inbox.sort((a, b) => {
      // Priority order: critical > high > medium > low
      const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      const priorityDiff =
        (priorityOrder[b.priority || 'medium'] || 2) -
        (priorityOrder[a.priority || 'medium'] || 2);

      // If priorities are equal, sort by timestamp (most recent first)
      if (priorityDiff === 0) {
        return (
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
      }

      return priorityDiff;
    });

    return count ? inbox.slice(0, count) : inbox;
  }

  /**
   * Get all messages (for broadcast or admin purposes)
   * @param filters Optional array of filter functions to apply
   * @param type Optional message type filter
   * @param sender Optional sender filter
   */
  async getAllMessages(
    filters?: MessageFilter[],
    type?:
      | 'request'
      | 'response'
      | 'notification'
      | 'data'
      | 'workflow'
      | 'health'
      | 'error',
    sender?: string,
  ): Promise<AgentMessage[]> {
    const allKeys = await this.memory.keys();
    let messages: AgentMessage[] = [];

    for (const key of allKeys) {
      if (key.startsWith('message:')) {
        const message = await this.memory.get<AgentMessage>(key);
        if (message) {
          // Check if message matches optional filters
          if (type && message.type !== type) continue;
          if (sender && message.from !== sender) continue;

          messages.push(message);
        }
      }
    }

    // Apply custom filters
    if (filters && filters.length > 0) {
      for (const filter of filters) {
        messages = messages.filter(filter);
      }
    }

    // Apply system filters
    for (const [_, filter] of this.messageFilters) {
      messages = messages.filter(filter);
    }

    // Sort by timestamp (most recent first)
    messages.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

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
   * Broadcast a message to a filtered set of agents
   * @param from The sending agent
   * @param type The type of message
   * @param content The content of the message
   * @param agentFilter Filter function to determine which agents should receive the message
   * @param options Additional options like priority or correlation ID
   */
  async broadcastToFiltered(
    from: string,
    type:
      | 'request'
      | 'response'
      | 'notification'
      | 'data'
      | 'workflow'
      | 'health'
      | 'error',
    content: string | Record<string, unknown>,
    agentFilter: (agentName: string) => boolean,
    options?: {
      correlationId?: string;
      priority?: 'low' | 'medium' | 'high' | 'critical';
      tags?: string[]; // Tags for message classification
      expiry?: string; // Optional expiry timestamp
      source?: string; // Source of the message
    },
  ): Promise<void> {
    // Get all agent inboxes
    const allKeys = await this.memory.keys();
    const agentInboxes = allKeys.filter((key) => key.startsWith('inbox:'));

    for (const inboxKey of agentInboxes) {
      const agentName = inboxKey.substring(6); // Remove 'inbox:' prefix

      // Check if this agent passes the filter
      if (agentFilter(agentName)) {
        // Send message directly to this agent
        await this.sendMessage(from, agentName, type, content, options);
      }
    }
  }

  /**
   * Acknowledge receipt of a message
   * @param messageId The ID of the message to acknowledge
   * @param receiver The agent acknowledging the message
   */
  async acknowledgeMessage(messageId: string, receiver: string): Promise<void> {
    const ackKey = `ack:${messageId}`;
    const ackRecord = await this.memory.get<Record<string, unknown>>(ackKey);

    if (ackRecord) {
      // Update the acknowledgment status
      await this.memory.set(ackKey, {
        ...ackRecord,
        status: 'received',
        receivedAt: new Date().toISOString(),
        receiver,
      });
    }
  }

  /**
   * Check acknowledgment status for a message
   * @param messageId The ID of the message to check
   */
  async getAcknowledgmentStatus(
    messageId: string,
  ): Promise<'pending' | 'received' | 'not_required' | 'timeout'> {
    const ackKey = `ack:${messageId}`;
    const ackRecord = await this.memory.get<Record<string, unknown>>(ackKey);

    if (!ackRecord) {
      return 'not_required';
    }

    // Check if the message is too old and should be considered timed out
    const messageTimestamp = new Date(
      (ackRecord as { timestamp: string }).timestamp,
    ).getTime();
    const ageInMs = Date.now() - messageTimestamp;

    // Consider message timed out after 5 minutes
    if (ageInMs > 5 * 60 * 1000) {
      await this.memory.set(ackKey, {
        ...ackRecord,
        status: 'timeout',
      });
      return 'timeout';
    }

    return (ackRecord as { status: string }).status as
      | 'pending'
      | 'received'
      | 'timeout';
  }

  /**
   * Get all pending acknowledgments
   */
  async getPendingAcknowledgments(): Promise<
    Array<{ messageId: string; receiver: string; timestamp: string }>
  > {
    const allKeys = await this.memory.keys();
    const pendingAcks: Array<{
      messageId: string;
      receiver: string;
      timestamp: string;
    }> = [];

    for (const key of allKeys) {
      if (key.startsWith('ack:')) {
        const ackRecord = await this.memory.get<Record<string, unknown>>(key);
        if (
          ackRecord &&
          (ackRecord as { status: string }).status === 'pending'
        ) {
          pendingAcks.push({
            messageId: (ackRecord as { messageId: string }).messageId,
            receiver: (ackRecord as { receiver: string }).receiver,
            timestamp: (ackRecord as { timestamp: string }).timestamp,
          });
        }
      }
    }

    return pendingAcks;
  }

  /**
   * Batch send multiple messages efficiently
   * @param messages Array of messages to send
   * @returns Array of message IDs
   */
  async batchSend(
    messages: Array<{
      from: string;
      to: string | 'broadcast';
      type:
        | 'request'
        | 'response'
        | 'notification'
        | 'data'
        | 'workflow'
        | 'health'
        | 'error';
      content: string | Record<string, unknown>;
      options?: {
        correlationId?: string;
        priority?: 'low' | 'medium' | 'high' | 'critical';
        requireAck?: boolean;
        tags?: string[];
        expiry?: string;
        source?: string;
      };
    }>,
  ): Promise<string[]> {
    const messageIds: string[] = [];

    // Group messages by priority to process critical messages first
    const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
    const sortedMessages = [...messages].sort((a, b) => {
      const priorityA = priorityOrder[a.options?.priority || 'medium'] || 2;
      const priorityB = priorityOrder[b.options?.priority || 'medium'] || 2;
      return priorityB - priorityA; // Sort in descending order (critical first)
    });

    for (const msg of sortedMessages) {
      const messageId = await this.sendMessage(
        msg.from,
        msg.to,
        msg.type,
        msg.content,
        msg.options,
      );
      messageIds.push(messageId);
    }

    return messageIds;
  }

  /**
   * Create a priority queue for message handling
   * @param agentId The agent that will handle the queue
   * @param maxQueueSize Maximum size of the queue (default 1000)
   */
  async createPriorityQueue(
    agentId: string,
    maxQueueSize: number = 1000,
  ): Promise<void> {
    // Create a queue in memory for the agent with priority levels
    await this.memory.set(`priority-queue:${agentId}`, {
      high: [] as AgentMessage[],
      medium: [] as AgentMessage[],
      low: [] as AgentMessage[],
      maxQueueSize,
      currentSize: 0,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Add a message to an agent's priority queue
   * @param agentId The agent that owns the queue
   * @param message The message to add
   */
  async addToPriorityQueue(
    agentId: string,
    message: AgentMessage,
  ): Promise<void> {
    const queueKey = `priority-queue:${agentId}`;
    let queue = await this.memory.get<Record<string, unknown>>(queueKey);

    if (!queue) {
      await this.createPriorityQueue(agentId);
      queue = await this.memory.get<Record<string, unknown>>(queueKey);
    }

    if (!queue) {
      throw new Error(
        `Could not create or access priority queue for agent: ${agentId}`,
      );
    }

    // Get the priority level for this message
    const priorityLevel = message.priority || 'medium';
    const priorityQueue = (queue[priorityLevel] || []) as AgentMessage[];

    // Check if the queue is at max capacity
    const currentSize = (queue['currentSize'] as number) || 0;
    const maxQueueSize = (queue['maxQueueSize'] as number) || 1000;

    if (currentSize >= maxQueueSize) {
      // Remove lowest priority message if it's a lower priority than the incoming one
      if (priorityLevel !== 'low') {
        // Try to remove a low priority message
        const lowPriorityQueue = (queue['low'] as AgentMessage[]) || [];
        if (lowPriorityQueue.length > 0) {
          lowPriorityQueue.shift(); // Remove oldest low priority message
          queue['currentSize'] = currentSize - 1;
        } else if (
          priorityLevel !== 'medium' &&
          ((queue['medium'] as AgentMessage[]) || []).length > 0
        ) {
          // If adding high priority and no low priority messages, remove oldest medium priority
          (queue['medium'] as AgentMessage[]).shift();
          queue['currentSize'] = currentSize - 1;
        }
      } else {
        // If adding a low priority message to a full queue, reject it
        console.warn(
          `Priority queue for agent ${agentId} is full. Message rejected: ${message.id}`,
        );
        return;
      }
    }

    // Add the message to the appropriate priority queue
    priorityQueue.push(message);
    queue[priorityLevel] = priorityQueue;
    queue['currentSize'] = ((queue['currentSize'] as number) || 0) + 1;

    // Store the updated queue
    await this.memory.set(queueKey, queue);
  }

  /**
   * Process messages from an agent's priority queue
   * @param agentId The agent that owns the queue
   * @param count Maximum number of messages to process (default 10)
   */
  async processPriorityQueue(
    agentId: string,
    count: number = 10,
  ): Promise<AgentMessage[]> {
    const queueKey = `priority-queue:${agentId}`;
    const queue = await this.memory.get<Record<string, unknown>>(queueKey);

    if (!queue) {
      return []; // No queue exists
    }

    // Process messages in priority order: critical, high, medium, low
    const priorities = ['critical', 'high', 'medium', 'low'];
    const processedMessages: AgentMessage[] = [];
    let remainingCount = count;

    for (const priority of priorities) {
      const queueForPriority = (queue[priority] as AgentMessage[]) || [];

      const messagesToProcess = queueForPriority.slice(0, remainingCount);
      const actualMessagesCount = messagesToProcess.length;

      // Remove these messages from the queue
      const updatedQueue = queueForPriority.slice(actualMessagesCount);
      queue[priority] = updatedQueue;

      processedMessages.push(...messagesToProcess);
      remainingCount -= actualMessagesCount;

      if (remainingCount <= 0) {
        break;
      }
    }

    // Update the current size
    queue['currentSize'] = Math.max(
      0,
      ((queue['currentSize'] as number) || 0) - processedMessages.length,
    );

    // Store the updated queue
    await this.memory.set(queueKey, queue);

    return processedMessages;
  }

  /**
   * Record collaboration metrics for performance monitoring
   */
  private async recordCollaborationMetrics(
    workflowId: string | undefined,
    initiatingAgent: string,
    receivingAgent: string,
    messageType: string,
    duration: number,
    success: boolean,
    error?: string,
  ): Promise<void> {
    try {
      // Use metrics collector to record collaboration metrics
      const { AgentMetricsCollector } = await import('./metrics.js');
      const metricsCollector = new AgentMetricsCollector(this.config);

      await metricsCollector.recordCollaborationMetrics(
        workflowId,
        initiatingAgent,
        receivingAgent,
        messageType,
        duration,
        success,
        error,
      );
    } catch (error) {
      console.error('Failed to record collaboration metrics:', error);
    }
  }

  /**
   * Get the shared memory instance for direct access
   */
  getMemory(): AgentSharedMemory {
    return this.memory;
  }
}
