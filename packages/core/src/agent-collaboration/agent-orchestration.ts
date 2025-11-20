/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { AgentCoordinationSystem } from './agent-coordination.js';
import { AgentCommunicationSystem } from './agent-communication.js';
import { AgentSharedMemory } from './shared-memory.js';

export interface AgentWorkflowStep {
  id: string;
  agent: string;
  task: string;
  dependencies?: string[];
  onResult?: (result: unknown) => Promise<void>;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  requiredCapabilities?: string[]; // Capabilities required for this step
  fallbackAgent?: string; // Agent to use if primary agent fails
  timeoutMinutes?: number; // Specific timeout for this step
  maxRetries?: number; // Specific max retries for this step
  retryCount?: number; // Number of times to retry if failed
}

export interface AgentWorkflow {
  id: string;
  name: string;
  description: string;
  steps: AgentWorkflowStep[];
  created: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'paused';
  result?: unknown;
  currentStep?: string;
  completedSteps?: number;
  totalSteps?: number;
  progress?: number; // Percentage of completion
}

export interface AgentOrchestrationOptions {
  maxConcurrency?: number;
  timeoutMinutes?: number;
  enableRecovery?: boolean; // Whether to enable automatic recovery from failures
  defaultMaxRetries?: number; // Default max retries for steps
}

/**
 * Enhanced orchestration system for managing complex workflows involving multiple agents
 */
export class AgentOrchestrationSystem {
  private readonly coordination: AgentCoordinationSystem;
  private readonly communication: AgentCommunicationSystem;
  private readonly memory: AgentSharedMemory;
  private readonly config: Config;
  private readonly options: AgentOrchestrationOptions;

  constructor(config: Config, options: AgentOrchestrationOptions = {}) {
    this.config = config;
    this.coordination = new AgentCoordinationSystem(config);
    this.communication = new AgentCommunicationSystem(config);
    this.memory = new AgentSharedMemory(config);
    this.options = {
      maxConcurrency: 3,
      timeoutMinutes: 30,
      enableRecovery: true,
      defaultMaxRetries: 3,
      ...options,
    };

    // Use config to log initialization if needed
    void this.config;
    void this.options;
  }

  /**
   * Execute a workflow with multiple agent steps using different collaboration strategies
   * @param workflowId Unique workflow identifier
   * @param name Human-readable name for the workflow
   * @param description Description of the workflow
   * @param steps The steps to execute in the workflow
   * @param strategy Collaboration strategy to use ('sequential', 'parallel', 'round-robin', 'specialized', 'hybrid')
   */
  async executeWorkflow(
    workflowId: string,
    name: string,
    description: string,
    steps: AgentWorkflowStep[],
    strategy:
      | 'sequential'
      | 'parallel'
      | 'round-robin'
      | 'specialized'
      | 'hybrid' = 'sequential',
  ): Promise<unknown> {
    const workflow: AgentWorkflow = {
      id: workflowId,
      name,
      description,
      steps,
      created: new Date().toISOString(),
      status: 'in-progress',
      completedSteps: 0,
      totalSteps: steps.length,
      progress: 0,
    };

    // Store workflow in shared memory
    await this.memory.set(`workflow:${workflowId}`, workflow);

    let result: unknown;

    try {
      switch (strategy) {
        case 'sequential':
          result = await this.executeSequentialWorkflow(workflowId, steps);
          break;
        case 'parallel':
          result = await this.executeParallelWorkflow(workflowId, steps);
          break;
        case 'round-robin':
          result = await this.executeRoundRobinWorkflow(workflowId, steps);
          break;
        case 'specialized':
          result = await this.executeSpecializedWorkflow(workflowId, steps);
          break;
        case 'hybrid':
          result = await this.executeHybridWorkflow(workflowId, steps);
          break;
        default:
          throw new Error(`Unknown strategy: ${strategy}`);
      }
    } catch (error) {
      // Mark workflow as failed
      workflow.status = 'failed';
      workflow.result = { error: (error as Error).message };
      await this.memory.set(`workflow:${workflowId}`, workflow);
      throw error;
    }

    // Mark workflow as completed
    workflow.status = 'completed';
    workflow.result = result;
    workflow.progress = 100;
    await this.memory.set(`workflow:${workflowId}`, workflow);

    return result;
  }

  /**
   * Execute workflow steps sequentially, one after another
   */
  private async executeSequentialWorkflow(
    workflowId: string,
    steps: AgentWorkflowStep[],
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    const completedSteps = new Set<string>();

    for (const step of steps) {
      // Update workflow progress
      const workflow = await this.memory.get<AgentWorkflow>(
        `workflow:${workflowId}`,
      );
      if (workflow) {
        workflow.currentStep = step.id;
        workflow.completedSteps = completedSteps.size;
        workflow.progress = Math.round(
          (completedSteps.size / steps.length) * 100,
        );
        await this.memory.set(`workflow:${workflowId}`, workflow);
      }

      // Check if all dependencies are completed
      if (step.dependencies) {
        const allDependenciesMet = step.dependencies.every((depId) =>
          completedSteps.has(depId),
        );
        if (!allDependenciesMet) {
          throw new Error(
            `Dependency not met for step ${step.id}: ${step.dependencies.join(', ')}`,
          );
        }
      }

      // Execute this step
      try {
        const stepResult = await this.executeWorkflowStep(step, results);
        results[step.id] = stepResult;
        completedSteps.add(step.id);

        // Execute any result handler
        if (step.onResult) {
          await step.onResult(stepResult);
        }
      } catch (error) {
        // Handle failure based on recovery settings
        if (this.options.enableRecovery && step.fallbackAgent) {
          // Try fallback agent
          const fallbackStep: AgentWorkflowStep = {
            ...step,
            agent: step.fallbackAgent,
          };
          const stepResult = await this.executeWorkflowStep(
            fallbackStep,
            results,
          );
          results[step.id] = stepResult;
          completedSteps.add(step.id);
        } else {
          // Mark workflow as failed
          const workflow = await this.memory.get<AgentWorkflow>(
            `workflow:${workflowId}`,
          );
          if (workflow) {
            workflow.status = 'failed';
            workflow.result = { error: (error as Error).message };
            await this.memory.set(`workflow:${workflowId}`, workflow);
          }
          throw error;
        }
      }
    }

    return results;
  }

  /**
   * Execute workflow steps in parallel where possible
   */
  private async executeParallelWorkflow(
    workflowId: string,
    steps: AgentWorkflowStep[],
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    const completedSteps = new Set<string>();
    const remainingSteps = [...steps];

    while (remainingSteps.length > 0) {
      // Find steps whose dependencies are satisfied
      const readySteps = remainingSteps.filter((step) => {
        if (!step.dependencies) return true;
        return step.dependencies.every((depId) => completedSteps.has(depId));
      });

      if (readySteps.length === 0) {
        throw new Error('Circular dependency detected in parallel workflow');
      }

      // Execute ready steps in parallel up to max concurrency
      const executionBatch = readySteps.slice(
        0,
        this.options.maxConcurrency || 3,
      );
      const pendingExecutions = executionBatch.map(async (step) => {
        try {
          const stepResult = await this.executeWorkflowStep(step, results);
          results[step.id] = stepResult;

          // Remove from remaining steps and add to completed
          const index = remainingSteps.findIndex((s) => s.id === step.id);
          if (index !== -1) {
            remainingSteps.splice(index, 1);
          }
          completedSteps.add(step.id);

          // Execute any result handler
          if (step.onResult) {
            await step.onResult(stepResult);
          }

          return { id: step.id, result: stepResult };
        } catch (error) {
          // Handle failure based on recovery settings
          if (this.options.enableRecovery && step.fallbackAgent) {
            // Try fallback agent
            const fallbackStep: AgentWorkflowStep = {
              ...step,
              agent: step.fallbackAgent,
            };
            const stepResult = await this.executeWorkflowStep(
              fallbackStep,
              results,
            );
            results[step.id] = stepResult;

            // Remove from remaining steps and add to completed
            const index = remainingSteps.findIndex((s) => s.id === step.id);
            if (index !== -1) {
              remainingSteps.splice(index, 1);
            }
            completedSteps.add(step.id);

            return { id: step.id, result: stepResult };
          } else {
            // Re-throw to be handled by the caller
            throw error;
          }
        }
      });

      // Execute the batch
      await Promise.all(pendingExecutions);

      // Update workflow progress
      const workflow = await this.memory.get<AgentWorkflow>(
        `workflow:${workflowId}`,
      );
      if (workflow) {
        workflow.completedSteps = completedSteps.size;
        workflow.progress = Math.round(
          ((steps.length - remainingSteps.length) / steps.length) * 100,
        );
        await this.memory.set(`workflow:${workflowId}`, workflow);
      }
    }

    return results;
  }

  /**
   * Execute workflow steps in a round-robin fashion where each agent contributes to a shared output
   */
  private async executeRoundRobinWorkflow(
    workflowId: string,
    steps: AgentWorkflowStep[],
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    let sharedContext: unknown = null;

    for (const step of steps) {
      // Update workflow progress
      const workflow = await this.memory.get<AgentWorkflow>(
        `workflow:${workflowId}`,
      );
      if (workflow) {
        workflow.currentStep = step.id;
        workflow.completedSteps = Object.keys(results).length;
        workflow.progress = Math.round(
          (Object.keys(results).length / steps.length) * 100,
        );
        await this.memory.set(`workflow:${workflowId}`, workflow);
      }

      try {
        // Execute the step with the shared context
        const stepResult = await this.executeWorkflowStep(
          step,
          results,
          sharedContext,
        );

        // Update the shared context with new information
        sharedContext = stepResult;
        results[step.id] = stepResult;

        // Execute any result handler
        if (step.onResult) {
          await step.onResult(stepResult);
        }
      } catch (error) {
        // Handle failure based on recovery settings
        if (this.options.enableRecovery && step.fallbackAgent) {
          // Try fallback agent
          const fallbackStep: AgentWorkflowStep = {
            ...step,
            agent: step.fallbackAgent,
          };
          const stepResult = await this.executeWorkflowStep(
            fallbackStep,
            results,
            sharedContext,
          );
          sharedContext = stepResult;
          results[step.id] = stepResult;
        } else {
          // Mark workflow as failed
          const workflow = await this.memory.get<AgentWorkflow>(
            `workflow:${workflowId}`,
          );
          if (workflow) {
            workflow.status = 'failed';
            workflow.result = { error: (error as Error).message };
            await this.memory.set(`workflow:${workflowId}`, workflow);
          }
          throw error;
        }
      }
    }

    return results;
  }

  /**
   * Execute workflow steps with each agent focusing on their specialized area
   */
  private async executeSpecializedWorkflow(
    workflowId: string,
    steps: AgentWorkflowStep[],
  ): Promise<Record<string, unknown>> {
    // Group steps by agent/specialty
    const stepsByAgent: Record<string, AgentWorkflowStep[]> = {};
    for (const step of steps) {
      if (!stepsByAgent[step.agent]) {
        stepsByAgent[step.agent] = [];
      }
      stepsByAgent[step.agent].push(step);
    }

    const results: Record<string, unknown> = {};

    // Execute each agent's specialized tasks
    for (const [_, agentSteps] of Object.entries(stepsByAgent)) {
      for (const step of agentSteps) {
        // Update workflow progress
        const workflow = await this.memory.get<AgentWorkflow>(
          `workflow:${workflowId}`,
        );
        if (workflow) {
          workflow.currentStep = step.id;
          workflow.completedSteps = Object.keys(results).length;
          workflow.progress = Math.round(
            (Object.keys(results).length / steps.length) * 100,
          );
          await this.memory.set(`workflow:${workflowId}`, workflow);
        }

        try {
          const stepResult = await this.executeWorkflowStep(step, results);
          results[step.id] = stepResult;

          // Execute any result handler
          if (step.onResult) {
            await step.onResult(stepResult);
          }
        } catch (error) {
          // Handle failure based on recovery settings
          if (this.options.enableRecovery && step.fallbackAgent) {
            // Try fallback agent
            const fallbackStep: AgentWorkflowStep = {
              ...step,
              agent: step.fallbackAgent,
            };
            const stepResult = await this.executeWorkflowStep(
              fallbackStep,
              results,
            );
            results[step.id] = stepResult;
          } else {
            // Mark workflow as failed
            const workflow = await this.memory.get<AgentWorkflow>(
              `workflow:${workflowId}`,
            );
            if (workflow) {
              workflow.status = 'failed';
              workflow.result = { error: (error as Error).message };
              await this.memory.set(`workflow:${workflowId}`, workflow);
            }
            throw error;
          }
        }
      }
    }

    return results;
  }

  /**
   * Execute workflow using a hybrid approach that adapts based on workflow characteristics
   */
  private async executeHybridWorkflow(
    workflowId: string,
    steps: AgentWorkflowStep[],
  ): Promise<Record<string, unknown>> {
    // Determine the best approach based on workflow characteristics
    // For example, if there are many independent tasks, use parallel execution
    // If there are many interdependent tasks, use sequential execution

    // Calculate dependency density
    const dependencyCount = steps.reduce(
      (count, step) => count + (step.dependencies?.length || 0),
      0,
    );
    const dependencyDensity =
      dependencyCount / (steps.length * (steps.length - 1 || 1));

    if (dependencyDensity < 0.3) {
      // Low dependency density, use parallel execution
      return this.executeParallelWorkflow(workflowId, steps);
    } else if (dependencyDensity > 0.7) {
      // High dependency density, use sequential execution
      return this.executeSequentialWorkflow(workflowId, steps);
    } else {
      // Medium dependency density, use a combination approach
      return this.executeSequentialWorkflow(workflowId, steps);
    }
  }

  /**
   * Execute a single workflow step with error handling and fallbacks
   */
  private async executeWorkflowStep(
    step: AgentWorkflowStep,
    allResults: Record<string, unknown>,
    sharedContext?: unknown,
  ): Promise<unknown> {
    // Prepare the task context with previous results
    const taskWithContext = `${step.task}

    Previous step results: ${JSON.stringify(allResults, null, 2)}

    Shared context: ${JSON.stringify(sharedContext, null, 2)}`;

    // Execute the agent with appropriate parameters
    return this.coordination
      .getAgentsManager()
      .executeAgent(
        step.agent,
        `Perform the following task: ${taskWithContext}`,
        taskWithContext,
      );
  }

  /**
   * Execute multiple workflows in parallel
   * @param workflows The workflows to execute in parallel
   */
  async executeWorkflowsParallel(
    workflows: Array<{
      workflowId: string;
      name: string;
      description: string;
      steps: AgentWorkflowStep[];
      strategy?:
        | 'sequential'
        | 'parallel'
        | 'round-robin'
        | 'specialized'
        | 'hybrid';
    }>,
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};

    // Limit concurrency
    const chunks = this.chunkArray(workflows, this.options.maxConcurrency || 3);

    for (const chunk of chunks) {
      const chunkPromises = chunk.map(async (workflow) => {
        try {
          const result = await this.executeWorkflow(
            workflow.workflowId,
            workflow.name,
            workflow.description,
            workflow.steps,
            workflow.strategy || 'sequential',
          );
          return { id: workflow.workflowId, result };
        } catch (error) {
          return {
            id: workflow.workflowId,
            result: { error: (error as Error).message },
          };
        }
      });

      const chunkResults = await Promise.all(chunkPromises);
      for (const { id, result } of chunkResults) {
        results[id] = result;
      }
    }

    return results;
  }

  /**
   * Get the status of a workflow
   * @param workflowId The ID of the workflow to check
   */
  async getWorkflowStatus(workflowId: string): Promise<AgentWorkflow | null> {
    return (
      (await this.memory.get<AgentWorkflow>(`workflow:${workflowId}`)) || null
    );
  }

  /**
   * Cancel a running workflow
   * @param workflowId The ID of the workflow to cancel
   */
  async cancelWorkflow(workflowId: string): Promise<void> {
    const workflow = await this.memory.get<AgentWorkflow>(
      `workflow:${workflowId}`,
    );
    if (!workflow) {
      throw new Error(`Workflow with ID ${workflowId} not found`);
    }

    workflow.status = 'failed';
    workflow.result = { error: 'Workflow cancelled by user' };
    await this.memory.set(`workflow:${workflowId}`, workflow);
  }

  /**
   * Pause a running workflow
   * @param workflowId The ID of the workflow to pause
   */
  async pauseWorkflow(workflowId: string): Promise<void> {
    const workflow = await this.memory.get<AgentWorkflow>(
      `workflow:${workflowId}`,
    );
    if (!workflow) {
      throw new Error(`Workflow with ID ${workflowId} not found`);
    }

    workflow.status = 'paused';
    await this.memory.set(`workflow:${workflowId}`, workflow);
  }

  /**
   * Resume a paused workflow
   * @param workflowId The ID of the workflow to resume
   */
  async resumeWorkflow(workflowId: string): Promise<void> {
    const workflow = await this.memory.get<AgentWorkflow>(
      `workflow:${workflowId}`,
    );
    if (!workflow) {
      throw new Error(`Workflow with ID ${workflowId} not found`);
    }

    if (workflow.status !== 'paused') {
      throw new Error(`Workflow ${workflowId} is not paused`);
    }

    workflow.status = 'in-progress';
    await this.memory.set(`workflow:${workflowId}`, workflow);
  }

  /**
   * Create a simple workflow for task delegation
   * @param taskDescription The task to delegate
   * @param specialistAgent The agent that should handle the task
   */
  async createDelegationWorkflow(
    taskId: string,
    taskDescription: string,
    specialistAgent: string,
  ): Promise<string> {
    const workflowId = `delegation-${Date.now()}`;

    const steps: AgentWorkflowStep[] = [
      {
        id: 'delegation-step',
        agent: specialistAgent,
        task: taskDescription,
      },
    ];

    await this.executeWorkflow(
      workflowId,
      `Delegation: ${taskDescription.substring(0, 30)}...`,
      `Delegating task to ${specialistAgent}`,
      steps,
    );

    return workflowId;
  }

  /**
   * Create a workflow for consensus building among agents
   * @param topic The topic to build consensus on
   * @param agents The agents to participate in consensus
   * @param taskPerAgent A function to generate a specific task for each agent
   */
  async createConsensusWorkflow(
    topic: string,
    agents: string[],
    taskPerAgent: (agent: string) => string,
  ): Promise<Record<string, unknown>> {
    const workflowId = `consensus-${Date.now()}`;
    const results: Record<string, unknown> = {};

    // Execute each agent's task in sequence
    for (const agent of agents) {
      try {
        const result = await this.coordination
          .getAgentsManager()
          .executeAgent(
            agent,
            `Participate in consensus building for: ${topic}`,
            taskPerAgent(agent),
          );
        results[agent] = result;
      } catch (error) {
        results[agent] = { error: (error as Error).message };
      }
    }

    // Store the consensus results
    await this.memory.set(`consensus:${workflowId}`, {
      topic,
      participants: agents,
      results,
      timestamp: new Date().toISOString(),
    });

    return results;
  }

  /**
   * Create a workflow for peer review where agents validate each other's work
   */
  async createPeerReviewWorkflow(
    topic: string,
    primaryAgent: string,
    reviewAgents: string[],
    initialTask: string,
  ): Promise<Record<string, unknown>> {
    const workflowId = `peer-review-${Date.now()}`;
    const results: Record<string, unknown> = {};

    // First, have the primary agent complete the initial task
    try {
      const initialResult = await this.coordination
        .getAgentsManager()
        .executeAgent(
          primaryAgent,
          `Complete the following task: ${initialTask}`,
          initialTask,
        );
      results['initial'] = initialResult;
    } catch (error) {
      results['initial'] = { error: (error as Error).message };
      return results;
    }

    // Then, have each review agent review the initial result
    for (const reviewAgent of reviewAgents) {
      try {
        const reviewTask = `Review the following work and provide feedback: ${JSON.stringify(results['initial'])}`;
        const reviewResult = await this.coordination
          .getAgentsManager()
          .executeAgent(
            reviewAgent,
            `Review the following work and provide feedback: ${topic}`,
            reviewTask,
          );
        results[`review-${reviewAgent}`] = reviewResult;
      } catch (error) {
        results[`review-${reviewAgent}`] = { error: (error as Error).message };
      }
    }

    // Store the peer review results
    await this.memory.set(`peer-review:${workflowId}`, {
      topic,
      primaryAgent,
      reviewAgents,
      results,
      timestamp: new Date().toISOString(),
    });

    return results;
  }

  /**
   * Helper to chunk an array into smaller arrays
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Get the coordination system instance
   */
  getCoordination(): AgentCoordinationSystem {
    return this.coordination;
  }

  /**
   * Get the communication system instance
   */
  getCommunication(): AgentCommunicationSystem {
    return this.communication;
  }

  /**
   * Get the shared memory instance
   */
  getMemory(): AgentSharedMemory {
    return this.memory;
  }
}
