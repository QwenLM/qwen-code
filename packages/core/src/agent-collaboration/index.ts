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
import {
  EnhancedAgentCoordinationSystem,
  EnhancedAgentCommunicationSystem,
  EnhancedAgentOrchestrationSystem,
} from './enhanced-coordination.js';

export interface AgentCollaborationAPI {
  coordination: AgentCoordinationSystem;
  communication: AgentCommunicationSystem;
  orchestration: AgentOrchestrationSystem;
  memory: AgentSharedMemory;
}

export interface EnhancedAgentCollaborationAPI {
  coordination: EnhancedAgentCoordinationSystem;
  communication: EnhancedAgentCommunicationSystem;
  orchestration: EnhancedAgentOrchestrationSystem;
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
  const memory = new AgentSharedMemory(config, {
    maxSize: 5000,
    maxAgeMinutes: 60,
  }); // Custom settings
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
 * Create an enhanced collaboration API with advanced features for agent teamwork
 * @param config The Qwen configuration
 * @param options Optional configuration for the collaboration systems
 */
export function createEnhancedAgentCollaborationAPI(
  config: Config,
  options?: AgentCollaborationOptions,
): EnhancedAgentCollaborationAPI {
  const memory = new AgentSharedMemory(config, {
    maxSize: 5000,
    maxAgeMinutes: 60,
  }); // Custom settings
  const communication = new EnhancedAgentCommunicationSystem(config);
  const coordination = new EnhancedAgentCoordinationSystem(
    config,
    communication,
  );
  const orchestration = new EnhancedAgentOrchestrationSystem(
    config,
    coordination,
    communication,
  );

  // Use options parameter (even if just to acknowledge it)
  void options;

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

  // Initialize the team workspace in shared memory
  await api.memory.initializeTeamWorkspace(teamName, agents, task);

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
    | 'delegation'
    | 'specialized' = 'sequential',
): Promise<Record<string, unknown>> {
  const api = createAgentCollaborationAPI(config);
  const results: Record<string, unknown> = {};
  let currentTask: string;
  let primaryAgent: string;
  let parallelResults: Array<{ agent: string; result: unknown }>;
  let result: unknown;
  let promises: Array<Promise<{ agent: string; result: unknown }>>;

  // Initialize shared context for collaboration
  await api.memory.set('shared-context', {
    initial_task: task,
    results: {},
    timestamp: new Date().toISOString(),
  });

  switch (strategy) {
    case 'parallel':
      // Execute tasks in parallel
      {
        const sharedContext = (await api.memory.get('shared-context')) || {};
        promises = agents.map((agent) =>
          api.coordination
            .getAgentsManager()
            .executeAgent(
              agent,
              `Collaborate on the following task: ${task}`,
              task,
              undefined, // tools
              { shared_context: sharedContext }, // context
            )
            .then((result) => ({ agent, result }))
            .catch((error) => ({
              agent,
              result: { error: (error as Error).message },
            })),
        );
        parallelResults = await Promise.all(promises);
        for (const {
          agent: agentKey,
          result: resultValue,
        } of parallelResults) {
          results[agentKey] = resultValue;

          // Store individual agent's result in shared memory
          await api.memory.set(`agent:${agentKey}:result:${Date.now()}`, {
            task,
            result: resultValue,
            agent: agentKey,
            timestamp: new Date().toISOString(),
          });

          // Send notification about completion
          await api.communication.sendMessage(
            agentKey,
            'broadcast',
            'notification',
            {
              type: 'completed_task',
              agent: agentKey,
              task,
              result_summary:
                typeof resultValue === 'string'
                  ? resultValue.substring(0, 100)
                  : JSON.stringify(resultValue).substring(0, 100),
              timestamp: new Date().toISOString(),
            },
            { requireAck: false },
          );
        }
      }
      break;

    case 'sequential':
      // Execute tasks sequentially, with context sharing between agents
      for (const agentKey of agents) {
        try {
          // Get shared context to pass to the agent
          const sharedContext = (await api.memory.get('shared-context')) || {};
          const taskContext = {
            ...sharedContext,
            current_agent: agentKey,
            previous_results: results,
            team_task: task,
          };

          result = await api.coordination.getAgentsManager().executeAgent(
            agentKey,
            `Collaborate on the following task: ${task}. Use any information from previous agents' work to inform your contribution.`,
            task,
            undefined, // tools
            taskContext, // context
          );
          results[agentKey] = result;

          // Send an update to other team members about this agent's contribution
          await api.communication.sendMessage(
            agentKey,
            'broadcast',
            'notification',
            {
              type: 'contribution',
              agent: agentKey,
              contribution: result,
              timestamp: new Date().toISOString(),
            },
            { requireAck: false }, // For broadcast, we don't require individual acknowledgments
          );

          // Update shared context with the latest result
          const updatedContext = {
            ...sharedContext,
            [agentKey]: result,
            results: { ...results },
            last_agent_result: result,
            last_agent: agentKey,
          };
          await api.memory.set('shared-context', updatedContext);
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
          // Get shared context and previous results
          const sharedContext = (await api.memory.get('shared-context')) || {};
          const taskContext = {
            ...sharedContext,
            current_agent: agentKey,
            current_task: currentTask,
            previous_results: results,
            previous_task: currentTask,
          };

          result = await api.coordination.getAgentsManager().executeAgent(
            agentKey,
            `Process the following task, building on previous work: ${currentTask}. Use shared context and previous results to inform your contribution.`,
            currentTask,
            undefined, // tools
            taskContext, // context
          );
          results[agentKey] = result;

          // Update shared context
          const updatedContext = {
            ...sharedContext,
            [agentKey]: result,
            last_result: result,
            last_agent: agentKey,
          };
          await api.memory.set('shared-context', updatedContext);

          // Notify other agents about this agent's contribution
          await api.communication.sendMessage(
            agentKey,
            'broadcast',
            'data',
            {
              type: 'round_robin_update',
              agent: agentKey,
              contribution: result,
              next_task: `Continue based on: ${JSON.stringify(result)}. Original task: ${task}`,
              timestamp: new Date().toISOString(),
            },
            { requireAck: false },
          );

          // Create next task based on current result
          currentTask = `Continue the work based on previous results: ${JSON.stringify(result)}. Task: ${task}`;
        } catch (error) {
          results[agentKey] = { error: (error as Error).message };

          // Notify of failure
          await api.communication.sendMessage(
            agentKey,
            'broadcast',
            'notification',
            {
              type: 'error',
              agent: agentKey,
              error: (error as Error).message,
              timestamp: new Date().toISOString(),
            },
            { requireAck: false },
          );

          break; // Stop on error
        }
      }
      break;

    case 'delegation':
      // Task is delegated to the most appropriate agent based on naming convention
      primaryAgent = agents[0]; // For now, delegate to first agent
      try {
        result = await api.coordination.getAgentsManager().executeAgent(
          primaryAgent,
          `Handle the following task, delegating parts to other team members as needed: ${task}`,
          task,
          undefined, // tools
          { available_agents: agents, team_task: task }, // context
        );
        results[primaryAgent] = result;

        // If the primary agent requests help with subtasks, coordinate those
        // This would be handled through shared memory and communication channels
      } catch (error) {
        results[primaryAgent] = { error: (error as Error).message };
      }
      break;

    case 'specialized':
      // Each agent specializes in a specific aspect of the overall task
      for (const agentKey of agents) {
        try {
          // Determine the specialized aspect based on agent type
          let agentSpecificTask = task;
          if (agentKey.includes('researcher')) {
            agentSpecificTask = `Research and analyze: ${task}`;
          } else if (agentKey.includes('architect')) {
            agentSpecificTask = `Design solution architecture for: ${task}`;
          } else if (agentKey.includes('engineer')) {
            agentSpecificTask = `Implement solution for: ${task}`;
          } else if (agentKey.includes('tester')) {
            agentSpecificTask = `Test and validate: ${task}`;
          } else if (agentKey.includes('planner')) {
            agentSpecificTask = `Plan and organize approach for: ${task}`;
          }

          // Get shared context to pass to the specialized agent
          const sharedContext = (await api.memory.get('shared-context')) || {};
          const taskContext = {
            ...sharedContext,
            specialized_role: agentKey,
            agent_task: agentSpecificTask,
            previous_results: results,
            team_task: task,
          };

          result = await api.coordination.getAgentsManager().executeAgent(
            agentKey,
            `As a specialized ${agentKey}, work on your specific role: ${agentSpecificTask}. Use shared context and results from other team members to inform your work.`,
            agentSpecificTask,
            undefined, // tools
            taskContext, // context
          );
          results[agentKey] = result;

          // Update shared context with this agent's specialized contribution
          const sharedContextRecord = sharedContext as Record<string, unknown>;
          const specializedResults = sharedContextRecord['specialized_results']
            ? {
                ...(sharedContextRecord['specialized_results'] as Record<
                  string,
                  unknown
                >),
              }
            : {};
          const completedAgents = Array.isArray(
            sharedContextRecord['completed_agents'],
          )
            ? (sharedContextRecord['completed_agents'] as string[])
            : [];
          const updatedContext = {
            ...sharedContext,
            [agentKey]: result,
            specialized_results: {
              ...specializedResults,
              [agentKey]: result,
            },
            completed_agents: [...completedAgents, agentKey],
          };
          await api.memory.set('shared-context', updatedContext);

          // Notify team of this specialized contribution
          await api.communication.sendMessage(
            agentKey,
            'broadcast',
            'data',
            {
              type: 'specialized_contribution',
              agent: agentKey,
              role: agentKey,
              contribution: result,
              task: agentSpecificTask,
              timestamp: new Date().toISOString(),
            },
            { requireAck: false },
          );
        } catch (error) {
          results[agentKey] = { error: (error as Error).message };

          // Notify team of failure in specialized role
          await api.communication.sendMessage(
            agentKey,
            'broadcast',
            'notification',
            {
              type: 'error',
              agent: agentKey,
              role: agentKey,
              error: (error as Error).message,
              task, // Use the original task if agentSpecificTask is not defined
              timestamp: new Date().toISOString(),
            },
            { requireAck: false },
          );

          // Continue with other agents even if one fails
        }
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
export * from './metrics.js';
