/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Cross-Mode Communication — enables parallel tasks to exchange
 * artifacts, messages, and dependency information.
 *
 * This facilitates collaboration between parallel work streams such as
 * frontend and backend tasks, allowing them to share API specs, contracts,
 * data models, and coordinate implementation details.
 */

import { EventEmitter } from 'node:events';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('CROSS_MODE_COMM');

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A message exchanged between parallel tasks.
 */
export interface CrossModeMessage {
  /** Unique message identifier */
  id: string;

  /** Source task ID */
  fromTask: string;

  /** Target task ID (or '*' for broadcast) */
  toTask: string;

  /** Message type */
  type: 'artifact' | 'message' | 'dependency' | 'question' | 'answer';

  /** Message content */
  content: string;

  /** Timestamp when the message was sent */
  timestamp: Date;

  /** Optional metadata for extensions */
  metadata?: Record<string, unknown>;
}

/**
 * A shareable artifact such as an API spec, interface, or data model.
 */
export interface Artifact {
  /** Artifact name */
  name: string;

  /** Artifact type */
  type: 'api-spec' | 'interface' | 'contract' | 'data-model' | 'config';

  /** Artifact content */
  content: string;

  /** Task ID that produced this artifact */
  producer: string;

  /** Task IDs that are intended to consume this artifact */
  consumers: string[];
}

/**
 * Event types emitted by the communication manager.
 */
export type CrossModeCommEvents = {
  'message:sent': [message: CrossModeMessage];
  'message:received': [taskId: string, message: CrossModeMessage];
  'artifact:registered': [artifact: Artifact];
  'dependencies:detected': [deps: Array<{ from: string; to: string; reason: string }>];
};

// ─── Split Pattern Definitions ───────────────────────────────────────────────

/**
 * Pattern keywords mapped to task splits for auto-detection.
 */
interface SplitPattern {
  keywords: string[];
  tasks: Array<{
    taskId: string;
    taskName: string;
    prompt: string;
    icon: string;
    color: string;
  }>;
}

const SPLIT_PATTERNS: SplitPattern[] = [
  {
    keywords: ['authentication', 'login', 'oauth', 'auth'],
    tasks: [
      {
        taskId: 'auth-frontend',
        taskName: 'Auth Frontend',
        icon: '🎨',
        color: '#3498DB',
        prompt: 'Implement the frontend authentication UI including login forms, OAuth redirect handlers, token storage, and session management.',
      },
      {
        taskId: 'auth-backend',
        taskName: 'Auth Backend',
        icon: '🔒',
        color: '#E74C3C',
        prompt: 'Implement the backend authentication system including OAuth providers, JWT token generation, session management, and security middleware.',
      },
    ],
  },
  {
    keywords: ['real-time', 'websocket', 'chat', 'live'],
    tasks: [
      {
        taskId: 'ws-server',
        taskName: 'WebSocket Server',
        icon: '🔌',
        color: '#9B59B6',
        prompt: 'Implement the WebSocket server for real-time communication including connection management, message routing, and event broadcasting.',
      },
      {
        taskId: 'ws-client',
        taskName: 'WebSocket Client',
        icon: '💬',
        color: '#3498DB',
        prompt: 'Implement the frontend WebSocket client including connection handling, real-time UI updates, and message display components.',
      },
      {
        taskId: 'db-persistence',
        taskName: 'Message Persistence',
        icon: '💾',
        color: '#2ECC71',
        prompt: 'Implement database persistence for real-time messages including storage, retrieval, and history APIs.',
      },
    ],
  },
  {
    keywords: ['dashboard', 'analytics', 'metrics', 'reporting'],
    tasks: [
      {
        taskId: 'data-api',
        taskName: 'Data API',
        icon: '📊',
        color: '#E67E22',
        prompt: 'Implement the data API for analytics including aggregation endpoints, metric calculations, and query optimization.',
      },
      {
        taskId: 'data-ui',
        taskName: 'Data UI',
        icon: '📈',
        color: '#3498DB',
        prompt: 'Implement the analytics dashboard UI including charts, tables, filters, and real-time metric displays.',
      },
      {
        taskId: 'data-aggregation',
        taskName: 'Data Aggregation',
        icon: '🔄',
        color: '#1ABC9C',
        prompt: 'Implement the data aggregation pipeline including scheduled jobs, data normalization, and caching strategies.',
      },
    ],
  },
  {
    keywords: ['search', 'filter', 'pagination', 'browse'],
    tasks: [
      {
        taskId: 'search-backend',
        taskName: 'Search Backend',
        icon: '🔍',
        color: '#2ECC71',
        prompt: 'Implement the search backend including indexing, query parsing, relevance ranking, and filter processing.',
      },
      {
        taskId: 'search-ui',
        taskName: 'Search UI',
        icon: '🎯',
        color: '#3498DB',
        prompt: 'Implement the search UI including search bar, results display, filter panels, and pagination controls.',
      },
      {
        taskId: 'search-indexing',
        taskName: 'Search Indexing',
        icon: '📋',
        color: '#F39C12',
        prompt: 'Implement the search indexing system including document indexing, reindexing strategies, and index optimization.',
      },
    ],
  },
];

// ─── Cross-Mode Communication Manager ────────────────────────────────────────

/**
 * Manages communication between parallel tasks, enabling artifact exchange
 * and message passing.
 */
export class CrossModeCommunicationManager extends EventEmitter {
  private messages: CrossModeMessage[] = [];
  private artifacts: Map<string, Artifact> = new Map();
  private messageQueue: CrossModeMessage[] = [];
  private messageIdCounter = 0;

  constructor() {
    super();
  }

  // ─── Message Operations ────────────────────────────────────────────────────

  /**
   * Send a message from one task to another.
   *
   * @param fromTask - Source task ID
   * @param toTask - Target task ID
   * @param type - Message type
   * @param content - Message content
   * @param metadata - Optional metadata
   */
  sendMessage(
    fromTask: string,
    toTask: string,
    type: CrossModeMessage['type'],
    content: string,
    metadata?: Record<string, unknown>,
  ): void {
    const message: CrossModeMessage = {
      id: this.generateMessageId(),
      fromTask,
      toTask,
      type,
      content,
      timestamp: new Date(),
      metadata,
    };

    this.messages.push(message);
    this.messageQueue.push(message);

    this.emit('message:sent', message);
    debugLogger.debug(
      `Message sent: ${fromTask} -> ${toTask} [${type}]`,
    );
  }

  /**
   * Broadcast a message to all tasks.
   *
   * @param fromTask - Source task ID
   * @param type - Message type
   * @param content - Message content
   * @param metadata - Optional metadata
   */
  broadcast(
    fromTask: string,
    type: CrossModeMessage['type'],
    content: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.sendMessage(fromTask, '*', type, content, metadata);
  }

  /**
   * Get messages for a specific task (both direct and broadcast).
   *
   * @param taskId - Target task ID
   * @returns Array of messages addressed to this task
   */
  getMessagesForTask(taskId: string): CrossModeMessage[] {
    return this.messages.filter(
      (msg) => msg.toTask === taskId || msg.toTask === '*',
    );
  }

  /**
   * Get and clear the message queue for a task.
   * Returns messages and removes them from the queue.
   *
   * @param taskId - Target task ID
   * @returns Array of queued messages for this task
   */
  consumeMessagesForTask(taskId: string): CrossModeMessage[] {
    const taskMessages: CrossModeMessage[] = [];
    const remaining: CrossModeMessage[] = [];

    for (const msg of this.messageQueue) {
      if (msg.toTask === taskId || msg.toTask === '*') {
        taskMessages.push(msg);
      } else {
        remaining.push(msg);
      }
    }

    this.messageQueue = remaining;
    return taskMessages;
  }

  // ─── Artifact Operations ───────────────────────────────────────────────────

  /**
   * Register an artifact produced by a task.
   *
   * @param artifact - The artifact to register
   */
  registerArtifact(artifact: Artifact): void {
    const key = `${artifact.producer}:${artifact.name}`;
    this.artifacts.set(key, artifact);

    this.emit('artifact:registered', artifact);
    debugLogger.debug(
      `Artifact registered: ${artifact.name} by ${artifact.producer}`,
    );
  }

  /**
   * Get artifacts relevant for a specific task (as producer or consumer).
   *
   * @param taskId - Task ID to filter by
   * @returns Array of artifacts relevant for this task
   */
  getArtifactsForTask(taskId: string): Artifact[] {
    return Array.from(this.artifacts.values()).filter(
      (artifact) =>
        artifact.producer === taskId || artifact.consumers.includes(taskId),
    );
  }

  /**
   * Get all registered artifacts.
   *
   * @returns Array of all artifacts
   */
  getAllArtifacts(): Artifact[] {
    return Array.from(this.artifacts.values());
  }

  /**
   * Get artifacts by type.
   *
   * @param type - Artifact type to filter by
   * @returns Array of matching artifacts
   */
  getArtifactsByType(type: Artifact['type']): Artifact[] {
    return Array.from(this.artifacts.values()).filter(
      (artifact) => artifact.type === type,
    );
  }

  /**
   * Get an artifact by name and producer.
   *
   * @param name - Artifact name
   * @param producer - Producer task ID
   * @returns The artifact or undefined
   */
  getArtifact(name: string, producer: string): Artifact | undefined {
    return this.artifacts.get(`${producer}:${name}`);
  }

  // ─── Dependency Detection ──────────────────────────────────────────────────

  /**
   * Auto-detect and suggest dependencies between tasks based on their prompts.
   *
   * @param tasks - Array of tasks with ID and prompt
   * @returns Array of suggested dependencies
   */
  detectDependencies(
    tasks: { id: string; prompt: string }[],
  ): Array<{ from: string; to: string; reason: string }> {
    const dependencies: Array<{ from: string; to: string; reason: string }> =
      [];

    // Common dependency patterns
    const dependencyPatterns = [
      {
        fromKeywords: ['api', 'endpoint', 'route', 'server', 'backend'],
        toKeywords: ['api integration', 'fetch', 'http', 'consume', 'client'],
        reason: 'Backend provides APIs that frontend consumes',
      },
      {
        fromKeywords: ['database', 'model', 'schema', 'migration'],
        toKeywords: ['data', 'fetch', 'query', 'api'],
        reason: 'Database layer provides data for API layer',
      },
      {
        fromKeywords: ['auth', 'token', 'session', 'login'],
        toKeywords: ['protected', 'authenticated', 'auth', 'login'],
        reason: 'Authentication must be ready before protected features',
      },
      {
        fromKeywords: ['index', 'search', 'elasticsearch'],
        toKeywords: ['search ui', 'search results', 'search bar'],
        reason: 'Search indexing must be ready before search UI',
      },
    ];

    for (const pattern of dependencyPatterns) {
      for (const fromTask of tasks) {
        const fromMatches = pattern.fromKeywords.some((kw) =>
          fromTask.prompt.toLowerCase().includes(kw),
        );

        if (!fromMatches) continue;

        for (const toTask of tasks) {
          if (fromTask.id === toTask.id) continue;

          const toMatches = pattern.toKeywords.some((kw) =>
            toTask.prompt.toLowerCase().includes(kw),
          );

          if (toMatches) {
            // Avoid duplicate dependencies
            const exists = dependencies.some(
              (d) => d.from === fromTask.id && d.to === toTask.id,
            );
            if (!exists) {
              dependencies.push({
                from: fromTask.id,
                to: toTask.id,
                reason: pattern.reason,
              });
            }
          }
        }
      }
    }

    if (dependencies.length > 0) {
      this.emit('dependencies:detected', dependencies);
    }

    return dependencies;
  }

  /**
   * Detect split pattern based on feature description keywords.
   *
   * @param featureDescription - Description of the feature
   * @returns Matching split pattern or null
   */
  detectSplitPattern(
    featureDescription: string,
  ): SplitPattern['tasks'] | null {
    const lowerDesc = featureDescription.toLowerCase();

    for (const pattern of SPLIT_PATTERNS) {
      const hasMatch = pattern.keywords.some((kw) => lowerDesc.includes(kw));
      if (hasMatch) {
        return pattern.tasks;
      }
    }

    return null;
  }

  // ─── Utility Operations ────────────────────────────────────────────────────

  /**
   * Clear all messages.
   */
  clear(): void {
    this.messages = [];
    this.messageQueue = [];
    debugLogger.debug('Communication manager cleared');
  }

  /**
   * Clear artifacts.
   */
  clearArtifacts(): void {
    this.artifacts.clear();
    debugLogger.debug('Artifacts cleared');
  }

  /**
   * Get statistics about communication.
   *
   * @returns Communication statistics
   */
  getStats(): {
    totalMessages: number;
    queuedMessages: number;
    totalArtifacts: number;
    messagesByType: Record<string, number>;
  } {
    const messagesByType: Record<string, number> = {};
    for (const msg of this.messages) {
      messagesByType[msg.type] = (messagesByType[msg.type] || 0) + 1;
    }

    return {
      totalMessages: this.messages.length,
      queuedMessages: this.messageQueue.length,
      totalArtifacts: this.artifacts.size,
      messagesByType,
    };
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  private generateMessageId(): string {
    this.messageIdCounter++;
    return `msg-${Date.now()}-${this.messageIdCounter}`;
  }
}
