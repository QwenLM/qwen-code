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
  status:
    | 'pending'
    | 'in-progress'
    | 'completed'
    | 'failed'
    | 'queued'
    | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'critical';
  created: string;
  started?: string;
  completed?: string;
  result?: unknown;
  dependencies?: string[]; // Task IDs this task depends on
  dependents?: string[]; // Task IDs that depend on this task
  retries: number; // Number of times this task has been retried
  maxRetries?: number; // Maximum number of retries for this specific task
  timeout?: number; // Timeout in minutes for this specific task
  agentConstraints?: string[]; // Specific agents that can handle this task
  estimatedDuration?: number; // Estimated duration in minutes
}

export interface AgentCoordinationOptions {
  timeoutMinutes?: number;
  maxRetries?: number;
  maxConcurrency?: number; // Maximum number of tasks that can run simultaneously
  enableDependencyValidation?: boolean; // Whether to validate dependencies to prevent cycles
  enableMetrics?: boolean; // Whether to enable metrics collection
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
  private readonly runningTasks: Set<string> = new Set(); // Track currently running tasks
  private readonly taskQueue: string[] = []; // Queue for tasks waiting to run
  private readonly dependencyGraph: Map<string, Set<string>> = new Map(); // Track dependencies between tasks

  constructor(config: Config, options: AgentCoordinationOptions = {}) {
    this.config = config;
    this.agents = new DynamicAgentManager(config);
    this.memory = new AgentSharedMemory(config);
    this.options = {
      timeoutMinutes: 30,
      maxRetries: 3,
      maxConcurrency: 5, // Default to 5 concurrent tasks max
      enableDependencyValidation: true, // Enable dependency validation by default
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
   * Validates the dependency graph to ensure there are no circular dependencies
   * @param taskId The task ID to validate
   * @param dependencies The dependencies to check
   */
  private validateDependencies(
    taskId: string,
    dependencies: string[] = [],
  ): boolean {
    if (!this.options.enableDependencyValidation) {
      return true;
    }

    // Create a copy of the dependency graph for validation
    const tempGraph = new Map(this.dependencyGraph);

    // Add the new task dependencies to the temporary graph
    const newDependencies = new Set(dependencies);
    tempGraph.set(taskId, newDependencies);

    // For each dependency, also track the reverse dependency (dependents)
    for (const depId of dependencies) {
      if (!tempGraph.has(depId)) {
        tempGraph.set(depId, new Set());
      }
    }

    // Check for cycles using a topological sort approach
    const visited = new Set<string>();
    const temp = new Set<string>(); // For current path tracking

    function hasCycle(node: string): boolean {
      if (temp.has(node)) {
        // Found a cycle
        return true;
      }
      if (visited.has(node)) {
        // Already processed, no cycle from this node
        return false;
      }

      temp.add(node);
      const dependenciesForNode = tempGraph.get(node) || new Set<string>();

      for (const child of dependenciesForNode) {
        if (hasCycle(child)) {
          return true;
        }
      }

      temp.delete(node);
      visited.add(node);
      return false;
    }

    // Check for cycles from the new task
    if (hasCycle(taskId)) {
      return false;
    }

    // Add the task and its dependencies to the real graph if validation passes
    this.dependencyGraph.set(taskId, newDependencies);

    // Update dependents for each dependency
    for (const depId of dependencies) {
      let dependents = this.dependencyGraph.get(depId);
      if (!dependents) {
        dependents = new Set();
        this.dependencyGraph.set(depId, dependents);
      }
      dependents.add(taskId);
    }

    return true;
  }

  /**
   * Assign a task to an agent
   * @param taskId Unique task identifier
   * @param agentName Name of the agent to assign the task to
   * @param taskDescription Description of what the agent should do
   * @param priority How urgent this task is
   * @param dependencies List of task IDs this task depends on
   * @param agentConstraints Specific agents that can handle this task
   */
  async assignTask(
    taskId: string,
    agentName: string,
    taskDescription: string,
    priority: 'low' | 'medium' | 'high' | 'critical' = 'medium',
    dependencies?: string[],
    agentConstraints?: string[],
  ): Promise<void> {
    if (this.tasks.has(taskId)) {
      throw new Error(`Task with ID ${taskId} already exists`);
    }

    // Validate dependencies to avoid circular dependencies
    if (dependencies && !this.validateDependencies(taskId, dependencies)) {
      throw new Error(
        `Circular dependency detected when adding task ${taskId}`,
      );
    }

    const task: AgentTask = {
      id: taskId,
      name: agentName,
      description: taskDescription,
      status: dependencies && dependencies.length > 0 ? 'blocked' : 'pending',
      priority,
      created: new Date().toISOString(),
      retries: 0,
      dependencies,
      dependents: [], // Will be populated when other tasks depend on this
      agentConstraints,
    };

    this.tasks.set(taskId, task);
    await this.memory.set(`task:${taskId}`, task);

    // Add to task memory
    const assigneeTask: AgentTask = { ...task, assignee: agentName };
    this.tasks.set(taskId, assigneeTask);
    await this.memory.set(`task:${taskId}`, assigneeTask);

    // If no dependencies, task is ready to be processed
    if (!dependencies || dependencies.length === 0) {
      await this.markTaskAsReady(taskId);
    }
  }

  /**
   * Marks a task as ready to be executed (not blocked by dependencies)
   */
  private async markTaskAsReady(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const updatedTask: AgentTask = {
      ...task,
      status: 'pending',
    };

    this.tasks.set(taskId, updatedTask);
    await this.memory.set(`task:${taskId}`, updatedTask);
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

    if (task.status !== 'pending') {
      throw new Error(
        `Task ${taskId} is not in pending state and cannot be started`,
      );
    }

    // Check if we're at max concurrency and queue if needed
    if (this.runningTasks.size >= (this.options.maxConcurrency || 5)) {
      // Change status to queued and add to the queue
      const updatedTask: AgentTask = {
        ...task,
        status: 'queued',
        assignee: agentId,
      };
      this.tasks.set(taskId, updatedTask);
      await this.memory.set(`task:${taskId}`, updatedTask);
      this.taskQueue.push(taskId);
      return;
    }

    const updatedTask: AgentTask = {
      ...task,
      status: 'in-progress',
      assignee: agentId,
      started: new Date().toISOString(),
    };

    this.tasks.set(taskId, updatedTask);
    await this.memory.set(`task:${taskId}`, updatedTask);
    this.runningTasks.add(taskId);
  }

  /**
   * Process the next task in the queue if concurrency allows
   */
  private async processNextQueuedTask(): Promise<void> {
    if (
      this.taskQueue.length > 0 &&
      this.runningTasks.size < (this.options.maxConcurrency || 5)
    ) {
      const nextTaskId = this.taskQueue.shift();
      if (nextTaskId) {
        const task = this.tasks.get(nextTaskId);
        if (task) {
          // Change status to in-progress
          const updatedTask: AgentTask = {
            ...task,
            status: 'in-progress',
            started: new Date().toISOString(),
          };
          this.tasks.set(nextTaskId, updatedTask);
          await this.memory.set(`task:${nextTaskId}`, updatedTask);
          this.runningTasks.add(nextTaskId);

          // Execute the task
          await this.executeTask(nextTaskId);
        }
      }
    }
  }

  /**
   * Execute a task
   */
  private async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    if (task.status !== 'in-progress') {
      throw new Error(`Task ${taskId} is not in progress`);
    }

    const startTime = Date.now();
    try {
      const result = await this.agents.executeAgent(
        task.assignee || task.name,
        `Perform the task: ${task.description}`,
        task.description,
      );

      const responseTime = Date.now() - startTime;
      await this.completeTask(taskId, result);

      // Record successful task completion metrics
      if (this.options.enableMetrics) {
        await this.recordTaskMetrics(
          task.assignee || task.name,
          true,
          responseTime,
          responseTime,
        );
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const currentRetries = task.retries + 1;
      const maxRetries = task.maxRetries ?? this.options.maxRetries ?? 3;

      if (currentRetries < maxRetries) {
        // Retry the task
        const updatedTask: AgentTask = {
          ...task,
          retries: currentRetries,
          status: 'pending', // Reset to pending for retry
        };
        this.tasks.set(taskId, updatedTask);
        await this.memory.set(`task:${taskId}`, updatedTask);
        this.runningTasks.delete(taskId);

        // Add to queue for retry
        this.taskQueue.push(taskId);
        await this.processNextQueuedTask();
      } else {
        // Mark as failed after max retries
        await this.failTask(taskId, (error as Error).message);

        // Record failed task metrics
        if (this.options.enableMetrics) {
          await this.recordTaskMetrics(
            task.assignee || task.name,
            false,
            responseTime,
            responseTime,
          );
        }
      }
    }
  }

  /**
   * Record task metrics for performance monitoring
   */
  private async recordTaskMetrics(
    agentName: string,
    success: boolean,
    responseTime: number,
    processingTime: number,
  ): Promise<void> {
    // Import metrics collector here to avoid circular dependencies
    const { AgentMetricsCollector } = await import('./metrics.js');
    const metricsCollector = new AgentMetricsCollector(this.config);

    await metricsCollector.recordAgentTaskMetrics(
      agentName,
      success,
      responseTime,
      processingTime,
    );
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

    // Remove from running tasks and process next queued task
    this.runningTasks.delete(taskId);
    await this.processNextQueuedTask();

    // Check if any dependent tasks can now be unblocked
    await this.unblockDependentTasks(taskId);

    // Record system-level metrics about task completion
    if (this.options.enableMetrics) {
      await this.recordSystemMetrics();
    }
  }

  /**
   * Unblocks tasks that were waiting for this task to complete
   */
  private async unblockDependentTasks(completedTaskId: string): Promise<void> {
    // Get all tasks that depend on the completed task
    const dependents = this.dependencyGraph.get(completedTaskId);

    if (!dependents) {
      return; // No tasks depend on this one
    }

    for (const dependentTaskId of dependents) {
      const dependentTask = this.tasks.get(dependentTaskId);
      if (!dependentTask) continue;

      // Check if all dependencies of the dependent task are now completed
      const allDependenciesMet = (dependentTask.dependencies || []).every(
        (depId) => {
          const depTask = this.tasks.get(depId);
          return (
            depTask &&
            (depTask.status === 'completed' || depTask.status === 'failed')
          );
        },
      );

      if (allDependenciesMet && dependentTask.status === 'blocked') {
        // Mark the dependent task as ready to execute
        await this.markTaskAsReady(dependentTaskId);

        // If the dependency failed but the task should still run, mark as ready
        // If the dependency failed and the task should not run, we would mark it as failed
        const hasFailedDependency = (dependentTask.dependencies || []).some(
          (depId) => {
            const depTask = this.tasks.get(depId);
            return depTask && depTask.status === 'failed';
          },
        );

        if (hasFailedDependency) {
          // For now, mark as failed if any dependency failed
          // In the future, we could have more sophisticated error handling
          await this.failTask(
            dependentTaskId,
            `Dependency failed: ${completedTaskId}`,
          );
        }
      }
    }
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

    // Remove from running tasks and process next queued task
    this.runningTasks.delete(taskId);
    await this.processNextQueuedTask();
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
    tasks: Array<Omit<AgentTask, 'id' | 'retries'>>,
    onProgress?: (taskId: string, status: string, result?: unknown) => void,
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    const taskMap: Map<string, Omit<AgentTask, 'id' | 'retries'>> = new Map();
    const taskExecutionOrder: string[] = [];

    // Generate unique IDs for tasks and create dependency graph
    const taskIds: string[] = [];
    tasks.forEach((task, index) => {
      const taskId = `task-${Date.now()}-${index}`;
      taskIds.push(taskId);
      const taskWithId: AgentTask = {
        ...task,
        id: taskId,
        created: task.created || new Date().toISOString(), // Use existing created if available
        retries: 0, // Initialize retry count
      };
      taskMap.set(taskId, taskWithId);
    });

    // Identify execution order considering dependencies
    const processed = new Set<string>();
    const pending = new Set<string>(taskIds); // Tasks that are pending execution

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

    // Group tasks by priority to execute higher priority tasks first
    const prioritizedTaskIds = Array.from(taskIds).sort((a, b) => {
      const taskA = taskMap.get(a) as AgentTask;
      const taskB = taskMap.get(b) as AgentTask;

      const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      return priorityOrder[taskB.priority] - priorityOrder[taskA.priority];
    });

    // Execute tasks respecting dependencies and concurrency limits
    while (processed.size < tasks.length) {
      let executedThisRound = false;

      for (const taskId of prioritizedTaskIds) {
        if (
          !processed.has(taskId) &&
          pending.has(taskId) &&
          canExecute(taskId)
        ) {
          // Check if we're at max concurrency and queue if needed
          if (this.runningTasks.size >= (this.options.maxConcurrency || 5)) {
            // Just continue to next task if at max concurrency
            continue;
          }

          const task = taskMap.get(taskId)!;

          // Mark the task as in-progress
          const updatedTask: AgentTask = {
            ...task,
            id: taskId,
            created: task.created || new Date().toISOString(), // Ensure 'created' field is preserved
            status: 'in-progress',
            started: new Date().toISOString(),
            retries: 0,
          };
          this.tasks.set(taskId, updatedTask);
          await this.memory.set(`task:${taskId}`, updatedTask);
          this.runningTasks.add(taskId);

          // Execute the assigned task with shared context
          try {
            // Get the shared context and task-specific data
            const sharedContext =
              (await this.getMemory().get('shared-context')) || {};
            const taskContext = {
              ...sharedContext,
              current_task: task.description,
              task_results: results,
              team_context: (await this.getMemory().get('team-context')) || {},
            };

            const result = await this.getAgentsManager().executeAgent(
              task.name,
              `Perform the following task: ${task.description}`,
              task.description,
              undefined, // tools
              taskContext, // context
            );

            results[taskId] = result;
            processed.add(taskId);
            pending.delete(taskId);
            taskExecutionOrder.push(taskId);

            // Update shared context with the result of this task
            const sharedContextRecord = sharedContext as Record<
              string,
              unknown
            >;
            const completedTasks = Array.isArray(
              sharedContextRecord['completed_tasks'],
            )
              ? (sharedContextRecord['completed_tasks'] as string[])
              : [];
            const updatedSharedContext = {
              ...sharedContext,
              [taskId]: result,
              last_task_result: result,
              completed_tasks: [...completedTasks, taskId],
            };
            await this.getMemory().set('shared-context', updatedSharedContext);

            // Mark task as completed
            const completedTask: AgentTask = {
              ...updatedTask,
              status: 'completed',
              completed: new Date().toISOString(),
              result,
            };
            this.tasks.set(taskId, completedTask);
            await this.memory.set(`task:${taskId}`, completedTask);
            this.runningTasks.delete(taskId);

            // Process any queued tasks
            await this.processNextQueuedTask();

            if (onProgress) {
              onProgress(taskId, 'completed', result);
            }
          } catch (error) {
            // Handle task failure with retry logic
            const currentTask = this.tasks.get(taskId);
            const currentRetries = currentTask ? currentTask.retries + 1 : 1;

            if (currentRetries < (this.options.maxRetries || 3)) {
              // Retry the task
              const retryTask: AgentTask = {
                ...updatedTask,
                retries: currentRetries,
                status: 'pending', // Reset to pending for retry
              };
              this.tasks.set(taskId, retryTask);
              await this.memory.set(`task:${taskId}`, retryTask);
              this.runningTasks.delete(taskId);

              // Add to queue for retry
              this.taskQueue.push(taskId);

              results[taskId] = {
                error: (error as Error).message,
                retrying: true,
                attempt: currentRetries,
              };
              if (onProgress) {
                onProgress(taskId, 'retrying', {
                  error: (error as Error).message,
                  attempt: currentRetries,
                });
              }
            } else {
              // Mark as failed after max retries
              results[taskId] = { error: (error as Error).message };
              processed.add(taskId);
              pending.delete(taskId);
              taskExecutionOrder.push(taskId);

              const failedTask: AgentTask = {
                ...updatedTask,
                status: 'failed',
                completed: new Date().toISOString(),
                result: { error: (error as Error).message },
              };
              this.tasks.set(taskId, failedTask);
              await this.memory.set(`task:${taskId}`, failedTask);
              this.runningTasks.delete(taskId);

              // Process any queued tasks
              await this.processNextQueuedTask();

              if (onProgress) {
                onProgress(taskId, 'failed', {
                  error: (error as Error).message,
                });
              }
            }
          }

          executedThisRound = true;
          break; // Execute one task per round to respect dependencies
        }
      }

      if (!executedThisRound) {
        // Check if there are tasks in the queue
        if (this.taskQueue.length > 0) {
          await this.processNextQueuedTask();
          continue; // Continue the loop after processing queued tasks
        }

        // If no progress is made and no queued tasks, there's likely a circular dependency
        const unprocessed = Array.from(pending).filter(
          (id) => !processed.has(id),
        );
        if (unprocessed.length > 0) {
          throw new Error(
            `Circular dependency or unresolvable dependency detected in task sequence. Unprocessed tasks: ${unprocessed.join(', ')}`,
          );
        }
        break; // Exit if all tasks are processed
      }
    }

    return results;
  }

  /**
   * Resolve task dependencies using topological sort
   * @param tasks The tasks to order based on dependencies
   */
  async topologicalSort(tasks: AgentTask[]): Promise<AgentTask[]> {
    // Build adjacency list for dependencies
    const graph: Map<string, Set<string>> = new Map();
    const inDegree: Map<string, number> = new Map();

    // Initialize graph and in-degree map
    for (const task of tasks) {
      if (!graph.has(task.id)) {
        graph.set(task.id, new Set());
      }
      inDegree.set(task.id, 0);
    }

    // Add edges for dependencies
    for (const task of tasks) {
      if (task.dependencies) {
        for (const depId of task.dependencies) {
          if (tasks.some((t) => t.id === depId)) {
            // Only consider dependencies within this task set
            const adjList = graph.get(depId) || new Set();
            adjList.add(task.id);
            graph.set(depId, adjList);

            inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);
          }
        }
      }
    }

    // Kahn's algorithm for topological sort
    const queue: string[] = [];
    for (const [taskId, degree] of inDegree.entries()) {
      if (degree === 0) {
        queue.push(taskId);
      }
    }

    const sortedTasks: AgentTask[] = [];

    while (queue.length > 0) {
      const taskId = queue.shift()!;
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        sortedTasks.push(task);
      }

      const dependents = graph.get(taskId) || new Set();
      for (const dependentId of dependents) {
        const newDegree = (inDegree.get(dependentId) || 0) - 1;
        inDegree.set(dependentId, newDegree);
        if (newDegree === 0) {
          queue.push(dependentId);
        }
      }
    }

    // If not all tasks were processed, there's a cycle
    if (sortedTasks.length !== tasks.length) {
      throw new Error('Cycle detected in task dependencies');
    }

    return sortedTasks;
  }

  /**
   * Calculate the load for each agent based on their assigned tasks
   */
  async calculateAgentLoad(): Promise<Record<string, number>> {
    const agentLoad: Record<string, number> = {};

    // Initialize load for all known agents
    const allTasks = Array.from(this.tasks.values());
    for (const task of allTasks) {
      if (task.assignee) {
        if (!agentLoad[task.assignee]) {
          agentLoad[task.assignee] = 0;
        }
        // Count different task statuses with different weights
        switch (task.status) {
          case 'in-progress':
            agentLoad[task.assignee] += 2; // In-progress tasks have higher weight
            break;
          case 'pending':
          case 'queued':
          case 'blocked':
            agentLoad[task.assignee] += 1; // Pending/queued tasks have medium weight
            break;
          case 'completed':
          case 'failed':
            // Completed/failed tasks don't count toward current load
            break;
          default:
            // For any other status, we don't count it toward load
            break;
        }
      }
    }

    return agentLoad;
  }

  /**
   * Select the agent with the lowest current load
   * @param eligibleAgents List of agents that can handle the task
   * @returns The agent with the lowest load or undefined if no agents available
   */
  async selectLeastLoadedAgent(
    eligibleAgents: string[],
  ): Promise<string | null> {
    if (eligibleAgents.length === 0) {
      return null;
    }

    const agentLoads = await this.calculateAgentLoad();

    // Initialize loads for all eligible agents if not already present
    for (const agent of eligibleAgents) {
      if (agentLoads[agent] === undefined) {
        agentLoads[agent] = 0;
      }
    }

    // Find the agent with the minimum load
    let selectedAgent: string | null = null;
    let minLoad = Infinity;

    for (const agent of eligibleAgents) {
      const load = agentLoads[agent] || 0;
      if (load < minLoad) {
        minLoad = load;
        selectedAgent = agent;
      }
    }

    return selectedAgent;
  }

  /**
   * Preempt lower priority tasks to make room for a critical task
   * @param targetAgent Agent that should handle the critical task
   * @param criticalTaskId ID of the critical task to schedule
   * @param minPriority Minimum priority level to consider for preemption
   */
  async preemptTasksForCriticalTask(
    targetAgent: string,
    criticalTaskId: string,
    minPriority: 'low' | 'medium' | 'high' = 'low',
  ): Promise<boolean> {
    // Define priority levels for preemption
    const priorityLevels = { low: 1, medium: 2, high: 3, critical: 4 };
    const minPriorityLevel = priorityLevels[minPriority];

    // Find tasks assigned to the target agent that have lower priority
    const tasksToPreempt: AgentTask[] = [];

    for (const task of this.tasks.values()) {
      if (
        task.assignee === targetAgent &&
        task.status === 'in-progress' &&
        priorityLevels[task.priority] < priorityLevels['critical'] &&
        priorityLevels[task.priority] >= minPriorityLevel
      ) {
        tasksToPreempt.push(task);
      }
    }

    if (tasksToPreempt.length === 0) {
      return false; // No tasks to preempt
    }

    // Sort by priority (lowest first) so we don't preempt higher-priority tasks unnecessarily
    tasksToPreempt.sort(
      (a, b) => priorityLevels[a.priority] - priorityLevels[b.priority],
    );

    // Preempt lower priority tasks
    for (const taskToPreempt of tasksToPreempt) {
      if (this.runningTasks.size < (this.options.maxConcurrency || 5)) {
        // We have room, so we can schedule the critical task now
        break;
      }

      // Stop the running task
      this.tasks.delete(taskToPreempt.id);
      await this.memory.delete(`task:${taskToPreempt.id}`);
      this.runningTasks.delete(taskToPreempt.id);

      // Put the preempted task back in pending state to be rescheduled later
      const updatedTask: AgentTask = {
        ...taskToPreempt,
        status: 'pending',
        started: undefined, // Reset start time
      };
      this.tasks.set(taskToPreempt.id, updatedTask);
      await this.memory.set(`task:${taskToPreempt.id}`, updatedTask);
    }

    return true;
  }

  /**
   * Distribute a task among eligible agents using load balancing
   * @param agentConstraints Specific agents that can handle this task, or undefined for any agent
   * @param taskDescription Description of the task
   * @param priority Priority of the task
   * @param dependencies Task dependencies
   */
  async distributeTaskWithLoadBalancing(
    taskDescription: string,
    priority: 'low' | 'medium' | 'high' | 'critical' = 'medium',
    agentConstraints?: string[],
    dependencies?: string[],
  ): Promise<string> {
    // Generate a unique task ID
    const taskId = `task-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    // Determine eligible agents
    let eligibleAgents = agentConstraints;
    if (!eligibleAgents) {
      // If no constraints, use all available agents
      const allTasks = Array.from(this.tasks.values());
      const allAgents = new Set<string>();
      for (const task of allTasks) {
        if (task.assignee) {
          allAgents.add(task.assignee);
        }
      }
      eligibleAgents = Array.from(allAgents);
    }

    let selectedAgent: string | null = null;

    if (priority === 'critical') {
      // For critical tasks, use first available agent or preempt if necessary
      const agentLoads = await this.calculateAgentLoad();
      const availableAgents = eligibleAgents.filter(
        (agent) =>
          (agentLoads[agent] || 0) < (this.options.maxConcurrency || 5),
      );

      if (availableAgents.length > 0) {
        // Use the first available agent
        selectedAgent = availableAgents[0];
      } else {
        // No available agents, try to preempt a lower priority task
        for (const agent of eligibleAgents) {
          const hasPreempted = await this.preemptTasksForCriticalTask(
            agent,
            taskId,
            'low',
          );
          if (hasPreempted) {
            selectedAgent = agent;
            break;
          }
        }
      }
    } else {
      // For non-critical tasks, use load balancing
      selectedAgent = await this.selectLeastLoadedAgent(eligibleAgents);
    }

    if (!selectedAgent) {
      throw new Error('No available agents to assign the task');
    }

    // Assign the task to the selected agent
    await this.assignTask(
      taskId,
      selectedAgent,
      taskDescription,
      priority,
      dependencies,
      agentConstraints,
    );

    return taskId;
  }

  /**
   * Record system-level metrics
   */
  private async recordSystemMetrics(): Promise<void> {
    if (!this.options.enableMetrics) {
      return;
    }

    try {
      // Calculate system metrics
      const totalTasks = this.tasks.size;
      const completedTasks = Array.from(this.tasks.values()).filter(
        (t) => t.status === 'completed',
      ).length;
      const failedTasks = Array.from(this.tasks.values()).filter(
        (t) => t.status === 'failed',
      ).length;

      // Calculate average task completion time (for completed tasks only)
      let avgTaskCompletionTime = 0;
      const completedTaskTimes: number[] = [];

      for (const task of this.tasks.values()) {
        if (task.status === 'completed' && task.started && task.completed) {
          const startTime = new Date(task.started).getTime();
          const endTime = new Date(task.completed).getTime();
          completedTaskTimes.push(endTime - startTime);
        }
      }

      if (completedTaskTimes.length > 0) {
        avgTaskCompletionTime =
          completedTaskTimes.reduce((a, b) => a + b, 0) /
          completedTaskTimes.length;
      }

      // Get memory usage
      const memoryStats = await this.memory.getStats();

      // Use metrics collector to record system metrics
      const { AgentMetricsCollector } = await import('./metrics.js');
      const metricsCollector = new AgentMetricsCollector(this.config);

      await metricsCollector.recordSystemMetrics({
        totalTasks,
        completedTasks,
        failedTasks,
        avgTaskCompletionTime,
        activeAgents: this.runningTasks.size,
        avgAgentLoad: 0, // Calculate this differently based on your needs
        memoryUsage: memoryStats.size,
        avgMessageResponseTime: 0, // Not applicable here, but we'll set it to 0
      });
    } catch (error) {
      console.error('Failed to record system metrics:', error);
    }
  }

  /**
   * Get the shared memory instance for direct access
   */
  getMemory(): AgentSharedMemory {
    return this.memory;
  }
}
