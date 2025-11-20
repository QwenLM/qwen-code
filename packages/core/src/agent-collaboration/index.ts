/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { AgentCoordinationSystem } from './agent-coordination.js';
import { AgentCommunicationSystem } from './agent-communication.js';
import { AgentOrchestrationSystem } from './agent-orchestration.js';
import { AgentSharedMemory } from './shared-memory.js';

export interface AgentCollaborationAPI {
  coordination: AgentCoordinationSystem;
  communication: AgentCommunicationSystem;
  orchestration: AgentOrchestrationSystem;
  memory: AgentSharedMemory;
}

export interface AgentCollaborationOptions {
  coordination?: ConstructorParameters<typeof AgentCoordinationSystem>[1];
  orchestration?: ConstructorParameters<typeof AgentOrchestrationSystem>[1];
}

/**
 * Create a comprehensive collaboration API for agent teams
 * @param config The Qwen configuration
 * @param options Optional configuration for the collaboration systems
 */
export function createAgentCollaborationAPI(
  config: Config,
  options?: AgentCollaborationOptions,
): AgentCollaborationAPI {
  const memory = new AgentSharedMemory(config);
  const coordination = new AgentCoordinationSystem(
    config,
    options?.coordination,
  );
  const communication = new AgentCommunicationSystem(config);
  const orchestration = new AgentOrchestrationSystem(
    config,
    options?.orchestration,
  );

  return {
    coordination,
    communication,
    orchestration,
    memory,
  };
}

/**
 * Utility function to create a specialized agent team for a specific purpose
 * @param config The Qwen configuration
 * @param teamName The name of the agent team
 * @param agents The agents to include in the team
 * @param task The task the team should collaborate on
 */
export async function createAgentTeam(
  config: Config,
  teamName: string,
  agents: Array<{ name: string; role: string }>,
  task: string,
): Promise<AgentCollaborationAPI> {
  const api = createAgentCollaborationAPI(config);

  // Register the team in shared memory
  await api.memory.set(`team:${teamName}`, {
    name: teamName,
    agents,
    task,
    created: new Date().toISOString(),
    status: 'active',
  });

  // Set up team-specific shared context
  for (const agent of agents) {
    // Initialize agent's local context with team information
    await api.memory.set(`agent:${agent.name}:context`, {
      team: teamName,
      role: agent.role,
      task,
      capabilities: [], // To be populated as needed
    });
  }

  return api;
}

/**
 * Utility function to execute a collaborative task with multiple agents
 * @param config The Qwen configuration
 * @param agents List of agent names to participate
 * @param task The main task to be accomplished
 * @param strategy The collaboration strategy to use
 */
export async function executeCollaborativeTask(
  config: Config,
  agents: string[],
  task: string,
  strategy:
    | 'parallel'
    | 'sequential'
    | 'round-robin'
    | 'delegation' = 'sequential',
): Promise<Record<string, unknown>> {
  const api = createAgentCollaborationAPI(config);
  const results: Record<string, unknown> = {};
  let currentTask: string;
  let primaryAgent: string;
  let parallelResults: Array<{ agent: string; result: unknown }>;
  let result: unknown;
  let promises: Array<Promise<{ agent: string; result: unknown }>>;

  switch (strategy) {
    case 'parallel':
      // Execute tasks in parallel
      promises = agents.map((agent) =>
        api.coordination
          .getAgentsManager()
          .executeAgent(
            agent,
            `Collaborate on the following task: ${task}`,
            task,
          )
          .then((result) => ({ agent, result }))
          .catch((error) => ({
            agent,
            result: { error: (error as Error).message },
          })),
      );
      parallelResults = await Promise.all(promises);
      for (const { agent: agentKey, result: resultValue } of parallelResults) {
        results[agentKey] = resultValue;
      }
      break;

    case 'sequential':
      // Execute tasks sequentially
      for (const agentKey of agents) {
        try {
          result = await api.coordination
            .getAgentsManager()
            .executeAgent(
              agentKey,
              `Collaborate on the following task: ${task}`,
              task,
            );
          results[agentKey] = result;
        } catch (error) {
          results[agentKey] = { error: (error as Error).message };
          break; // Stop on error for sequential approach
        }
      }
      break;

    case 'round-robin':
      // Execute tasks in round-robin fashion, passing results between agents
      currentTask = task;
      for (const agentKey of agents) {
        try {
          result = await api.coordination
            .getAgentsManager()
            .executeAgent(
              agentKey,
              `Process the following task, building on previous work: ${currentTask}`,
              currentTask,
            );
          results[agentKey] = result;
          currentTask = JSON.stringify(result); // Pass result as next task
        } catch (error) {
          results[agentKey] = { error: (error as Error).message };
          break; // Stop on error
        }
      }
      break;

    case 'delegation':
      // Task is delegated to the most appropriate agent based on naming convention
      primaryAgent = agents[0]; // For now, delegate to first agent
      try {
        result = await api.coordination
          .getAgentsManager()
          .executeAgent(
            primaryAgent,
            `Handle the following task, delegating parts to other team members as needed: ${task}`,
            task,
          );
        results[primaryAgent] = result;

        // If the primary agent requests help with subtasks, coordinate those
        // This would be handled through shared memory and communication channels
      } catch (error) {
        results[primaryAgent] = { error: (error as Error).message };
      }
      break;

    default:
      throw new Error(`Unsupported collaboration strategy: ${strategy}`);
  }

  // Store the collaboration result in shared memory
  await api.memory.set(`collaboration:result:${Date.now()}`, {
    task,
    strategy,
    agents,
    results,
    timestamp: new Date().toISOString(),
  });

  return results;
}

// Export the project workflow functionality
export * from './project-workflow.js';
export * from './workflow-examples.js';
