/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Smart Task Splitting — analyzes a feature description and
 * decides how to best split it into parallel or sequential tasks.
 *
 * Uses pattern matching and historical data to determine optimal task
 * decomposition strategies for efficient parallel execution.
 */

import type { Config } from '../config/config.js';
import type {
  ParallelGroupRuntime,
  ParallelGroupConfig,
  ParallelTaskConfig,
} from './parallel-task-runner.js';
import { ParallelTaskRunner } from './parallel-task-runner.js';
import { CrossModeCommunicationManager } from './mode-cross-communication.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SMART_SPLIT');

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A single task in a split analysis.
 */
export interface TaskSplit {
  /** Unique task identifier */
  taskId: string;

  /** Display name for the task */
  taskName: string;

  /** Task description */
  description: string;

  /** Mode to use for this task */
  mode: string;

  /** Sub-agent to execute the task */
  subagent: string;

  /** Prompt/instructions for the task */
  prompt: string;

  /** Icon for visual identification */
  icon: string;

  /** Color for UI display */
  color: string;

  /** Estimated time in minutes */
  estimatedTimeMinutes: number;

  /** Task IDs this task depends on */
  dependencies: string[];
}

/**
 * Result of a split analysis.
 */
export interface SplitAnalysis {
  /** Original feature description */
  featureDescription: string;

  /** Suggested task splits */
  suggestedSplit: TaskSplit[];

  /** Reasoning behind the split */
  reasoning: string;

  /** Whether tasks can run in parallel */
  parallelizable: boolean;

  /** Estimated total time in minutes */
  estimatedTotalTime: number;

  /** Alternative split strategies */
  alternativeSplits: Array<{
    name: string;
    tasks: TaskSplit[];
    estimatedTotalTime: number;
  }>;
}

/**
 * Historical record of a previous split for learning.
 */
interface SplitHistoryEntry {
  featureDescription: string;
  tasks: TaskSplit[];
  actualTimeMinutes: number;
  timestamp: Date;
}

// ─── Split Pattern Definitions ───────────────────────────────────────────────

/**
 * A pattern that maps keywords to a specific task split strategy.
 */
interface SplitPattern {
  name: string;
  keywords: string[];
  parallelizable: boolean;
  generateSplit: (featureDescription: string) => TaskSplit[];
  generateReasoning: (featureDescription: string) => string;
  generateAlternative?: (featureDescription: string) => {
    name: string;
    tasks: TaskSplit[];
    estimatedTotalTime: number;
  };
}

/**
 * Generate a unique task ID from a base name.
 */
function makeTaskId(base: string, index: number): string {
  return `${base}-${index}`;
}

/**
 * Calculate estimated total time considering dependencies.
 */
function calculateEstimatedTime(tasks: TaskSplit[]): number {
  // For parallel tasks, the total time is the max path through the dependency graph
  // For simplicity, group by dependency levels
  const completed = new Set<string>();
  let totalTime = 0;

  const remaining = [...tasks];
  while (remaining.length > 0) {
    // Find tasks whose dependencies are all completed
    const readyTasks: TaskSplit[] = [];
    const stillBlocked: TaskSplit[] = [];

    for (const task of remaining) {
      const allDepsMet = task.dependencies.every((dep) => completed.has(dep));
      if (allDepsMet) {
        readyTasks.push(task);
      } else {
        stillBlocked.push(task);
      }
    }

    if (readyTasks.length === 0 && stillBlocked.length > 0) {
      // Circular dependency or missing dep - just sum all remaining
      totalTime += stillBlocked.reduce((sum, t) => sum + t.estimatedTimeMinutes, 0);
      break;
    }

    // Parallel tasks in this level - take the max time
    const levelMax = Math.max(
      ...readyTasks.map((t) => t.estimatedTimeMinutes),
    );
    totalTime += levelMax;

    for (const task of readyTasks) {
      completed.add(task.taskId);
    }

    remaining.length = 0;
    remaining.push(...stillBlocked);
  }

  return totalTime;
}

const SPLIT_PATTERNS: SplitPattern[] = [
  {
    name: 'authentication',
    keywords: ['authentication', 'login', 'oauth', 'auth', 'sign-in', 'signin'],
    parallelizable: true,
    generateSplit: (desc: string): TaskSplit[] => [
      {
        taskId: 'auth-frontend',
        taskName: 'Auth Frontend',
        description: 'Implement authentication UI components',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the frontend authentication for: ${desc}

Tasks:
- Create login/signup form components
- Implement OAuth redirect handlers
- Add token/session storage (localStorage, cookies)
- Create protected route wrappers
- Implement logout functionality
- Add loading states and error handling
- Style authentication pages`,
        icon: '🎨',
        color: '#3498DB',
        estimatedTimeMinutes: 45,
        dependencies: [],
      },
      {
        taskId: 'auth-backend',
        taskName: 'Auth Backend',
        description: 'Implement authentication backend',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the backend authentication system for: ${desc}

Tasks:
- Create authentication routes (login, register, logout)
- Implement OAuth provider integrations
- Add JWT token generation and validation
- Create session management
- Implement password hashing and security
- Add rate limiting for auth endpoints
- Create auth middleware for protected routes`,
        icon: '🔒',
        color: '#E74C3C',
        estimatedTimeMinutes: 60,
        dependencies: [],
      },
    ],
    generateReasoning: () =>
      'Authentication naturally splits into frontend (UI, forms, token handling) and backend (token generation, OAuth, security) components that can be developed in parallel. Both sides agree on the API contract upfront.',
  },
  {
    name: 'realtime',
    keywords: ['real-time', 'realtime', 'websocket', 'chat', 'live', 'streaming'],
    parallelizable: true,
    generateSplit: (desc: string): TaskSplit[] => [
      {
        taskId: 'ws-server',
        taskName: 'WebSocket Server',
        description: 'Implement WebSocket server infrastructure',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the WebSocket server for real-time features: ${desc}

Tasks:
- Set up WebSocket server and connection management
- Implement message routing and event broadcasting
- Add connection authentication
- Create room/channel management
- Implement message persistence
- Add rate limiting and connection limits
- Handle reconnection logic server-side`,
        icon: '🔌',
        color: '#9B59B6',
        estimatedTimeMinutes: 60,
        dependencies: [],
      },
      {
        taskId: 'ws-client',
        taskName: 'WebSocket Client',
        description: 'Implement WebSocket client and real-time UI',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the frontend WebSocket client for: ${desc}

Tasks:
- Create WebSocket connection manager
- Implement real-time message display components
- Add connection status indicators
- Create event listeners and handlers
- Implement offline/reconnection handling
- Add optimistic UI updates
- Style real-time components`,
        icon: '💬',
        color: '#3498DB',
        estimatedTimeMinutes: 50,
        dependencies: [],
      },
      {
        taskId: 'db-persistence',
        taskName: 'Message Persistence',
        description: 'Implement database persistence for real-time data',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement database persistence for real-time messages: ${desc}

Tasks:
- Create message database models/schemas
- Implement message storage and retrieval APIs
- Add message history endpoints
- Create pagination for message history
- Implement message search functionality
- Add data cleanup/archival strategies`,
        icon: '💾',
        color: '#2ECC71',
        estimatedTimeMinutes: 45,
        dependencies: [],
      },
    ],
    generateReasoning: () =>
      'Real-time features split into three parallel concerns: the WebSocket server handling connections, the client UI displaying real-time updates, and the persistence layer storing message history. These can be developed simultaneously with a shared message format contract.',
    generateAlternative: (desc: string) => ({
      name: 'Simplified (Server + Client only)',
      tasks: [
        {
          taskId: 'realtime-server',
          taskName: 'Realtime Server',
          description: 'Full server-side real-time implementation',
          mode: 'developer',
          subagent: 'general-purpose',
          prompt: `Implement the full server-side real-time system: ${desc}

Tasks:
- WebSocket server with connection management
- Message routing and broadcasting
- Database persistence for messages
- Message history APIs with pagination
- Authentication for WebSocket connections`,
          icon: '⚙️',
          color: '#2ECC71',
          estimatedTimeMinutes: 90,
          dependencies: [],
        },
        {
          taskId: 'realtime-client',
          taskName: 'Realtime Client',
          description: 'Client-side real-time UI',
          mode: 'developer',
          subagent: 'general-purpose',
          prompt: `Implement the client-side real-time UI for: ${desc}

Tasks:
- WebSocket connection and reconnection
- Real-time message display
- Connection status indicators
- Message input and sending
- Message history loading`,
          icon: '🎨',
          color: '#3498DB',
          estimatedTimeMinutes: 50,
          dependencies: [],
        },
      ],
      estimatedTotalTime: 90,
    }),
  },
  {
    name: 'dashboard',
    keywords: ['dashboard', 'analytics', 'metrics', 'reporting', 'charts', 'graphs'],
    parallelizable: true,
    generateSplit: (desc: string): TaskSplit[] => [
      {
        taskId: 'data-api',
        taskName: 'Data API',
        description: 'Implement analytics data APIs',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the data API layer for analytics dashboard: ${desc}

Tasks:
- Create analytics endpoint routes
- Implement metric calculation logic
- Add data aggregation queries
- Create date-range filtering
- Implement caching for expensive queries
- Add API response formatting`,
        icon: '📊',
        color: '#E67E22',
        estimatedTimeMinutes: 50,
        dependencies: [],
      },
      {
        taskId: 'data-ui',
        taskName: 'Data UI',
        description: 'Implement analytics dashboard UI',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the analytics dashboard UI: ${desc}

Tasks:
- Create dashboard layout and grid
- Implement chart components (line, bar, pie)
- Add metric cards and KPI displays
- Create date range pickers and filters
- Implement data table with sorting
- Add export functionality (CSV, PDF)
- Style responsive dashboard`,
        icon: '📈',
        color: '#3498DB',
        estimatedTimeMinutes: 60,
        dependencies: [],
      },
      {
        taskId: 'data-aggregation',
        taskName: 'Data Aggregation',
        description: 'Implement data aggregation pipeline',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the data aggregation pipeline: ${desc}

Tasks:
- Create scheduled aggregation jobs
- Implement data normalization
- Add data validation and cleaning
- Create aggregation cache management
- Implement rollup strategies
- Add monitoring for pipeline health`,
        icon: '🔄',
        color: '#1ABC9C',
        estimatedTimeMinutes: 45,
        dependencies: [],
      },
    ],
    generateReasoning: () =>
      'Analytics dashboards split into three parallel workstreams: the API serving data, the UI visualizing it, and the aggregation pipeline preparing metrics. The API contract (metric names, date ranges, response shapes) allows parallel development.',
  },
  {
    name: 'search',
    keywords: ['search', 'filter', 'pagination', 'browse', 'find', 'query'],
    parallelizable: true,
    generateSplit: (desc: string): TaskSplit[] => [
      {
        taskId: 'search-backend',
        taskName: 'Search Backend',
        description: 'Implement search backend and query processing',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the search backend: ${desc}

Tasks:
- Create search API endpoints
- Implement query parsing and validation
- Add relevance ranking algorithms
- Create filter processing logic
- Implement pagination for results
- Add search result formatting`,
        icon: '🔍',
        color: '#2ECC71',
        estimatedTimeMinutes: 55,
        dependencies: [],
      },
      {
        taskId: 'search-ui',
        taskName: 'Search UI',
        description: 'Implement search UI components',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the search user interface: ${desc}

Tasks:
- Create search bar with autocomplete
- Implement results list/grid display
- Add filter panels and faceted search
- Create pagination controls
- Implement sort options
- Add loading states and empty states
- Style search results page`,
        icon: '🎯',
        color: '#3498DB',
        estimatedTimeMinutes: 50,
        dependencies: [],
      },
      {
        taskId: 'search-indexing',
        taskName: 'Search Indexing',
        description: 'Implement search indexing system',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the search indexing system: ${desc}

Tasks:
- Create document indexing pipeline
- Implement reindexing strategies
- Add index optimization
- Create incremental update handlers
- Implement full-text search setup
- Add index health monitoring`,
        icon: '📋',
        color: '#F39C12',
        estimatedTimeMinutes: 45,
        dependencies: [],
      },
    ],
    generateReasoning: () =>
      'Search features split into backend (query processing), frontend (search UI), and infrastructure (indexing). All three can be developed in parallel with a shared search result format and API contract.',
    generateAlternative: (desc: string) => ({
      name: 'Sequential (Index first, then API+UI)',
      tasks: [
        {
          taskId: 'index-first',
          taskName: 'Search Indexing',
          description: 'Set up indexing before other work',
          mode: 'developer',
          subagent: 'general-purpose',
          prompt: `Set up the search indexing foundation: ${desc}`,
          icon: '📋',
          color: '#F39C12',
          estimatedTimeMinutes: 45,
          dependencies: [],
        },
        {
          taskId: 'search-api',
          taskName: 'Search API',
          description: 'Build search API on top of index',
          mode: 'developer',
          subagent: 'general-purpose',
          prompt: `Build search API on top of the index: ${desc}`,
          icon: '🔍',
          color: '#2ECC71',
          estimatedTimeMinutes: 40,
          dependencies: ['index-first'],
        },
        {
          taskId: 'search-ui',
          taskName: 'Search UI',
          description: 'Build search UI',
          mode: 'developer',
          subagent: 'general-purpose',
          prompt: `Build the search UI: ${desc}`,
          icon: '🎯',
          color: '#3498DB',
          estimatedTimeMinutes: 50,
          dependencies: ['index-first'],
        },
      ],
      estimatedTotalTime: 95,
    }),
  },
  {
    name: 'fullstack-feature',
    keywords: ['feature', 'crud', 'create', 'manage', 'admin', 'module'],
    parallelizable: true,
    generateSplit: (desc: string): TaskSplit[] => [
      {
        taskId: 'frontend',
        taskName: 'Frontend Implementation',
        description: 'Implement frontend components and UI',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the FRONTEND for this feature: ${desc}

Focus on:
- UI components and layout
- User interactions and forms
- API integration (assume backend will provide endpoints)
- State management
- Styling and responsiveness
- Error handling and loading states

Document the expected API endpoints you'll need.`,
        icon: '🎨',
        color: '#3498DB',
        estimatedTimeMinutes: 60,
        dependencies: [],
      },
      {
        taskId: 'backend',
        taskName: 'Backend Implementation',
        description: 'Implement backend API and business logic',
        mode: 'developer',
        subagent: 'general-purpose',
        prompt: `Implement the BACKEND for this feature: ${desc}

Focus on:
- API endpoints and routes
- Business logic and validation
- Database models and migrations
- Authentication and authorization
- Input validation and error handling
- Unit tests

Document the API endpoints you're providing.`,
        icon: '⚙️',
        color: '#2ECC71',
        estimatedTimeMinutes: 70,
        dependencies: [],
      },
    ],
    generateReasoning: () =>
      'Standard full-stack features split cleanly into frontend (UI, state, API integration) and backend (endpoints, business logic, database). Both teams can work in parallel by agreeing on an API contract document upfront.',
    generateAlternative: (desc: string) => ({
      name: 'Database-first (Sequential)',
      tasks: [
        {
          taskId: 'database',
          taskName: 'Database Layer',
          description: 'Set up database models and migrations',
          mode: 'developer',
          subagent: 'general-purpose',
          prompt: `Set up the database layer for: ${desc}`,
          icon: '🗄️',
          color: '#F39C12',
          estimatedTimeMinutes: 30,
          dependencies: [],
        },
        {
          taskId: 'api',
          taskName: 'API Layer',
          description: 'Build API on top of database',
          mode: 'developer',
          subagent: 'general-purpose',
          prompt: `Build the API layer for: ${desc}`,
          icon: '🔌',
          color: '#2ECC71',
          estimatedTimeMinutes: 50,
          dependencies: ['database'],
        },
        {
          taskId: 'ui',
          taskName: 'UI Layer',
          description: 'Build UI on top of API',
          mode: 'developer',
          subagent: 'general-purpose',
          prompt: `Build the UI for: ${desc}`,
          icon: '🎨',
          color: '#3498DB',
          estimatedTimeMinutes: 60,
          dependencies: ['database'],
        },
      ],
      estimatedTotalTime: 110,
    }),
  },
];

// ─── Smart Task Splitter ─────────────────────────────────────────────────────

/**
 * Analyzes feature descriptions and suggests optimal task splits
 * for parallel or sequential execution.
 */
export class SmartTaskSplitter {
  private history: SplitHistoryEntry[] = [];
  private commManager: CrossModeCommunicationManager;

  constructor() {
    this.commManager = new CrossModeCommunicationManager();
  }

  /**
   * Get the communication manager for cross-task communication.
   */
  getCommunicationManager(): CrossModeCommunicationManager {
    return this.commManager;
  }

  /**
   * Analyze a feature description and suggest optimal task split.
   *
   * @param featureDescription - Description of the feature to implement
   * @returns SplitAnalysis with suggested tasks and reasoning
   */
  analyze(featureDescription: string): SplitAnalysis {
    const lowerDesc = featureDescription.toLowerCase();

    // Find the best matching pattern
    let bestPattern: SplitPattern | null = null;
    let bestMatchScore = 0;

    for (const pattern of SPLIT_PATTERNS) {
      let score = 0;
      for (const keyword of pattern.keywords) {
        if (lowerDesc.includes(keyword)) {
          score++;
        }
      }
      if (score > bestMatchScore) {
        bestMatchScore = score;
        bestPattern = pattern;
      }
    }

    // Fall back to generic fullstack split if no pattern matches
    if (!bestPattern) {
      bestPattern = SPLIT_PATTERNS.find(
        (p) => p.name === 'fullstack-feature',
      )!;
    }

    const tasks = bestPattern.generateSplit(featureDescription);
    const reasoning = bestPattern.generateReasoning(featureDescription);
    const parallelizable = bestPattern.parallelizable;
    const estimatedTotalTime = calculateEstimatedTime(tasks);

    // Generate alternative splits if available
    const alternativeSplits: Array<{
      name: string;
      tasks: TaskSplit[];
      estimatedTotalTime: number;
    }> = [];

    if (bestPattern.generateAlternative) {
      alternativeSplits.push(bestPattern.generateAlternative(featureDescription));
    }

    // Always offer the generic fullstack alternative if we matched something else
    if (bestPattern.name !== 'fullstack-feature') {
      const fullstackPattern = SPLIT_PATTERNS.find(
        (p) => p.name === 'fullstack-feature',
      )!;
      const fullstackTasks = fullstackPattern.generateSplit(featureDescription);
      alternativeSplits.push({
        name: 'Generic Frontend + Backend',
        tasks: fullstackTasks,
        estimatedTotalTime: calculateEstimatedTime(fullstackTasks),
      });
    }

    // Check history for similar features to refine estimates
    const refinedTasks = this.refineEstimatesFromHistory(tasks);

    const analysis: SplitAnalysis = {
      featureDescription,
      suggestedSplit: refinedTasks,
      reasoning,
      parallelizable,
      estimatedTotalTime: calculateEstimatedTime(refinedTasks),
      alternativeSplits,
    };

    debugLogger.debug(
      `Split analysis complete for: ${featureDescription.substring(0, 50)}...`,
    );

    return analysis;
  }

  /**
   * Get split tasks ready for parallel execution.
   *
   * @param split - SplitAnalysis from analyze()
   * @param runner - ParallelTaskRunner instance
   * @param config - Config instance
   * @returns The running group
   */
  async executeSplit(
    split: SplitAnalysis,
    runner: ParallelTaskRunner,
    config: Config,
  ): Promise<ParallelGroupRuntime> {
    const tasks = split.suggestedSplit;

    // Build parallel group config
    const groupConfig: ParallelGroupConfig = {
      groupId: `split-${Date.now()}`,
      description: `Feature split: ${split.featureDescription}`,
      waitForAll: true,
      tasks: tasks.map(
        (task): ParallelTaskConfig => ({
          taskId: task.taskId,
          taskName: task.taskName,
          icon: task.icon,
          color: task.color,
          mode: task.mode,
          subagent: task.subagent,
          prompt: task.prompt,
        }),
      ),
    };

    debugLogger.debug(
      `Executing split with ${tasks.length} tasks: ${groupConfig.groupId}`,
    );

    return runner.startGroup(groupConfig);
  }

  /**
   * Learn from a completed split to improve future suggestions.
   *
   * @param featureDescription - Original feature description
   * @param actualTasks - Tasks as they were actually split
   * @param actualTime - Total actual time in minutes
   */
  recordSplitResult(
    featureDescription: string,
    actualTasks: TaskSplit[],
    actualTime: number,
  ): void {
    const entry: SplitHistoryEntry = {
      featureDescription,
      tasks: actualTasks,
      actualTimeMinutes: actualTime,
      timestamp: new Date(),
    };

    this.history.push(entry);
    debugLogger.debug(
      `Recorded split result: ${featureDescription.substring(0, 50)}... (${actualTime} min)`,
    );
  }

  /**
   * Get split history for analysis.
   *
   * @returns Array of historical split entries
   */
  getHistory(): SplitHistoryEntry[] {
    return [...this.history];
  }

  /**
   * Get all available split patterns.
   *
   * @returns Array of pattern names
   */
  static getPatternNames(): string[] {
    return SPLIT_PATTERNS.map((p) => p.name);
  }

  /**
   * Get a split pattern by name.
   *
   * @param name - Pattern name
   * @returns Pattern or undefined
   */
  static getPattern(name: string): SplitPattern | undefined {
    return SPLIT_PATTERNS.find((p) => p.name === name);
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  /**
   * Refine time estimates based on historical data.
   */
  private refineEstimatesFromHistory(tasks: TaskSplit[]): TaskSplit[] {
    if (this.history.length === 0) {
      return tasks;
    }

    // Calculate average adjustment factor from history
    let totalRatio = 0;
    let count = 0;

    for (const entry of this.history) {
      const estimatedTotal = entry.tasks.reduce(
        (sum, t) => sum + t.estimatedTimeMinutes,
        0,
      );
      if (estimatedTotal > 0) {
        totalRatio += entry.actualTimeMinutes / estimatedTotal;
        count++;
      }
    }

    if (count === 0) {
      return tasks;
    }

    const adjustmentFactor = totalRatio / count;

    // Apply adjustment with bounds (don't adjust more than 50%)
    const boundedFactor = Math.max(0.5, Math.min(1.5, adjustmentFactor));

    return tasks.map((task) => ({
      ...task,
      estimatedTimeMinutes: Math.round(
        task.estimatedTimeMinutes * boundedFactor,
      ),
    }));
  }
}
