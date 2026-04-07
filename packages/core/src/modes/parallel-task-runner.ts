/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Parallel Task Runner — execute multiple sub-agents with
 * different modes concurrently for independent tasks (e.g., frontend + backend).
 *
 * This enables splitting a feature into parallel work streams that execute
 * simultaneously and merge their results upon completion.
 */

import { EventEmitter } from 'node:events';
import type { Config } from '../config/config.js';
import type { SubagentConfig } from '../subagents/types.js';
import type { ModeConfig } from './types.js';
import { ModeError, ModeErrorCode } from './types.js';
import { AgentHeadless } from '../agents/runtime/agent-headless.js';
import type {
  AgentEventEmitter,
  AgentFinishEvent,
  AgentErrorEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentStreamTextEvent,
} from '../agents/runtime/agent-events.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('PARALLEL_RUNNER');

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Status of a single parallel task.
 */
export type ParallelTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Configuration for a single parallel task.
 */
export interface ParallelTaskConfig {
  /** Unique task identifier */
  taskId: string;

  /** Display name for the task */
  taskName: string;

  /** Icon for visual identification */
  icon?: string;

  /** Color for UI display */
  color?: string;

  /** Mode to apply to this task */
  mode?: string;

  /** Sub-agent to execute the task */
  subagent: string;

  /** Task prompt/instructions */
  prompt: string;

  /** Working directory for this task */
  cwd?: string;

  /** Maximum time in minutes (overrides mode default) */
  maxTimeMinutes?: number;

  /** Maximum turns (overrides mode default) */
  maxTurns?: number;
}

/**
 * Configuration for a parallel task group.
 */
export interface ParallelGroupConfig {
  /** Group identifier */
  groupId: string;

  /** Group description */
  description: string;

  /** Individual task configurations */
  tasks: ParallelTaskConfig[];

  /** Whether to wait for all tasks or return on first completion */
  waitForAll?: boolean;

  /** Master prompt that splits into subtasks (alternative to explicit tasks) */
  masterPrompt?: string;
}

/**
 * Runtime state of a parallel task.
 */
export interface ParallelTaskRuntime {
  config: ParallelTaskConfig;
  status: ParallelTaskStatus;
  agent?: AgentHeadless;
  eventEmitter?: AgentEventEmitter;
  startTime?: Date;
  endTime?: Date;
  result?: string;
  error?: string;
  toolCallCount: number;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Runtime state of a parallel group.
 */
export interface ParallelGroupRuntime {
  config: ParallelGroupConfig;
  tasks: ParallelTaskRuntime[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startTime?: Date;
  endTime?: Date;
}

/**
 * Event types emitted by the parallel task runner.
 */
export type ParallelRunnerEvents = {
  'group:start': [group: ParallelGroupRuntime];
  'group:complete': [group: ParallelGroupRuntime];
  'group:fail': [group: ParallelGroupRuntime, error: Error];
  'task:start': [group: ParallelGroupRuntime, task: ParallelTaskRuntime];
  'task:complete': [group: ParallelGroupRuntime, task: ParallelTaskRuntime];
  'task:fail': [group: ParallelGroupRuntime, task: ParallelTaskRuntime];
  'task:stream': [
    group: ParallelGroupRuntime,
    task: ParallelTaskRuntime,
    text: string,
  ];
  'task:tool-call': [
    group: ParallelGroupRuntime,
    task: ParallelTaskRuntime,
    toolName: string,
  ];
};

// ─── Parallel Task Runner ────────────────────────────────────────────────────

/**
 * Executes multiple tasks in parallel with isolated modes and sub-agents.
 */
export class ParallelTaskRunner extends EventEmitter {
  private activeGroups: Map<string, ParallelGroupRuntime> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();

  constructor(private readonly config: Config) {
    super();
  }

  // ─── Group Management ──────────────────────────────────────────────────────

  /**
   * Start a parallel task group.
   *
   * @param groupConfig - Group configuration
   * @returns The running group runtime
   */
  async startGroup(
    groupConfig: ParallelGroupConfig,
  ): Promise<ParallelGroupRuntime> {
    const groupId = groupConfig.groupId;

    // Create runtime state
    const groupRuntime: ParallelGroupRuntime = {
      config: groupConfig,
      tasks: groupConfig.tasks.map((task) => ({
        config: task,
        status: 'pending' as const,
        toolCallCount: 0,
      })),
      status: 'pending',
    };

    this.activeGroups.set(groupId, groupRuntime);

    const abortController = new AbortController();
    this.abortControllers.set(groupId, abortController);

    groupRuntime.status = 'running';
    groupRuntime.startTime = new Date();

    this.emit('group:start', groupRuntime);
    debugLogger.debug(`Starting parallel group: ${groupId}`);

    // Launch all tasks in parallel
    const taskPromises = groupRuntime.tasks.map((taskRuntime) =>
      this.executeTask(groupRuntime, taskRuntime, abortController.signal),
    );

    try {
      // Wait for all tasks (or first completion if waitForAll is false)
      if (groupConfig.waitForAll !== false) {
        await Promise.allSettled(taskPromises);
      } else {
        await Promise.race(taskPromises);
        // Cancel remaining tasks
        abortController.abort();
      }

      // Check if any task failed
      const hasFailures = groupRuntime.tasks.some(
        (t) => t.status === 'failed',
      );

      if (hasFailures) {
        groupRuntime.status = 'failed';
        groupRuntime.endTime = new Date();
        this.emit('group:fail', groupRuntime, new Error('One or more tasks failed'));
      } else {
        groupRuntime.status = 'completed';
        groupRuntime.endTime = new Date();
        this.emit('group:complete', groupRuntime);
      }
    } catch (error) {
      groupRuntime.status = 'failed';
      groupRuntime.endTime = new Date();
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('group:fail', groupRuntime, err);
      throw err;
    }

    return groupRuntime;
  }

  /**
   * Cancel a running group and all its tasks.
   *
   * @param groupId - Group identifier
   */
  cancelGroup(groupId: string): void {
    const group = this.activeGroups.get(groupId);
    if (!group) {
      throw new ModeError(
        `Group "${groupId}" not found`,
        ModeErrorCode.NOT_FOUND,
      );
    }

    const controller = this.abortControllers.get(groupId);
    if (controller) {
      controller.abort();
    }

    group.status = 'cancelled';
    group.endTime = new Date();

    for (const task of group.tasks) {
      if (task.status === 'running') {
        task.status = 'cancelled';
        task.endTime = new Date();
      }
    }

    this.activeGroups.delete(groupId);
    this.abortControllers.delete(groupId);

    debugLogger.debug(`Cancelled parallel group: ${groupId}`);
  }

  /**
   * Get all active groups.
   *
   * @returns Map of group ID to runtime
   */
  getActiveGroups(): Map<string, ParallelGroupRuntime> {
    return this.activeGroups;
  }

  /**
   * Get a group by ID.
   *
   * @param groupId - Group identifier
   * @returns Group runtime or undefined
   */
  getGroup(groupId: string): ParallelGroupRuntime | undefined {
    return this.activeGroups.get(groupId);
  }

  // ─── Task Execution ────────────────────────────────────────────────────────

  /**
   * Execute a single parallel task.
   *
   * @param group - Parent group runtime
   * @param taskRuntime - Task runtime state
   * @param signal - Abort signal
   */
  private async executeTask(
    group: ParallelGroupRuntime,
    taskRuntime: ParallelTaskRuntime,
    signal: AbortSignal,
  ): Promise<void> {
    const { config: taskConfig } = taskRuntime;

    try {
      // Check for abort before starting
      if (signal.aborted) {
        taskRuntime.status = 'cancelled';
        return;
      }

      taskRuntime.status = 'running';
      taskRuntime.startTime = new Date();
      this.emit('task:start', group, taskRuntime);
      debugLogger.debug(`Starting task: ${taskConfig.taskId}`);

      // Get mode configuration if specified
      let modeConfig: ModeConfig | undefined;
      if (taskConfig.mode) {
        modeConfig = this.config.getModeManager().getMode(taskConfig.mode);
        if (!modeConfig) {
          throw new ModeError(
            `Mode "${taskConfig.mode}" not found for task "${taskConfig.taskId}"`,
            ModeErrorCode.NOT_FOUND,
            taskConfig.mode,
          );
        }
      }

      // Get sub-agent configuration
      const subagentConfig = this.config
        .getSubagentManager()
        .listSubagents()
        .find((s) => s.name === taskConfig.subagent);

      if (!subagentConfig) {
        throw new ModeError(
          `Sub-agent "${taskConfig.subagent}" not found for task "${taskConfig.taskId}"`,
          ModeErrorCode.SUBAGENT_NOT_FOUND,
        );
      }

      // Build the system prompt: mode prompt + task prompt
      let systemPrompt = subagentConfig.systemPrompt;
      if (modeConfig?.systemPrompt) {
        systemPrompt = `${modeConfig.systemPrompt}\n\n---\n\nTask-specific instructions: ${taskConfig.prompt}`;
      } else {
        systemPrompt = `${systemPrompt}\n\n---\n\nTask instructions: ${taskConfig.prompt}`;
      }

      // Build tool list from mode constraints
      const toolNames = modeConfig?.allowedTools
        ? modeConfig.allowedTools
        : modeConfig?.deniedTools
          ? this.config
              .getToolRegistry()
              .getAllToolNames()
              .filter((t) => !modeConfig!.deniedTools!.includes(t))
          : undefined;

      // Create agent headless instance
      const agentConfig = {
        name: taskConfig.taskId,
        description: taskConfig.taskName,
        systemPrompt,
        tools: toolNames,
        model: modeConfig?.modelConfig?.model ?? subagentConfig.model,
        runConfig: {
          max_time_minutes:
            taskConfig.maxTimeMinutes ??
            modeConfig?.runConfig?.max_time_minutes ??
            30,
          max_turns:
            taskConfig.maxTurns ??
            modeConfig?.runConfig?.max_turns ??
            50,
        },
        level: 'session' as const,
      };

      const agent = await this.config
        .getSubagentManager()
        .createAgentHeadless(agentConfig, this.config);

      taskRuntime.agent = agent;

      // Set up event listeners on the agent
      const eventEmitter = agent.eventEmitter;
      taskRuntime.eventEmitter = eventEmitter;

      eventEmitter.on('TOOL_CALL', (event: AgentToolCallEvent) => {
        taskRuntime.toolCallCount++;
        this.emit('task:tool-call', group, taskRuntime, event.toolName);
      });

      eventEmitter.on('STREAM_TEXT', (event: AgentStreamTextEvent) => {
        this.emit('task:stream', group, taskRuntime, event.text);
      });

      eventEmitter.on('FINISH', (event: AgentFinishEvent) => {
        taskRuntime.tokenUsage = {
          promptTokens: event.usageMetadata?.promptTokenCount ?? 0,
          completionTokens: event.usageMetadata?.candidatesTokenCount ?? 0,
          totalTokens: event.usageMetadata?.totalTokenCount ?? 0,
        };
      });

      // Execute the task (with abort signal support)
      const context = new (await import('../agents/runtime/agent-headless.js'))
        .ContextState();
      context.set('task_prompt', taskConfig.prompt);

      await agent.execute(context, signal);

      taskRuntime.status = 'completed';
      taskRuntime.endTime = new Date();
      taskRuntime.result = context.get('task_prompt') ?? '';

      this.emit('task:complete', group, taskRuntime);
      debugLogger.debug(`Task completed: ${taskConfig.taskId}`);
    } catch (error) {
      if (signal.aborted) {
        taskRuntime.status = 'cancelled';
        taskRuntime.endTime = new Date();
        debugLogger.debug(`Task cancelled: ${taskConfig.taskId}`);
        return;
      }

      taskRuntime.status = 'failed';
      taskRuntime.endTime = new Date();
      taskRuntime.error =
        error instanceof Error ? error.message : String(error);

      this.emit('task:fail', group, taskRuntime);
      debugLogger.warn(`Task failed: ${taskConfig.taskId}`, error);
    }
  }

  // ─── Convenience Methods ───────────────────────────────────────────────────

  /**
   * Quick helper to split a feature into frontend/backend tasks.
   *
   * @param featureDescription - Description of the feature to implement
   * @returns The running group
   */
  async splitFeatureImplementation(
    featureDescription: string,
    options?: {
      frontendMode?: string;
      backendMode?: string;
      frontendSubagent?: string;
      backendSubagent?: string;
    },
  ): Promise<ParallelGroupRuntime> {
    const group: ParallelGroupConfig = {
      groupId: `feature-${Date.now()}`,
      description: `Feature implementation: ${featureDescription}`,
      waitForAll: true,
      tasks: [
        {
          taskId: 'frontend',
          taskName: 'Frontend Implementation',
          icon: '🎨',
          color: '#3498DB',
          mode: options?.frontendMode ?? 'developer',
          subagent: options?.frontendSubagent ?? 'general-purpose',
          prompt: `Implement the FRONTEND for this feature: ${featureDescription}

Focus on:
- UI components and layout
- User interactions
- API integration (assume backend will provide endpoints)
- State management
- Styling and responsiveness

Create all necessary frontend files in the appropriate directories.
Document the expected API endpoints you'll need.`,
        },
        {
          taskId: 'backend',
          taskName: 'Backend Implementation',
          icon: '⚙️',
          color: '#2ECC71',
          mode: options?.backendMode ?? 'developer',
          subagent: options?.backendSubagent ?? 'general-purpose',
          prompt: `Implement the BACKEND for this feature: ${featureDescription}

Focus on:
- API endpoints and routes
- Business logic
- Database models and migrations (if needed)
- Authentication and authorization
- Input validation and error handling
- Unit tests

Create all necessary backend files in the appropriate directories.
Document the API endpoints you're providing.`,
        },
      ],
    };

    return this.startGroup(group);
  }

  /**
   * Generate a summary of a completed group's results.
   *
   * @param group - Completed group runtime
   * @returns Formatted summary string
   */
  static generateSummary(group: ParallelGroupRuntime): string {
    const lines = [
      `**Parallel Task Complete:** ${group.config.description}`,
      '',
      `**Status:** ${group.status === 'completed' ? '✅ All tasks completed' : group.status === 'failed' ? '❌ One or more tasks failed' : '⏹️ Cancelled'}`,
      '',
    ];

    if (group.startTime && group.endTime) {
      const duration =
        (group.endTime.getTime() - group.startTime.getTime()) / 60000;
      lines.push(`**Duration:** ${duration.toFixed(1)} minutes`);
      lines.push('');
    }

    lines.push('**Tasks:**');
    lines.push('');

    for (const task of group.tasks) {
      const icon =
        task.status === 'completed'
          ? '✅'
          : task.status === 'failed'
            ? '❌'
            : '⏹️';
      const taskIcon = task.config.icon ?? '📋';

      lines.push(
        `${icon} ${taskIcon} **${task.config.taskName}** (${task.status})`,
      );

      if (task.startTime && task.endTime) {
        const duration =
          (task.endTime.getTime() - task.startTime.getTime()) / 60000;
        lines.push(`   Duration: ${duration.toFixed(1)} min`);
      }

      if (task.toolCallCount > 0) {
        lines.push(`   Tool calls: ${task.toolCallCount}`);
      }

      if (task.tokenUsage) {
        lines.push(`   Tokens: ${task.tokenUsage.totalTokens.toLocaleString()}`);
      }

      if (task.error) {
        lines.push(`   Error: ${task.error}`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }
}
