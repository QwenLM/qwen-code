/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { AgentCoordinationSystem } from './agent-coordination.js';
import {
  AgentCommunicationSystem,
  type AgentMessage,
} from './agent-communication.js';
import { AgentSharedMemory } from './shared-memory.js';

/**
 * Enhanced coordination system with improved team collaboration features
 */
export class EnhancedAgentCoordinationSystem extends AgentCoordinationSystem {
  private communication: AgentCommunicationSystem;

  constructor(config: Config, communication: AgentCommunicationSystem) {
    super(config);
    this.communication = communication;
  }

  /**
   * Enhanced task execution with team awareness and notification
   */
  async executeTeamTask(
    taskId: string,
    agentName: string,
    taskDescription: string,
    notifyTeam: boolean = true,
  ): Promise<unknown> {
    // Assign and start the task
    await this.assignTask(taskId, agentName, taskDescription);
    await this.startTask(taskId, agentName);

    // Execute the task
    let result: unknown;
    try {
      result = await this.getAgentsManager().executeAgent(
        agentName,
        `Perform the task: ${taskDescription}`,
        taskDescription,
      );

      // Complete the task
      await this.completeTask(taskId, result);

      // Notify the team if requested
      if (notifyTeam) {
        await this.communication.sendMessage(
          agentName,
          'broadcast',
          'notification',
          {
            type: 'task_completed',
            taskId,
            agent: agentName,
            description: taskDescription,
            result:
              typeof result === 'string'
                ? result.substring(0, 200)
                : JSON.stringify(result).substring(0, 200),
            timestamp: new Date().toISOString(),
          },
        );
      }
    } catch (error) {
      // Mark task as failed
      await this.failTask(taskId, (error as Error).message);

      // Notify the team about the failure
      if (notifyTeam) {
        await this.communication.sendMessage(
          agentName,
          'broadcast',
          'notification',
          {
            type: 'task_failed',
            taskId,
            agent: agentName,
            description: taskDescription,
            error: (error as Error).message,
            timestamp: new Date().toISOString(),
          },
        );
      }

      throw error;
    }

    return result;
  }

  /**
   * Execute a complex task with dependencies and team coordination
   */
  async executeComplexTask(
    taskId: string,
    agentName: string,
    taskDescription: string,
    dependencies: string[] = [],
    notifyTeam: boolean = true,
  ): Promise<unknown> {
    // Check if dependencies are completed
    for (const depId of dependencies) {
      const depTask = await this.getTaskStatus(depId);
      if (!depTask || depTask.status !== 'completed') {
        throw new Error(`Dependency task ${depId} is not completed`);
      }
    }

    // Execute the task with team awareness
    return this.executeTeamTask(taskId, agentName, taskDescription, notifyTeam);
  }

  /**
   * Get team status with detailed information about each agent's tasks
   */
  async getTeamStatus(teamName: string): Promise<{
    teamName: string;
    agents: Array<{
      name: string;
      activeTasks: number;
      completedTasks: number;
      status: string;
      lastActivity: string;
    }>;
    overallProgress: number;
  }> {
    const memory = this.getMemory();
    const teamData = await memory.get<Record<string, unknown>>(
      `team:${teamName}`,
    );

    if (!teamData) {
      throw new Error(`Team ${teamName} not found`);
    }

    const agents =
      (teamData['members'] as Array<{ name: string; role: string }>) || [];
    const teamStatus = {
      teamName,
      agents: [],
      overallProgress:
        ((teamData['sharedContext'] as Record<string, unknown>)?.[
          'progress'
        ] as number) || 0,
    };

    for (const agent of agents) {
      const agentTasks = await this.getTasksForAgent(agent.name);
      const activeTasks = agentTasks.filter(
        (t) => t.status === 'in-progress' || t.status === 'queued',
      ).length;
      const completedTasks = agentTasks.filter(
        (t) => t.status === 'completed',
      ).length;

      // Get last activity from shared memory
      const agentContext = await memory.get<Record<string, unknown>>(
        `agent:${agent.name}:context`,
      );
      const lastActivity =
        (agentContext?.['lastInteraction'] as string) || 'unknown';

      (
        teamStatus.agents as Array<{
          name: string;
          activeTasks: number;
          completedTasks: number;
          status: string;
          lastActivity: string;
        }>
      ).push({
        name: agent.name,
        activeTasks,
        completedTasks,
        status:
          activeTasks > 0 ? 'busy' : completedTasks > 0 ? 'available' : 'idle',
        lastActivity,
      });
    }

    return teamStatus;
  }
}

/**
 * Enhanced communication system with improved message handling
 */
export class EnhancedAgentCommunicationSystem extends AgentCommunicationSystem {
  /**
   * Send a message with automatic acknowledgment tracking
   */
  async sendRequestWithAck(
    from: string,
    to: string,
    type: 'request' | 'response' | 'notification' | 'data',
    content: string | Record<string, unknown>,
    timeoutMs: number = 10000,
  ): Promise<string> {
    const messageId = await this.sendMessage(from, to, type, content, {
      requireAck: true,
    });

    // Wait for acknowledgment
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const ackStatus = await this.getAcknowledgmentStatus(messageId);
      if (ackStatus === 'received') {
        return messageId;
      } else if (ackStatus === 'timeout') {
        throw new Error(
          `Message ${messageId} timed out waiting for acknowledgment`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(
      `Timeout waiting for acknowledgment of message ${messageId}`,
    );
  }

  /**
   * Send a message to multiple agents and wait for all responses
   */
  async broadcastAndWaitForResponses(
    from: string,
    recipients: string[],
    type: 'request' | 'notification' | 'data',
    content: string | Record<string, unknown>,
    timeoutMs: number = 15000,
  ): Promise<Array<{ agent: string; response: AgentMessage }>> {
    const correlationId = `broadcast-${Date.now()}`;
    const responses: Array<{ agent: string; response: AgentMessage }> = [];

    // Send message to each recipient
    for (const recipient of recipients) {
      await this.sendMessage(from, recipient, type, content, { correlationId });
    }

    // Wait for responses from all agents
    const startTime = Date.now();
    const pendingResponses = new Set(recipients);

    while (pendingResponses.size > 0 && Date.now() - startTime < timeoutMs) {
      for (const recipient of pendingResponses) {
        const inbox = await this.getInbox(recipient);
        const response = inbox.find(
          (msg) =>
            msg.correlationId === correlationId && msg.type === 'response',
        );

        if (response) {
          responses.push({ agent: recipient, response });
          pendingResponses.delete(recipient);

          // Remove response from inbox
          const currentInbox: AgentMessage[] =
            (await this.getMemory().get(`inbox:${recipient}`)) || [];
          const updatedInbox = currentInbox.filter(
            (msg) => msg.id !== response.id,
          );
          await this.getMemory().set(`inbox:${recipient}`, updatedInbox);
        }
      }

      if (pendingResponses.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    return responses;
  }

  /**
   * Subscribe to messages matching a specific pattern
   */
  async subscribeToMessages(
    agentId: string,
    filter: (msg: AgentMessage) => boolean,
    callback: (msg: AgentMessage) => void,
    pollInterval: number = 1000,
  ): Promise<() => void> {
    // Returns a function to stop subscription
    let lastCheckTime = new Date(0); // Start with epoch time

    const intervalId = setInterval(async () => {
      const allKeys = await this.getMemory().keys();
      const messageKeys = allKeys.filter((key) => key.startsWith('message:'));

      for (const key of messageKeys) {
        const message = await this.getMemory().get<AgentMessage>(key);
        if (
          message &&
          new Date(message.timestamp) > lastCheckTime &&
          filter(message)
        ) {
          lastCheckTime = new Date(message.timestamp);
          callback(message);
        }
      }
    }, pollInterval);

    // Return function to stop subscription
    return () => clearInterval(intervalId);
  }
}

/**
 * Enhanced orchestration system for better workflow management
 */
export class EnhancedAgentOrchestrationSystem {
  private coordination: EnhancedAgentCoordinationSystem;
  private communication: EnhancedAgentCommunicationSystem;
  private memory: AgentSharedMemory;

  constructor(
    config: Config,
    coordination: EnhancedAgentCoordinationSystem,
    communication: EnhancedAgentCommunicationSystem,
  ) {
    this.coordination = coordination;
    this.communication = communication;
    this.memory = new AgentSharedMemory(config);
  }

  /**
   * Execute a complex workflow with detailed progress tracking
   */
  async executeWorkflowWithTracking(
    workflowId: string,
    name: string,
    description: string,
    steps: Array<{
      id: string;
      agent: string;
      task: string;
      dependencies?: string[];
      onSuccess?: (result: unknown) => Promise<void>;
      onError?: (error: Error) => Promise<void>;
      fallbackAgent?: string; // Agent to use if primary agent fails
      retryCount?: number; // Number of times to retry if failed
    }>,
  ): Promise<{
    results: Record<string, unknown>;
    status: 'completed' | 'failed';
    errors?: string[];
  }> {
    const startTime = Date.now();
    const errors: string[] = [];

    // Initialize workflow in memory
    await this.memory.set(`workflow:${workflowId}`, {
      id: workflowId,
      name,
      description,
      steps: steps.map((step) => ({ ...step })),
      status: 'in-progress',
      started: new Date().toISOString(),
      progress: 0,
      totalSteps: steps.length,
      completedSteps: 0,
    });

    const results: Record<string, unknown> = {};
    const completedStepIds: Set<string> = new Set();

    while (completedStepIds.size < steps.length) {
      let executedThisRound = false;

      for (const step of steps) {
        if (completedStepIds.has(step.id)) continue;

        // Check dependencies
        const dependenciesMet =
          !step.dependencies ||
          step.dependencies.every((depId) => completedStepIds.has(depId));

        if (!dependenciesMet) continue;

        // Try executing the step with retry logic and fallback agents
        let success = false;
        let attempt = 0;
        const maxRetries = step.retryCount ?? 3; // Default to 3 retries
        let currentAgent = step.agent;

        while (!success && attempt <= maxRetries) {
          try {
            // Update workflow progress
            const progress = Math.round(
              (completedStepIds.size / steps.length) * 100,
            );
            await this.memory.set(`workflow:${workflowId}`, {
              id: workflowId,
              name,
              description,
              steps: steps.map((s) => ({ ...s })),
              status: 'in-progress',
              started: new Date().toISOString(),
              progress,
              totalSteps: steps.length,
              completedSteps: completedStepIds.size,
              currentStep: step.id,
            });

            // Execute the step
            const result = await this.coordination.executeTeamTask(
              `step-${step.id}`,
              currentAgent,
              step.task,
            );

            results[step.id] = result;
            completedStepIds.add(step.id);

            // Update workflow progress
            const updatedProgress = Math.round(
              (completedStepIds.size / steps.length) * 100,
            );
            await this.memory.set(`workflow:${workflowId}`, {
              id: workflowId,
              name,
              description,
              steps: steps.map((s) => ({ ...s })),
              status: 'in-progress',
              started: new Date().toISOString(),
              progress: updatedProgress,
              totalSteps: steps.length,
              completedSteps: completedStepIds.size,
            });

            // Execute success callback if provided
            if (step.onSuccess) {
              try {
                await step.onSuccess(result);
              } catch (callbackError) {
                console.warn(
                  `Workflow callback error for step ${step.id}:`,
                  callbackError,
                );
              }
            }

            // Notify team of completion
            await this.communication.sendMessage(
              currentAgent,
              'broadcast',
              'notification',
              {
                type: 'workflow_step_completed',
                workflowId,
                stepId: step.id,
                result:
                  typeof result === 'string'
                    ? result.substring(0, 200)
                    : JSON.stringify(result).substring(0, 200),
                timestamp: new Date().toISOString(),
              },
            );

            success = true;
            executedThisRound = true;
          } catch (error) {
            attempt++;
            if (attempt <= maxRetries) {
              // If we have a fallback agent and this is our first attempt with the primary agent
              if (step.fallbackAgent && attempt === 1) {
                currentAgent = step.fallbackAgent;
                console.log(
                  `Primary agent failed, switching to fallback agent: ${currentAgent}`,
                );
              } else {
                console.log(
                  `Step ${step.id} attempt ${attempt} failed, retrying...`,
                );
                // Wait a bit before retrying
                await new Promise((resolve) =>
                  setTimeout(resolve, 1000 * attempt),
                );
              }
            } else {
              // All retries and fallbacks exhausted
              errors.push(
                `Step ${step.id} failed after ${maxRetries} retries: ${(error as Error).message}`,
              );

              // Execute error callback if provided
              if (step.onError) {
                try {
                  await step.onError(error as Error);
                } catch (callbackError) {
                  console.warn(
                    `Error callback error for step ${step.id}:`,
                    callbackError,
                  );
                }
              }

              // Notify team of failure
              await this.communication.sendMessage(
                currentAgent,
                'broadcast',
                'notification',
                {
                  type: 'workflow_step_failed',
                  workflowId,
                  stepId: step.id,
                  error: (error as Error).message,
                  attempt,
                  timestamp: new Date().toISOString(),
                },
              );

              // Mark workflow as failed and exit
              await this.memory.set(`workflow:${workflowId}`, {
                id: workflowId,
                name,
                description,
                steps: steps.map((s) => ({ ...s })),
                status: 'failed',
                started: new Date().toISOString(),
                completed: new Date().toISOString(),
                progress: Math.round(
                  (completedStepIds.size / steps.length) * 100,
                ),
                totalSteps: steps.length,
                completedSteps: completedStepIds.size,
                errors,
              });

              return { results, status: 'failed', errors };
            }
          }
        }

        if (success) {
          break; // Execute one step at a time to respect dependencies
        }
      }

      if (!executedThisRound) {
        // No progress was made - likely a circular dependency or error
        throw new Error(
          `No progress made in workflow execution. Possible circular dependency or unresolved tasks.`,
        );
      }
    }

    // Workflow completed successfully
    const duration = Date.now() - startTime;
    await this.memory.set(`workflow:${workflowId}`, {
      id: workflowId,
      name,
      description,
      steps: steps.map((s) => ({ ...s })),
      status: 'completed',
      started: new Date().toISOString(),
      completed: new Date().toISOString(),
      duration,
      progress: 100,
      totalSteps: steps.length,
      completedSteps: completedStepIds.size,
    });

    // Notify team of workflow completion
    await this.communication.sendMessage(
      'workflow-manager',
      'broadcast',
      'notification',
      {
        type: 'workflow_completed',
        workflowId,
        name,
        duration,
        timestamp: new Date().toISOString(),
      },
    );

    return { results, status: 'completed' };
  }

  /**
   * Recover a failed workflow from a specific point
   */
  async recoverWorkflow(
    workflowId: string,
    recoveryOption: 'retryFailedSteps' | 'skipFailedSteps' | 'restartFromPoint',
  ): Promise<{
    results: Record<string, unknown>;
    status: 'completed' | 'failed';
    errors?: string[];
  }> {
    // Get the current workflow state
    const workflow = await this.memory.get<Record<string, unknown>>(
      `workflow:${workflowId}`,
    );

    if (!workflow) {
      throw new Error(`Workflow ${workflowId} does not exist`);
    }

    if (workflow['status'] !== 'failed') {
      throw new Error(`Workflow ${workflowId} is not in failed state`);
    }

    const steps = (workflow['steps'] as Array<Record<string, unknown>>) || [];
    const errors = (workflow['errors'] as string[]) || [];

    // Based on the recovery option, handle the workflow recovery
    switch (recoveryOption) {
      case 'retryFailedSteps': {
        // Find failed and pending steps and retry them
        const stepResults: Record<string, unknown> =
          (workflow['results'] as Record<string, unknown>) || {};
        const completedStepIds = new Set<string>();
        const failedErrors: string[] = [];

        // Identify already completed steps
        for (const [stepId, result] of Object.entries(stepResults)) {
          if (
            result &&
            typeof result === 'object' &&
            !(result as { error?: string }).error
          ) {
            completedStepIds.add(stepId);
          }
        }

        // Retry failed steps
        for (const step of steps) {
          if (typeof step !== 'object' || !step) continue;

          const stepId = step['id'] as string;
          const stepAgent = step['agent'] as string;
          const stepTask = step['task'] as string;
          const stepDependencies = step['dependencies'] as string[] | undefined;

          // Check if all dependencies are completed before executing this step
          const dependenciesMet =
            !stepDependencies ||
            stepDependencies.every((depId) => completedStepIds.has(depId));

          if (dependenciesMet && !completedStepIds.has(stepId)) {
            try {
              const result = await this.coordination.executeTeamTask(
                `step-${stepId}`,
                stepAgent,
                stepTask,
              );
              stepResults[stepId] = result;
              completedStepIds.add(stepId);
            } catch (error) {
              failedErrors.push(
                `Step ${stepId} failed during recovery: ${(error as Error).message}`,
              );
            }
          }
        }

        // Update workflow state
        await this.memory.set(`workflow:${workflowId}`, {
          ...workflow,
          status: failedErrors.length === 0 ? 'completed' : 'failed',
          errors: failedErrors,
          results: stepResults,
        });

        return {
          results: stepResults,
          status: failedErrors.length === 0 ? 'completed' : 'failed',
          errors: failedErrors.length > 0 ? failedErrors : undefined,
        };
      }
      case 'skipFailedSteps': {
        // Skip failed steps and continue with the workflow
        console.warn(
          `Skipping failed steps for workflow ${workflowId} is not fully implemented yet.`,
        );
        // For now, just mark the workflow as completed with warnings
        await this.memory.set(`workflow:${workflowId}`, {
          ...workflow,
          status: 'completed',
          errors: [...errors, `Skipped failed steps: ${errors.join(', ')}`],
        });
        return {
          results: (workflow['results'] as Record<string, unknown>) || {},
          status: 'completed',
          errors: [...errors, `Skipped failed steps: ${errors.join(', ')}`],
        };
      }
      case 'restartFromPoint': {
        // Restart the workflow from a specific point
        console.warn(
          `Restarting workflow from a specific point for ${workflowId} is not fully implemented yet.`,
        );
        // For now, just return an error indicating it's not implemented
        throw new Error('Restart from specific point not implemented yet');
      }
      default:
        // For any other recovery option, throw an error
        throw new Error(`Unknown recovery option: ${recoveryOption}`);
    }
  }

  /**
   * Save the current state of a workflow for recovery
   */
  async saveWorkflowState(workflowId: string): Promise<void> {
    const workflow = await this.memory.get<Record<string, unknown>>(
      `workflow:${workflowId}`,
    );
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} does not exist`);
    }

    // Save current state with a timestamp
    const recoveryPointKey = `workflow-recovery-point:${workflowId}:${Date.now()}`;
    await this.memory.set(recoveryPointKey, workflow);

    // Also update the main workflow state
    await this.memory.set(`workflow:${workflowId}`, {
      ...workflow,
      lastSaved: new Date().toISOString(),
      recoveryPoints: [
        ...((workflow['recoveryPoints'] as string[]) || []),
        recoveryPointKey,
      ],
    });
  }

  /**
   * Restore a workflow to a saved state
   */
  async restoreWorkflowState(
    workflowId: string,
    recoveryPointKey: string,
  ): Promise<void> {
    const recoveryPoint =
      await this.memory.get<Record<string, unknown>>(recoveryPointKey);
    if (!recoveryPoint) {
      throw new Error(`Recovery point ${recoveryPointKey} does not exist`);
    }

    // Restore the workflow to the saved state
    await this.memory.set(`workflow:${workflowId}`, recoveryPoint);
  }

  /**
   * Get the shared memory instance for direct access
   */
  getMemory(): AgentSharedMemory {
    return this.memory;
  }

  /**
   * Get the coordination system instance
   */
  getCoordination(): EnhancedAgentCoordinationSystem {
    return this.coordination;
  }

  /**
   * Get the communication system instance
   */
  getCommunication(): EnhancedAgentCommunicationSystem {
    return this.communication;
  }
}
