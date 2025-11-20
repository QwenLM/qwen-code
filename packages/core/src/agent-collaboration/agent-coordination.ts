/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { DynamicAgentManager } from '../subagents/dynamic-agent-manager.js';
import { AgentSharedMemory } from './shared-memory.js';

export interface AgentTask {
  id: string;
  name: string;
  description: string;
  assignee?: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  priority: 'low' | 'medium' | 'high';
  created: string;
  completed?: string;
  result?: unknown;
  dependencies?: string[]; // Task IDs this task depends on
}

export interface AgentCoordinationOptions {
  timeoutMinutes?: number;
  maxRetries?: number;
}

/**
 * Agent coordination system for managing task distribution and collaboration
 */
export class AgentCoordinationSystem {
  private readonly agents: DynamicAgentManager;
  private readonly memory: AgentSharedMemory;
  private tasks: Map<string, AgentTask> = new Map();
  private config: Config;
  private readonly options: AgentCoordinationOptions;

  constructor(config: Config, options: AgentCoordinationOptions = {}) {
    this.config = config;
    this.agents = new DynamicAgentManager(config);
    this.memory = new AgentSharedMemory(config);
    this.options = {
      timeoutMinutes: 30,
      maxRetries: 3,
      ...options,
    };

    // Use the config and options to log initialization if needed
    // This keeps TypeScript happy about unused variables
    void this.config;
    void this.options;
  }

  /**
   * Get the agents manager instance
   */
  getAgentsManager(): DynamicAgentManager {
    return this.agents;
  }

  /**
   * Assign a task to an agent
   * @param taskId Unique task identifier
   * @param agentName Name of the agent to assign the task to
   * @param taskDescription Description of what the agent should do
   * @param priority How urgent this task is
   */
  async assignTask(
    taskId: string,
    agentName: string,
    taskDescription: string,
    priority: 'low' | 'medium' | 'high' = 'medium',
  ): Promise<void> {
    if (this.tasks.has(taskId)) {
      throw new Error(`Task with ID ${taskId} already exists`);
    }

    const task: AgentTask = {
      id: taskId,
      name: agentName,
      description: taskDescription,
      status: 'pending',
      priority,
      created: new Date().toISOString(),
    };

    this.tasks.set(taskId, task);
    await this.memory.set(`task:${taskId}`, task);

    // Notify the assignee agent
    const assigneeTask: AgentTask = { ...task, assignee: agentName };
    this.tasks.set(taskId, assigneeTask);
    await this.memory.set(`task:${taskId}`, assigneeTask);
  }

  /**
   * Start processing a task assigned to an agent
   * @param taskId The ID of the task to start
   * @param agentId The ID of the agent starting the task
   */
  async startTask(taskId: string, agentId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    if (task.assignee !== agentId) {
      throw new Error(`Task ${taskId} is not assigned to agent ${agentId}`);
    }

    const updatedTask: AgentTask = {
      ...task,
      status: 'in-progress',
      assignee: agentId,
    };

    this.tasks.set(taskId, updatedTask);
    await this.memory.set(`task:${taskId}`, updatedTask);
  }

  /**
   * Complete a task and store its result
   * @param taskId The ID of the task to complete
   * @param result The result of the completed task
   */
  async completeTask(taskId: string, result: unknown): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    const updatedTask: AgentTask = {
      ...task,
      status: 'completed',
      completed: new Date().toISOString(),
      result,
    };

    this.tasks.set(taskId, updatedTask);
    await this.memory.set(`task:${taskId}`, updatedTask);
  }

  /**
   * Mark a task as failed
   * @param taskId The ID of the task that failed
   * @param error The error that caused the failure
   */
  async failTask(taskId: string, error: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    const updatedTask: AgentTask = {
      ...task,
      status: 'failed',
      completed: new Date().toISOString(),
      result: { error },
    };

    this.tasks.set(taskId, updatedTask);
    await this.memory.set(`task:${taskId}`, updatedTask);
  }

  /**
   * Get the status of a task
   * @param taskId The ID of the task to check
   */
  async getTaskStatus(taskId: string): Promise<AgentTask | null> {
    return (
      this.tasks.get(taskId) ||
      (await this.memory.get<AgentTask>(`task:${taskId}`)) ||
      null
    );
  }

  /**
   * Get all tasks assigned to a specific agent
   * @param agentId The ID of the agent to get tasks for
   */
  async getTasksForAgent(agentId: string): Promise<AgentTask[]> {
    const tasks: AgentTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.assignee === agentId) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  /**
   * Execute a sequence of tasks in dependency order
   * @param tasks The tasks to execute in order
   * @param onProgress Optional callback for progress updates
   */
  async executeTaskSequence(
    tasks: Array<Omit<AgentTask, 'id' | 'created'>>,
    onProgress?: (taskId: string, status: string, result?: unknown) => void,
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    const taskMap: Map<string, Omit<AgentTask, 'id' | 'created'>> = new Map();
    const taskExecutionOrder: string[] = [];

    // Generate unique IDs for tasks and create dependency graph
    const taskIds: string[] = [];
    tasks.forEach((task, index) => {
      const taskId = `task-${Date.now()}-${index}`;
      taskIds.push(taskId);
      const taskWithId: AgentTask = {
        ...task,
        id: taskId,
        created: new Date().toISOString(),
      };
      taskMap.set(taskId, taskWithId);
    });

    // Identify execution order considering dependencies
    const processed = new Set<string>();

    const canExecute = (taskId: string): boolean => {
      const task = taskMap.get(taskId);
      if (!task) return false;

      // Check if all dependencies are completed
      if (task.dependencies) {
        for (const depId of task.dependencies) {
          if (!processed.has(depId)) {
            return false;
          }
        }
      }
      return true;
    };

    while (processed.size < tasks.length) {
      let executedThisRound = false;

      for (const [taskId] of taskMap) {
        if (!processed.has(taskId) && canExecute(taskId)) {
          const task = taskMap.get(taskId)!;

          // Execute the assigned task
          try {
            const result = await this.getAgentsManager().executeAgent(
              task.name,
              `Perform the following task: ${task.description}`,
              task.description,
            );

            results[taskId] = result;
            processed.add(taskId);
            taskExecutionOrder.push(taskId);

            if (onProgress) {
              onProgress(taskId, 'completed', result);
            }
          } catch (error) {
            results[taskId] = { error: (error as Error).message };
            processed.add(taskId);
            taskExecutionOrder.push(taskId);

            if (onProgress) {
              onProgress(taskId, 'failed', { error: (error as Error).message });
            }
          }

          executedThisRound = true;
          break; // Execute one task per round to respect dependencies
        }
      }

      if (!executedThisRound) {
        throw new Error('Circular dependency detected in task sequence');
      }
    }

    return results;
  }

  /**
   * Get the shared memory instance for direct access
   */
  getMemory(): AgentSharedMemory {
    return this.memory;
  }
}
