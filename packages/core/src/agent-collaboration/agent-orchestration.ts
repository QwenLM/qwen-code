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
}

export interface AgentWorkflow {
  id: string;
  name: string;
  description: string;
  steps: AgentWorkflowStep[];
  created: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  result?: unknown;
}

export interface AgentOrchestrationOptions {
  maxConcurrency?: number;
  timeoutMinutes?: number;
}

/**
 * Orchestration system for managing complex workflows involving multiple agents
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
      ...options,
    };

    // Use config to log initialization if needed
    void this.config;
    void this.options;
  }

  /**
   * Execute a workflow with multiple agent steps
   * @param workflowId Unique workflow identifier
   * @param name Human-readable name for the workflow
   * @param description Description of the workflow
   * @param steps The steps to execute in the workflow
   */
  async executeWorkflow(
    workflowId: string,
    name: string,
    description: string,
    steps: AgentWorkflowStep[],
  ): Promise<unknown> {
    const workflow: AgentWorkflow = {
      id: workflowId,
      name,
      description,
      steps,
      created: new Date().toISOString(),
      status: 'in-progress',
    };

    // Store workflow in shared memory
    await this.memory.set(`workflow:${workflowId}`, workflow);

    try {
      // Execute steps in dependency order
      const results: Record<string, unknown> = {};

      // Identify execution order considering dependencies
      const completedSteps = new Set<string>();
      const stepResults: Record<string, unknown> = {};

      while (completedSteps.size < steps.length) {
        let executedThisRound = false;

        for (const step of steps) {
          if (completedSteps.has(step.id)) continue;

          // Check if all dependencies are completed
          if (step.dependencies) {
            const allDependenciesMet = step.dependencies.every((depId) =>
              completedSteps.has(depId),
            );
            if (!allDependenciesMet) continue;
          }

          // Execute this step
          try {
            const result = await this.coordination
              .getAgentsManager()
              .executeAgent(
                step.agent,
                `Perform the following task: ${step.task}`,
                step.task,
              );

            stepResults[step.id] = result;
            results[step.id] = result;
            completedSteps.add(step.id);

            // Execute any result handler
            if (step.onResult) {
              await step.onResult(result);
            }
          } catch (error) {
            // Mark workflow as failed and re-throw
            workflow.status = 'failed';
            workflow.result = { error: (error as Error).message };
            await this.memory.set(`workflow:${workflowId}`, workflow);
            throw error;
          }

          executedThisRound = true;
          break; // Execute only one step per round to respect dependencies
        }

        if (!executedThisRound) {
          throw new Error(
            `Circular dependency or missing dependency detected in workflow ${workflowId}`,
          );
        }
      }

      // Mark workflow as completed
      workflow.status = 'completed';
      workflow.result = stepResults;
      await this.memory.set(`workflow:${workflowId}`, workflow);

      return stepResults;
    } catch (error) {
      // Mark workflow as failed
      workflow.status = 'failed';
      workflow.result = { error: (error as Error).message };
      await this.memory.set(`workflow:${workflowId}`, workflow);
      throw error;
    }
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
    }>,
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};

    // Limit concurrency
    const chunks = this.chunkArray(workflows, this.options.maxConcurrency || 3);

    for (const chunk of chunks) {
      const chunkPromises = chunk.map((workflow) =>
        this.executeWorkflow(
          workflow.workflowId,
          workflow.name,
          workflow.description,
          workflow.steps,
        )
          .then((result) => ({ id: workflow.workflowId, result }))
          .catch((error) => ({
            id: workflow.workflowId,
            result: { error: (error as Error).message },
          })),
      );

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
